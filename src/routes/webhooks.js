const express = require('express');
const router = express.Router();
const { gupshupWebhook } = require('../controllers/webhookController');

// Public — protected by the shared secret token in the query string.
router.post('/gupshup', gupshupWebhook);

module.exports = router;
