const db = require('../config/db');

const USERNAME_RE = /^[a-z0-9_]{3,30}$/;

function parseCustomization(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

// Public route: no auth, no user-supplied filtering beyond the username itself.
async function getByUsername(req, res) {
  const username = String(req.params.username || '').toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return res.status(404).json({ message: 'Page not found.' });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, full_name, username, bio, location, photo_url, template_id, customization
         FROM profiles
        WHERE username = ? AND is_published = 1
        LIMIT 1`,
      [username]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ message: 'This page is not available.' });

    const [socials] = await db.query(
      'SELECT platform, label, url FROM social_links WHERE profile_id = ? ORDER BY sort_order, id',
      [row.id]
    );
    const [links] = await db.query(
      'SELECT id, icon, label, url FROM links WHERE profile_id = ? AND is_active = 1 ORDER BY sort_order, id',
      [row.id]
    );

    res.json({
      profile: {
        full_name: row.full_name,
        username: row.username,
        bio: row.bio,
        location: row.location,
        photo_url: row.photo_url,
        template_id: row.template_id,
        customization: parseCustomization(row.customization),
        socials,
        links,
      },
    });
  } catch (err) {
    console.error('public.getByUsername failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not load this page.' });
  }
}

module.exports = { getByUsername };