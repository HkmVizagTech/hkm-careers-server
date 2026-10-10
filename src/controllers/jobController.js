const { validationResult, body } = require('express-validator');
const Job = require('../models/Job');
const Notification = require('../models/Notification');
const Application = require('../models/Application');
const { notifyStatusChange } = require('../utils/notifications');

const OPEN_STATUSES = ['received', 'under-review', 'shortlisted', 'interview'];
const { endOfDayIST } = require('../utils/dates');

/** Accept "YYYY-MM-DD" from the date picker (means end of that day, India time); "" clears it. */
function normalizeDeadline(body) {
  if (!('deadline' in body)) return null;
  const d = endOfDayIST(body.deadline);
  if (d === undefined) return 'Invalid application deadline';
  body.deadline = d; // Date or null
  return null;
}

/** Tidy the free-text fields and the qualification checkboxes before saving. */
function normalizeContent(body) {
  for (const key of ['description', 'responsibilities', 'qualifications']) {
    if (typeof body[key] === 'string') {
      body[key] = body[key].replace(/\r\n?|[\u2028\u2029\u0085\v\f]/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    }
  }
  if ('qualificationTags' in body) {
    const seen = new Set();
    body.qualificationTags = (Array.isArray(body.qualificationTags) ? body.qualificationTags : [])
      .map((t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 80))
      .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
      .slice(0, 30);
  }
  if (body.descriptionFormat !== undefined && !['points', 'text'].includes(body.descriptionFormat)) delete body.descriptionFormat;
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

    normalizeContent(req.body);
    if (!req.body.description) return res.status(400).json({ message: 'Description is required' });
    const deadlineError = normalizeDeadline(req.body);
    if (deadlineError) return res.status(400).json({ message: deadlineError });
    if ('openings' in req.body) {
      const n = parseInt(req.body.openings, 10);
      req.body.openings = Number.isFinite(n) && n >= 1 ? Math.min(n, 500) : 1;
    }
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
    normalizeContent(req.body);
    if ('description' in req.body && !req.body.description) {
      return res.status(400).json({ message: 'Description is required' });
    }
    if ('openings' in req.body) {
      const n = parseInt(req.body.openings, 10);
      req.body.openings = Number.isFinite(n) && n >= 1 ? Math.min(n, 500) : 1;
    }
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

// GET /api/jobs/:id/pipeline -> { openings, selected, remaining, status }
const pipeline = async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id).select('title status openings');
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const [selected, remaining] = await Promise.all([
      Application.countDocuments({ job: job._id, status: 'selected' }),
      Application.countDocuments({ job: job._id, status: { $in: OPEN_STATUSES } }),
    ]);
    res.json({ jobId: job._id, title: job.title, status: job.status, openings: job.openings || 1, selected, remaining });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/jobs/:id/close-remaining { notify }
 * Closes the job and moves every applicant still in progress to "Not Selected".
 * With notify, each gets the Not Selected WhatsApp (sent in the background).
 */
const closeRemaining = async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id).select('title status');
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (job.status === 'active') await Job.updateOne({ _id: job._id }, { $set: { status: 'closed' } });

    const apps = await Application.find({ job: job._id, status: { $in: OPEN_STATUSES } }).select('name phone applicationNumber status');
    const ids = apps.map((a) => a._id);
    await Application.updateMany({ _id: { $in: ids }, status: { $in: OPEN_STATUSES } }, { $set: { status: 'rejected' } });

    const notify = req.body?.notify === true;
    res.json({ updated: ids.length, notified: notify ? ids.length : 0, jobClosed: true });

    if (notify && apps.length) {
      // One at a time so Gupshup isn't flooded; failures are logged on each application.
      (async () => {
        for (const a of apps) {
          a.status = 'rejected';
          await notifyStatusChange(a, job, 'rejected').catch((err) =>
            console.error('[jobs] close-remaining notify failed:', err.message)
          );
          await new Promise((r) => setTimeout(r, 300));
        }
      })();
    }
  } catch (error) {
    next(error);
  }
};

module.exports = { getAll, getBySlug, getById, create, createValidation, update, remove, pipeline, closeRemaining };
