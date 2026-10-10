const QualificationOption = require('../models/QualificationOption');

const DEFAULTS = ['Post Graduation', 'B.Tech', 'B.Sc', 'Intermediate', '10th'];
const COLLATION = { locale: 'en', strength: 2 };

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

let seeding = null;
/** First time the list is read, fill in the starter options (only if the collection was never used). */
async function ensureSeeded() {
  if (!seeding) {
    seeding = (async () => {
      if ((await QualificationOption.estimatedDocumentCount()) > 0) return;
      await QualificationOption.insertMany(DEFAULTS.map((label, order) => ({ label, order })), { ordered: false }).catch(() => {});
    })().catch(() => { seeding = null; });
  }
  return seeding;
}

const list = () => QualificationOption.find().sort({ order: 1, createdAt: 1 }).select('label order');

const duplicate = (err) => err?.code === 11000;

// GET /api/qualification-options
const getAll = async (req, res, next) => {
  try {
    await ensureSeeded();
    res.json(await list());
  } catch (err) {
    next(err);
  }
};

// POST /api/qualification-options { label }
const create = async (req, res, next) => {
  try {
    const label = clean(req.body?.label);
    if (!label) return res.status(400).json({ message: 'Enter a name for the qualification' });
    const last = await QualificationOption.findOne().sort({ order: -1 }).select('order');
    const option = await QualificationOption.create({ label, order: (last?.order ?? -1) + 1 });
    res.status(201).json(option);
  } catch (err) {
    if (duplicate(err)) return res.status(400).json({ message: 'That qualification is already in the list' });
    next(err);
  }
};

// PUT /api/qualification-options/:id { label }
const update = async (req, res, next) => {
  try {
    const label = clean(req.body?.label);
    if (!label) return res.status(400).json({ message: 'Enter a name for the qualification' });
    const option = await QualificationOption.findByIdAndUpdate(req.params.id, { label }, { new: true, runValidators: true });
    if (!option) return res.status(404).json({ message: 'Qualification not found' });
    res.json(option);
  } catch (err) {
    if (duplicate(err)) return res.status(400).json({ message: 'That qualification is already in the list' });
    next(err);
  }
};

// DELETE /api/qualification-options/:id  (jobs that already use it keep their saved text)
const remove = async (req, res, next) => {
  try {
    const option = await QualificationOption.findByIdAndDelete(req.params.id);
    if (!option) return res.status(404).json({ message: 'Qualification not found' });
    res.json({ message: 'Removed' });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, create, update, remove, DEFAULTS, COLLATION };
