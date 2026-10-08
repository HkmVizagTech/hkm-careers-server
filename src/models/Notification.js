const mongoose = require('mongoose');

// In-app alerts for the admin team (bell icon). Shared by all admins; each admin's read state is in readBy.
const notificationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['new-application', 'unreviewed', 'interview', 'job-closing', 'job-closed', 'follow-up', 'position-filled'],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, default: '' },
    link: { type: String }, // admin path, e.g. /admin/applications/<id>
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'Application' },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
    // Reminders use a stable key so the same reminder is only ever created once (safe with several server instances).
    dedupeKey: { type: String, unique: true, sparse: true },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

notificationSchema.index({ createdAt: -1 });
// Old alerts clean themselves up after 90 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'ttl_90d' });

module.exports = mongoose.model('Notification', notificationSchema);
