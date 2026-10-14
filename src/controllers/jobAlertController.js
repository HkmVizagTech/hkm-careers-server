/**
 * "Notify me about new openings".
 *
 * Public:  POST /api/job-alerts/subscribe        { email, name?, departments? }
 *          POST /api/job-alerts/confirm          { token }
 *          GET  /api/job-alerts/manage/:token
 *          PUT  /api/job-alerts/manage/:token    { departments }
 *          POST /api/job-alerts/unsubscribe      { token }   (deletes the subscriber)
 * Admin:   GET  /api/job-alerts                  list + counts
 *          DELETE /api/job-alerts/:id
 *
 * sendAlertsForJob(job) emails confirmed subscribers once per job, a few per minute so the
 * mailbox stays within Microsoft 365 sending limits.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const JobAlert = require('../models/JobAlert');
const Job = require('../models/Job');
const Department = require('../models/Department');
const { sendMail, isMailConfigured, isValidEmail } = require('../utils/mailer');
const templates = require('../utils/emailTemplates');

function siteUrl() {
  return (process.env.PUBLIC_SITE_URL || (process.env.CLIENT_URL || '').split(',')[0] || 'https://careers.harekrishnavizag.org')
    .trim()
    .replace(/\/+$/, '');
}
const confirmLink = (t) => `${siteUrl()}/alerts/confirm?token=${encodeURIComponent(t)}`;
const manageLink = (t) => `${siteUrl()}/alerts/manage?token=${encodeURIComponent(t)}`;
const newToken = () => crypto.randomBytes(24).toString('base64url');

async function cleanDepartments(list) {
  const ids = (Array.isArray(list) ? list : []).filter((id) => mongoose.isValidObjectId(id)).slice(0, 30);
  if (!ids.length) return [];
  const found = await Department.find({ _id: { $in: ids } }).select('_id');
  return found.map((d) => d._id);
}

async function departmentNames(ids) {
  if (!ids?.length) return [];
  return (await Department.find({ _id: { $in: ids } }).select('name')).map((d) => d.name);
}

/** Same address can't trigger a confirmation email more than once every 2 minutes. */
const RESEND_GAP = 2 * 60 * 1000;

const subscribe = async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isValidEmail(email) || email.length > 200) return res.status(400).json({ message: 'Please enter a valid email address' });
    if (!isMailConfigured()) return res.status(503).json({ message: 'Job alerts are not available right now. Please check back later.' });
    const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 100) || undefined;
    const departments = await cleanDepartments(req.body?.departments);

    let sub = await JobAlert.findOne({ email });
    if (sub?.confirmed) {
      // Already subscribed: we don't change their choices from an unauthenticated form; send their manage link.
      await sendMail({
        to: email,
        ...templates.jobAlertConfirm({ name: sub.name, departmentNames: await departmentNames(sub.departments) }, manageLink(sub.token)),
        subject: 'Your HKM Vizag job alerts',
      });
      return res.json({ status: 'already-subscribed' });
    }
    if (!sub) sub = new JobAlert({ email, token: newToken() });
    sub.name = name || sub.name;
    sub.departments = departments;
    if (sub.confirmSentAt && Date.now() - sub.confirmSentAt.getTime() < RESEND_GAP) {
      await sub.save();
      return res.json({ status: 'confirm-sent' });
    }
    sub.confirmSentAt = new Date();
    await sub.save();
    const result = await sendMail({
      to: email,
      ...templates.jobAlertConfirm({ name: sub.name, departmentNames: await departmentNames(departments) }, confirmLink(sub.token)),
    });
    if (!result.ok) return res.status(502).json({ message: 'We could not send the confirmation email. Please try again later.' });
    res.status(201).json({ status: 'confirm-sent' });
  } catch (err) {
    if (err?.code === 11000) return res.json({ status: 'confirm-sent' });
    next(err);
  }
};

const confirm = async (req, res, next) => {
  try {
    const token = String(req.body?.token || '');
    const sub = token.length >= 20 ? await JobAlert.findOne({ token }) : null;
    if (!sub) return res.status(404).json({ message: 'This link is not valid any more.' });
    if (!sub.confirmed) {
      sub.confirmed = true;
      sub.confirmedAt = new Date();
      await sub.save();
    }
    res.json({ email: sub.email, departments: await departmentNames(sub.departments), manageToken: sub.token });
  } catch (err) {
    next(err);
  }
};

const getManage = async (req, res, next) => {
  try {
    const sub = await JobAlert.findOne({ token: String(req.params.token || '') });
    if (!sub) return res.status(404).json({ message: 'This link is not valid any more.' });
    res.json({ email: sub.email, name: sub.name, confirmed: sub.confirmed, departments: sub.departments.map(String) });
  } catch (err) {
    next(err);
  }
};

const updateManage = async (req, res, next) => {
  try {
    const sub = await JobAlert.findOne({ token: String(req.params.token || '') });
    if (!sub) return res.status(404).json({ message: 'This link is not valid any more.' });
    sub.departments = await cleanDepartments(req.body?.departments);
    // Opening the manage link from an email proves they own the address.
    if (!sub.confirmed) {
      sub.confirmed = true;
      sub.confirmedAt = new Date();
    }
    await sub.save();
    res.json({ email: sub.email, confirmed: true, departments: sub.departments.map(String) });
  } catch (err) {
    next(err);
  }
};

const unsubscribe = async (req, res, next) => {
  try {
    const token = String(req.body?.token || '');
    if (token.length >= 20) await JobAlert.deleteOne({ token });
    res.json({ status: 'unsubscribed' });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------- admin

const list = async (req, res, next) => {
  try {
    const subs = await JobAlert.find()
      .sort({ createdAt: -1 })
      .limit(1000)
      .select('email name departments confirmed confirmedAt createdAt lastAlertAt alertsSent')
      .populate('departments', 'name');
    res.json({
      total: subs.length,
      confirmed: subs.filter((s) => s.confirmed).length,
      subscribers: subs,
    });
  } catch (err) {
    next(err);
  }
};

const remove = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Not found' });
    await JobAlert.deleteOne({ _id: req.params.id });
    res.json({ message: 'Removed' });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------- sending

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queue = [];
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const task = queue.shift();
      try {
        await task();
      } catch (err) {
        console.error('[job-alerts] send failed:', err.message);
      }
      // ~20 a minute keeps well inside Microsoft 365's 30 messages/minute limit (other emails share the mailbox).
      await sleep(Number(process.env.JOB_ALERT_DELAY_MS) || 3000);
    }
  } finally {
    draining = false;
  }
}

/**
 * Email confirmed subscribers about a newly published job (once per job).
 * Safe to call more than once and from several servers: the first caller claims the job.
 */
async function sendAlertsForJob(jobId) {
  try {
    if (!isMailConfigured()) return 0;
    const claimed = await Job.findOneAndUpdate(
      { _id: jobId, status: 'active', alertsSentAt: null },
      { $set: { alertsSentAt: new Date() } },
      { new: true }
    ).populate('department', 'name');
    if (!claimed) return 0;
    const deptId = claimed.department?._id || claimed.department;
    const subs = await JobAlert.find({
      confirmed: true,
      $or: [{ departments: { $size: 0 } }, { departments: deptId }],
    }).select('email name token');
    const applyLink = `${siteUrl()}/jobs/${claimed.slug}?src=job-alert`;
    for (const sub of subs) {
      queue.push(async () => {
        const built = templates.jobAlert(claimed, sub, { applyLink, manageLink: manageLink(sub.token) });
        const result = await sendMail({
          to: sub.email,
          ...built,
          headers: { 'List-Unsubscribe': `<${manageLink(sub.token)}>` },
        });
        if (result.ok) await JobAlert.updateOne({ _id: sub._id }, { $set: { lastAlertAt: new Date() }, $inc: { alertsSent: 1 } });
      });
    }
    drain();
    if (subs.length) console.log(`[job-alerts] "${claimed.title}": emailing ${subs.length} subscriber(s)`);
    return subs.length;
  } catch (err) {
    console.error('[job-alerts] could not send alerts:', err.message);
    return 0;
  }
}

module.exports = { subscribe, confirm, getManage, updateManage, unsubscribe, list, remove, sendAlertsForJob, _queue: queue };
