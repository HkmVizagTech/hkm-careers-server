const { validationResult, body } = require('express-validator');
const Application = require('../models/Application');
const Job = require('../models/Job');

const createValidation = [
  body('job').notEmpty().withMessage('Job is required'),
  body('name').notEmpty().withMessage('Name is required').trim(),
  body('email').isEmail().withMessage('Please provide a valid email'),
  body('phone').notEmpty().withMessage('Phone number is required').trim(),
];

const getAll = async (req, res, next) => {
  try {
    const { job, status, page = 1, limit = 10 } = req.query;
    const filter = {};

    if (job) filter.job = job;
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Application.countDocuments(filter);
    const applications = await Application.find(filter)
      .populate('job', 'title')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      applications,
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

const getById = async (req, res, next) => {
  try {
    const application = await Application.findById(req.params.id)
      .populate('job')
      .populate('notes.addedBy', 'name email');

    if (!application) {
      return res.status(404).json({ message: 'Application not found' });
    }

    res.json(application);
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

    const job = await Job.findById(req.body.job);
    if (!job || job.status !== 'active') {
      return res.status(400).json({ message: 'Job is not accepting applications' });
    }

    // File uploaded via multer-s3
    if (!req.file) {
      return res.status(400).json({ message: 'Resume file is required' });
    }

    const applicationData = {
      job: req.body.job,
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      coverLetter: req.body.coverLetter,
      resumeUrl: req.file.location,
      resumeKey: req.file.key,
      isExperienced: req.body.isExperienced === 'true',
      yearsOfExperience: req.body.yearsOfExperience ? Number(req.body.yearsOfExperience) : undefined,
      lastEmployer: req.body.lastEmployer || undefined,
      lastEmploymentFrom: req.body.lastEmploymentFrom || undefined,
      lastEmploymentTo: req.body.lastEmploymentTo || undefined,
    };

    const application = await Application.create(applicationData);

    // Increment application count on job
    await Job.findByIdAndUpdate(req.body.job, { $inc: { applicationCount: 1 } });

    res.status(201).json({
      message: 'Application submitted successfully',
      application: {
        id: application._id,
        name: application.name,
        email: application.email,
      },
    });
  } catch (error) {
    next(error);
  }
};

const updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ['received', 'under-review', 'shortlisted', 'interview', 'selected', 'rejected'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const application = await Application.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('job', 'title');

    if (!application) {
      return res.status(404).json({ message: 'Application not found' });
    }

    res.json(application);
  } catch (error) {
    next(error);
  }
};

const addNote = async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Note text is required' });
    }

    const application = await Application.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          notes: {
            text: text.trim(),
            addedBy: req.user._id,
          },
        },
      },
      { new: true }
    ).populate('notes.addedBy', 'name email');

    if (!application) {
      return res.status(404).json({ message: 'Application not found' });
    }

    res.json(application);
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const application = await Application.findByIdAndDelete(req.params.id);
    if (!application) {
      return res.status(404).json({ message: 'Application not found' });
    }

    // Decrement application count on job
    await Job.findByIdAndUpdate(application.job, { $inc: { applicationCount: -1 } });

    res.json({ message: 'Application deleted successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAll,
  getById,
  create,
  createValidation,
  updateStatus,
  addNote,
  remove,
};
