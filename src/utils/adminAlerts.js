/**
 * In-app alerts and reminders for the admin team (the bell in the admin header).
 *
 * Event alerts:   new application received.
 * Reminder checks (run every REMINDER_INTERVAL_MINUTES, default 15):
 *   - applications still "received" after UNREVIEWED_AFTER_DAYS (default 3) -> one digest per day
 *   - scheduled interviews -> "tomorrow / within 24h" and "starting soon (2h)" reminders
 *   - job deadlines -> "closing soon" (JOB_CLOSING_WARN_DAYS, default 3) and auto-close once passed
 *   - follow-up reminders admins set on an application -> alert when due
 *
 * Every reminder has a dedupeKey, so running the checks often (or on several servers) never duplicates one.
 * Nothing here throws: alerts must never break an application submission or a status change.
 */
const Notification = require('../models/Notification');
const Application = require('../models/Application');
const Job = require('../models/Job');
const { istDateKey, formatIST } = require('./dates');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const config = () => ({
  unreviewedAfterDays: num(process.env.UNREVIEWED_AFTER_DAYS, 3),
  jobClosingWarnDays: num(process.env.JOB_CLOSING_WARN_DAYS, 3),
  intervalMinutes: num(process.env.REMINDER_INTERVAL_MINUTES, 15),
});

const MODE_LABEL = { 'in-person': 'In person', phone: 'Phone', video: 'Video call' };

/** Create an alert. With a dedupeKey, a second call with the same key is a no-op. Returns the doc or null. */
async function createAlert(data) {
  try {
    if (!data.dedupeKey) return await Notification.create(data);
    const res = await Notification.findOneAndUpdate(
      { dedupeKey: data.dedupeKey },
      { $setOnInsert: data },
      { upsert: true, new: true, includeResultMetadata: true }
    );
    // Only report a newly inserted alert.
    return res?.lastErrorObject?.updatedExisting ? null : res?.value || null;
  } catch (err) {
    if (err?.code === 11000) return null; // another server inserted it a moment earlier
    console.error('[alerts] could not create alert:', err.message);
    return null;
  }
}

async function alertNewApplication(application, job) {
  const title = job?.title || 'a position';
  return createAlert({
    type: 'new-application',
    title: `New application for ${title}`,
    message: `${application.name}${application.applicationNumber ? ` (${application.applicationNumber})` : ''} just applied.`,
    link: `/admin/applications/${application._id}`,
    application: application._id,
    job: job?._id,
    dedupeKey: `new-application:${application._id}`,
  });
}

/** All openings for a job are filled: the job was closed automatically. */
async function alertPositionFilled(job, selected, remaining) {
  return createAlert({
    type: 'position-filled',
    title: `Position filled: ${job.title}`,
    message: `${selected} selected, so the job was closed.${remaining ? ` ${remaining} applicant${remaining === 1 ? ' is' : 's are'} still in progress.` : ''}`,
    link: `/admin/applications?job=${job._id}`,
    job: job._id,
    dedupeKey: `position-filled:${job._id}:${selected}`,
  });
}

// ---------------------------------------------------------------- reminder checks

async function checkUnreviewed(now) {
  const { unreviewedAfterDays } = config();
  const cutoff = new Date(now.getTime() - unreviewedAfterDays * DAY);
  const count = await Application.countDocuments({ status: 'received', createdAt: { $lte: cutoff } });
  if (!count) return 0;
  const created = await createAlert({
    type: 'unreviewed',
    title: `${count} application${count === 1 ? '' : 's'} waiting for review`,
    message: `Still in "Received" for more than ${unreviewedAfterDays} day${unreviewedAfterDays === 1 ? '' : 's'}.`,
    link: '/admin/applications?status=received',
    dedupeKey: `unreviewed:${istDateKey(now)}`, // at most one digest per day
  });
  return created ? 1 : 0;
}

async function checkInterviews(now) {
  const upcoming = await Application.find({
    'interview.scheduledAt': { $gt: now, $lte: new Date(now.getTime() + DAY) },
    status: { $nin: ['rejected', 'selected'] },
  })
    .select('name applicationNumber interview job')
    .populate('job', 'title');

  let created = 0;
  for (const app of upcoming) {
    const at = app.interview.scheduledAt;
    const soon = at.getTime() - now.getTime() <= 2 * HOUR;
    const where = [MODE_LABEL[app.interview.mode], app.interview.location].filter(Boolean).join(' · ');
    const doc = await createAlert({
      type: 'interview',
      title: soon ? `Interview starting soon: ${app.name}` : `Interview ${istDateKey(at) === istDateKey(now) ? 'today' : 'tomorrow'}: ${app.name}`,
      message: `${formatIST(at)}${app.job?.title ? ` · ${app.job.title}` : ''}${where ? ` · ${where}` : ''}`,
      link: `/admin/applications/${app._id}`,
      application: app._id,
      // Rescheduling changes the timestamp, so the new time gets fresh reminders.
      dedupeKey: `interview-${soon ? 'soon' : 'day'}:${app._id}:${at.getTime()}`,
    });
    if (doc) created++;
  }
  return created;
}

async function checkJobDeadlines(now) {
  const { jobClosingWarnDays } = config();
  let created = 0;

  // Past the deadline -> close the job so it stops taking applications.
  const expired = await Job.find({ status: 'active', deadline: { $ne: null, $lte: now } }).select('title deadline');
  for (const job of expired) {
    const res = await Job.updateOne({ _id: job._id, status: 'active' }, { $set: { status: 'closed' } });
    if (!res.modifiedCount) continue; // another server closed it
    const doc = await createAlert({
      type: 'job-closed',
      title: `Job closed: ${job.title}`,
      message: `The application deadline (${formatIST(job.deadline, false)}) has passed, so it no longer accepts applications.`,
      link: '/admin/jobs',
      job: job._id,
      dedupeKey: `job-closed:${job._id}:${job.deadline.getTime()}`,
    });
    if (doc) created++;
  }

  const closing = await Job.find({
    status: 'active',
    deadline: { $gt: now, $lte: new Date(now.getTime() + jobClosingWarnDays * DAY) },
  }).select('title deadline applicationCount');
  for (const job of closing) {
    const doc = await createAlert({
      type: 'job-closing',
      title: `Closing soon: ${job.title}`,
      message: `Applications close on ${formatIST(job.deadline, false)} (${job.applicationCount || 0} received so far).`,
      link: '/admin/jobs',
      job: job._id,
      dedupeKey: `job-closing:${job._id}:${job.deadline.getTime()}`,
    });
    if (doc) created++;
  }
  return created;
}

async function checkFollowUps(now) {
  const apps = await Application.find({
    followUps: { $elemMatch: { done: false, notifiedAt: null, dueAt: { $lte: now } } },
  }).select('name applicationNumber followUps');

  let created = 0;
  for (const app of apps) {
    for (const f of app.followUps) {
      if (f.done || f.notifiedAt || f.dueAt > now) continue;
      const doc = await createAlert({
        type: 'follow-up',
        title: `Follow up: ${app.name}`,
        message: f.note,
        link: `/admin/applications/${app._id}`,
        application: app._id,
        dedupeKey: `follow-up:${f._id}`,
      });
      await Application.updateOne(
        { _id: app._id, 'followUps._id': f._id },
        { $set: { 'followUps.$.notifiedAt': now } }
      );
      if (doc) created++;
    }
  }
  return created;
}

let running = null;
let lastRunAt = 0;

/** Run all reminder checks once. Concurrent calls share the same run. */
async function runReminderChecks(now = new Date()) {
  if (running) return running;
  running = (async () => {
    const results = {};
    for (const [name, check] of Object.entries({
      unreviewed: checkUnreviewed,
      interviews: checkInterviews,
      jobs: checkJobDeadlines,
      followUps: checkFollowUps,
    })) {
      try {
        results[name] = await check(now);
      } catch (err) {
        console.error(`[alerts] ${name} check failed:`, err.message);
        results[name] = 0;
      }
    }
    lastRunAt = Date.now();
    return results;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

/** Run the checks if they haven't run recently (used when an admin opens the bell). */
function runChecksIfStale(maxAgeMs = 5 * 60 * 1000) {
  if (Date.now() - lastRunAt < maxAgeMs) return Promise.resolve(null);
  return runReminderChecks().catch(() => null);
}

/** Start the background schedule. Call once after the DB connection is set up. */
function startReminderScheduler() {
  const { intervalMinutes } = config();
  const tick = () => runReminderChecks().catch((err) => console.error('[alerts] run failed:', err.message));
  setTimeout(tick, 15 * 1000).unref();
  setInterval(tick, intervalMinutes * 60 * 1000).unref();
  console.log(`[alerts] reminder checks every ${intervalMinutes} min`);
}

module.exports = {
  createAlert,
  alertNewApplication,
  alertPositionFilled,
  runReminderChecks,
  runChecksIfStale,
  startReminderScheduler,
  checkUnreviewed,
  checkInterviews,
  checkJobDeadlines,
  checkFollowUps,
};
