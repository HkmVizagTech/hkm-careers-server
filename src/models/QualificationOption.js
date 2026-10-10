const mongoose = require('mongoose');

/** Checkbox choices shown under "Qualifications" when creating or editing a job. Managed from the admin panel. */
const qualificationOptionSchema = new mongoose.Schema(
  {
    label: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 80 },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

qualificationOptionSchema.index({ label: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.model('QualificationOption', qualificationOptionSchema);
