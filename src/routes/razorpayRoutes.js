const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/Authmiddleware');
const ctrl = require('../controllers/razorpayController');

const router = express.Router();

router.use(auth);
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please slow down.' },
  })
);

router.get('/me', ctrl.me);
router.get('/terms', ctrl.terms);
router.post('/checkout', ctrl.checkout);
router.post('/verify', ctrl.verify);
router.put('/cancel', ctrl.cancel);
router.put('/auto-renewal', ctrl.autoRenewal);

// The old endpoint started a trial without any payment. It is closed.
router.post('/sub', (req, res) =>
  res.status(410).json({ message: 'Please start your trial through the payment window.' })
);

module.exports = router;