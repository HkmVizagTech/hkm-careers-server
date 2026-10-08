const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { list, unreadCount, markRead, markAllRead } = require('../controllers/notificationController');

router.get('/', auth, list);
router.get('/unread-count', auth, unreadCount);
router.post('/read-all', auth, markAllRead);
router.post('/:id/read', auth, markRead);

module.exports = router;
