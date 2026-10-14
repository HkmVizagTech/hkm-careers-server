/**
 * Document requests: HR asks a candidate for documents (or joining documents with bank details),
 * the candidate uploads them through a private link, HR reviews each one.
 *
 * Public (link holder):  GET  /api/documents/:token
 *                        POST /api/documents/:token/items/:itemId        (multipart "file")
 *                        DELETE /api/documents/:token/items/:itemId/files/:fileId
 *                        POST /api/documents/:token/bank
 *                        POST /api/documents/:token/submit
 * Admin:                 POST   /api/applications/:id/documents
 *                        GET    /api/applications/:id/documents/:rid/files/:fid
 *                        PATCH  /api/applications/:id/documents/:rid/items/:iid
 *                        POST   /api/applications/:id/documents/:rid/notify
 *                        GET    /api/applications/:id/documents/:rid/bank
 *                        DELETE /api/applications/:id/documents/:rid
 */
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const Application = require('../models/Application');
const { encryptText, decryptText, saveFile, readFile, deleteFile } = require('../utils/secureStore');
const { emailDocumentRequest, emailHrDocuments } = require('../utils/emailNotifications');
const { createAlert } = require('../utils/adminAlerts');
const { logActivity } = require('../utils/activity');

const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES_PER_ITEM = 5;
const DEFAULT_DAYS = 14;
const TYPES = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Files stay in memory only long enough to be encrypted. */
const uploadOne = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (TYPES[ext]) cb(null, true);
    else cb(Object.assign(new Error('Please upload a PDF, photo (JPG/PNG) or Word file'), { status: 400 }));
  },
}).single('file');

/** Runs multer and turns its errors into friendly 400s. */
function receiveFile(req, res, next) {
  uploadOne(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 10 MB. Please upload a smaller file.' : err.message;
    res.status(400).json({ message });
  });
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');

function siteUrl() {
  return (process.env.PUBLIC_SITE_URL || (process.env.CLIENT_URL || '').split(',')[0] || 'https://careers.harekrishnavizag.org')
    .trim()
    .replace(/\/+$/, '');
}
const linkFor = (token) => `${siteUrl()}/documents/${token}`;

const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** What an admin may see of a request (never the token or the encrypted account number). */
function adminView(r) {
  const o = r.toObject ? r.toObject() : r;
  const { tokenHash, tokenEnc, ...rest } = o; // eslint-disable-line no-unused-vars
  if (rest.bank) {
    const { accountEnc, ...bank } = rest.bank; // eslint-disable-line no-unused-vars
    rest.bank = bank;
  }
  rest.items = (rest.items || []).map((i) => ({ ...i, files: (i.files || []).map(({ storageKey, ...f }) => f) })); // eslint-disable-line no-unused-vars
  rest.expired = !!rest.expiresAt && new Date(rest.expiresAt) < new Date();
  return rest;
}

/** What the candidate sees on their upload page. */
function candidateView(app, r) {
  return {
    firstName: String(app.name || '').split(' ')[0],
    jobTitle: app.job?.title || '',
    applicationNumber: app.applicationNumber,
    kind: r.kind,
    message: r.message || '',
    status: r.status,
    expiresAt: r.expiresAt,
    items: r.items.map((i) => ({
      _id: i._id,
      label: i.label,
      hint: i.hint,
      required: i.required,
      status: i.status,
      note: i.status === 'rejected' ? i.note : undefined,
      files: i.files.map((f) => ({ _id: f._id, name: f.name, size: f.size, uploadedAt: f.uploadedAt })),
    })),
    bank: r.bank?.wanted
      ? {
          wanted: true,
          submitted: !!r.bank.submittedAt,
          holder: r.bank.holder,
          accountLast4: r.bank.accountLast4,
          ifsc: r.bank.ifsc,
          bankName: r.bank.bankName,
          branch: r.bank.branch,
          accountType: r.bank.accountType,
        }
      : { wanted: false },
  };
}

/** All required items approved and bank details in: the request is complete. */
function refreshCompletion(r) {
  const itemsDone = r.items.every((i) => i.status === 'approved' || (!i.required && !i.files.length));
  const bankDone = !r.bank?.wanted || !!r.bank.submittedAt;
  if (itemsDone && bankDone && r.status !== 'cancelled') {
    if (r.status !== 'completed') r.completedAt = new Date();
    r.status = 'completed';
  } else if (r.status === 'completed') {
    r.status = r.submittedAt ? 'submitted' : 'open';
  }
}

// ---------------------------------------------------------------- public (link holder)

/** Finds the application + request for a link token, or replies with an error. */
async function byToken(req, res) {
  const token = String(req.params.token || '');
  if (token.length < 20) {
    res.status(404).json({ message: 'This link is not valid.' });
    return null;
  }
  const hash = hashToken(token);
  const app = await Application.findOne({ 'documentRequests.tokenHash': hash })
    .select('name applicationNumber job documentRequests status email')
    .populate('job', 'title');
  const r = app?.documentRequests.find((x) => x.tokenHash === hash);
  if (!app || !r || r.status === 'cancelled') {
    res.status(404).json({ message: 'This link is no longer active. Please contact HR for a new one.' });
    return null;
  }
  if (r.expiresAt && r.expiresAt < new Date()) {
    res.status(410).json({ message: 'This link has expired. Please contact HR and they will send you a new one.' });
    return null;
  }
  return { app, r };
}

const getForCandidate = async (req, res, next) => {
  try {
    const found = await byToken(req, res);
    if (!found) return;
    res.json(candidateView(found.app, found.r));
  } catch (err) {
    next(err);
  }
};

const uploadItemFile = async (req, res, next) => {
  try {
    const found = await byToken(req, res);
    if (!found) return;
    const { app, r } = found;
    const item = r.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: 'Document not found' });
    if (item.status === 'approved') return res.status(400).json({ message: 'HR has already approved this document.' });
    if (!req.file) return res.status(400).json({ message: 'Please choose a file to upload' });
    if (item.files.length >= MAX_FILES_PER_ITEM) {
      return res.status(400).json({ message: `You can upload up to ${MAX_FILES_PER_ITEM} files for one document. Remove one first.` });
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    const storageKey = await saveFile(req.file.buffer, app._id);
    item.files.push({
      storageKey,
      name: clean(req.file.originalname, 150) || `document${ext}`,
      mime: TYPES[ext],
      size: req.file.size,
    });
    // A new file after a "please re-upload" goes back to HR for review.
    item.status = 'uploaded';
    await app.save();
    res.status(201).json(candidateView(app, r));
  } catch (err) {
    next(err);
  }
};

const removeItemFile = async (req, res, next) => {
  try {
    const found = await byToken(req, res);
    if (!found) return;
    const { app, r } = found;
    const item = r.items.id(req.params.itemId);
    const file = item?.files.id(req.params.fileId);
    if (!item || !file) return res.status(404).json({ message: 'File not found' });
    if (item.status === 'approved') return res.status(400).json({ message: 'HR has already approved this document.' });
    const key = file.storageKey;
    item.files.pull(file._id);
    if (!item.files.length) item.status = item.note ? 'rejected' : 'pending';
    await app.save();
    await deleteFile(key);
    res.json(candidateView(app, r));
  } catch (err) {
    next(err);
  }
};

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const saveBank = async (req, res, next) => {
  try {
    const found = await byToken(req, res);
    if (!found) return;
    const { app, r } = found;
    if (!r.bank?.wanted) return res.status(400).json({ message: 'Bank details were not requested.' });
    const holder = clean(req.body?.holder, 100);
    const account = String(req.body?.account || '').replace(/\s+/g, '');
    const ifsc = clean(req.body?.ifsc, 11).toUpperCase();
    const bankName = clean(req.body?.bankName, 100);
    const branch = clean(req.body?.branch, 100);
    const accountType = ['savings', 'current'].includes(req.body?.accountType) ? req.body.accountType : 'savings';
    if (!holder) return res.status(400).json({ message: 'Enter the account holder name' });
    if (!/^\d{9,18}$/.test(account)) return res.status(400).json({ message: 'Enter a valid account number (9 to 18 digits)' });
    if (!IFSC.test(ifsc)) return res.status(400).json({ message: 'Enter a valid IFSC code, e.g. SBIN0001234' });
    if (!bankName) return res.status(400).json({ message: 'Enter the bank name' });
    Object.assign(r.bank, {
      holder,
      accountEnc: encryptText(account),
      accountLast4: account.slice(-4),
      ifsc,
      bankName,
      branch,
      accountType,
      submittedAt: new Date(),
    });
    await app.save();
    res.json(candidateView(app, r));
  } catch (err) {
    next(err);
  }
};

const submit = async (req, res, next) => {
  try {
    const found = await byToken(req, res);
    if (!found) return;
    const { app, r } = found;
    const missing = r.items.filter((i) => i.required && !i.files.length).map((i) => i.label);
    if (missing.length) return res.status(400).json({ message: `Please upload: ${missing.join(', ')}` });
    if (r.bank?.wanted && !r.bank.submittedAt) return res.status(400).json({ message: 'Please fill in your bank details' });
    r.status = 'submitted';
    r.submittedAt = new Date();
    refreshCompletion(r);
    await app.save();

    const joining = r.kind === 'joining';
    await logActivity(app._id, {
      type: 'documents',
      text: `Uploaded ${joining ? 'joining ' : ''}documents (${r.items.filter((i) => i.files.length).length} of ${r.items.length})${r.bank?.wanted ? ' and bank details' : ''}`,
      byName: 'Candidate',
    });
    createAlert({
      type: 'documents',
      title: `${joining ? 'Joining documents' : 'Documents'} uploaded: ${app.name}`,
      message: `${app.applicationNumber || ''}${app.job?.title ? ` · ${app.job.title}` : ''} · ready for review`,
      link: `/admin/applications/${app._id}`,
      application: app._id,
      dedupeKey: `documents:${r._id}:${r.submittedAt.getTime()}`,
    });
    emailHrDocuments(app, app.job, r);
    res.json(candidateView(app, r));
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------- admin

async function loadForAdmin(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ message: 'Application not found' });
    return null;
  }
  const app = await Application.findById(req.params.id).populate('job', 'title');
  if (!app) {
    res.status(404).json({ message: 'Application not found' });
    return null;
  }
  return app;
}

const requestsOf = (app) => app.documentRequests.map(adminView).reverse();

// POST /api/applications/:id/documents { kind, items:[{label, required, hint}], message, wantBank, expiresInDays, notify }
const createRequest = async (req, res, next) => {
  try {
    const app = await loadForAdmin(req, res);
    if (!app) return;
    const kind = req.body?.kind === 'joining' ? 'joining' : 'documents';
    const seen = new Set();
    const items = (Array.isArray(req.body?.items) ? req.body.items : [])
      .map((i) => ({ label: clean(i?.label, 120), hint: clean(i?.hint, 200) || undefined, required: i?.required !== false }))
      .filter((i) => i.label && !seen.has(i.label.toLowerCase()) && seen.add(i.label.toLowerCase()))
      .slice(0, 20);
    const wantBank = req.body?.wantBank === true;
    if (!items.length && !wantBank) return res.status(400).json({ message: 'Add at least one document to request' });
    const days = Math.min(Math.max(parseInt(req.body?.expiresInDays, 10) || DEFAULT_DAYS, 1), 60);
    const token = newToken();
    app.documentRequests.push({
      kind,
      tokenHash: hashToken(token),
      tokenEnc: encryptText(token),
      expiresAt: new Date(Date.now() + days * 86400e3),
      message: String(req.body?.message || '').trim().slice(0, 2000) || undefined,
      items,
      bank: { wanted: wantBank },
      createdBy: req.user._id,
    });
    await app.save();
    const r = app.documentRequests[app.documentRequests.length - 1];

    let email = null;
    if (req.body?.notify !== false) {
      email = await emailDocumentRequest(app, app.job, r, { link: linkFor(token), sender: req.user });
    }
    await logActivity(app._id, {
      type: 'documents',
      text: `Requested ${kind === 'joining' ? 'joining documents' : 'documents'}: ${[...items.map((i) => i.label), ...(wantBank ? ['bank details'] : [])].join(', ')}${email?.status === 'sent' ? ' (emailed the link)' : ''}`,
      by: req.user,
    });
    const fresh = await Application.findById(app._id).select('documentRequests');
    res.status(201).json({ requests: requestsOf(fresh), link: linkFor(token), email });
  } catch (err) {
    next(err);
  }
};

// GET /api/applications/:id/documents/:rid/files/:fid?inline=1
const downloadFile = async (req, res, next) => {
  try {
    const app = await loadForAdmin(req, res);
    if (!app) return;
    const r = app.documentRequests.id(req.params.rid);
    const item = r?.items.find((i) => i.files.id(req.params.fid));
    const file = item?.files.id(req.params.fid);
    if (!file) return res.status(404).json({ message: 'File not found' });
    const buf = await readFile(file.storageKey);
    const ext = path.extname(file.name).toLowerCase() || '.pdf';
    const niceName = `${app.applicationNumber || 'APP'}_${item.label}`.replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s+/g, '_') + ext;
    res.set('Content-Type', file.mime || TYPES[ext] || 'application/octet-stream');
    res.set('Content-Length', String(buf.length));
    res.set('Cache-Control', 'private, no-store');
    res.set('Access-Control-Expose-Headers', 'Content-Disposition');
    res.set(
      'Content-Disposition',
      `${req.query.inline ? 'inline' : 'attachment'}; filename="${niceName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(niceName)}`
    );
    res.send(buf);
  } catch (err) {
    next(err);
  }
};

// PATCH /api/applications/:id/documents/:rid/items/:iid { status: 'approved'|'rejected', note }
const reviewItem = async (req, res, next) => {
  try {
    const app = await loadForAdmin(req, res);
    if (!app) return;
    const r = app.documentRequests.id(req.params.rid);
    const item = r?.items.id(req.params.iid);
    if (!item) return res.status(404).json({ message: 'Document not found' });
    const status = req.body?.status;
    if (!['approved', 'rejected', 'uploaded'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
    if (status === 'approved' && !item.files.length) return res.status(400).json({ message: 'Nothing has been uploaded yet' });
    item.status = status;
    item.note = status === 'rejected' ? clean(req.body?.note, 500) || 'Please upload a clearer copy.' : undefined;
    if (status === 'rejected' && r.status === 'submitted') r.status = 'open';
    refreshCompletion(r);
    await app.save();
    await logActivity(app._id, {
      type: 'documents',
      text: status === 'approved' ? `Approved "${item.label}"` : status === 'rejected' ? `Asked to re-upload "${item.label}": ${item.note}` : `Marked "${item.label}" for review again`,
      by: req.user,
    });
    if (r.status === 'completed') {
      await logActivity(app._id, { type: 'documents', text: `All ${r.kind === 'joining' ? 'joining ' : ''}documents approved`, by: req.user });
    }
    res.json({ requests: requestsOf(app) });
  } catch (err) {
    next(err);
  }
};

// POST /api/applications/:id/documents/:rid/notify  -> sends the link again (re-upload list if any were rejected)
const notifyCandidate = async (req, res, next) => {
  try {
    const app = await loadForAdmin(req, res);
    if (!app) return;
    const r = app.documentRequests.id(req.params.rid);
    if (!r || r.status === 'cancelled') return res.status(404).json({ message: 'Request not found' });
    let token;
    try {
      token = decryptText(r.tokenEnc);
    } catch {
      // Key changed: issue a fresh link.
      token = newToken();
      r.tokenHash = hashToken(token);
      r.tokenEnc = encryptText(token);
    }
    // Sending again keeps the link working for another two weeks.
    const until = new Date(Date.now() + DEFAULT_DAYS * 86400e3);
    if (!r.expiresAt || r.expiresAt < until) r.expiresAt = until;
    await app.save();
    const reupload = r.items.some((i) => i.status === 'rejected');
    const email = await emailDocumentRequest(app, app.job, r, { link: linkFor(token), reminder: !reupload, reupload, sender: req.user });
    if (email?.notConfigured) return res.status(503).json({ message: 'Email is not set up yet.' });
    await logActivity(app._id, {
      type: 'documents',
      text: reupload ? 'Emailed the candidate to re-upload documents' : 'Sent the document upload link again',
      by: req.user,
    });
    res.json({ email, link: linkFor(token), requests: requestsOf(app) });
  } catch (err) {
    next(err);
  }
};

// GET /api/applications/:id/documents/:rid/bank -> full account number (logged)
const revealBank = async (req, res, next) => {
  try {
    const app = await loadForAdmin(req, res);
    if (!app) return;
    const r = app.documentRequests.id(req.params.rid);
    if (!r?.bank?.accountEnc) return res.status(404).json({ message: 'No bank details yet' });
    const account = decryptText(r.bank.accountEnc);
    await logActivity(app._id, { type: 'documents', text: 'Viewed the full bank account number', by: req.user });
    res.set('Cache-Control', 'private, no-store');
    res.json({ account });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/applications/:id/documents/:rid -> removes the request, its files and stops the link
const deleteRequest = async (req, res, next) => {
  try {
    const app = await loadForAdmin(req, res);
    if (!app) return;
    const r = app.documentRequests.id(req.params.rid);
    if (!r) return res.status(404).json({ message: 'Request not found' });
    const keys = r.items.flatMap((i) => i.files.map((f) => f.storageKey));
    const label = r.kind === 'joining' ? 'joining documents' : 'documents';
    app.documentRequests.pull(r._id);
    await app.save();
    await Promise.all(keys.map(deleteFile));
    await logActivity(app._id, { type: 'documents', text: `Deleted the request for ${label}${keys.length ? ` and ${keys.length} uploaded file${keys.length === 1 ? '' : 's'}` : ''}`, by: req.user });
    res.json({ requests: requestsOf(app) });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  receiveFile,
  getForCandidate,
  uploadItemFile,
  removeItemFile,
  saveBank,
  submit,
  createRequest,
  downloadFile,
  reviewItem,
  notifyCandidate,
  revealBank,
  deleteRequest,
  adminView,
  _hashToken: hashToken,
};
