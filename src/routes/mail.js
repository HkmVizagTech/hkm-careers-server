const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { sendMail, isMailConfigured, transportKind, fromAddress } = require('../utils/mailer');
const { hrRecipients } = require('../utils/emailNotifications');
const { testEmail } = require('../utils/emailTemplates');

// GET /api/mail/status -> how email is set up (no secrets)
router.get('/status', auth, (req, res) => {
  res.json({
    configured: isMailConfigured(),
    via: transportKind(),
    from: fromAddress() || null,
    replyTo: process.env.MAIL_REPLY_TO || null,
    hrRecipients: hrRecipients(),
  });
});

// POST /api/mail/test { to? } -> sends a test email (defaults to the signed-in admin)
router.post('/test', auth, async (req, res, next) => {
  try {
    const to = String(req.body?.to || req.user.email || '').trim();
    const built = testEmail(req.user.name);
    const result = await sendMail({ to, ...built });
    res.status(result.ok ? 200 : 502).json({ ...result, to });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
