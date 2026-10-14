const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const C = require('../controllers/jobAlertController');

/** Per-IP limit on sign-ups (10 per 10 minutes) so the form can't be used to flood inboxes. */
const hits = new Map();
function limit(req, res, next) {
  const now = Date.now();
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ message: 'Too many attempts. Please try again in a few minutes.' });
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  next();
}

// Public
router.post('/subscribe', limit, C.subscribe);
router.post('/confirm', C.confirm);
router.get('/manage/:token', C.getManage);
router.put('/manage/:token', C.updateManage);
router.post('/unsubscribe', C.unsubscribe);

// Admin
router.get('/', auth, C.list);
router.delete('/:id', auth, C.remove);

module.exports = router;
