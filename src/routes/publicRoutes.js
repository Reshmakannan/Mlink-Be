const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/publicController');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down.' },
});

router.use(limiter);
router.get('/:username', ctrl.getByUsername);

module.exports = router;