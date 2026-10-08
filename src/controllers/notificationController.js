const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const { runChecksIfStale } = require('../utils/adminAlerts');

const shape = (n, userId) => {
  const o = n.toObject ? n.toObject() : n;
  const read = (o.readBy || []).some((id) => String(id) === String(userId));
  delete o.readBy;
  return { ...o, read };
};

// GET /api/notifications?limit=20 -> { notifications, unreadCount }
const list = async (req, res, next) => {
  try {
    // Opening the bell also catches up on reminders if the background schedule hasn't run lately.
    await runChecksIfStale();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const [items, unreadCount] = await Promise.all([
      Notification.find().sort({ createdAt: -1 }).limit(limit),
      Notification.countDocuments({ readBy: { $ne: req.user._id } }),
    ]);
    res.json({ notifications: items.map((n) => shape(n, req.user._id)), unreadCount });
  } catch (error) {
    next(error);
  }
};

// GET /api/notifications/unread-count -> { unreadCount } (cheap poll)
const unreadCount = async (req, res, next) => {
  try {
    runChecksIfStale(); // fire and forget
    res.json({ unreadCount: await Notification.countDocuments({ readBy: { $ne: req.user._id } }) });
  } catch (error) {
    next(error);
  }
};

// POST /api/notifications/:id/read
const markRead = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Notification not found' });
    const n = await Notification.findByIdAndUpdate(
      req.params.id,
      { $addToSet: { readBy: req.user._id } },
      { new: true }
    );
    if (!n) return res.status(404).json({ message: 'Notification not found' });
    res.json(shape(n, req.user._id));
  } catch (error) {
    next(error);
  }
};

// POST /api/notifications/read-all
const markAllRead = async (req, res, next) => {
  try {
    await Notification.updateMany({ readBy: { $ne: req.user._id } }, { $addToSet: { readBy: req.user._id } });
    res.json({ unreadCount: 0 });
  } catch (error) {
    next(error);
  }
};

module.exports = { list, unreadCount, markRead, markAllRead };
