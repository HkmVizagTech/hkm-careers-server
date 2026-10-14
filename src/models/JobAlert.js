const mongoose = require('mongoose');

/** "Notify me about new openings" subscribers. Confirmed by email; one-click unsubscribe deletes the record. */
const jobAlertSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    name: { type: String, trim: true, maxlength: 100 },
    // Empty = all departments.
    departments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Department' }],
    token: { type: String, required: true, unique: true }, // in confirm / manage / unsubscribe links
    confirmed: { type: Boolean, default: false },
    confirmedAt: { type: Date },
    confirmSentAt: { type: Date },
    lastAlertAt: { type: Date },
    alertsSent: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('JobAlert', jobAlertSchema);
