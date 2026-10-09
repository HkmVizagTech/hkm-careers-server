/**
 * Emails about an application: candidate updates (mirroring the WhatsApp messages),
 * admin-written messages, and the "new application" alert to HR.
 * Each attempt is logged on the application (`emails`). Nothing here throws.
 */
const Application = require('../models/Application');
const { sendMail, isValidEmail, isMailConfigured } = require('./mailer');
const templates = require('./emailTemplates');
const { readResumeBuffer } = require('./resumeFile');

async function log(applicationId, entry) {
  try {
    await Application.updateOne({ _id: applicationId }, { $push: { emails: entry } });
  } catch (err) {
    console.error('[email] could not log email:', err.message);
  }
}

async function send(application, { kind, to, built, applicationStatus, body, sentBy, attachments, replyTo }) {
  // Until email is set up, stay silent: nothing logged on the application, nothing shown to HR.
  if (!isMailConfigured()) {
    return { kind, status: 'skipped', error: 'Email is not set up yet', notConfigured: true };
  }
  const entry = {
    kind,
    applicationStatus,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject: built.subject,
    body,
    sentBy,
    status: 'sent',
    createdAt: new Date(),
  };
  const result = await sendMail({ to, subject: built.subject, html: built.html, text: built.text, attachments, replyTo });
  if (result.ok) entry.messageId = result.messageId;
  else {
    entry.status = result.skipped ? 'skipped' : 'failed';
    entry.error = result.error;
  }
  await log(application._id, entry);
  return entry;
}

/** @param {'received'|'status'|'interview'} kind */
async function emailCandidate(application, job, kind, { status, copy } = {}) {
  try {
    let built;
    if (kind === 'received') built = templates.applicationReceived(application, job);
    else if (kind === 'interview') built = templates.interviewScheduled(application, job);
    else built = templates.statusUpdate(application, job, copy);
    return await send(application, { kind, to: application.email, built, applicationStatus: status || application.status });
  } catch (err) {
    console.error('[email] candidate email failed:', err.message);
    return { kind, status: 'failed', error: err.message };
  }
}

/** Admin-written email from the application page. */
async function emailCustom(application, job, { subject, message, sender }) {
  const built = templates.customMessage(application, job, { subject, message, senderName: sender?.name });
  // Replies go to the configured HR inbox; fall back to the admin who wrote it.
  const replyTo = process.env.MAIL_REPLY_TO || (isValidEmail(sender?.email) ? sender.email : undefined);
  return send(application, { kind: 'custom', to: application.email, built, body: message, sentBy: sender?._id, replyTo });
}

function hrRecipients() {
  return String(process.env.HR_NOTIFY_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(isValidEmail);
}

/** "New application" email to HR with the resume attached. Fire-and-forget safe. */
async function emailHrNewApplication(application, job) {
  const to = hrRecipients();
  if (!to.length) return null;
  try {
    const resume = await readResumeBuffer({ ...application.toObject?.() ?? application, job }).catch(() => null);
    const built = templates.hrNewApplication(application, job, { hasAttachment: !!resume });
    return await send(application, {
      kind: 'hr-new-application',
      to,
      built,
      // HR can hit Reply to answer the candidate directly.
      replyTo: isValidEmail(application.email) ? application.email : undefined,
      attachments: resume ? [resume] : undefined,
    });
  } catch (err) {
    console.error('[email] HR email failed:', err.message);
    return null;
  }
}

module.exports = { emailCandidate, emailCustom, emailHrNewApplication, hrRecipients };
