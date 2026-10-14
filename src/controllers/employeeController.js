/**
 * Employees: HR's own record for each staff member, kept separately from job applications.
 *
 *   GET    /api/employees                       list (q, status, department)
 *   POST   /api/employees                       add by hand
 *   POST   /api/employees/from-application/:appId   copy a selected applicant's details, documents and bank details
 *   GET    /api/employees/:id
 *   PUT    /api/employees/:id                   update any of the details
 *   DELETE /api/employees/:id                   delete the record and its files
 *   GET    /api/employees/:id/reveal/:field     full Aadhaar / PAN / bank account number (logged)
 *   POST   /api/employees/:id/documents         upload (multipart "file", field "label")
 *   PATCH  /api/employees/:id/documents/:fid    rename { label }
 *   GET    /api/employees/:id/documents/:fid    download (decrypted)
 *   DELETE /api/employees/:id/documents/:fid
 */
const path = require('path');
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const Application = require('../models/Application');
const Department = require('../models/Department');
const { encryptText, decryptText, saveFile, readFile, deleteFile } = require('../utils/secureStore');
const { readResumeBuffer } = require('../utils/resumeFile');
const { logActivity } = require('../utils/activity');

const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (v, max = 500) => String(v ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const MAX_DOCS = 100;

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

const AADHAAR = /^\d{12}$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const FIELD_LABEL = {
  employeeId: 'employee ID',
  name: 'name',
  designation: 'designation',
  department: 'department',
  joiningDate: 'joining date',
  status: 'status',
  leavingDate: 'leaving date',
  email: 'email',
  phone: 'phone',
  altPhone: 'alternate phone',
  currentAddress: 'current address',
  permanentAddress: 'permanent address',
  emergencyContact: 'emergency contact',
  gender: 'gender',
  dateOfBirth: 'date of birth',
  bloodGroup: 'blood group',
  aadhaar: 'Aadhaar number',
  pan: 'PAN',
  bank: 'bank details',
  notes: 'notes',
};

/** What the admin pages see: no encrypted values or storage keys. */
function view(emp) {
  const o = emp.toObject ? emp.toObject() : emp;
  const { aadhaarEnc, panEnc, ...rest } = o; // eslint-disable-line no-unused-vars
  if (rest.bank) {
    const { accountEnc, ...bank } = rest.bank; // eslint-disable-line no-unused-vars
    rest.bank = bank;
  }
  rest.documents = (rest.documents || []).map(({ storageKey, ...d }) => d); // eslint-disable-line no-unused-vars
  rest.hasAadhaar = !!aadhaarEnc;
  rest.hasPan = !!panEnc;
  rest.activity = [...(rest.activity || [])].reverse();
  return rest;
}

const log = (emp, text, user) => emp.activity.push({ text: text.slice(0, 500), by: user?._id, byName: user?.name });

function parseDate(v) {
  if (v === '' || v === null) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Apply the allowed fields from a form to an employee. Returns { error } or { changed: [labels] }.
 * Fields that aren't sent are left alone; an empty string clears a field.
 */
async function applyFields(emp, body = {}) {
  const changed = new Set();
  const setIf = (key, value) => {
    const before = emp[key] instanceof Date ? emp[key].getTime() : emp[key] ?? '';
    const after = value instanceof Date ? value.getTime() : value ?? '';
    if (String(before) !== String(after)) {
      emp[key] = value === '' || value === null ? undefined : value;
      changed.add(FIELD_LABEL[key] || key);
    }
  };

  if (body.employeeId !== undefined) setIf('employeeId', clean(body.employeeId, 40).toUpperCase());
  const text = { name: 120, designation: 120, email: 200, phone: 20, altPhone: 20, gender: 20 };
  for (const [k, max] of Object.entries(text)) if (body[k] !== undefined) setIf(k, clean(body[k], max));
  for (const k of ['currentAddress', 'permanentAddress']) if (body[k] !== undefined) setIf(k, cleanText(body[k], 500));
  if (body.notes !== undefined) setIf('notes', cleanText(body.notes, 3000));
  if (body.name !== undefined && !emp.name) return { error: 'Name is required' };
  if (body.email !== undefined && emp.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emp.email)) return { error: 'Enter a valid email address' };

  if (body.bloodGroup !== undefined) {
    const bg = clean(body.bloodGroup, 5).toUpperCase();
    if (bg && !BLOOD.includes(bg)) return { error: 'Choose a valid blood group' };
    setIf('bloodGroup', bg);
  }
  if (body.status !== undefined) {
    if (!['active', 'left'].includes(body.status)) return { error: 'Invalid status' };
    setIf('status', body.status);
  }
  for (const k of ['joiningDate', 'leavingDate', 'dateOfBirth']) {
    if (body[k] === undefined) continue;
    const d = parseDate(body[k]);
    if (d === undefined) return { error: `Invalid ${FIELD_LABEL[k]}` };
    setIf(k, d);
  }
  if (body.department !== undefined) {
    if (body.department && !mongoose.isValidObjectId(body.department)) return { error: 'Invalid department' };
    if (body.department && !(await Department.exists({ _id: body.department }))) return { error: 'Department not found' };
    const before = emp.department ? String(emp.department._id || emp.department) : '';
    if (before !== String(body.department || '')) {
      emp.department = body.department || undefined;
      changed.add(FIELD_LABEL.department);
    }
  }
  if (body.emergencyContact && typeof body.emergencyContact === 'object') {
    const ec = {
      name: clean(body.emergencyContact.name, 120),
      relationship: clean(body.emergencyContact.relationship, 60),
      phone: clean(body.emergencyContact.phone, 20),
    };
    const prev = emp.emergencyContact || {};
    if (ec.name !== (prev.name || '') || ec.relationship !== (prev.relationship || '') || ec.phone !== (prev.phone || '')) {
      emp.emergencyContact = ec;
      changed.add(FIELD_LABEL.emergencyContact);
    }
  }

  // Sensitive numbers: only replaced when a new value is typed; `clearAadhaar` / `clearPan` remove them.
  if (body.aadhaar) {
    const a = String(body.aadhaar).replace(/\s+/g, '');
    if (!AADHAAR.test(a)) return { error: 'Aadhaar number should be 12 digits' };
    emp.aadhaarEnc = encryptText(a);
    emp.aadhaarLast4 = a.slice(-4);
    changed.add(FIELD_LABEL.aadhaar);
  } else if (body.clearAadhaar && emp.aadhaarEnc) {
    emp.aadhaarEnc = undefined;
    emp.aadhaarLast4 = undefined;
    changed.add(FIELD_LABEL.aadhaar);
  }
  if (body.pan) {
    const p = String(body.pan).replace(/\s+/g, '').toUpperCase();
    if (!PAN.test(p)) return { error: 'PAN should look like ABCDE1234F' };
    emp.panEnc = encryptText(p);
    emp.panLast4 = p.slice(-4);
    changed.add(FIELD_LABEL.pan);
  } else if (body.clearPan && emp.panEnc) {
    emp.panEnc = undefined;
    emp.panLast4 = undefined;
    changed.add(FIELD_LABEL.pan);
  }

  if (body.bank && typeof body.bank === 'object') {
    const b = body.bank;
    const account = String(b.account || '').replace(/\s+/g, '');
    const ifsc = clean(b.ifsc, 11).toUpperCase();
    if (account && !/^\d{9,18}$/.test(account)) return { error: 'Account number should be 9 to 18 digits' };
    if (ifsc && !IFSC.test(ifsc)) return { error: 'Enter a valid IFSC code, e.g. SBIN0001234' };
    const next = {
      holder: clean(b.holder, 100),
      ifsc,
      bankName: clean(b.bankName, 100),
      branch: clean(b.branch, 100),
      accountType: ['savings', 'current'].includes(b.accountType) ? b.accountType : 'savings',
    };
    const prev = emp.bank || {};
    const differs = Object.keys(next).some((k) => (prev[k] || '') !== next[k]) || !!account;
    if (differs) {
      Object.assign(emp.bank, next);
      if (account) Object.assign(emp.bank, { accountEnc: encryptText(account), accountLast4: account.slice(-4) });
      changed.add(FIELD_LABEL.bank);
    }
  }
  return { changed: [...changed] };
}

function duplicateIdError(err) {
  return err?.code === 11000 && /employeeId/.test(err.message || JSON.stringify(err.keyPattern || {}));
}

async function load(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ message: 'Employee not found' });
    return null;
  }
  const emp = await Employee.findById(req.params.id);
  if (!emp) res.status(404).json({ message: 'Employee not found' });
  return emp;
}

async function respond(res, emp, status = 200, extra = {}) {
  await emp.populate([
    { path: 'department', select: 'name' },
    { path: 'activity.by', select: 'name' },
  ]);
  res.status(status).json({ ...view(emp), ...extra });
}

// ---------------------------------------------------------------- list / create

const list = async (req, res, next) => {
  try {
    const filter = {};
    if (['active', 'left'].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.department && mongoose.isValidObjectId(req.query.department)) filter.department = req.query.department;
    const q = clean(req.query.q, 100);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { employeeId: rx }, { designation: rx }];
    }
    const employees = await Employee.find(filter)
      .sort({ status: 1, name: 1 })
      .limit(1000)
      .select('employeeId name designation department joiningDate status leavingDate email phone documents.label application applicationNumber createdAt')
      .populate('department', 'name');
    const [active, left] = await Promise.all([Employee.countDocuments({ status: 'active' }), Employee.countDocuments({ status: 'left' })]);
    res.json({
      employees: employees.map((e) => {
        const o = e.toObject();
        o.documentCount = (o.documents || []).length;
        delete o.documents;
        return o;
      }),
      counts: { active, left, total: active + left },
    });
  } catch (err) {
    next(err);
  }
};

const create = async (req, res, next) => {
  try {
    const emp = new Employee({ createdBy: req.user._id });
    const result = await applyFields(emp, req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    if (!emp.name) return res.status(400).json({ message: 'Name is required' });
    log(emp, 'Added the employee record', req.user);
    await emp.save();
    await respond(res, emp, 201);
  } catch (err) {
    if (duplicateIdError(err)) return res.status(400).json({ message: 'Another employee already has this employee ID' });
    next(err);
  }
};

/** Copy a file the application holds into the employee's own encrypted storage. */
async function copyFile(emp, buffer, { label, name, mime, size, user }) {
  const storageKey = await saveFile(buffer, `employees/${emp._id}`);
  emp.documents.push({
    label,
    storageKey,
    name,
    mime,
    size,
    fromApplication: true,
    addedBy: user._id,
    addedByName: user.name,
  });
}

const createFromApplication = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.appId)) return res.status(404).json({ message: 'Application not found' });
    const app = await Application.findById(req.params.appId).populate('job', 'title department');
    if (!app) return res.status(404).json({ message: 'Application not found' });
    const existing = await Employee.findOne({ application: app._id }).select('_id');
    if (existing) return res.status(409).json({ message: 'This person is already in Employees', employee: existing._id });

    const emp = new Employee({
      name: app.name,
      email: app.email,
      phone: app.phone,
      gender: app.gender,
      dateOfBirth: app.dateOfBirth || undefined,
      currentAddress: app.currentLocation || app.location || undefined,
      designation: app.job?.title,
      department: app.job?.department || undefined,
      application: app._id,
      applicationNumber: app.applicationNumber,
      appliedFor: app.job?.title,
      createdBy: req.user._id,
    });
    // HR's choices from the "Add to employees" window (employee ID, designation, joining date...)
    const result = await applyFields(emp, req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    // Bank details: the latest request that has them.
    const withBank = [...(app.documentRequests || [])].reverse().find((r) => r.bank?.accountEnc);
    if (withBank) {
      const b = withBank.bank;
      emp.bank = {
        holder: b.holder,
        accountEnc: b.accountEnc,
        accountLast4: b.accountLast4,
        ifsc: b.ifsc,
        bankName: b.bankName,
        branch: b.branch,
        accountType: b.accountType,
      };
    }

    // Documents: everything uploaded except files HR asked to be replaced.
    let copied = 0;
    let failed = 0;
    for (const r of app.documentRequests || []) {
      for (const item of r.items) {
        if (item.status === 'rejected') continue;
        for (const f of item.files) {
          if (emp.documents.length >= MAX_DOCS) break;
          try {
            const buf = await readFile(f.storageKey);
            await copyFile(emp, buf, { label: item.label, name: f.name, mime: f.mime, size: f.size, user: req.user });
            copied += 1;
          } catch (err) {
            console.error('[employees] could not copy a document:', err.message);
            failed += 1;
          }
        }
      }
    }
    // The resume too.
    try {
      const resume = await readResumeBuffer(app, 10 * 1024 * 1024);
      if (resume) {
        await copyFile(emp, resume.content, {
          label: 'Resume',
          name: resume.filename,
          mime: resume.contentType,
          size: resume.content.length,
          user: req.user,
        });
        copied += 1;
      }
    } catch (err) {
      console.error('[employees] could not copy the resume:', err.message);
      failed += 1;
    }

    log(
      emp,
      `Added from application ${app.applicationNumber || ''} (${app.job?.title || 'job'}) with ${copied} document${copied === 1 ? '' : 's'}${withBank ? ' and bank details' : ''}`,
      req.user
    );
    try {
      await emp.save();
    } catch (err) {
      // Don't leave copied files behind if the record couldn't be saved.
      await Promise.all(emp.documents.map((d) => deleteFile(d.storageKey)));
      throw err;
    }
    await Application.updateOne({ _id: app._id }, { $set: { employee: emp._id } });
    await logActivity(app._id, { type: 'status', text: `Added to Employees${emp.employeeId ? ` as ${emp.employeeId}` : ''}`, by: req.user });
    await respond(res, emp, 201, { copied, failed });
  } catch (err) {
    if (duplicateIdError(err)) return res.status(400).json({ message: 'Another employee already has this employee ID' });
    if (err?.code === 11000) return res.status(409).json({ message: 'This person is already in Employees' });
    next(err);
  }
};

// ---------------------------------------------------------------- one employee

const getOne = async (req, res, next) => {
  try {
    const emp = await load(req, res);
    if (!emp) return;
    await respond(res, emp);
  } catch (err) {
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const emp = await load(req, res);
    if (!emp) return;
    const result = await applyFields(emp, req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    if (!emp.name) return res.status(400).json({ message: 'Name is required' });
    if (result.changed.length) log(emp, `Updated ${result.changed.join(', ')}`, req.user);
    await emp.save();
    await respond(res, emp);
  } catch (err) {
    if (duplicateIdError(err)) return res.status(400).json({ message: 'Another employee already has this employee ID' });
    next(err);
  }
};

const remove = async (req, res, next) => {
  try {
    const emp = await load(req, res);
    if (!emp) return;
    const keys = emp.documents.map((d) => d.storageKey);
    await Employee.deleteOne({ _id: emp._id });
    await Promise.all(keys.map(deleteFile));
    if (emp.application) await Application.updateOne({ _id: emp.application }, { $unset: { employee: 1 } });
    res.json({ message: 'Employee record deleted' });
  } catch (err) {
    next(err);
  }
};

const reveal = async (req, res, next) => {
  try {
    const emp = await load(req, res);
    if (!emp) return;
    const field = req.params.field;
    const enc = field === 'aadhaar' ? emp.aadhaarEnc : field === 'pan' ? emp.panEnc : field === 'account' ? emp.bank?.accountEnc : null;
    if (!enc) return res.status(404).json({ message: 'Not saved' });
    const value = decryptText(enc);
    log(emp, `Viewed the full ${field === 'account' ? 'bank account number' : field === 'pan' ? 'PAN' : 'Aadhaar number'}`, req.user);
    await emp.save();
    res.set('Cache-Control', 'no-store').json({ value });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------- documents

const uploadDocument = async (req, res, next) => {
  try {
    const emp = await load(req, res);
    if (!emp) return;
    if (!req.file) return res.status(400).json({ message: 'Please choose a file to upload' });
    const label = clean(req.body?.label, 120);
    if (!label) return res.status(400).json({ message: 'Say what this document is, e.g. Aadhaar card' });
    if (emp.documents.length >= MAX_DOCS) return res.status(400).json({ message: `Up to ${MAX_DOCS} documents per employee` });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const storageKey = await saveFile(req.file.buffer, `employees/${emp._id}`);
    emp.documents.push({
      label,
      storageKey,
      name: clean(req.file.originalname, 150) || `document${ext}`,
      mime: TYPES[ext],
      size: req.file.size,
      addedBy: req.user._id,
      addedByName: req.user.name,
    });
    log(emp, `Uploaded "${label}" (${emp.documents.at(-1).name})`, req.user);
    await emp.save();
    await respond(res, emp, 201);
  } catch (err) {
    next(err);
  }
};

const renameDocument = async (req, res, next) => {
  try {
    const emp = await load(req, res);
    if (!emp) return;
    const doc = emp.documents.id(req.params.fid);
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    const label = clean(req.body?.label, 120);
    if (!label) return res.status(400).json({ message: 'Enter the document name' });
    if (label !== doc.label) {
      log(emp, `Renamed the document "${doc.label}" to "${label}"`, req.user);
      doc.label = label;
      await emp.save();
    }
    await respond(res, emp);
  } catch (err) {
    next(err);
  }
};

const downloadDocument = async (req, res, next) => {
  try {
    const emp = await load(req, res);
    if (!emp) return;
    const doc = emp.documents.id(req.params.fid);
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    const buf = await readFile(doc.storageKey);
    const ext = path.extname(doc.name).toLowerCase() || '.pdf';
    const base = `${emp.employeeId || emp.name}_${doc.label}`.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80);
    const filename = `${base}${ext}`;
    const inline = req.query.inline === '1' || req.query.inline === 'true';
    res.setHeader('Content-Type', doc.mime || TYPES[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  } catch (err) {
    next(err);
  }
};

const deleteDocument = async (req, res, next) => {
  try {
    const emp = await load(req, res);
    if (!emp) return;
    const doc = emp.documents.id(req.params.fid);
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    const { storageKey, label, name } = doc;
    emp.documents.pull(doc._id);
    log(emp, `Deleted the document "${label}" (${name})`, req.user);
    await emp.save();
    await deleteFile(storageKey);
    await respond(res, emp);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  list,
  create,
  createFromApplication,
  getOne,
  update,
  remove,
  reveal,
  uploadDocument,
  renameDocument,
  downloadDocument,
  deleteDocument,
};
