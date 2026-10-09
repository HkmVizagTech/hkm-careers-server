/**
 * WhatsApp notifications for job applications (via Gupshup).
 *
 * Two approved templates are needed in Gupshup (category: UTILITY, language: English):
 *
 * 1) GUPSHUP_TPL_RECEIVED  — name suggestion: careers_application_received
 *    Hare Krishna {{1}} 🙏
 *    We have received your application for the position of {{2}}.
 *    Application No.: {{3}}
 *    Your application has been successfully received. Our HR team will review ...
 *    [Button: Visit website, dynamic URL  https://<careers-domain>/track?id={{1}}]
 *    body params: [candidate name, job title, application id]
 *    button param: application id
 *
 * 2) GUPSHUP_TPL_STATUS_UPDATE — name suggestion: careers_application_status_update
 *    Hare Krishna {{1}} 🙏
 *    There is an update on your application for the position of {{2}}.
 *    Application Status: {{3}}
 *    {{4}}
 *    You can track your application status using the button below.
 *    Thank you for your interest in serving with Hare Krishna Movement.
 *    [Button: Visit website, dynamic URL  https://careers.harekrishnavizag.org/track?id={{1}}]
 *    body params: [candidate name, job title, status label, status message]
 *    button param: application id
 *
 * 3) GUPSHUP_TPL_INTERVIEW — name suggestion: job_interview_scheduled
 *    Hare Krishna {{1}} 🙏
 *    Your interview for the position of {{2}} has been scheduled.
 *    Date & Time: {{3}}
 *    Mode: {{4}}
 *    {{5}}   <- "Venue: <maps link>", "Meeting link: <link>" or "Details: ..." depending on the mode
 *    Please be available on time. If you have any questions, HR will be happy to help.
 *    Thank you for your interest in serving with Hare Krishna Movement.
 *    [Button: Track Application, dynamic URL  https://careers.harekrishnavizag.org/track?id={{1}}]
 *    body params: [candidate name, job title, date & time, mode, venue or link]
 *
 * Every send is recorded on the application (`whatsappMessages`) and updated later by the
 * Gupshup webhook (sent / delivered / read / failed).
 */

const Application = require('../models/Application');
const { isConfigured, normalizePhone, sendTemplate, maskPhone } = require('./gupshup');
const { formatIST } = require('./dates');
const { interviewPlace } = require('./interviewPlace');
const { emailCandidate } = require('./emailNotifications');

const MODE_LABEL = { 'in-person': 'In person', phone: 'Phone call', video: 'Video call' };

/**
 * {{5}} in the interview template is a whole line, labelled by the interview mode:
 *   "Venue: Chaitanya Bhavan https://maps..." / "Meeting link: https://meet..." / "Details: HR will call you"
 * With nothing entered (admin will share it later): "<label>: HR will share the details with you".
 */
const LATER = 'HR will share the details with you';
function interviewWhereLine(iv = {}) {
  // WhatsApp runs a venue name and a link together, so when there's a link send only the link.
  const { venue, link } = interviewPlace(iv);
  const label = iv.mode === 'video' ? 'Meeting link' : iv.mode === 'phone' ? 'Details' : 'Venue';
  return `${label}: ${link || venue || LATER}`;
}

const STATUS_COPY = {
  received: {
    label: 'Received',
    message: 'We have received your application.',
  },
  'under-review': {
    label: 'Under Review',
    message: 'Our HR team has started reviewing your application. HR will get back to you with further details.',
  },
  shortlisted: {
    label: 'Shortlisted',
    message: 'Congratulations, you have been shortlisted. HR will get back to you with further details.',
  },
  interview: {
    label: 'Interview',
    message: 'You have been selected for an interview. HR will get back to you with further details.',
  },
  selected: {
    label: 'Selected',
    message: 'Congratulations, you have been selected to serve with us. HR will get back to you with further details.',
  },
  rejected: {
    label: 'Not Selected',
    message:
      'Thank you for your interest. We are unable to take your application forward at this time. We encourage you to apply for other openings.',
  },
};

const DEFAULT_NOTIFY_STATUSES = ['under-review', 'shortlisted', 'interview', 'selected', 'rejected'];

function notifyStatuses() {
  const raw = process.env.GUPSHUP_NOTIFY_STATUSES;
  if (!raw) return DEFAULT_NOTIFY_STATUSES;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function trackUrl(applicationId) {
  const base = (process.env.PUBLIC_SITE_URL || (process.env.CLIENT_URL || '').split(',')[0] || '')
    .trim()
    .replace(/\/+$/, '');
  return base ? `${base}/track?id=${applicationId}` : String(applicationId);
}

/**
 * Whether the approved template has the dynamic "Track Application" button, whose value is sent
 * after the body variables. All three templates have it now (the interview one was re-approved with
 * the button). If a template without the button is ever used for interviews, set
 * GUPSHUP_TPL_INTERVIEW_BUTTON=false, otherwise Gupshup fails with "#2000 localizable_params ... does not match".
 */
function hasTrackButton(kind) {
  if (kind === 'interview') return process.env.GUPSHUP_TPL_INTERVIEW_BUTTON !== 'false';
  return true;
}

/**
 * Build, send and log one message. Never throws.
 * @param {object} application  Application document (needs _id, name, phone)
 * @param {{ title?: string }|null} job
 * @param {'received'|'status'|'interview'} kind
 * @param {string} applicationStatus  status the message is about
 */
async function dispatch(application, job, kind, applicationStatus) {
  const now = new Date();
  const to = normalizePhone(application.phone);
  const templateId = {
    received: process.env.GUPSHUP_TPL_RECEIVED,
    status: process.env.GUPSHUP_TPL_STATUS_UPDATE,
    interview: process.env.GUPSHUP_TPL_INTERVIEW,
  }[kind];
  const entry = { kind, applicationStatus, templateId, to, status: 'submitted', createdAt: now, updatedAt: now };

  try {
    if (!isConfigured() || !templateId) {
      entry.status = 'skipped';
      entry.error =
        kind === 'interview' && isConfigured()
          ? 'Interview template not set yet (GUPSHUP_TPL_INTERVIEW)'
          : 'WhatsApp is not configured (missing Gupshup env vars or template id)';
    } else if (!to) {
      entry.status = 'skipped';
      entry.error = 'Phone number is not a valid WhatsApp number';
    } else {
      const copy = STATUS_COPY[applicationStatus] || { label: applicationStatus, message: '' };
      const name = application.name;
      const title = job?.title || 'the position';
      const id = application.applicationNumber || String(application._id);
      // All templates share the same shape: body variables + a dynamic "track" button.
      let params;
      if (kind === 'received') params = [name, title, id];
      else if (kind === 'interview') {
        const iv = application.interview || {};
        params = [
          name,
          title,
          formatIST(iv.scheduledAt, true, true),
          MODE_LABEL[iv.mode] || 'In person',
          interviewWhereLine(iv),
        ];
      } else params = [name, title, copy.label, copy.message];

      const result = await sendTemplate({ to, templateId, params, buttonParam: hasTrackButton(kind) ? id : undefined });
      if (result.ok) {
        entry.messageId = result.messageId;
      } else {
        entry.status = 'failed';
        entry.error = result.error;
      }
    }
  } catch (err) {
    entry.status = 'failed';
    entry.error = err.message;
    console.error(`[notifications] dispatch error for ${maskPhone(to)}:`, err.message);
  }

  try {
    await Application.updateOne({ _id: application._id }, { $push: { whatsappMessages: entry } });
  } catch (err) {
    console.error('[notifications] could not log message:', err.message);
  }
  return entry;
}

/**
 * WhatsApp + email together. Resolves to the WhatsApp log entry with the email result
 * attached as `.email`, so callers can report both.
 */
async function both(application, job, kind, status) {
  const emailKind = kind;
  const copy = STATUS_COPY[status] || { label: status, message: '' };
  const [whatsapp, email] = await Promise.all([
    dispatch(application, job, kind, status),
    emailCandidate(application, job, emailKind, { status, copy }),
  ]);
  // Email not set up yet: report WhatsApp only.
  return email?.notConfigured ? whatsapp : { ...whatsapp, email };
}

/** "Thanks for applying" message (WhatsApp + email). Fire-and-forget safe. */
function notifyApplicationReceived(application, job) {
  return both(application, job, 'received', 'received');
}

/** Status-change message. Skips statuses not in GUPSHUP_NOTIFY_STATUSES unless `force`. */
async function notifyStatusChange(application, job, status, { force = false } = {}) {
  if (!force && !notifyStatuses().includes(status)) return null;
  return both(application, job, status === 'received' ? 'received' : 'status', status);
}

/** Interview date/time message. Needs application.interview.scheduledAt. */
async function notifyInterview(application, job) {
  if (!application?.interview?.scheduledAt) return null;
  return both(application, job, 'interview', application.status);
}

module.exports = {
  STATUS_COPY,
  interviewWhereLine,
  notifyInterview,
  notifyApplicationReceived,
  notifyStatusChange,
  trackUrl,
  notifyStatuses,
};
