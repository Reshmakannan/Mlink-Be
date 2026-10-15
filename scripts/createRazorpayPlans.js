require('dotenv').config();
const { getClient, PLANS } = require('../src/config/razorpay');

(async () => {
  const razorpay = getClient();
  for (const [key, p] of Object.entries(PLANS)) {
    const plan = await razorpay.plans.create({
      period: p.period,
      interval: p.interval,
      item: {
        name: `MLink ${p.label}`,
        amount: p.price * 100,
        currency: 'INR',
        description: `MLink ${p.label} plan (${key})`,
      },
    });
    console.log(`${p.envKey}=${plan.id}`);
  }
})().catch((err) => {
  console.error('Failed:', (err && err.error && err.error.description) || err.message);
  process.exit(1);
});