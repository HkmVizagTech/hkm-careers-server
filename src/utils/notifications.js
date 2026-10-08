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
 *    Hello {{1}}, there is an update on your application for {{2}} at Hare Krishna Movement Vizag.
 *    Status: {{3}}. {{4}} Track your application at {{5}}.
 *    params: [candidate name, job title, status label, status message, track link]
 *
 * Every send is recorded on the application (`whatsappMessages`) and updated later by the
 * Gupshup webhook (sent / delivered / read / failed).
 */

const Application = require('../models/Application');
const { isConfigured, normalizePhone, sendTemplate, maskPhone } = require('./gupshup');

const STATUS_COPY = {
  received: {
    label: 'Received',
    message: 'We have received your application.',
  },
  'under-review': {
    label: 'Under Review',
    message: 'Our team has started reviewing your application.',
  },
  shortlisted: {
    label: 'Shortlisted',
    message: 'Congratulations, you have been shortlisted. We will contact you shortly with the next steps.',
  },
  interview: {
    label: 'Interview',
    message: 'You have been selected for an interview. Our team will contact you with the schedule.',
  },
  selected: {
    label: 'Selected',
    message: 'Congratulations, you have been selected. Our team will reach out with the joining details.',
  },
  rejected: {
    label: 'Not Selected',
    message:
      'Thank you for your interest. We are unable to take your application forward at this time, and we encourage you to apply for other openings.',
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

const MAX_MESSAGES_PER_NUMBER_PER_DAY = Number(process.env.WHATSAPP_MAX_PER_NUMBER_PER_DAY) || 8;

async function sentTodayTo(to) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await Application.aggregate([
    { $match: { 'whatsappMessages.to': to } },
    { $unwind: '$whatsappMessages' },
    {
      $match: {
        'whatsappMessages.to': to,
        'whatsappMessages.createdAt': { $gte: since },
        'whatsappMessages.status': { $ne: 'skipped' },
      },
    },
    { $count: 'n' },
  ]);
  return rows[0]?.n || 0;
}

/**
 * Build, send and log one message. Never throws.
 * @param {object} application  Application document (needs _id, name, phone)
 * @param {{ title?: string }|null} job
 * @param {'received'|'status'} kind
 * @param {string} applicationStatus  status the message is about
 */
async function dispatch(application, job, kind, applicationStatus) {
  const now = new Date();
  const to = normalizePhone(application.phone);
  const templateId =
    kind === 'received' ? process.env.GUPSHUP_TPL_RECEIVED : process.env.GUPSHUP_TPL_STATUS_UPDATE;
  const entry = { kind, applicationStatus, templateId, to, status: 'submitted', createdAt: now, updatedAt: now };

  try {
    if (!isConfigured() || !templateId) {
      entry.status = 'skipped';
      entry.error = 'WhatsApp is not configured (missing Gupshup env vars or template id)';
    } else if (!to) {
      entry.status = 'skipped';
      entry.error = 'Phone number is not a valid WhatsApp number';
    } else if ((await sentTodayTo(to)) >= MAX_MESSAGES_PER_NUMBER_PER_DAY) {
      entry.status = 'skipped';
      entry.error = 'Daily message limit for this number reached';
    } else {
      const copy = STATUS_COPY[applicationStatus] || { label: applicationStatus, message: '' };
      const name = application.name;
      const title = job?.title || 'the position';
      const link = trackUrl(application._id);
      const id = String(application._id);
      const params =
        kind === 'received'
          ? [name, title, id]
          : [name, title, copy.label, copy.message, link];

      const result = await sendTemplate({
        to,
        templateId,
        params,
        buttonParam: kind === 'received' ? id : undefined,
      });
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

/** "Thanks for applying" message. Fire-and-forget safe. */
function notifyApplicationReceived(application, job) {
  return dispatch(application, job, 'received', 'received');
}

/** Status-change message. Skips statuses not in GUPSHUP_NOTIFY_STATUSES unless `force`. */
async function notifyStatusChange(application, job, status, { force = false } = {}) {
  if (!force && !notifyStatuses().includes(status)) return null;
  return dispatch(application, job, status === 'received' ? 'received' : 'status', status);
}

module.exports = {
  STATUS_COPY,
  notifyApplicationReceived,
  notifyStatusChange,
  trackUrl,
  notifyStatuses,
};
