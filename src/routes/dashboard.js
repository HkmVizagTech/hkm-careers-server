const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Job = require('../models/Job');
const Application = require('../models/Application');
const { istDateKey } = require('../utils/dates');

router.get('/stats', auth, async (req, res, next) => {
  try {
    const [openPositions, totalApplications, pendingReviews, recentApplications, applicationsByStatus] =
      await Promise.all([
        Job.countDocuments({ status: 'active' }),
        Application.countDocuments(),
        Application.countDocuments({ status: 'received' }),
        Application.find()
          .populate('job', 'title')
          .sort({ createdAt: -1 })
          .limit(10),
        Application.aggregate([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
      ]);

    res.json({
      openPositions,
      totalApplications,
      pendingReviews,
      recentApplications,
      applicationsByStatus: applicationsByStatus.map((s) => ({
        status: s._id,
        count: s.count,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// "Needs attention" panel: unreviewed applications, upcoming interviews, closing jobs, due follow-ups.
router.get('/attention', auth, async (req, res, next) => {
  try {
    const DAY = 24 * 60 * 60 * 1000;
    const now = new Date();
    const unreviewedDays = Number(process.env.UNREVIEWED_AFTER_DAYS) > 0 ? Number(process.env.UNREVIEWED_AFTER_DAYS) : 3;
    const cutoff = new Date(now.getTime() - unreviewedDays * DAY);
    const endOfToday = new Date(`${istDateKey(now)}T23:59:59.999+05:30`);

    const [unreviewedCount, unreviewed, interviews, closingJobs, followUpApps] = await Promise.all([
      Application.countDocuments({ status: 'received', createdAt: { $lte: cutoff } }),
      Application.find({ status: 'received', createdAt: { $lte: cutoff } })
        .select('name applicationNumber createdAt job')
        .populate('job', 'title')
        .sort({ createdAt: 1 })
        .limit(5),
      Application.find({
        'interview.scheduledAt': { $gte: new Date(now.getTime() - 2 * 60 * 60 * 1000), $lte: new Date(now.getTime() + 7 * DAY) },
        status: { $nin: ['rejected', 'selected'] },
      })
        .select('name applicationNumber interview job')
        .populate('job', 'title')
        .sort({ 'interview.scheduledAt': 1 })
        .limit(10),
      Job.find({ status: 'active', deadline: { $gt: now, $lte: new Date(now.getTime() + 7 * DAY) } })
        .select('title deadline applicationCount')
        .sort({ deadline: 1 }),
      Application.find({ followUps: { $elemMatch: { done: false, dueAt: { $lte: endOfToday } } } })
        .select('name applicationNumber followUps'),
    ]);

    const followUps = followUpApps
      .flatMap((a) =>
        a.followUps
          .filter((f) => !f.done && f.dueAt <= endOfToday)
          .map((f) => ({
            _id: f._id,
            applicationId: a._id,
            name: a.name,
            applicationNumber: a.applicationNumber,
            note: f.note,
            dueAt: f.dueAt,
            overdue: f.dueAt < now,
          }))
      )
      .sort((x, y) => new Date(x.dueAt) - new Date(y.dueAt))
      .slice(0, 10);

    res.json({ unreviewedDays, unreviewedCount, unreviewed, interviews, closingJobs, followUps });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
