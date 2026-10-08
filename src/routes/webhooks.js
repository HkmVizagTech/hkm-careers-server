const express = require('express');
const router = express.Router();
const { gupshupWebhook, gupshupWebhookCheck } = require('../controllers/webhookController');

// Public — protected by the shared secret token in the query string.
router.post('/gupshup', gupshupWebhook);
router.get('/gupshup', gupshupWebhookCheck); // URL validation when saving the webhook in Gupshup

module.exports = router;
