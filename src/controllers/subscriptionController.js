// Place at: backend/controllers/subscriptionController.js
//
// Assumes your existing auth middleware attaches the logged-in user as req.user,
// with an id field (e.g. req.user.id). If your middleware names it differently
// (req.user.userId, req.userId, etc.), adjust the three `req.user.id` reads below —
// nothing else here needs to change.

const subscriptionModel = require('../models/subscriptionModel');
const { PLANS, TRIAL_DAYS } = require('../config/plans');

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// Lazily brings a stored row's status in line with the current date, without
// needing a cron job: trial -> active on trial end, active -> renewed or
// expired on period end (based on auto_renewal). Persists any change it makes.
async function refreshStatus(subscription) {
  if (!subscription) return null;
  const now = new Date();

  if (
    subscription.status === 'trialing' &&
    now >= new Date(subscription.trial_end_date)
  ) {
    if (subscription.auto_renewal) {
      const start = new Date(subscription.trial_end_date);
      const plan = PLANS[subscription.plan_type];
      const end = addDays(start, plan.durationDays);
      return subscriptionModel.updateFields(subscription.id, {
        status: 'active',
        subscription_start_date: start,
        subscription_end_date: end,
      });
    }
    return subscriptionModel.updateFields(subscription.id, {
      status: 'expired',
    });
  }

  if (
    subscription.status === 'active' &&
    subscription.subscription_end_date &&
    now >= new Date(subscription.subscription_end_date)
  ) {
    if (subscription.auto_renewal) {
      const plan = PLANS[subscription.plan_type];
      const start = new Date(subscription.subscription_end_date);
      const end = addDays(start, plan.durationDays);
      // Auto-debit point: charge subscription.price via your payment
      // provider here before extending the period, if/when one is wired up.
      return subscriptionModel.updateFields(subscription.id, {
        subscription_start_date: start,
        subscription_end_date: end,
      });
    }
    return subscriptionModel.updateFields(subscription.id, {
      status: 'expired',
    });
  }

  return subscription;
}

// POST /api/subscriptions
async function createSubscription(req, res) {
  try {
    const { planType } = req.body;
    const plan = PLANS[planType];
    if (!plan) {
      return res.status(400).json({ message: 'Invalid plan type.' });
    }

    const existing = await subscriptionModel.findLatestByUserId(req.user.id);
    if (existing && ['trialing', 'active'].includes(existing.status)) {
      return res.status(409).json({
        message: 'You already have a subscription in progress.',
        subscription: existing,
      });
    }

    const trialStartDate = new Date();
    const trialEndDate = addDays(trialStartDate, TRIAL_DAYS);

    const subscription = await subscriptionModel.create({
      userId: req.user.id,
      planType,
      price: plan.price,
      trialStartDate,
      trialEndDate,
    });

    res.status(201).json({ subscription });
  } catch (err) {
    console.error('createSubscription error:', err);
    res.status(500).json({ message: 'Could not start subscription.' });
  }
}

// GET /api/subscriptions/me
async function getMySubscription(req, res) {
  try {
    const latest = await subscriptionModel.findLatestByUserId(req.user.id);
    const subscription = await refreshStatus(latest);
    res.json({ subscription });
  } catch (err) {
    console.error('getMySubscription error:', err);
    res.status(500).json({ message: 'Could not load subscription.' });
  }
}

// PUT /api/subscriptions/cancel

async function cancelSubscription(req, res) {
  try {
    const latest = await subscriptionModel.findLatestByUserId(req.user.id);
    const current = await refreshStatus(latest);

    if (!current || !['trialing', 'active'].includes(current.status)) {
      return res.status(400).json({
        message: 'No active subscription to cancel.',
      });
    }

    // Your MySQL row must contain the real Razorpay subscription ID.
    const razorpaySubscriptionId = current.razorpay_subscription_id;

    if (!razorpaySubscriptionId) {
      return res.status(400).json({
        message:
          'Razorpay subscription ID is missing. Cannot confirm cancellation. Please check your subscription creation and database storage.',
      });
    }

    const razorpay = require('../config/razorpay');

    const { atCycleEnd = true } = req.body;

    // Call Razorpay before updating MySQL.
    const razorpayResult = await razorpay.subscriptions.cancel(
      razorpaySubscriptionId,
      atCycleEnd
    );

    console.log('Razorpay cancellation response:', razorpayResult);

    // Only update the database after Razorpay accepts the cancellation.
    const now = new Date();

    const subscription = await subscriptionModel.updateFields(current.id, {
      status: 'cancelled',
      auto_renewal: 0,
      cancelled_at: now,
      subscription_end_date: atCycleEnd
        ? current.subscription_end_date || current.trial_end_date
        : now,
    });

    return res.json({ subscription });
  } catch (err) {
    console.error(
      'Razorpay cancellation failed:',
      err.statusCode || err.status,
      err.error || err.message
    );

    return res.status(err.statusCode || 500).json({
      message:
        err.error?.description ||
        err.message ||
        'Could not cancel the Razorpay subscription.',
    });
  }
}

// PUT /api/subscriptions/auto-renewal
async function updateAutoRenewal(req, res) {
  try {
    const { autoRenewal } = req.body;
    const latest = await subscriptionModel.findLatestByUserId(req.user.id);
    const current = await refreshStatus(latest);

    if (!current || !['trialing', 'active'].includes(current.status)) {
      return res.status(400).json({ message: 'No active subscription to update.' });
    }

    const subscription = await subscriptionModel.updateFields(current.id, {
      auto_renewal: autoRenewal ? 1 : 0,
    });

    res.json({ subscription });
  } catch (err) {
    console.error('updateAutoRenewal error:', err);
    res.status(500).json({ message: 'Could not update auto-renewal.' });
  }
}

module.exports = {
  createSubscription,
  getMySubscription,
  cancelSubscription,
  updateAutoRenewal,
};