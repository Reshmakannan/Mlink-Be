const crypto = require('crypto');
const db = require('../config/db');
const { getClient, PLANS, TRIAL_DAYS, TRIAL_FEE_PAISE, planIdFor } = require('../config/razorpay');

const uid = (req) => req.user.id;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const toDate = (unix) => (unix ? new Date(unix * 1000) : null);
const LIVE = ['trialing', 'active', 'past_due'];

function rzpMessage(err) {
  if (!err) return 'The payment provider returned an error.';
  const detail = err.error && (err.error.description || err.error.reason);
  if (detail) return detail;
  if (typeof err.error === 'string') return err.error.slice(0, 200);
  if (err.message) return err.message;
  return `The payment provider returned an error${err.statusCode ? ` (status ${err.statusCode})` : ''}.`;
}

// Logs the raw Razorpay error (never secrets) so failures can be diagnosed.
function logRzp(label, err) {
  console.error(
    label,
    JSON.stringify({
      statusCode: err && err.statusCode,
      error: err && err.error,
      message: err && err.message,
    })
  );
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const accessEnd = (row) => (row.status === 'trialing' ? row.trial_end_date : row.subscription_end_date);

async function latestRow(userId, conn = db) {
  const [rows] = await conn.query(
    "SELECT * FROM subscriptions WHERE user_id = ? AND status <> 'pending' ORDER BY id DESC LIMIT 1",
    [userId]
  );
  return rows[0] || null;
}

async function hasUsedTrial(userId) {
  const [rows] = await db.query('SELECT 1 FROM trial_claims WHERE user_id = ? LIMIT 1', [userId]);
  return rows.length > 0;
}

async function updateRow(conn, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE subscriptions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  await conn.query(sql, [...keys.map((k) => fields[k]), id]);
}

async function withTx(fn) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// Shape the frontend receives. Keeps the field names Pricing/Dashboard already use.
function toApi(row) {
  if (!row) return null;
  const cancelRequested = !!row.cancelled_at;
  let nextDebit = null;
  if (!cancelRequested && row.auto_renewal) {
    if (row.status === 'trialing') nextDebit = row.trial_end_date;
    else if (row.status === 'active') nextDebit = row.subscription_end_date;
  }
  return {
    id: row.id,
    plan_type: row.plan_type,
    status: row.status,
    price: row.price,
    currency: row.currency || 'INR',
    with_trial: !!row.with_trial,
    trial_start_date: row.trial_started_at,
    trial_end_date: row.trial_end_date,
    subscription_end_date: row.subscription_end_date,
    auto_renewal: !!row.auto_renewal,
    cancel_at_period_end: !!row.cancel_at_period_end,
    cancelled_at: row.cancelled_at,
    next_debit_at: nextDebit,
    renewal_amount: Number(row.price),
    access_until: cancelRequested || row.status === 'cancelled' ? accessEnd(row) || null : null,
  };
}

async function recordPayment(conn, row, pay, statusOverride, kindOverride) {
  const status = statusOverride || pay.status;
  const kind = kindOverride || (row.with_trial && pay.amount === TRIAL_FEE_PAISE ? 'trial_fee' : 'plan_charge');
  await conn.query(
    `INSERT INTO razorpay_payments
       (user_id, subscription_row_id, rzp_payment_id, rzp_subscription_id, amount_paise, currency, status, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status)`,
    [row.user_id, row.id, pay.id, row.rzp_subscription_id, pay.amount || 0, pay.currency || 'INR', status, kind]
  );
  if (status === 'captured') {
    await conn.query('UPDATE subscriptions SET rzp_payment_id = ? WHERE id = ?', [pay.id, row.id]);
  }
}

// Turns a Razorpay subscription object into our local state. Used by the
// webhook, by /verify and by lazy syncing, so all three always agree.
async function applySubscriptionState(conn, row, rzp) {
  const now = new Date();
  const upd = {};
  const settled = row.status === 'cancelled' || row.status === 'expired';
  if (rzp.customer_id && rzp.customer_id !== row.rzp_customer_id) upd.rzp_customer_id = rzp.customer_id;

  switch (rzp.status) {
    case 'authenticated':
      if (row.status === 'pending' && row.with_trial) {
        upd.status = 'trialing';
        upd.trial_started_at = row.trial_started_at || now;
        upd.trial_end_date = toDate(rzp.start_at);
        upd.auto_renewal = 1;
      }
      break;
    case 'active':
      if (!settled) {
        upd.status = 'active';
        if (rzp.current_end) upd.subscription_end_date = toDate(rzp.current_end);
        if (!row.cancelled_at) upd.auto_renewal = 1;
        if (row.status === 'pending' && row.with_trial) upd.trial_started_at = row.trial_started_at || now;
      }
      break;
    case 'pending':
      if (row.status === 'trialing' || row.status === 'active') upd.status = 'past_due';
      break;
    case 'halted':
    case 'completed':
    case 'expired':
      if (row.status !== 'cancelled') {
        upd.status = 'expired';
        upd.auto_renewal = 0;
      }
      break;
    case 'cancelled': {
      upd.auto_renewal = 0;
      upd.cancel_at_period_end = 1;
      upd.cancelled_at = row.cancelled_at || now;
      const end = accessEnd(row);
      // Access continues until the end of what the user already has.
      if (row.status === 'pending' || row.status === 'trialing' || !end || new Date(end) <= now) upd.status = 'cancelled';
      break;
    }
    default:
      break;
  }

  await updateRow(conn, row.id, upd);

  const becameLive = upd.status === 'trialing' || (upd.status === 'active' && row.with_trial);
  if (becameLive && row.with_trial) {
    await conn.query(
      'INSERT INTO trial_claims (user_id, plan_type) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = user_id',
      [row.user_id, row.plan_type]
    );
  }
  return { ...row, ...upd };
}

// Run on every read: ends cancelled access when its date passes, and asks
// Razorpay if a webhook seems to be missing.
async function settleRow(row) {
  if (!row) return row;
  const now = Date.now();

    // A cancelled free trial ends immediately (this also fixes trials cancelled earlier).
  if (row.status === 'trialing' && row.cancelled_at) {
    await updateRow(db, row.id, { status: 'cancelled', auto_renewal: 0 });
    return { ...row, status: 'cancelled', auto_renewal: 0 };
  }

  if (row.cancelled_at && LIVE.includes(row.status)) {
    const end = accessEnd(row);
    if (!end || new Date(end).getTime() <= now) {
      await updateRow(db, row.id, { status: 'cancelled', auto_renewal: 0 });
      return { ...row, status: 'cancelled', auto_renewal: 0 };
    }
    return row;
  }

  const end = accessEnd(row);
  const overdue = end && new Date(end).getTime() + 10 * 60 * 1000 < now;
  if ((row.status === 'trialing' || row.status === 'active') && overdue && row.rzp_subscription_id) {
    try {
      const rzp = await getClient().subscriptions.fetch(row.rzp_subscription_id);
      return await applySubscriptionState(db, row, rzp);
    } catch (err) {
      console.error('settleRow sync failed:', rzpMessage(err));
    }
  }
  return row;
}

// Decides whether a user who already has a subscription may pick another plan.
// null = no live subscription (normal flow); {error} = blocked; {ok} = trial switch.
function trialSwitchState(existing, planType) {
  if (!existing || !['trialing', 'active'].includes(existing.status)) return null;
  if (existing.status === 'active') {
    return {
      error:
        'You are subscribed. To change plan, cancel your subscription from the dashboard first, then choose a new plan.',
    };
  }
  if (existing.cancelled_at) return null;
  if (existing.plan_type === planType) return { error: 'You are already on this plan.' };
  if (!existing.rzp_subscription_id) {
    return {
      error:
        'This is an older trial without payment details. Cancel it from the dashboard, then start your new plan.',
    };
  }
  const end = existing.trial_end_date ? new Date(existing.trial_end_date).getTime() : 0;
  if (end - Date.now() < 30 * 60 * 1000) {
    return { error: 'Your trial ends very soon, so the plan cannot be switched now.' };
  }
  return { ok: true, trialEnd: new Date(end) };
}

// After a switch, cancels any older live subscription at Razorpay so the user
// is never charged for two plans. An old row is only marked cancelled once
// Razorpay confirms it, otherwise it is retried on the next call.
async function retireOthers(userId) {
  try {
    const [rows] = await db.query(
      "SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('trialing','active','past_due') ORDER BY id DESC",
      [userId]
    );
    if (rows.length < 2) return;
    for (const old of rows.slice(1)) {
      if (old.rzp_subscription_id) {
        try {
          await rzpCancelSubscription(old.rzp_subscription_id, false);
        } catch (err) {
          let current = null;
          try {
            current = await getClient().subscriptions.fetch(old.rzp_subscription_id);
          } catch (e) {
            /* ignore */
          }
          if (!current || current.status !== 'cancelled') {
            console.error('could not retire old subscription', old.rzp_subscription_id, err && err.message);
            continue;
          }
        }
      }
      await updateRow(db, old.id, {
        status: 'cancelled',
        auto_renewal: 0,
        cancel_at_period_end: 0,
        cancelled_at: old.cancelled_at || new Date(),
      });
    }
  } catch (err) {
    console.error('retireOthers failed:', err.code || err.message);
  }
}

// ---------- API handlers ----------

async function me(req, res) {
  try {
    await retireOthers(uid(req));
    let row = await latestRow(uid(req));
    row = await settleRow(row);
    res.json({ subscription: row && row.status !== 'pending' ? toApi(row) : null });
  } catch (err) {
    console.error('payments.me failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not load your subscription.' });
  }
}

// What the user is agreeing to, shown before they authorize anything.
async function terms(req, res) {
  const planType = str(req.query.planType);
  const plan = PLANS[planType];
  if (!plan) return res.status(400).json({ message: 'Choose a valid plan.' });
  try {
    const existing = await settleRow(await latestRow(uid(req)));
    const sw = trialSwitchState(existing, planType);
    if (sw && sw.error) return res.status(409).json({ message: sw.error });
    if (sw && sw.ok) {
      return res.json({
        terms: {
          plan_type: planType,
          label: plan.label,
          price: plan.price,
          billing: plan.billing,
          currency: 'INR',
          trial: true,
          switching: true,
          trial_days: TRIAL_DAYS,
          upfront_amount: 0,
          first_debit_at: sw.trialEnd.toISOString(),
          current_label: (PLANS[existing.plan_type] || {}).label || existing.plan_type,
        },
      });
    }

    const used = await hasUsedTrial(uid(req));
    const now = new Date();
    const firstDebit = used ? now : new Date(now.getTime() + TRIAL_DAYS * 86400000);
    res.json({
      terms: {
        plan_type: planType,
        label: plan.label,
        price: plan.price,
        billing: plan.billing,
        currency: 'INR',
        trial: !used,
        trial_days: TRIAL_DAYS,
        upfront_amount: used ? plan.price : TRIAL_FEE_PAISE / 100,
        first_debit_at: firstDebit.toISOString(),
      },
    });
  } catch (err) {
    console.error('payments.terms failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not load the payment terms.' });
  }
}

async function checkout(req, res) {
  const userId = uid(req);
  const planType = str(req.body && req.body.planType);
  const plan = PLANS[planType];
  if (!plan) return res.status(400).json({ message: 'Choose a valid plan.' });

  const planId = planIdFor(planType);
  if (!planId) {
    console.error(`Razorpay plan id missing for ${planType} (set ${plan.envKey} in .env)`);
    return res.status(500).json({ message: 'Payments are not set up yet. Please try again later.' });
  }

  try {
    const razorpay = getClient();
    const existing = await settleRow(await latestRow(userId));

    const sw = trialSwitchState(existing, planType);
    if (sw && sw.error) return res.status(409).json({ message: sw.error });
    const switching = !!(sw && sw.ok);

    // Retry after a failed renewal: stop the failed subscription first.
    if (existing && existing.status === 'past_due' && existing.rzp_subscription_id) {
      try {
        await rzpCancelSubscription(existing.rzp_subscription_id, false);
      } catch (err) {
        console.error('could not cancel past_due subscription:', rzpMessage(err));
      }
    }

    const withTrial = switching ? true : !(await hasUsedTrial(userId));
    const params = {
      plan_id: planId,
      total_count: plan.totalCount,
      quantity: 1,
      customer_notify: 1,
      notes: {
        user_id: String(userId),
        plan_type: planType,
        ...(switching ? { switched_from: existing.plan_type } : {}),
      },
    };
    if (switching) {
      // Same trial end date as before, and no second Rs 1 charge.
      params.start_at = Math.floor(sw.trialEnd.getTime() / 1000);
    } else if (withTrial) {
      // Subscription starts after the trial; the Rs 1 is charged now as an add-on.
      params.start_at = Math.floor(Date.now() / 1000 + TRIAL_DAYS * 86400);
      params.addons = [
        { item: { name: `MLink free trial (${TRIAL_DAYS} days)`, amount: TRIAL_FEE_PAISE, currency: 'INR' } },
      ];
    }
    const rzpSub = await razorpay.subscriptions.create(params);

    // The new attempt is its own row, so abandoning checkout never
    // disturbs the subscription the user already has.
    await db.query("DELETE FROM subscriptions WHERE user_id = ? AND status = 'pending'", [userId]);
    await db.query('INSERT INTO subscriptions SET ?', {
      user_id: userId,
      plan_type: planType,
      price: plan.price,
      currency: 'INR',
      status: 'pending',
      with_trial: withTrial ? 1 : 0,
      rzp_subscription_id: rzpSub.id,
      rzp_plan_id: planId,
      rzp_payment_id: null,
      trial_started_at: switching ? existing.trial_started_at : null,
      trial_end_date: switching ? existing.trial_end_date : null,
      subscription_end_date: null,
      auto_renewal: 1,
      cancel_at_period_end: 0,
      cancelled_at: null,
    });

    const [users] = await db.query('SELECT name, email FROM users WHERE id = ? LIMIT 1', [userId]);
    res.json({
      key: process.env.RAZORPAY_KEY_ID,
      subscription_id: rzpSub.id,
      trial: withTrial,
      switching,
      plan: { label: plan.label, price: plan.price },
      prefill: { name: (users[0] && users[0].name) || '', email: (users[0] && users[0].email) || '' },
    });
  } catch (err) {
    console.error('payments.checkout failed:', rzpMessage(err));
    res.status(502).json({ message: rzpMessage(err) });
  }
}

async function verify(req, res) {
  const userId = uid(req);
  const b = req.body || {};
  const paymentId = str(b.razorpay_payment_id);
  const subId = str(b.razorpay_subscription_id);
  const signature = str(b.razorpay_signature);
  if (!paymentId || !subId || !signature) {
    return res.status(400).json({ message: 'Missing payment details.' });
  }

  // Checkout signs "payment_id|subscription_id" with the key secret.
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${paymentId}|${subId}`)
    .digest('hex');
  if (!safeEqual(expected, signature)) {
    return res.status(400).json({ message: 'Payment verification failed.' });
  }

  try {
    const [rows] = await db.query(
      'SELECT * FROM subscriptions WHERE rzp_subscription_id = ? AND user_id = ? LIMIT 1',
      [subId, userId]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Subscription not found.' });

    // Already handled (for example by the webhook): just return it.
    if (rows[0].status !== 'pending') {
      await retireOthers(userId);
      return res.json({ subscription: toApi(await settleRow(rows[0])) });
    }

    // A plan switch during a trial keeps the existing trial end date.
    const isSwitch = !!rows[0].trial_end_date;

    // Never trust the browser alone: ask Razorpay directly.
    const razorpay = getClient();
    const payment = await razorpay.payments.fetch(paymentId);
    if (payment.status === 'failed') {
      return res.status(402).json({ message: 'The payment failed. You were not charged the plan price.' });
    }
    const rzpSub = await razorpay.subscriptions.fetch(subId);
    if ((payment.status !== 'captured' && !isSwitch) || !['authenticated', 'active'].includes(rzpSub.status)) {
      return res.status(202).json({ pending: true, message: 'Your payment is still being confirmed.' });
    }

    const updated = await withTx(async (conn) => {
      const [locked] = await conn.query('SELECT * FROM subscriptions WHERE id = ? FOR UPDATE', [rows[0].id]);
      let row = locked[0];
      if (row.status === 'pending') row = await applySubscriptionState(conn, row, rzpSub);
      await recordPayment(conn, row, payment, undefined, isSwitch ? 'authorization' : undefined);
      return row;
    });
    await retireOthers(userId);
    res.json({ subscription: toApi(updated) });
  } catch (err) {
    console.error('payments.verify failed:', rzpMessage(err));
    res.status(502).json({ message: 'We could not confirm your payment yet. Please check again in a minute.' });
  }
}
// Calls Razorpay's cancel endpoint directly (Node 18+ has fetch built in), so
// a failure always carries a readable reason instead of an empty error.
async function rzpCancelSubscription(subscriptionId, atCycleEnd) {
  const token = Buffer.from(
    `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
  ).toString('base64');

  let res;
  try {
    res = await fetch(
      `https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancel_at_cycle_end: atCycleEnd ? 1 : 0 }),
      }
    );
  } catch (netErr) {
    const code = netErr && netErr.cause && netErr.cause.code;
    throw new Error(`Could not reach Razorpay${code ? ` (${code})` : ''}. Check the server's internet connection.`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason =
      (data.error && (data.error.description || data.error.reason)) ||
      `Razorpay returned status ${res.status}.`;
    const err = new Error(reason);
    err.statusCode = res.status;
    err.error = data.error;
    throw err;
  }
  return data;
}
async function performCancel(userId, atCycleEndRequested) {
  let row = await settleRow(await latestRow(userId));
  if (!row || !LIVE.includes(row.status)) {
    const e = new Error('There is no active subscription to cancel.');
    e.http = 400;
    throw e;
  }
  if (row.cancelled_at) return row; // already cancelled: repeated clicks are harmless

  const isTrial = row.status === 'trialing';
  const cycleEnd = row.status === 'active' && atCycleEndRequested;
  const razorpay = getClient();
  try {
    await rzpCancelSubscription(row.rzp_subscription_id, cycleEnd);
  } catch (err) {
    console.error('razorpay cancel failed:', err && err.statusCode, err && err.message, JSON.stringify(err && err.error));
    // If a second request already cancelled it, carry on; otherwise it is a real failure.
    let current = null;
    try {
      current = await razorpay.subscriptions.fetch(row.rzp_subscription_id);
    } catch (e) {
      /* ignore */
    }
    if (!current || current.status !== 'cancelled') {
      const e = new Error(rzpMessage(err));
      e.http = 502;
      throw e;
    }
  }

  // Razorpay accepted the cancellation, so it is now safe to record it.
  const upd = { auto_renewal: 0, cancel_at_period_end: 1, cancelled_at: new Date() };
  if (isTrial || !cycleEnd) upd.status = 'cancelled';
  await updateRow(db, row.id, upd);
  return { ...row, ...upd };
}

function sendCancelError(res, err) {
  if (err.http) return res.status(err.http).json({ message: err.message });
  console.error('payments.cancel failed:', err.code || err.message);
  return res.status(500).json({ message: 'Could not cancel your subscription.' });
}

async function cancel(req, res) {
  try {
    const atCycleEnd = !(req.body && req.body.atCycleEnd === false);
    const row = await performCancel(uid(req), atCycleEnd);
    res.json({ subscription: toApi(row) });
  } catch (err) {
    sendCancelError(res, err);
  }
}

async function autoRenewal(req, res) {
  const want = req.body && req.body.autoRenewal;
  if (typeof want !== 'boolean') return res.status(400).json({ message: 'Invalid request.' });
  try {
    if (!want) {
      const row = await performCancel(uid(req), true);
      return res.json({ subscription: toApi(row) });
    }
    const row = await settleRow(await latestRow(uid(req)));
    if (row && row.cancelled_at) {
      return res.status(409).json({
        message: 'A cancelled subscription cannot be switched back on. Start a new subscription after your access ends.',
      });
    }
    res.json({ subscription: toApi(row) });
  } catch (err) {
    sendCancelError(res, err);
  }
}

// ---------- webhook ----------

async function handleEvent(conn, body) {
  const payload = body.payload || {};
  const subEntity = payload.subscription && payload.subscription.entity;
  const payEntity = payload.payment && payload.payment.entity;
  const rzpSubId = (subEntity && subEntity.id) || (payEntity && payEntity.subscription_id) || null;
  if (!rzpSubId) return;

  const [rows] = await conn.query('SELECT * FROM subscriptions WHERE rzp_subscription_id = ? LIMIT 1 FOR UPDATE', [
    rzpSubId,
  ]);
  const row = rows[0];
  if (!row) return;

  switch (body.event) {
    case 'subscription.authenticated':
    case 'subscription.activated':
    case 'subscription.pending':
    case 'subscription.halted':
    case 'subscription.cancelled':
    case 'subscription.completed':
    case 'subscription.updated':
      if (subEntity) await applySubscriptionState(conn, row, subEntity);
      break;
    case 'subscription.charged': {
      const current = subEntity ? await applySubscriptionState(conn, row, subEntity) : row;
      if (payEntity) await recordPayment(conn, current, payEntity);
      break;
    }
    case 'payment.failed':
      if (payEntity) await recordPayment(conn, row, payEntity, 'failed');
      break;
    default:
      break;
  }
  return row.user_id;
}

// Mounted with express.raw() BEFORE express.json(), so req.body is the exact
// bytes Razorpay signed.
async function webhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ message: 'Webhook is not configured.' });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ message: 'Invalid body.' });

  const signature = req.get('x-razorpay-signature') || '';
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (!safeEqual(expected, signature)) return res.status(400).json({ message: 'Invalid signature.' });

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ message: 'Invalid JSON.' });
  }
  const eventId = req.get('x-razorpay-event-id');
  if (!eventId) return res.status(400).json({ message: 'Missing event id.' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    try {
      await conn.query('INSERT INTO razorpay_webhook_events (event_id, event_type) VALUES (?, ?)', [
        eventId,
        String(body.event || '').slice(0, 60),
      ]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        await conn.rollback();
        return res.json({ status: 'duplicate' });
      }
      throw err;
    }
    const affectedUser = await handleEvent(conn, body);
    await conn.commit();
    res.json({ status: 'ok' });
    // After replying: make sure a switched-away plan is really cancelled at Razorpay.
    if (affectedUser) retireOthers(affectedUser);
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('webhook failed:', err.code || err.message);
    // A non-2xx reply makes Razorpay retry later.
    res.status(500).json({ message: 'Webhook processing failed.' });
  } finally {
    conn.release();
  }
}

module.exports = { me, terms, checkout, verify, cancel, autoRenewal, webhook };