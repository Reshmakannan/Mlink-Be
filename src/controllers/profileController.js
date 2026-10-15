const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/db'); // fixed: was './config/db'
const {
  RESERVED_USERNAMES,
  CATEGORIES,
  PLATFORMS,
  PLATFORM_HOSTS,
} = require('../config/profileRules');

// fixed: goes up to the project root, where server.js serves /uploads from
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'profile');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const USERNAME_RE = /^[a-z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;

// The user id ALWAYS comes from the verified token, never from the request body.
// If your auth middleware uses another property, change it here only.
const uid = (req) => req.user.id;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function normalizeUrl(raw) {
  let v = str(raw);
  if (!v || v.length > 255) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    // blocks javascript:, data:, file: etc.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    const out = u.toString();
    return out.length <= 255 ? out : null;
  } catch {
    return null;
  }
}

function hostAllowed(platform, hostname) {
  const list = PLATFORM_HOSTS[platform];
  if (!list) return true; // "other"
  const h = hostname.toLowerCase();
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

function detectImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (
    buf.length > 12 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    buf.length > 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

function removeFile(url) {
  if (!url) return;
  // basename() stops any path traversal
  fs.unlink(path.join(UPLOAD_DIR, path.basename(url)), () => {});
}

function parseCustomization(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

async function findProfileRow(userId) {
  const [rows] = await db.query('SELECT * FROM profiles WHERE user_id = ? LIMIT 1', [userId]);
  return rows[0] || null;
}

async function buildProfile(userId) {
  const row = await findProfileRow(userId);
  if (!row) return null;
  const [socials] = await db.query(
    'SELECT platform, label, url FROM social_links WHERE profile_id = ? ORDER BY sort_order, id',
    [row.id]
  );
  const [links] = await db.query(
    'SELECT id, icon, label, url, is_active FROM links WHERE profile_id = ? ORDER BY sort_order, id',
    [row.id]
  );
  return {
    full_name: row.full_name,
    username: row.username,
    bio: row.bio,
    email: row.email,
    phone: row.phone,
    location: row.location,
    website: row.website,
    photo_url: row.photo_url,
    category: row.category,
    template_id: row.template_id || null,
    customization: parseCustomization(row.customization),
    is_published: !!row.is_published,
    socials,
    links,
  };
}

function validateDetails(body = {}) {
  const errors = {};
  const v = {
    full_name: str(body.full_name),
    username: str(body.username).toLowerCase(),
    bio: str(body.bio),
    email: str(body.email),
    phone: str(body.phone),
    location: str(body.location),
    website: str(body.website),
  };

  if (v.full_name.length < 2 || v.full_name.length > 80) {
    errors.full_name = 'Enter your name (2–80 characters).';
  }
  if (!USERNAME_RE.test(v.username)) {
    errors.username = 'Use 3–30 lowercase letters, numbers or underscores.';
  } else if (RESERVED_USERNAMES.has(v.username)) {
    errors.username = 'That username is not available.';
  }
  if (v.bio.length > 300) errors.bio = 'Bio must be 300 characters or fewer.';
  if (v.email && (v.email.length > 254 || !EMAIL_RE.test(v.email))) {
    errors.email = 'Enter a valid email address.';
  }
  if (v.phone && !PHONE_RE.test(v.phone)) errors.phone = 'Enter a valid phone number.';
  if (v.location.length > 100) errors.location = 'Location must be 100 characters or fewer.';
  if (v.website) {
    const url = normalizeUrl(v.website);
    if (!url) errors.website = 'Enter a valid website URL.';
    else v.website = url;
  }
  return { errors, values: v };
}

function validateLinks(input) {
  if (!Array.isArray(input) || input.length > 10) return { error: 'Invalid social links.' };
  const seen = new Set();
  const links = [];
  for (const item of input) {
    const platform = str(item && item.platform).toLowerCase();
    if (!PLATFORMS.includes(platform)) return { error: 'Unsupported platform.' };
    if (platform !== 'other') {
      if (seen.has(platform)) return { error: `Only one ${platform} link is allowed.` };
      seen.add(platform);
    }
    const url = normalizeUrl(item.url);
    if (!url) return { error: `Enter a valid ${platform} URL.` };
    if (!hostAllowed(platform, new URL(url).hostname)) {
      return { error: `That doesn't look like a ${platform} link.` };
    }
    const label = platform === 'other' ? str(item.label).slice(0, 40) || 'Link' : '';
    links.push({ platform, label, url });
  }
  return { links };
}

// ---------- handlers ----------

async function getMe(req, res) {
  try {
    res.json({ profile: await buildProfile(uid(req)) });
  } catch (err) {
    console.error('getMe failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not load your profile.' });
  }
}

async function usernameAvailable(req, res) {
  const u = str(req.query.u).toLowerCase();
  if (!USERNAME_RE.test(u) || RESERVED_USERNAMES.has(u)) return res.json({ available: false });
  try {
    const [rows] = await db.query('SELECT user_id FROM profiles WHERE username = ? LIMIT 1', [u]);
    res.json({ available: rows.length === 0 || rows[0].user_id === uid(req) });
  } catch (err) {
    console.error('usernameAvailable failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not check the username.' });
  }
}

async function saveDetails(req, res) {
  const { errors, values } = validateDetails(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).json({ message: 'Please fix the highlighted fields.', errors });
  }
  const v = values;
  try {
    const existing = await findProfileRow(uid(req));
    if (existing) {
      await db.query(
        `UPDATE profiles
           SET full_name = ?, username = ?, bio = ?, email = ?, phone = ?, location = ?, website = ?
         WHERE id = ? AND user_id = ?`,
        [v.full_name, v.username, v.bio, v.email, v.phone, v.location, v.website, existing.id, uid(req)]
      );
    } else {
      await db.query(
        `INSERT INTO profiles (user_id, full_name, username, bio, email, phone, location, website)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uid(req), v.full_name, v.username, v.bio, v.email, v.phone, v.location, v.website]
      );
    }
    res.json({ profile: await buildProfile(uid(req)) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'That username is already taken.',
        errors: { username: 'That username is already taken.' },
      });
    }
    console.error('saveDetails failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not save your profile. Please try again.' });
  }
}

async function saveSocial(req, res) {
  const { links, error } = validateLinks(req.body && req.body.links);
  if (error) return res.status(400).json({ message: error, errors: { links: error } });

  let conn;
  try {
    const profile = await findProfileRow(uid(req));
    if (!profile) {
      return res.status(409).json({ message: 'Save your personal details first.' });
    }
    conn = await db.getConnection();
    await conn.beginTransaction();
    await conn.query('DELETE FROM social_links WHERE profile_id = ?', [profile.id]);
    if (links.length) {
      await conn.query(
        'INSERT INTO social_links (profile_id, platform, label, url, sort_order) VALUES ?',
        [links.map((l, i) => [profile.id, l.platform, l.label, l.url, i])]
      );
    }
    await conn.commit();
    res.json({ profile: await buildProfile(uid(req)) });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('saveSocial failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not save your social links.' });
  } finally {
    if (conn) conn.release();
  }
}

async function saveCategory(req, res) {
  const category = str(req.body && req.body.category).toLowerCase();
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ message: 'Choose a valid category.' });
  }
  try {
    const profile = await findProfileRow(uid(req));
    if (!profile) return res.status(409).json({ message: 'Save your personal details first.' });
    await db.query('UPDATE profiles SET category = ? WHERE id = ? AND user_id = ?', [
      category,
      profile.id,
      uid(req),
    ]);
    res.json({ profile: await buildProfile(uid(req)) });
  } catch (err) {
    console.error('saveCategory failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not save your category.' });
  }
}

async function uploadPhoto(req, res) {
  if (!req.file) return res.status(400).json({ message: 'Choose a photo to upload.' });
  // Trust the file's real bytes, not its name or the browser-supplied mime type.
  const ext = detectImage(req.file.buffer);
  if (!ext) return res.status(400).json({ message: 'Use a JPG, PNG or WebP image.' });

  try {
    const profile = await findProfileRow(uid(req));
    if (!profile) return res.status(409).json({ message: 'Save your personal details first.' });

    const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`; // random, never the user's filename
    await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), req.file.buffer, { flag: 'wx' });

    const url = `/uploads/profile/${filename}`;
    await db.query('UPDATE profiles SET photo_url = ? WHERE id = ? AND user_id = ?', [
      url,
      profile.id,
      uid(req),
    ]);
    removeFile(profile.photo_url);
    res.json({ photo_url: url });
  } catch (err) {
    console.error('uploadPhoto failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not upload your photo.' });
  }
}

async function setPublished(req, res) {
  const publish = !!(req.body && req.body.publish);
  try {
    const profile = await findProfileRow(uid(req));
    if (!profile) return res.status(409).json({ message: 'Save your personal details first.' });

    if (publish && (!profile.username || !profile.template_id)) {
      return res.status(400).json({
        message: 'Choose a template before publishing your page.',
      });
    }

    await db.query('UPDATE profiles SET is_published = ? WHERE id = ? AND user_id = ?', [
      publish ? 1 : 0,
      profile.id,
      uid(req),
    ]);
    res.json({ profile: await buildProfile(uid(req)) });
  } catch (err) {
    console.error('setPublished failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not update publish status.' });
  }
}

module.exports = {
  getMe,
  usernameAvailable,
  saveDetails,
  saveSocial,
  saveCategory,
  uploadPhoto,
  setPublished,
};