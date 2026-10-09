/**
 * Branded HTML emails (table layout + inline styles so they render in Gmail, Outlook and phones).
 * Every builder returns { subject, html, text }.
 */
const { formatIST } = require('./dates');
const { interviewPlace } = require('./interviewPlace');

const C = {
  navy: '#052057',
  ocean: '#0f618a',
  cyan: '#2bcdee',
  gold: '#f6b828',
  text: '#1f2937',
  muted: '#6b7280',
  line: '#e5e7eb',
  bg: '#f3f6fb',
};

const ORG = 'Hare Krishna Movement, Visakhapatnam';
// HR contact in every email footer (override with HR_CONTACT_EMAIL / HR_CONTACT_PHONE).
const HR = {
  email: process.env.HR_CONTACT_EMAIL || 'hrexecutive@hkmvizag.org',
  phone: process.env.HR_CONTACT_PHONE || '+91 70751 26644',
};

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function siteUrl() {
  return (process.env.PUBLIC_SITE_URL || (process.env.CLIENT_URL || '').split(',')[0] || 'https://careers.harekrishnavizag.org')
    .trim()
    .replace(/\/+$/, '');
}
const trackLink = (app) => `${siteUrl()}/track?id=${encodeURIComponent(app.applicationNumber || String(app._id))}`;
const adminLink = (app) => `${siteUrl()}/admin/applications/${app._id}`;
const appNo = (app) => app.applicationNumber || String(app._id);

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px"><tr><td style="border-radius:10px;background:${C.navy}">
<a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px">${esc(label)}</a>
</td></tr></table>`;
}

function detailRows(rows) {
  const body = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(
      ([k, v, isHtml]) => `<tr>
<td style="padding:9px 12px;border-bottom:1px solid ${C.line};font-size:13px;color:${C.muted};white-space:nowrap;vertical-align:top">${esc(k)}</td>
<td style="padding:9px 12px;border-bottom:1px solid ${C.line};font-size:14px;color:${C.text};font-weight:600;word-break:break-word">${isHtml ? v : esc(v)}</td></tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border:1px solid ${C.line};border-radius:10px;border-collapse:separate;overflow:hidden">${body}</table>`;
}

/** Message text from an admin -> paragraphs; everything escaped, URLs made clickable. */
function textToHtml(text) {
  return esc(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:' + C.ocean + '">$1</a>')}</p>`)
    .join('');
}

function layout({ preheader, heading, bodyHtml, footerNote }) {
  // White-text logo on the navy header band.
  const logo = `${siteUrl()}/brand/hkm-logo-white.png`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">
<tr><td style="background:${C.navy};padding:20px 28px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${esc(logo)}" width="130" height="70" alt="Hare Krishna Movement Visakhapatnam" style="display:block;height:70px;width:auto;border:0;color:#ffffff;font-weight:bold;font-size:14px"></td>
    <td align="right" style="color:${C.cyan};font-size:11px;font-weight:bold;letter-spacing:2px">CAREERS</td>
  </tr></table>
</td></tr>
<tr><td style="height:4px;background:linear-gradient(90deg,${C.ocean},${C.cyan},${C.gold});background-color:${C.cyan}"></td></tr>
<tr><td style="padding:28px 28px 8px;color:${C.text};font-size:15px;line-height:1.6">
  <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:${C.navy}">${esc(heading)}</h1>
  ${bodyHtml}
</td></tr>
<tr><td style="padding:8px 28px 28px;color:${C.muted};font-size:12px;line-height:1.6;border-top:1px solid ${C.line}">
  ${footerNote ? `<p style="margin:14px 0 6px">${footerNote}</p>` : ''}
  <p style="margin:${footerNote ? 0 : '14px'} 0 0">${ORG} · <a href="${esc(siteUrl())}" style="color:${C.ocean}">${esc(siteUrl().replace(/^https?:\/\//, ''))}</a></p>
  <p style="margin:6px 0 0">HR: <a href="mailto:${esc(HR.email)}" style="color:${C.ocean}">${esc(HR.email)}</a> · <a href="tel:${esc(HR.phone.replace(/\s/g, ''))}" style="color:${C.ocean}">${esc(HR.phone)}</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
}

const textFooter = () => `\n\n—\n${ORG}\n${siteUrl()}\nHR: ${HR.email} · ${HR.phone}`;

// ---------------------------------------------------------------- candidate emails

function applicationReceived(app, job) {
  const title = job?.title || 'the position';
  const subject = `Application received: ${title} (${appNo(app)})`;
  const html = layout({
    preheader: `We have received your application for ${title}.`,
    heading: 'We have received your application',
    bodyHtml: `<p style="margin:0 0 14px">Hare Krishna ${esc(app.name)} 🙏</p>
<p style="margin:0 0 14px">Thank you for applying for the position of <strong>${esc(title)}</strong>. Your application has been received successfully. Our HR team will review it and get back to you regarding the next steps.</p>
${detailRows([['Application No.', appNo(app)], ['Position', title], ['Applied on', formatIST(app.createdAt || new Date(), false, true)]])}
<p style="margin:0">Please keep your application number for reference. You can check your status anytime:</p>
${button(trackLink(app), 'Track your application')}`,
    footerNote: 'Thank you for your interest in serving with Hare Krishna Movement.',
  });
  const text = `Hare Krishna ${app.name},\n\nWe have received your application for the position of ${title}.\nApplication No.: ${appNo(app)}\n\nOur HR team will review your application and get back to you regarding the next steps.\nTrack your application: ${trackLink(app)}\n\nThank you for your interest in serving with Hare Krishna Movement.${textFooter()}`;
  return { subject, html, text };
}

function statusUpdate(app, job, copy) {
  const title = job?.title || 'the position';
  const subject = `Update on your application: ${title} (${appNo(app)})`;
  const tone = copy.label === 'Not Selected' ? '#6b7280' : copy.label === 'Selected' ? '#059669' : C.ocean;
  const html = layout({
    preheader: `Application status: ${copy.label}`,
    heading: 'There is an update on your application',
    bodyHtml: `<p style="margin:0 0 14px">Hare Krishna ${esc(app.name)} 🙏</p>
<p style="margin:0 0 6px">Your application for the position of <strong>${esc(title)}</strong> has been updated.</p>
${detailRows([
  ['Application No.', appNo(app)],
  ['Status', `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${tone};color:#ffffff;font-size:13px">${esc(copy.label)}</span>`, true],
])}
<p style="margin:0">${esc(copy.message)}</p>
${button(trackLink(app), 'Track your application')}`,
    footerNote: 'Thank you for your interest in serving with Hare Krishna Movement.',
  });
  const text = `Hare Krishna ${app.name},\n\nThere is an update on your application for the position of ${title}.\nApplication No.: ${appNo(app)}\nApplication Status: ${copy.label}\n\n${copy.message}\n\nTrack your application: ${trackLink(app)}${textFooter()}`;
  return { subject, html, text };
}

const MODE_LABEL = { 'in-person': 'In person', phone: 'Phone call', video: 'Video call' };

function googleCalendarLink(app, job) {
  const iv = app.interview;
  const start = new Date(iv.scheduledAt);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Interview: ${job?.title || 'Hare Krishna Movement'}`,
    dates: `${fmt(start)}/${fmt(end)}`,
    details: `Interview with ${ORG}. Application No.: ${appNo(app)}`,
    location: [interviewPlace(iv).venue, interviewPlace(iv).link].filter(Boolean).join(' '),
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

function interviewScheduled(app, job) {
  const title = job?.title || 'the position';
  const iv = app.interview || {};
  const when = formatIST(iv.scheduledAt, true, true);
  const mode = MODE_LABEL[iv.mode] || 'In person';
  const { venue, link } = interviewPlace(iv);
  const linkHtml = link ? `<a href="${esc(link)}" style="color:${C.ocean}">${esc(link)}</a>` : '';
  const isVideo = iv.mode === 'video';
  const subject = `Interview scheduled: ${title} on ${when}`;
  const html = layout({
    preheader: `Your interview is on ${when}.`,
    heading: 'Your interview has been scheduled',
    bodyHtml: `<p style="margin:0 0 14px">Hare Krishna ${esc(app.name)} 🙏</p>
<p style="margin:0 0 6px">Your interview for the position of <strong>${esc(title)}</strong> has been scheduled.</p>
${detailRows([
  ['Date & time', `${when} (IST)`],
  ['Mode', mode],
  ...(isVideo
    ? [['Meeting link', linkHtml || 'HR will share the details with you', true]]
    : [
        [iv.mode === 'phone' ? 'Details' : 'Venue', venue || (link ? '' : 'HR will share the details with you')],
        ...(link ? [['Location', linkHtml, true]] : []),
      ]),
  ['Application No.', appNo(app)],
])}
<p style="margin:0">Please be available on time. If you have any questions, simply reply to this email.</p>
${link ? button(link, isVideo ? 'Join the meeting' : 'Open in Google Maps') : ''}
<p style="margin:14px 0 0;font-size:13px"><a href="${esc(googleCalendarLink(app, job))}" style="color:${C.ocean}">Add to Google Calendar</a> · <a href="${esc(trackLink(app))}" style="color:${C.ocean}">Track your application</a></p>`,
    footerNote: 'Thank you for your interest in serving with Hare Krishna Movement.',
  });
  const text = `Hare Krishna ${app.name},\n\nYour interview for the position of ${title} has been scheduled.\n\nDate & Time: ${when} (IST)\nMode: ${mode}\n${isVideo ? 'Meeting link' : 'Venue'}: ${[venue, link].filter(Boolean).join(' - ') || 'HR will share the details with you'}\n\nPlease be available on time. If you have any questions, reply to this email.\nTrack your application: ${trackLink(app)}${textFooter()}`;
  return { subject, html, text };
}

/** Free-form email an admin writes from the application page. */
function customMessage(app, job, { subject, message, senderName }) {
  const html = layout({
    preheader: String(message).slice(0, 120),
    heading: subject,
    bodyHtml: `<p style="margin:0 0 14px">Hare Krishna ${esc(app.name)} 🙏</p>
${textToHtml(message)}
<p style="margin:18px 0 0">Regards,<br><strong>${esc(senderName || 'HR Team')}</strong><br><span style="color:${C.muted}">HR Team, ${ORG}</span></p>
${detailRows([['Application No.', appNo(app)], ['Position', job?.title || '']])}`,
    footerNote: 'You can reply directly to this email.',
  });
  const text = `Hare Krishna ${app.name},\n\n${message}\n\nRegards,\n${senderName || 'HR Team'}\nHR Team, ${ORG}\n\nApplication No.: ${appNo(app)}${job?.title ? `\nPosition: ${job.title}` : ''}${textFooter()}`;
  return { subject, html, text };
}

// ---------------------------------------------------------------- HR email

function hrNewApplication(app, job, { hasAttachment }) {
  const title = job?.title || 'a position';
  const subject = `New application: ${app.name} for ${title} (${appNo(app)})`;
  const experience = app.isExperienced
    ? `${app.yearsOfExperience ?? '?'} yrs${app.lastEmployer ? `, last at ${app.lastEmployer}` : ''}`
    : 'Fresher';
  const html = layout({
    preheader: `${app.name} applied for ${title}.`,
    heading: `New application for ${title}`,
    bodyHtml: `${detailRows([
      ['Application No.', appNo(app)],
      ['Name', app.name],
      ['Phone', app.phone],
      ['Email', `<a href="mailto:${esc(app.email)}" style="color:${C.ocean}">${esc(app.email)}</a>`, true],
      ['Location', app.currentLocation || app.location],
      ['Experience', experience],
      ['Available to join', app.availableToJoin],
      ['Education', [app.highestDegree, app.collegeName, app.studyYears].filter(Boolean).join(', ')],
      ['Came from', app.source || 'Careers site (direct)'],
    ])}
${app.coverLetter ? `<p style="margin:0 0 6px;font-size:13px;color:${C.muted}">Why should we hire them?</p><div style="padding:12px 14px;border-left:3px solid ${C.cyan};background:#f8fafc;font-size:14px">${textToHtml(app.coverLetter.slice(0, 1500))}</div>` : ''}
<p style="margin:16px 0 0">${hasAttachment ? 'The resume is attached.' : 'The resume is available in the admin panel.'}</p>
${button(adminLink(app), 'Open in admin')}`,
    footerNote: 'You get this because your address is in HR_NOTIFY_EMAILS.',
  });
  const text = `New application for ${title}\n\nApplication No.: ${appNo(app)}\nName: ${app.name}\nPhone: ${app.phone}\nEmail: ${app.email}\nExperience: ${experience}\n\nOpen in admin: ${adminLink(app)}`;
  return { subject, html, text };
}

function testEmail(toName) {
  return {
    subject: 'Test email from HKM Vizag Careers',
    html: layout({
      heading: 'Email is working 🎉',
      bodyHtml: `<p style="margin:0 0 14px">Hare Krishna ${esc(toName || '')} 🙏</p><p style="margin:0">This test confirms the careers site can send emails. Candidates will now get application, status and interview emails alongside WhatsApp.</p>`,
    }),
    text: 'This test confirms the careers site can send emails.',
  };
}

module.exports = {
  applicationReceived,
  statusUpdate,
  interviewScheduled,
  customMessage,
  hrNewApplication,
  testEmail,
  esc,
  siteUrl,
};
