// Single place for the rules the profile API enforces.
const RESERVED_USERNAMES = new Set([
  'admin', 'api', 'login', 'logout', 'signup', 'register', 'pricing',
  'dashboard', 'profile', 'settings', 'u', 'www', 'support', 'help',
  'about', 'terms', 'privacy', 'mlink', 'static', 'uploads', 'assets',
  'root', 'null', 'undefined',
]);

// Keep in sync with CATEGORIES in ProfileWizard.js and src/Data/templates.js
const CATEGORIES = [
  'fashion', 'doctor', 'business', 'technology', 'education',
  'creator', 'photography', 'fitness', 'music', 'other',
];

const PLATFORMS = ['instagram', 'linkedin', 'facebook', 'youtube', 'x', 'github', 'other'];

// A link for these platforms must point at one of these domains.
const PLATFORM_HOSTS = {
  instagram: ['instagram.com'],
  linkedin: ['linkedin.com'],
  facebook: ['facebook.com', 'fb.com'],
  youtube: ['youtube.com', 'youtu.be'],
  x: ['x.com', 'twitter.com'],
  github: ['github.com'],
};

module.exports = { RESERVED_USERNAMES, CATEGORIES, PLATFORMS, PLATFORM_HOSTS };