const db = require('../config/db');
const { CATEGORIES } = require('../config/profileRules');
const { TEMPLATES_IN_LIBRARY, templateLimitFor } = require('../config/planFeatures');

// Same as in profileController.js. The user id comes from the verified token only.
const uid = (req) => req.user.id;

const TEMPLATE_ID_RE = /^([a-z]+)-(\d{2})$/;

// ASSUMPTION: table `subscriptions` has columns id, user_id, plan_type, status.
async function currentSubscription(userId) {
  const [rows] = await db.query(
    'SELECT plan_type, status FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

async function getAccess(req, res) {
  try {
    const sub = await currentSubscription(uid(req));
    res.json({
      templates_per_category: templateLimitFor(sub),
      library_size: TEMPLATES_IN_LIBRARY,
      plan_type: sub ? sub.plan_type : null,
      status: sub ? sub.status : null,
    });
  } catch (err) {
    console.error('getAccess failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not load your plan.' });
  }
}

async function saveTemplate(req, res) {
  const raw = req.body && req.body.template_id;
  const id = typeof raw === 'string' ? raw.trim() : '';
  const m = TEMPLATE_ID_RE.exec(id);
  const index = m ? parseInt(m[2], 10) : 0;

  if (!m || !CATEGORIES.includes(m[1]) || index < 1 || index > TEMPLATES_IN_LIBRARY) {
    return res.status(400).json({ message: 'Choose a valid template.' });
  }

  try {
    // The plan is read from the database, never from the browser.
    const sub = await currentSubscription(uid(req));
    const limit = templateLimitFor(sub);
    if (index > limit) {
      return res.status(403).json({
        message: `Your plan includes the first ${limit} templates in each category. Upgrade to use this one.`,
      });
    }

    const [rows] = await db.query('SELECT id FROM profiles WHERE user_id = ? LIMIT 1', [uid(req)]);
    if (!rows[0]) return res.status(409).json({ message: 'Save your personal details first.' });

    await db.query('UPDATE profiles SET template_id = ? WHERE id = ? AND user_id = ?', [
      id,
      rows[0].id,
      uid(req),
    ]);
    res.json({ template_id: id });
  } catch (err) {
    console.error('saveTemplate failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not save your template.' });
  }
}

module.exports = { getAccess, saveTemplate };