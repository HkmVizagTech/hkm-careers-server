const mongoose = require('mongoose');

/** Ready-made emails HR can pick in "Write email" on an application. Edited in Settings → Email drafts. */
const emailDraftSchema = new mongoose.Schema(
  {
    label: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 60 },
    subject: { type: String, required: [true, 'Subject is required'], trim: true, maxlength: 200 },
    message: { type: String, required: [true, 'Message is required'], maxlength: 10000 },
    order: { type: Number, default: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmailDraft', emailDraftSchema);
