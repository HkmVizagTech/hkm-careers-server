const { validationResult, body } = require('express-validator');
const Application = require('../models/Application');
const Job = require('../models/Job');
const Notification = require('../models/Notification');
const { generateApplicationNumber } = require('../utils/applicationNumber');
const path = require('path');
const { getResumeUrl, getResumeKey } = require('../config/r2');
const { RESUME_TYPES, resumeFileName, openResume } = require('../utils/resumeFile');
const { notifyApplicationReceived, notifyStatusChange, notifyInterview } = require('../utils/notifications');
const { alertNewApplication, alertPositionFilled } = require('../utils/adminAlerts');
const { emailCustom, emailHrNewApplication } = require('../utils/emailNotifications');
const { formatIST } = require('../utils/dates');
const { interviewPlace, normalizeLink } = require('../utils/interviewPlace');

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
      .select('-whatsappMessages -emails')
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
      .populate('followUps.createdBy', 'name')
      .populate('emails.sentBy', 'name');

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
    // Some roles are open to one gender only (set by admin on the job).
    if (['male', 'female'].includes(job.targetGender) && req.body.gender !== job.targetGender) {
      return res.status(400).json({ message: `This position is open to ${job.targetGender} applicants only.` });
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
      source: String(req.body.source || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30) || undefined,
    };

    applicationData.applicationNumber = await generateApplicationNumber(job.title);
    const application = await Application.create(applicationData);

    // Increment application count on job
    await Job.findByIdAndUpdate(req.body.job, { $inc: { applicationCount: 1 } });

    // WhatsApp confirmation — fire and forget so a Gupshup hiccup never delays or fails the submission.
    notifyApplicationReceived(application, job).catch((err) =>
      console.error('[applications] received notification failed:', err.message)
    );
    // Bell alert for the admin team, and the HR inbox email (with resume) if configured.
    alertNewApplication(application, job);
    emailHrNewApplication(application, job);

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

const OPEN_STATUSES = ['received', 'under-review', 'shortlisted', 'interview'];

/**
 * When the number of selected candidates reaches the job's openings, close the job
 * (so it stops taking applications) and report how many applicants are still open.
 */
async function checkRoleFilled(jobId) {
  const job = await Job.findById(jobId).select('title status openings');
  if (!job) return null;
  const openings = job.openings || 1;
  const [selected, remaining] = await Promise.all([
    Application.countDocuments({ job: jobId, status: 'selected' }),
    Application.countDocuments({ job: jobId, status: { $in: OPEN_STATUSES } }),
  ]);
  if (selected < openings) return null;
  let closedNow = false;
  if (job.status === 'active') {
    const res = await Job.updateOne({ _id: jobId, status: 'active' }, { $set: { status: 'closed' } });
    closedNow = res.modifiedCount > 0;
    if (closedNow) alertPositionFilled(job, selected, remaining);
  }
  return { jobId: String(job._id), title: job.title, openings, selected, remaining, closedNow };
}

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

    // Filling the last opening closes the job and tells the admin how many are still in progress.
    let roleFilled = null;
    if (status === 'selected' && previous.status !== 'selected' && application.job?._id) {
      roleFilled = await checkRoleFilled(application.job._id);
    }

    res.json({ ...application.toObject(), notification, roleFilled });
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
  ['Source', (a) => a.source || 'direct'],
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
      .select('-whatsappMessages -emails -notes -followUps')
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

// PUT /api/applications/:id/interview { scheduledAt, mode, venue, link, notes, notify }
const scheduleInterview = async (req, res, next) => {
  try {
    const { scheduledAt, mode, notes } = req.body || {};
    // `location` (venue and link in one text) is what older admin pages send.
    const legacy = !req.body?.venue && !req.body?.link && req.body?.location ? interviewPlace({ location: req.body.location }) : null;
    const venue = String((legacy ? legacy.venue : req.body?.venue) || '').trim().slice(0, 200);
    const link = normalizeLink(legacy ? legacy.link : req.body?.link);
    if (link === null) {
      return res.status(400).json({ message: 'The link does not look right. Paste the full Google Maps or meeting link.' });
    }
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
            venue: venue || undefined,
            link: link ? link.slice(0, 500) : undefined,
            notes: notes ? String(notes).trim().slice(0, 1000) : undefined,
            scheduledBy: req.user._id,
          },
        },
      },
      { new: true, runValidators: true }
    ).populate('job', 'title');
    if (!application) return res.status(404).json({ message: 'Application not found' });
    // Reminders for the old time are no longer true; the checks create fresh ones for the new time.
    await Notification.deleteMany({ application: application._id, type: 'interview' });
    // WhatsApp the candidate the date/time unless the admin unticked it.
    const notification = req.body.notify === false ? null : await notifyInterview(application, application.job);
    res.json({ interview: application.interview, notification });
  } catch (error) {
    next(error);
  }
};

// POST /api/applications/:id/interview/notify -> re-send the interview details
const resendInterview = async (req, res, next) => {
  try {
    const application = await Application.findById(req.params.id).populate('job', 'title');
    if (!application) return res.status(404).json({ message: 'Application not found' });
    if (!application.interview?.scheduledAt) return res.status(400).json({ message: 'No interview scheduled' });
    const notification = await notifyInterview(application, application.job);
    const fresh = await Application.findById(req.params.id).select('whatsappMessages');
    res.json({ notification, whatsappMessages: fresh.whatsappMessages });
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

// POST /api/applications/:id/email { subject, message } -> admin-written email to the candidate
const sendEmail = async (req, res, next) => {
  try {
    const subject = String(req.body?.subject || '').trim().slice(0, 200);
    const message = String(req.body?.message || '').trim().slice(0, 10000);
    if (!subject) return res.status(400).json({ message: 'Please add a subject' });
    if (!message) return res.status(400).json({ message: 'Please write the message' });
    const application = await Application.findById(req.params.id).populate('job', 'title');
    if (!application) return res.status(404).json({ message: 'Application not found' });

    const email = await emailCustom(application, application.job, { subject, message, sender: req.user });
    if (email.notConfigured) {
      return res.status(503).json({ message: 'Email is not set up yet. Ask the developer to add the email settings.' });
    }
    const fresh = await Application.findById(req.params.id).select('emails').populate('emails.sentBy', 'name');
    res.status(email.status === 'sent' ? 201 : 200).json({ email, emails: fresh.emails });
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
      // Interview details only while the candidate is at the interview stage and it's not long past.
      interview:
        application.status === 'interview' &&
        application.interview?.scheduledAt &&
        application.interview.scheduledAt.getTime() > Date.now() - 24 * 60 * 60 * 1000
          ? {
              scheduledAt: application.interview.scheduledAt,
              mode: application.interview.mode || 'in-person',
              ...interviewPlace(application.interview),
            }
          : null,
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
  sendEmail,
  downloadResume,
  resumeFileName,
  scheduleInterview,
  clearInterview,
  resendInterview,
  checkRoleFilled,
  OPEN_STATUSES,
  addFollowUp,
  updateFollowUp,
  deleteFollowUp,
};
