const mongoose = require('mongoose');
const EmailDraft = require('../models/EmailDraft');

/** Starter drafts, added the first time the list is opened. {name}, {position} and {applicationNo} are filled in when used. */
const DEFAULTS = [
  {
    label: 'Request documents',
    subject: 'Documents required for your application ({applicationNo})',
    message:
      'Thank you for your application for the position of {position}. To take it forward, please reply to this email with the following documents:\n\n1. Updated resume\n2. Educational certificates\n3. A government photo ID\n\nPlease send them within the next 3 days.',
  },
  {
    label: 'Ask for availability',
    subject: 'Your availability for an interview',
    message:
      'We would like to speak with you about your application for {position}. Please reply with two or three dates and times over the next week when you are available for a short interview.',
  },
  {
    label: 'Offer follow-up',
    subject: 'Next steps for joining',
    message:
      'Congratulations once again on being selected for {position}. Our HR team will share the joining details shortly. Please reply to this email if you have any questions in the meantime.',
  },
];

const clean = (body) => ({
  label: String(body?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
  subject: String(body?.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
  message: String(body?.message ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 10000),
});

const missing = (d) =>
  !d.label ? 'Give the draft a name' : !d.subject ? 'Add a subject' : !d.message ? 'Add the message' : null;

let seeding = null;
function ensureSeeded() {
  if (!seeding) {
    seeding = (async () => {
      if ((await EmailDraft.estimatedDocumentCount()) > 0) return;
      await EmailDraft.insertMany(DEFAULTS.map((d, order) => ({ ...d, order })));
    })().catch(() => {
      seeding = null;
    });
  }
  return seeding;
}

const list = () => EmailDraft.find().sort({ order: 1, createdAt: 1 }).select('label subject message order updatedAt');

// GET /api/email-drafts
const getAll = async (req, res, next) => {
  try {
    await ensureSeeded();
    res.json(await list());
  } catch (err) {
    next(err);
  }
};

// POST /api/email-drafts { label, subject, message }
const create = async (req, res, next) => {
  try {
    const d = clean(req.body);
    const why = missing(d);
    if (why) return res.status(400).json({ message: why });
    const last = await EmailDraft.findOne().sort({ order: -1 }).select('order');
    const draft = await EmailDraft.create({ ...d, order: (last?.order ?? -1) + 1, updatedBy: req.user?._id });
    res.status(201).json(draft);
  } catch (err) {
    next(err);
  }
};

// PUT /api/email-drafts/:id { label, subject, message }
const update = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Draft not found' });
    const d = clean(req.body);
    const why = missing(d);
    if (why) return res.status(400).json({ message: why });
    const draft = await EmailDraft.findByIdAndUpdate(req.params.id, { ...d, updatedBy: req.user?._id }, { new: true, runValidators: true });
    if (!draft) return res.status(404).json({ message: 'Draft not found' });
    res.json(draft);
  } catch (err) {
    next(err);
  }
};

// PUT /api/email-drafts/order { ids: [...] }  (new order, top first)
const reorder = async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((id) => mongoose.isValidObjectId(id));
    await Promise.all(ids.map((id, order) => EmailDraft.updateOne({ _id: id }, { $set: { order } })));
    res.json(await list());
  } catch (err) {
    next(err);
  }
};

// DELETE /api/email-drafts/:id
const remove = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Draft not found' });
    const draft = await EmailDraft.findByIdAndDelete(req.params.id);
    if (!draft) return res.status(404).json({ message: 'Draft not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, create, update, reorder, remove, DEFAULTS };
