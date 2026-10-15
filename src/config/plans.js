// backend/config/plans.js

const TRIAL_DAYS = 3;

const PLANS = {
  monthly: {
    label: 'Monthly',
    price: 299,
    durationDays: 30,
  },

  '3_months': {
    label: '3 Months',
    price: 799,
    durationDays: 90,
  },

  '6_months': {
    label: '6 Months',
    price: 1499,
    durationDays: 180,
  },

  '1_year': {
    label: '1 Year',
    price: 2499,
    durationDays: 365,
  },
};

module.exports = {
  PLANS,
  TRIAL_DAYS,
};