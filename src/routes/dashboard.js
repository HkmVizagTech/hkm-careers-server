const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Job = require('../models/Job');
const Application = require('../models/Application');

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

module.exports = router;
