/**
 * Email sending for the careers site. Picked from the env vars that are set (first match wins):
 *
 * 1) Microsoft Graph (Microsoft 365 app registration with the Mail.Send application permission)
 *      MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET   (sends as the MAIL_FROM mailbox)
 *
 * 2) Gmail API
 *      GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *
 * 3) SMTP with the mailbox's own email + password (Microsoft 365, Gmail app password, Zoho, ...)
 *      SMTP_USER, SMTP_PASS, SMTP_HOST (default: smtp.office365.com for Microsoft domains, else smtp.gmail.com),
 *      SMTP_PORT (default 587 for Microsoft 365 with STARTTLS, 465 otherwise)
 *    Microsoft 365 turns password (basic auth) SMTP off by default at the end of December 2026;
 *    move to option 1 before then.
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
  const graphReady = !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
  const gmailReady = !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
  const smtpReady = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
  if (forced === 'graph') return graphReady ? 'graph' : null;
  if (forced === 'gmail-api') return gmailReady ? 'gmail-api' : null;
  if (forced === 'smtp') return smtpReady ? 'smtp' : null;
  if (graphReady) return 'graph';
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

// ---------------------------------------------------------------- Microsoft Graph

let graphToken = null; // { token, expiresAt }

/** The bare address in MAIL_FROM ("HKM Vizag Careers <careers@x.org>" -> careers@x.org). */
function fromEmail() {
  const from = fromAddress();
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

async function graphAccessToken() {
  if (graphToken && graphToken.expiresAt > Date.now() + 60_000) return graphToken.token;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(process.env.MS_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Microsoft sign-in failed: ${data.error_description?.split('\r\n')[0] || data.error || `HTTP ${res.status}`}`);
  }
  graphToken = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return graphToken.token;
}

/** Graph accepts the whole message as base64 MIME, so attachments and Reply-To work as in Gmail. */
async function sendViaGraph(message) {
  const raw = await new MailComposer(message).compile().build();
  const token = await graphAccessToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail())}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: raw.toString('base64'),
  });
  if (!res.ok) {
    if (res.status === 401) graphToken = null;
    const data = await res.json().catch(() => ({}));
    const msg = data.error?.message || `HTTP ${res.status}`;
    const hint =
      res.status === 403
        ? ' (the app needs the Mail.Send application permission with admin consent, and access to this mailbox)'
        : res.status === 404
          ? ' (MAIL_FROM must be a real mailbox in your Microsoft 365)'
          : '';
    throw new Error(`Microsoft Graph: ${msg}${hint}`);
  }
  return res.headers.get('request-id') || 'graph';
}

// ---------------------------------------------------------------- SMTP

const isMicrosoftHost = (host) => /office365|outlook|microsoft/i.test(host || '');

function smtpHost() {
  if (process.env.SMTP_HOST) return process.env.SMTP_HOST;
  // Gmail addresses use Gmail; everything else (like hkmvizag.org on Microsoft 365) defaults to Microsoft.
  return /@(gmail|googlemail)\.com$/i.test(process.env.SMTP_USER || '') ? 'smtp.gmail.com' : 'smtp.office365.com';
}

/** Turn the usual Microsoft 365 / Gmail SMTP errors into something HR can act on. */
function explainSmtpError(message) {
  if (/5\.7\.139|SmtpClientAuthentication is disabled/i.test(message)) {
    return 'Microsoft 365 has SMTP sign-in turned off for this mailbox. In the Microsoft 365 admin centre: Users > this user > Mail > Manage email apps > tick "Authenticated SMTP".';
  }
  if (/security defaults|5\.7\.57|basic authentication is disabled/i.test(message)) {
    return 'Microsoft 365 is blocking password sign-in (Security defaults or MFA). Use the Microsoft Graph settings instead (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET).';
  }
  if (/535|Invalid login|authentication unsuccessful|Username and Password not accepted/i.test(message)) {
    return 'The email or password was not accepted. Check SMTP_USER and SMTP_PASS (for Gmail, use an app password).';
  }
  if (/5\.7\.60|SendAsDenied|not allowed to send as/i.test(message)) {
    return `This mailbox is not allowed to send as ${fromEmail()}. Set MAIL_FROM to the same address as SMTP_USER.`;
  }
  if (/timed out|ETIMEDOUT|ECONNREFUSED|ESOCKET/i.test(message)) {
    return `${message}. The mail server could not be reached on port ${Number(process.env.SMTP_PORT) || ''} — check SMTP_HOST / SMTP_PORT.`;
  }
  return message;
}

let smtpTransport = null;

function getSmtpTransport() {
  if (!smtpTransport) {
    const host = smtpHost();
    const port = Number(process.env.SMTP_PORT) || (isMicrosoftHost(host) ? 587 : 465);
    const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
    const local = /^(localhost|127\.)/.test(host);
    smtpTransport = nodemailer.createTransport({
      host,
      port,
      secure,
      // STARTTLS on 587: never send the password unencrypted (a local test server is the only exception).
      requireTLS: !secure && !local && process.env.SMTP_REQUIRE_TLS !== 'false',
      tls: { minVersion: 'TLSv1.2', ...(process.env.SMTP_TLS_INSECURE === 'true' ? { rejectUnauthorized: false } : {}) },
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
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
    if (via === 'graph') {
      const id = await withTimeout(sendViaGraph(message), TIMEOUT_MS(), 'Microsoft Graph');
      return { ok: true, messageId: id, via };
    }
    if (via === 'gmail-api') {
      const id = await withTimeout(sendViaGmailApi(message), TIMEOUT_MS(), 'Gmail API');
      return { ok: true, messageId: id, via };
    }
    const info = await withTimeout(getSmtpTransport().sendMail(message), TIMEOUT_MS(), 'SMTP');
    return { ok: true, messageId: info.messageId, via };
  } catch (err) {
    const error = via === 'smtp' ? explainSmtpError(err.message) : err.message;
    console.error(`[mail] send failed via ${via}:`, error);
    return { ok: false, error: error.slice(0, 300), via };
  }
}

/** For tests: drop cached clients after env changes. */
function _reset() {
  cachedToken = null;
  graphToken = null;
  smtpTransport = null;
}

/** For the admin settings card: where mail goes out from (no secrets). */
function transportDetails() {
  const via = transportKind();
  if (via === 'smtp') return { host: smtpHost(), port: Number(process.env.SMTP_PORT) || (isMicrosoftHost(smtpHost()) ? 587 : 465), user: process.env.SMTP_USER };
  if (via === 'graph') return { mailbox: fromEmail() };
  return {};
}

module.exports = { sendMail, isMailConfigured, isValidEmail, transportKind, transportDetails, fromAddress, explainSmtpError, _reset };
