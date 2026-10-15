const Razorpay = require('razorpay');

let client = null;
function getClient() {
  if (!client) {
    const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      throw new Error('Razorpay keys are missing from .env');
    }
    client = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
  }
  return client;
}

// Prices here are the source of truth for charging. Keep them equal to the
// prices shown in Pricing.js. totalCount = how many billing cycles Razorpay
// may charge before the subscription completes (about 5 years here).
const PLANS = {
  monthly: { label: 'Monthly', price: 299, period: 'monthly', interval: 1, totalCount: 60, billing: 'every month', envKey: 'RAZORPAY_PLAN_MONTHLY' },
  '3_months': { label: '3 Months', price: 799, period: 'monthly', interval: 3, totalCount: 20, billing: 'every 3 months', envKey: 'RAZORPAY_PLAN_3_MONTHS' },
  '6_months': { label: '6 Months', price: 1499, period: 'monthly', interval: 6, totalCount: 10, billing: 'every 6 months', envKey: 'RAZORPAY_PLAN_6_MONTHS' },
  '1_year': { label: '1 Year', price: 2499, period: 'yearly', interval: 1, totalCount: 5, billing: 'every year', envKey: 'RAZORPAY_PLAN_1_YEAR' },
};

const trialDays = Number(process.env.TRIAL_DAYS);
const trialFee = Number(process.env.TRIAL_FEE_PAISE);
const TRIAL_DAYS = trialDays > 0 ? trialDays : 3;
const TRIAL_FEE_PAISE = trialFee > 0 ? trialFee : 100;

const planIdFor = (planType) => (PLANS[planType] ? process.env[PLANS[planType].envKey] || null : null);

module.exports = { getClient, PLANS, TRIAL_DAYS, TRIAL_FEE_PAISE, planIdFor };