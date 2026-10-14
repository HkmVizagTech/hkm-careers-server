const mongoose = require('mongoose');

/**
 * Staff record kept by HR. Created from a selected application ("Add to employees") or by hand.
 * It owns its own copies of the documents, so it stays complete even if the application is deleted.
 * Aadhaar, PAN and the bank account number are stored encrypted (see utils/secureStore.js).
 */
const employeeFileSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true, maxlength: 120 }, // e.g. "Aadhaar card"
  storageKey: { type: String, required: true },
  name: { type: String, required: true },
  mime: { type: String },
  size: { type: Number },
  uploadedAt: { type: Date, default: Date.now },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  addedByName: { type: String },
  fromApplication: { type: Boolean, default: false }, // copied over from the job application
});

const activitySchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 500 },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: { type: String },
  at: { type: Date, default: Date.now },
});

const employeeSchema = new mongoose.Schema(
  {
    // Job
    employeeId: { type: String, trim: true, maxlength: 40 },
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 120 },
    designation: { type: String, trim: true, maxlength: 120 },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    joiningDate: { type: Date },
    status: { type: String, enum: ['active', 'left'], default: 'active' },
    leavingDate: { type: Date },

    // Contact
    email: { type: String, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 20 },
    altPhone: { type: String, trim: true, maxlength: 20 },
    currentAddress: { type: String, trim: true, maxlength: 500 },
    permanentAddress: { type: String, trim: true, maxlength: 500 },
    emergencyContact: {
      name: { type: String, trim: true, maxlength: 120 },
      relationship: { type: String, trim: true, maxlength: 60 },
      phone: { type: String, trim: true, maxlength: 20 },
    },

    // Personal
    gender: { type: String, trim: true, maxlength: 20 },
    dateOfBirth: { type: Date },
    bloodGroup: { type: String, trim: true, maxlength: 5 },
    aadhaarEnc: { type: String },
    aadhaarLast4: { type: String },
    panEnc: { type: String },
    panLast4: { type: String },

    bank: {
      holder: { type: String, trim: true },
      accountEnc: { type: String },
      accountLast4: { type: String },
      ifsc: { type: String, trim: true, uppercase: true },
      bankName: { type: String, trim: true },
      branch: { type: String, trim: true },
      accountType: { type: String, trim: true },
    },

    notes: { type: String, trim: true, maxlength: 3000 },
    documents: [employeeFileSchema],

    // Where it came from (the application may be deleted later; the snapshot stays)
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'Application' },
    applicationNumber: { type: String },
    appliedFor: { type: String },

    activity: [activitySchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

employeeSchema.index({ employeeId: 1 }, { unique: true, partialFilterExpression: { employeeId: { $type: 'string', $gt: '' } } });
employeeSchema.index({ application: 1 }, { unique: true, partialFilterExpression: { application: { $type: 'objectId' } } });

module.exports = mongoose.model('Employee', employeeSchema);
