const db = require('../config/db');
const { TRIAL_LINK_LIMIT } = require('../config/planFeatures');

const MAX_LINKS = 20;
const LABEL_MAX = 60;

const ICONS = new Set([
  'youtube', 'instagram', 'tiktok', 'x', 'facebook', 'linkedin', 'github',
  'website', 'email', 'phone', 'location', 'shop', 'calendar', 'music',
  'video', 'file', 'other',
]);

// These already appear as social icons from the profile wizard, so they
// are not offered again as custom link buttons.
const SOCIAL_ICONS = new Set(['instagram', 'linkedin', 'facebook', 'youtube', 'x', 'github']);

const uid = (req) => req.user.id;
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function normalizeUrl(raw) {
  let v = str(raw);
  if (!v || v.length > 255) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    const out = u.toString();
    return out.length <= 255 ? out : null;
  } catch {
    return null;
  }
}
// The limit comes from the database, never from the browser.
async function linkLimitFor(userId) {
  const [rows] = await db.query(
    'SELECT status FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  );
  const trial = !!rows[0] && rows[0].status === 'trialing';
  return { limit: trial ? TRIAL_LINK_LIMIT : MAX_LINKS, trial };
}

async function ownedProfileId(userId) {
  const [rows] = await db.query('SELECT id FROM profiles WHERE user_id = ? LIMIT 1', [userId]);
  return rows[0] ? rows[0].id : null;
}

function validate(body = {}) {
  const errors = {};
  const icon = str(body.icon).toLowerCase();
  const label = str(body.label).slice(0, LABEL_MAX);
  const url = normalizeUrl(body.url);

  if (!ICONS.has(icon) || SOCIAL_ICONS.has(icon)) errors.icon = 'Choose a valid icon.';
  if (!label) errors.label = 'Enter a label for this button.';
  if (!url) errors.url = 'Enter a valid link.';

  return { errors, values: { icon, label, url } };
}

async function list(req, res) {
  try {
    const { limit, trial } = await linkLimitFor(uid(req));
    const profileId = await ownedProfileId(uid(req));
    if (!profileId) return res.json({ links: [], limit, trial });
    const [rows] = await db.query(
      'SELECT id, icon, label, url, is_active, sort_order FROM links WHERE profile_id = ? ORDER BY sort_order, id',
      [profileId]
    );
    res.json({ links: rows, limit, trial });
  } catch (err) {
    console.error('links.list failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not load your links.' });
  }
}

async function create(req, res) {
  const { errors, values } = validate(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).json({ message: 'Please fix the highlighted fields.', errors });
  }
  try {
    const profileId = await ownedProfileId(uid(req));
    if (!profileId) return res.status(409).json({ message: 'Save your personal details first.' });

    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM links WHERE profile_id = ?', [profileId]);
    const { limit, trial } = await linkLimitFor(uid(req));
    if (n >= limit) {
      return res.status(403).json({
        message: trial
          ? 'Your free trial includes 1 link. More links unlock when your trial ends and your plan starts.'
          : `You can add up to ${limit} links.`,
      });
    }

    await db.query(
      'INSERT INTO links (profile_id, icon, label, url, sort_order) VALUES (?, ?, ?, ?, ?)',
      [profileId, values.icon, values.label, values.url, n]
    );
    return list(req, res);
  } catch (err) {
    console.error('links.create failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not save this link.' });
  }
}

async function update(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid link.' });

  const body = req.body || {};
  const patch = [];
  const args = [];

  if (typeof body.is_active === 'boolean') {
    patch.push('is_active = ?');
    args.push(body.is_active ? 1 : 0);
  }
  if (body.icon !== undefined || body.label !== undefined || body.url !== undefined) {
    const { errors, values } = validate({
      icon: body.icon,
      label: body.label,
      url: body.url,
    });
    if (Object.keys(errors).length) {
      return res.status(400).json({ message: 'Please fix the highlighted fields.', errors });
    }
    patch.push('icon = ?, label = ?, url = ?');
    args.push(values.icon, values.label, values.url);
  }
  if (!patch.length) return res.status(400).json({ message: 'Nothing to update.' });

  try {
    const profileId = await ownedProfileId(uid(req));
    if (!profileId) return res.status(404).json({ message: 'Link not found.' });

    const [result] = await db.query(
      `UPDATE links SET ${patch.join(', ')} WHERE id = ? AND profile_id = ?`,
      [...args, id, profileId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Link not found.' });
    return list(req, res);
  } catch (err) {
    console.error('links.update failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not update this link.' });
  }
}

async function remove(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid link.' });
  try {
    const profileId = await ownedProfileId(uid(req));
    if (!profileId) return res.status(404).json({ message: 'Link not found.' });

    const [result] = await db.query('DELETE FROM links WHERE id = ? AND profile_id = ?', [id, profileId]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Link not found.' });
    return list(req, res);
  } catch (err) {
    console.error('links.remove failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not delete this link.' });
  }
}

async function reorder(req, res) {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
  if (!ids || !ids.every((n) => Number.isInteger(n)) || ids.length > MAX_LINKS) {
    return res.status(400).json({ message: 'Invalid order.' });
  }

  let conn;
  try {
    const profileId = await ownedProfileId(uid(req));
    if (!profileId) return res.status(409).json({ message: 'Save your personal details first.' });

    const [owned] = await db.query('SELECT id FROM links WHERE profile_id = ?', [profileId]);
    const ownedIds = new Set(owned.map((r) => r.id));
    if (ids.length !== ownedIds.size || !ids.every((id) => ownedIds.has(id))) {
      return res.status(400).json({ message: 'Invalid order.' });
    }

    conn = await db.getConnection();
    await conn.beginTransaction();
    for (let i = 0; i < ids.length; i += 1) {
      await conn.query('UPDATE links SET sort_order = ? WHERE id = ? AND profile_id = ?', [i, ids[i], profileId]);
    }
    await conn.commit();
    return list(req, res);
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('links.reorder failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not reorder your links.' });
  } finally {
    if (conn) conn.release();
  }
}

module.exports = { list, create, update, remove, reorder, ICONS, SOCIAL_ICONS, MAX_LINKS };