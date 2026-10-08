const { validationResult, body } = require('express-validator');
const Job = require('../models/Job');
const Notification = require('../models/Notification');
const { endOfDayIST } = require('../utils/dates');

/** Accept "YYYY-MM-DD" from the date picker (means end of that day, India time); "" clears it. */
function normalizeDeadline(body) {
  if (!('deadline' in body)) return null;
  const d = endOfDayIST(body.deadline);
  if (d === undefined) return 'Invalid application deadline';
  body.deadline = d; // Date or null
  return null;
}

const createValidation = [
  body('title').notEmpty().withMessage('Job title is required').trim(),
  body('department').notEmpty().withMessage('Department is required'),
  body('location').notEmpty().withMessage('Location is required').trim(),
  body('type')
    .isIn(['full-time', 'part-time', 'volunteer', 'intern'])
    .withMessage('Invalid job type'),
  body('description').notEmpty().withMessage('Description is required'),
];

const getAll = async (req, res, next) => {
  try {
    const { department, type, status, search, page = 1, limit = 10 } = req.query;
    const filter = {};

    // For public routes, only show active jobs
    if (!req.user) {
      filter.status = 'active';
      // Hide jobs whose deadline passed even before the reminder job gets to close them.
      filter.$or = [{ deadline: null }, { deadline: { $gt: new Date() } }];
    } else if (status) {
      filter.status = status;
    }

    if (department) filter.department = department;
    if (type) filter.type = type;
    if (search) {
      filter.title = { $regex: search, $options: 'i' };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Job.countDocuments(filter);
    const jobs = await Job.find(filter)
      .populate('department', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      jobs,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
};

const getBySlug = async (req, res, next) => {
  try {
    const job = await Job.findOne({ slug: req.params.slug }).populate('department', 'name');
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }
    res.json(job);
  } catch (error) {
    next(error);
  }
};

const getById = async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id).populate('department', 'name');
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }
    res.json(job);
  } catch (error) {
    next(error);
  }
};

const create = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const deadlineError = normalizeDeadline(req.body);
    if (deadlineError) return res.status(400).json({ message: deadlineError });
    req.body.postedBy = req.user._id;
    const job = await Job.create(req.body);
    await job.populate('department', 'name');
    res.status(201).json(job);
  } catch (error) {
    next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const deadlineError = normalizeDeadline(req.body);
    if (deadlineError) return res.status(400).json({ message: deadlineError });
    const job = await Job.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    }).populate('department', 'name');

    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const job = await Job.findByIdAndDelete(req.params.id);
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }
    await Notification.deleteMany({ job: job._id, application: null });
    res.json({ message: 'Job deleted successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = { getAll, getBySlug, getById, create, createValidation, update, remove };
