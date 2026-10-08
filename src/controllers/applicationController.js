const { validationResult, body } = require('express-validator');
const Application = require('../models/Application');
const Job = require('../models/Job');
const Notification = require('../models/Notification');
const { generateApplicationNumber } = require('../utils/applicationNumber');
const path = require('path');
const fs = require('fs');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, getResumeUrl, getResumeKey } = require('../config/r2');
const { prefixFromTitle } = require('../utils/applicationNumber');
const { notifyApplicationReceived, notifyStatusChange } = require('../utils/notifications');
const { alertNewApplication } = require('../utils/adminAlerts');
const { formatIST } = require('../utils/dates');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Shared list/export filter: job, status, department, search (name, email, phone, application number). */
async function buildFilter(query) {
  const { job, status, department, search } = query;
  const filter = {};
  if (job) filter.job = job;
  if (status) filter.status = status;

  if (department) {
    const jobIds = await Job.find({ department }).distinct('_id');
    filter.job = job ? { $in: jobIds.filter((id) => String(id) === String(job)) } : { $in: jobIds };
  }

  const term = String(search || '').trim().slice(0, 100);
  if (term) {
    const rx = new RegExp(escapeRegex(term), 'i');
    const or = [{ name: rx }, { email: rx }, { applicationNumber: rx }];
    const digits = term.replace(/\D/g, '');
    // Phone numbers are stored as typed ("98765 43210"), so match the digits with anything in between.
    if (digits.length >= 4) or.push({ phone: new RegExp(digits.split('').join('\\D*')) });
    filter.$or = or;
  }
  return filter;
}

const createValidation = [
  body('job').notEmpty().withMessage('Job is required'),
  body('name').notEmpty().withMessage('Name is required').trim(),
  body('email').isEmail().withMessage('Please provide a valid email'),
  body('phone').notEmpty().withMessage('Phone number is required').trim(),
];

const getAll = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const filter = await buildFilter(req.query);

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Application.countDocuments(filter);
    const applications = await Application.find(filter)
      .select('-whatsappMessages')
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
      .populate('notes.addedBy', 'name email')
      .populate('followUps.createdBy', 'name');

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
    if (!job || job.status !== 'active' || (job.deadline && job.deadline <= new Date())) {
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
      resumeUrl: getResumeUrl(req.file),
      resumeKey: getResumeKey(req.file),
      isExperienced: req.body.isExperienced === 'true',
      yearsOfExperience: req.body.yearsOfExperience ? Number(req.body.yearsOfExperience) : undefined,
      lastEmployer: req.body.lastEmployer || undefined,
      lastEmploymentFrom: req.body.lastEmploymentFrom || undefined,
      lastEmploymentTo: req.body.lastEmploymentTo || undefined,
      linkedinUrl: req.body.linkedinUrl || undefined,
      githubUrl: req.body.githubUrl || undefined,
      portfolioUrl: req.body.portfolioUrl || undefined,
      location: req.body.location || undefined,
      gender: req.body.gender || undefined,
      dateOfBirth: req.body.dateOfBirth || undefined,
      availableToJoin: req.body.availableToJoin || undefined,
      currentLocation: req.body.currentLocation || undefined,
      highestDegree: req.body.highestDegree || undefined,
      collegeName: req.body.collegeName || undefined,
      collegeCity: req.body.collegeCity || undefined,
      studyYears: req.body.studyYears || undefined,
    };

    applicationData.applicationNumber = await generateApplicationNumber(job.title);
    const application = await Application.create(applicationData);

    // Increment application count on job
    await Job.findByIdAndUpdate(req.body.job, { $inc: { applicationCount: 1 } });

    // WhatsApp confirmation — fire and forget so a Gupshup hiccup never delays or fails the submission.
    notifyApplicationReceived(application, job).catch((err) =>
      console.error('[applications] received notification failed:', err.message)
    );
    // Bell alert for the admin team.
    alertNewApplication(application, job);

    res.status(201).json({
      message: 'Application submitted successfully',
      application: {
        id: application.applicationNumber,
        _id: application._id,
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

    const previous = await Application.findById(req.params.id).select('status');
    if (!previous) {
      return res.status(404).json({ message: 'Application not found' });
    }

    const application = await Application.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('job', 'title');

    // `notify: false` lets HR change the status silently. Unchanged status never re-sends.
    let notification = null;
    if (req.body.notify !== false && previous.status !== status) {
      notification = await notifyStatusChange(application, application.job, status);
    }

    res.json({ ...application.toObject(), notification });
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

// Re-send the WhatsApp message that matches the application's current status.
const resendNotification = async (req, res, next) => {
  try {
    const application = await Application.findById(req.params.id).populate('job', 'title');
    if (!application) {
      return res.status(404).json({ message: 'Application not found' });
    }

    const notification = await notifyStatusChange(application, application.job, application.status, {
      force: true,
    });
    const fresh = await Application.findById(req.params.id).select('whatsappMessages');
    res.json({ notification, whatsappMessages: fresh.whatsappMessages });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- CSV export

const CSV_COLUMNS = [
  ['Application No', (a) => a.applicationNumber || String(a._id)],
  ['Name', (a) => a.name],
  ['Email', (a) => a.email],
  ['Phone', (a) => a.phone],
  ['Job', (a) => a.job?.title],
  ['Status', (a) => a.status],
  ['Applied On', (a) => formatIST(a.createdAt)],
  ['Location', (a) => a.location],
  ['Current Location', (a) => a.currentLocation],
  ['Gender', (a) => a.gender],
  ['Date of Birth', (a) => (a.dateOfBirth ? new Date(a.dateOfBirth).toISOString().slice(0, 10) : '')],
  ['Experienced', (a) => (a.isExperienced ? 'Yes' : 'No')],
  ['Years of Experience', (a) => a.yearsOfExperience],
  ['Last Employer', (a) => a.lastEmployer],
  ['Available to Join', (a) => a.availableToJoin],
  ['Highest Degree', (a) => a.highestDegree],
  ['College', (a) => a.collegeName],
  ['College City', (a) => a.collegeCity],
  ['Study Years', (a) => a.studyYears],
  ['LinkedIn', (a) => a.linkedinUrl],
  ['GitHub', (a) => a.githubUrl],
  ['Portfolio', (a) => a.portfolioUrl],
  ['Interview', (a) => (a.interview?.scheduledAt ? formatIST(a.interview.scheduledAt) : '')],
  ['Resume', (a) => a.resumeUrl],
];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Stop spreadsheet apps from treating candidate input as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/applications/export?status&job&department&search -> CSV (opens in Excel)
const exportCsv = async (req, res, next) => {
  try {
    const filter = await buildFilter(req.query);
    const apps = await Application.find(filter)
      .select('-whatsappMessages -notes -followUps')
      .populate('job', 'title')
      .sort({ createdAt: -1 })
      .limit(10000)
      .lean();

    const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')];
    for (const a of apps) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(a))).join(','));

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="applications-${stamp}.csv"`);
    res.send('﻿' + lines.join('\r\n')); // BOM so Excel reads Telugu/Hindi names correctly
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- interview

// PUT /api/applications/:id/interview { scheduledAt, mode, location, notes }
const scheduleInterview = async (req, res, next) => {
  try {
    const { scheduledAt, mode, location, notes } = req.body || {};
    const at = new Date(scheduledAt);
    if (!scheduledAt || Number.isNaN(at.getTime())) {
      return res.status(400).json({ message: 'Please choose a valid interview date and time' });
    }
    if (mode && !['in-person', 'phone', 'video'].includes(mode)) {
      return res.status(400).json({ message: 'Invalid interview mode' });
    }
    const application = await Application.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          interview: {
            scheduledAt: at,
            mode: mode || undefined,
            location: location ? String(location).trim().slice(0, 300) : undefined,
            notes: notes ? String(notes).trim().slice(0, 1000) : undefined,
            scheduledBy: req.user._id,
          },
        },
      },
      { new: true, runValidators: true }
    ).select('interview');
    if (!application) return res.status(404).json({ message: 'Application not found' });
    // Reminders for the old time are no longer true; the checks create fresh ones for the new time.
    await Notification.deleteMany({ application: application._id, type: 'interview' });
    res.json({ interview: application.interview });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/applications/:id/interview
const clearInterview = async (req, res, next) => {
  try {
    const application = await Application.findByIdAndUpdate(req.params.id, { $unset: { interview: 1 } }, { new: true });
    if (!application) return res.status(404).json({ message: 'Application not found' });
    await Notification.deleteMany({ application: application._id, type: 'interview' });
    res.json({ interview: null });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- follow-up reminders

const followUpsOf = async (id) =>
  (await Application.findById(id).select('followUps').populate('followUps.createdBy', 'name'))?.followUps;

// POST /api/applications/:id/follow-ups { dueAt, note }
const addFollowUp = async (req, res, next) => {
  try {
    const { dueAt, note } = req.body || {};
    const at = new Date(dueAt);
    if (!dueAt || Number.isNaN(at.getTime())) return res.status(400).json({ message: 'Please choose when to be reminded' });
    if (!note || !String(note).trim()) return res.status(400).json({ message: 'Please add what to follow up on' });
    const updated = await Application.findByIdAndUpdate(req.params.id, {
      $push: { followUps: { dueAt: at, note: String(note).trim().slice(0, 500), createdBy: req.user._id } },
    });
    if (!updated) return res.status(404).json({ message: 'Application not found' });
    res.status(201).json({ followUps: await followUpsOf(req.params.id) });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/applications/:id/follow-ups/:fid { done }
const updateFollowUp = async (req, res, next) => {
  try {
    const set = {};
    if (typeof req.body?.done === 'boolean') set['followUps.$.done'] = req.body.done;
    if (req.body?.dueAt) {
      const at = new Date(req.body.dueAt);
      if (Number.isNaN(at.getTime())) return res.status(400).json({ message: 'Invalid date' });
      set['followUps.$.dueAt'] = at;
      set['followUps.$.notifiedAt'] = null; // remind again at the new time
    }
    const result = await Application.updateOne({ _id: req.params.id, 'followUps._id': req.params.fid }, { $set: set });
    if (!result.matchedCount) return res.status(404).json({ message: 'Reminder not found' });
    res.json({ followUps: await followUpsOf(req.params.id) });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/applications/:id/follow-ups/:fid
const deleteFollowUp = async (req, res, next) => {
  try {
    const result = await Application.updateOne({ _id: req.params.id }, { $pull: { followUps: { _id: req.params.fid } } });
    if (!result.matchedCount) return res.status(404).json({ message: 'Application not found' });
    res.json({ followUps: await followUpsOf(req.params.id) });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- resume

const RESUME_TYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** "FSD_Chaitanya_Kumar.pdf": role short form + applicant name. */
function resumeFileName(application, ext) {
  const fromNumber = /^([A-Z]+)\d+$/.exec(application.applicationNumber || '')?.[1];
  const prefix = fromNumber || prefixFromTitle(application.job?.title);
  const name =
    String(application.name || 'Applicant')
      .normalize('NFC')
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '') // keeps Telugu/Hindi names too
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'Applicant';
  return `${prefix}_${name}${ext}`;
}

/** Readable stream + content type for the stored resume, from R2, local disk, or its public URL. */
async function openResume(application) {
  const key = application.resumeKey;
  if (s3Client && key) {
    const obj = await s3Client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    return { body: obj.Body, type: obj.ContentType, length: obj.ContentLength };
  }
  if (application.resumeUrl?.startsWith('/uploads/')) {
    const file = path.join(__dirname, '..', '..', application.resumeUrl.replace(/^\/+/, ''));
    if (fs.existsSync(file)) return { body: fs.createReadStream(file), length: fs.statSync(file).size };
  }
  if (/^https?:\/\//.test(application.resumeUrl || '')) {
    const res = await fetch(application.resumeUrl);
    if (res.ok) {
      const { Readable } = require('stream');
      return { body: Readable.fromWeb(res.body), type: res.headers.get('content-type'), length: Number(res.headers.get('content-length')) || undefined };
    }
  }
  return null;
}

// GET /api/applications/:id/resume?inline=1 -> the resume file named e.g. FSD_Chaitanya.pdf
const downloadResume = async (req, res, next) => {
  try {
    const application = await Application.findById(req.params.id)
      .select('name applicationNumber resumeUrl resumeKey job')
      .populate('job', 'title');
    if (!application) return res.status(404).json({ message: 'Application not found' });

    const ext = (path.extname(application.resumeKey || application.resumeUrl || '').toLowerCase().split('?')[0]) || '.pdf';
    const file = await openResume(application).catch((err) => {
      console.error('[resume] could not read file:', err.message);
      return null;
    });
    if (!file) return res.status(404).json({ message: 'Resume file not found' });

    const filename = resumeFileName(application, ext);
    const inline = req.query.inline === '1' || req.query.inline === 'true';
    res.setHeader('Content-Type', RESUME_TYPES[ext] || file.type || 'application/octet-stream');
    if (file.length) res.setHeader('Content-Length', String(file.length));
    res.setHeader(
      'Content-Disposition',
      // filename= must be plain ASCII; filename*= carries the exact (possibly Telugu) name.
      `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Cache-Control', 'private, no-store');
    file.body.on('error', (err) => {
      console.error('[resume] stream failed:', err.message);
      res.destroy(err);
    });
    file.body.pipe(res);
  } catch (error) {
    next(error);
  }
};

const trackStatus = async (req, res, next) => {
  try {
    // Accepts the short number (FSD10001, any case) or, for older applications, the long id.
    const key = String(req.params.id || '').trim();
    const application = await Application.findOne(
      /^[a-f0-9]{24}$/i.test(key) ? { _id: key } : { applicationNumber: key.toUpperCase() }
    ).populate('job', 'title location type');
    if (!application) {
      return res.status(404).json({ message: 'Application not found' });
    }
    // Return only safe public fields
    res.json({
      // Short ids are guessable, so the public view never shows the full name.
      name: application.name.trim().split(/\s+/).map((w, i) => (i === 0 ? w : w[0] + '.')).join(' '),
      applicationNumber: application.applicationNumber || String(application._id),
      email: application.email.replace(/(.{2}).*(@.*)/, '$1***$2'),
      job: application.job && typeof application.job === 'object' ? { title: application.job.title, location: application.job.location, type: application.job.type } : null,
      status: application.status,
      appliedAt: application.createdAt,
    });
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
    // Its bell alerts would only lead to a "not found" page now.
    await Notification.deleteMany({ application: application._id });

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
  resendNotification,
  addNote,
  remove,
  trackStatus,
  exportCsv,
  downloadResume,
  resumeFileName,
  scheduleInterview,
  clearInterview,
  addFollowUp,
  updateFollowUp,
  deleteFollowUp,
};
