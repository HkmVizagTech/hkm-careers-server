/**
 * Email sending for the careers site. Two ways to send, picked from the env vars that are set:
 *
 * 1) Gmail API (recommended on Railway: plain HTTPS, so it works on every plan)
 *      GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *      The refresh token belongs to the Google account that sends (e.g. careers@harekrishnavizag.org).
 *
 * 2) SMTP (Gmail / Google Workspace app password, Zoho, ...). Railway only allows outbound SMTP
 *    on its higher plans; elsewhere it times out.
 *      SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 465), SMTP_USER, SMTP_PASS
 *
 * Common:
 *   MAIL_FROM       e.g. "HKM Vizag Careers <careers@harekrishnavizag.org>"
 *   MAIL_REPLY_TO   where candidate replies go (optional)
 *   HR_NOTIFY_EMAILS  comma-separated inboxes for "new application" emails (optional)
 *
 * sendMail() never throws: it resolves { ok, messageId?, error?, via }.
 */
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');

const TIMEOUT_MS = () => Number(process.env.MAIL_TIMEOUT_MS) || 20000;

function transportKind() {
  const forced = (process.env.MAIL_TRANSPORT || '').toLowerCase();
  const gmailReady = !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
  const smtpReady = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
  if (forced === 'gmail-api') return gmailReady ? 'gmail-api' : null;
  if (forced === 'smtp') return smtpReady ? 'smtp' : null;
  if (gmailReady) return 'gmail-api';
  if (smtpReady) return 'smtp';
  return null;
}

function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || '';
}

function isMailConfigured() {
  return !!transportKind() && !!fromAddress();
}

/** Basic sanity check; we never mail an address that is obviously broken. */
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(email.trim());
}

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms).unref?.()),
  ]);

// ---------------------------------------------------------------- Gmail API

let cachedToken = null; // { token, expiresAt }

async function gmailAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Gmail sign-in failed: ${data.error_description || data.error || `HTTP ${res.status}`}`);
  }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cachedToken.token;
}

async function sendViaGmailApi(message) {
  const raw = await new MailComposer(message).compile().build();
  const token = await gmailAccessToken();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: raw.toString('base64url') }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) cachedToken = null;
    throw new Error(`Gmail API: ${data.error?.message || `HTTP ${res.status}`}`);
  }
  return data.id;
}

// ---------------------------------------------------------------- SMTP

let smtpTransport = null;

function getSmtpTransport() {
  if (!smtpTransport) {
    const port = Number(process.env.SMTP_PORT) || 465;
    smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      ...(process.env.SMTP_TLS_INSECURE === 'true' ? { tls: { rejectUnauthorized: false } } : {}),
    });
  }
  return smtpTransport;
}

/**
 * @param {{ to: string|string[], subject: string, html: string, text?: string, replyTo?: string,
 *           attachments?: { filename: string, content: Buffer, contentType?: string }[] }} mail
 */
async function sendMail(mail) {
  const via = transportKind();
  if (!via || !fromAddress()) return { ok: false, skipped: true, error: 'Email is not set up (see MAIL_* settings)', via };

  const recipients = (Array.isArray(mail.to) ? mail.to : [mail.to]).map((t) => String(t || '').trim()).filter(isValidEmail);
  if (!recipients.length) return { ok: false, skipped: true, error: 'No valid email address', via };

  const message = {
    from: fromAddress(),
    to: recipients.join(', '),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    replyTo: mail.replyTo || process.env.MAIL_REPLY_TO || undefined,
    attachments: mail.attachments,
    headers: { 'X-Entity-Ref-ID': `careers-${Date.now()}` }, // stops Gmail threading unrelated mails
  };

  try {
    if (via === 'gmail-api') {
      const id = await withTimeout(sendViaGmailApi(message), TIMEOUT_MS(), 'Gmail API');
      return { ok: true, messageId: id, via };
    }
    const info = await withTimeout(getSmtpTransport().sendMail(message), TIMEOUT_MS(), 'SMTP');
    return { ok: true, messageId: info.messageId, via };
  } catch (err) {
    const error = /timed out|ETIMEDOUT|ECONNREFUSED|ESOCKET/i.test(err.message) && via === 'smtp'
      ? `${err.message}. If this runs on Railway, outbound SMTP may be blocked on your plan; use the Gmail API settings instead.`
      : err.message;
    console.error(`[mail] send failed via ${via}:`, error);
    return { ok: false, error: error.slice(0, 300), via };
  }
}

/** For tests: drop cached clients after env changes. */
function _reset() {
  cachedToken = null;
  smtpTransport = null;
}

module.exports = { sendMail, isMailConfigured, isValidEmail, transportKind, fromAddress, _reset };
