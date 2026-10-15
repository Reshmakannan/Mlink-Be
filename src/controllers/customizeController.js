const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/db');
const { customizeFieldsFor } = require('../config/planFeatures');

const uid = (req) => req.user.id;

const FIELD_VALUES = {
  background: ['default', 'soft', 'dark', 'gradient'],
  buttonStyle: ['pill', 'soft', 'square'],
  font: ['sans', 'serif'],
  iconStyle: ['circle', 'rounded', 'square'],
  layout: ['center', 'left', 'banner', 'card'],
  avatarShape: ['circle', 'rounded', 'square'],
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Background image uploads live here, served at /uploads/background/<file>.
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'background');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Must match exactly what uploadBackground() generates, so save() can't be
// tricked into pointing a profile at an arbitrary path.
const BG_URL_RE = /^\/uploads\/background\/[a-f0-9]{32}\.(jpg|png|webp)$/;

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

function removeBackgroundFile(url) {
  if (!url || !BG_URL_RE.test(url)) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(url)), () => {});
}

async function currentSubscription(userId) {
  const [rows] = await db.query(
    'SELECT plan_type, status FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

async function ownedProfileRow(userId) {
  const [rows] = await db.query('SELECT id, customization FROM profiles WHERE user_id = ? LIMIT 1', [userId]);
  return rows[0] || null;
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

async function getAccess(req, res) {
  try {
    const sub = await currentSubscription(uid(req));
    const profile = await ownedProfileRow(uid(req));
    res.json({
      fields: customizeFieldsFor(sub),
      plan_type: sub ? sub.plan_type : null,
      customization: profile ? parseCustomization(profile.customization) : {},
    });
  } catch (err) {
    console.error('customize.getAccess failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not load your customization options.' });
  }
}

async function save(req, res) {
  const body = req.body && typeof req.body.customization === 'object' ? req.body.customization : null;
  if (!body) return res.status(400).json({ message: 'Invalid customization.' });

  try {
    // The plan is read from the database, never trusted from the browser.
    const sub = await currentSubscription(uid(req));
    const allowed = new Set(customizeFieldsFor(sub));

    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) {
        return res.status(403).json({ message: `Your plan does not include the "${key}" option.` });
      }
      const value = body[key];

      if (key === 'accentColor') {
        if (typeof value !== 'string' || !HEX_RE.test(value)) {
          return res.status(400).json({ message: 'Enter a valid color.' });
        }
      } else if (key === 'backgroundImage') {
        // '' clears it; otherwise it must be a URL this endpoint itself produced.
        if (value !== '' && (typeof value !== 'string' || !BG_URL_RE.test(value))) {
          return res.status(400).json({ message: 'Upload a background image first.' });
        }
      } else if (key === 'bgOverlay') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 90) {
          return res.status(400).json({ message: 'Overlay must be between 0 and 90.' });
        }
        body[key] = Math.round(n);
      } else if (!FIELD_VALUES[key] || !FIELD_VALUES[key].includes(value)) {
        return res.status(400).json({ message: `Invalid value for "${key}".` });
      }
    }

    const profile = await ownedProfileRow(uid(req));
    if (!profile) return res.status(409).json({ message: 'Save your personal details first.' });

    const existing = parseCustomization(profile.customization);
    const merged = { ...existing, ...body };

    // drop anything that isn't currently allowed, in case the plan changed since it was saved
    Object.keys(merged).forEach((k) => {
      if (!allowed.has(k)) delete merged[k];
    });

    // If the background image changed or was cleared, delete the old file
    // from disk so uploads don't pile up.
    if (Object.prototype.hasOwnProperty.call(body, 'backgroundImage')) {
      const oldUrl = existing.backgroundImage;
      const newUrl = merged.backgroundImage;
      if (oldUrl && oldUrl !== newUrl) removeBackgroundFile(oldUrl);
      if (!newUrl) delete merged.backgroundImage;
    }
    if (!merged.backgroundImage) delete merged.bgOverlay;

    await db.query('UPDATE profiles SET customization = ? WHERE id = ?', [JSON.stringify(merged), profile.id]);
    res.json({ customization: merged });
  } catch (err) {
    console.error('customize.save failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not save your customization.' });
  }
}

async function uploadBackground(req, res) {
  if (!req.file) return res.status(400).json({ message: 'Choose an image to upload.' });

  const ext = detectImage(req.file.buffer);
  if (!ext) return res.status(400).json({ message: 'Use a JPG, PNG or WebP image.' });

  try {
    // Must be on a plan that actually includes this feature.
    const sub = await currentSubscription(uid(req));
    const allowed = new Set(customizeFieldsFor(sub));
    if (!allowed.has('backgroundImage')) {
      return res.status(403).json({ message: 'Background images are available on Premium plans.' });
    }

    const profile = await ownedProfileRow(uid(req));
    if (!profile) return res.status(409).json({ message: 'Save your personal details first.' });

    const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), req.file.buffer, { flag: 'wx' });

    res.json({ url: `/uploads/background/${filename}` });
  } catch (err) {
    console.error('customize.uploadBackground failed:', err.code || err.message);
    res.status(500).json({ message: 'Could not upload your background image.' });
  }
}

module.exports = { getAccess, save, uploadBackground };