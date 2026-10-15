// Place at: backend/routes/subscriptionRoutes.js
//
// Import your existing JWT auth middleware here — replace the path/name below
// with whatever you already use to protect other logged-in-only routes.
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/Authmiddleware');
const subscriptionController = require('../controllers/subscriptionController');

router.post('/sub', authenticateToken, subscriptionController.createSubscription);
router.get('/me', authenticateToken, subscriptionController.getMySubscription);
router.put('/cancel', authenticateToken, subscriptionController.cancelSubscription);
router.put('/auto-renewal', authenticateToken, subscriptionController.updateAutoRenewal);

module.exports = router;