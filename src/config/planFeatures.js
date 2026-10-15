// What each plan unlocks. Keep in sync with PLAN_DISPLAY in Pricing.js.
const TEMPLATES_IN_LIBRARY = 20;
const TRIAL_LINK_LIMIT = 1; // links a user can create during the free trial

const TEMPLATES_PER_CATEGORY = {
  free: 3, // no live plan (cancelled / expired / payment failed)
  monthly: 5,
  '3_months': 10,
  '6_months': 15,
  '1_year': 20,
};

const isTrialing = (sub) => !!sub && sub.status === 'trialing';
const isLive = (sub) => !!sub && ['trialing', 'active'].includes(sub.status);

function templateLimitFor(sub) {
  if (isTrialing(sub)) return TEMPLATES_IN_LIBRARY; // trial = all features
  if (!isLive(sub)) return TEMPLATES_PER_CATEGORY.free;
  return TEMPLATES_PER_CATEGORY[sub.plan_type] || TEMPLATES_PER_CATEGORY.free;
}

// Customize step: which option keys each plan unlocks. No live plan = none.
const CUSTOMIZE_FIELDS = {
  monthly: [],
  '3_months': ['background', 'buttonStyle'],
  '6_months': ['background', 'buttonStyle', 'font', 'iconStyle', 'backgroundImage', 'bgOverlay'],
  '1_year': [
    'background', 'buttonStyle', 'font', 'iconStyle', 'layout', 'accentColor', 'avatarShape',
    'backgroundImage', 'bgOverlay',
  ],
};

function customizeFieldsFor(sub) {
  if (isTrialing(sub)) return CUSTOMIZE_FIELDS['1_year']; // trial = all features
  if (!isLive(sub)) return [];
  return CUSTOMIZE_FIELDS[sub.plan_type] || [];
}

module.exports = {
  TEMPLATES_IN_LIBRARY,
  TRIAL_LINK_LIMIT,
  TEMPLATES_PER_CATEGORY,
  templateLimitFor,
  CUSTOMIZE_FIELDS,
  customizeFieldsFor,
};