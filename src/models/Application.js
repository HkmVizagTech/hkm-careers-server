const mongoose = require('mongoose');
const { emailKey, phoneKey } = require('../utils/contactKeys');

const whatsappMessageSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['received', 'status', 'interview'], required: true },
    applicationStatus: { type: String },
    templateId: { type: String },
    to: { type: String, index: true },
    messageId: { type: String, index: true },
    // submitted -> sent -> delivered -> read, or failed / skipped
    status: {
      type: String,
      enum: ['submitted', 'sent', 'delivered', 'read', 'failed', 'skipped'],
      default: 'submitted',
    },
    error: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  }
);

// Every email sent about this application (candidate updates, admin messages, HR alert).
const emailMessageSchema = new mongoose.Schema({
  kind: {
    type: String,
    enum: ['received', 'status', 'interview', 'custom', 'hr-new-application', 'documents', 'hr-documents'],
    required: true,
  },
  applicationStatus: { type: String },
  to: { type: String },
  subject: { type: String },
  body: { type: String }, // only for custom messages written by an admin
  status: { type: String, enum: ['sent', 'failed', 'skipped'], default: 'sent' },
  error: { type: String },
  messageId: { type: String },
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
});

const applicationSchema = new mongoose.Schema(
  {
    // Short, human-friendly id shown to applicants (e.g. FSD10001). The Mongo _id stays the internal key.
    applicationNumber: { type: String, unique: true, sparse: true, uppercase: true, trim: true },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      required: [true, 'Job is required'],
    },
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
    },
    resumeUrl: {
      type: String,
      required: [true, 'Resume is required'],
    },
    resumeKey: {
      type: String,
    },
    coverLetter: {
      type: String,
    },
    isExperienced: {
      type: Boolean,
      default: false,
    },
    yearsOfExperience: {
      type: Number,
    },
    lastEmployer: {
      type: String,
      trim: true,
    },
    lastEmploymentFrom: {
      type: Date,
    },
    lastEmploymentTo: {
      type: Date,
    },
    status: {
      type: String,
      enum: ['received', 'under-review', 'shortlisted', 'interview', 'selected', 'rejected'],
      default: 'received',
    },
    linkedinUrl: {
      type: String,
      trim: true,
    },
    githubUrl: {
      type: String,
      trim: true,
    },
    portfolioUrl: {
      type: String,
      trim: true,
    },
    location: {
      type: String,
      trim: true,
    },
    gender: {
      type: String,
      enum: ['male', 'female', 'other', 'prefer-not-to-say'],
    },
    dateOfBirth: {
      type: Date,
    },
    availableToJoin: {
      type: String,
      trim: true,
    },
    currentLocation: {
      type: String,
      trim: true,
    },
    highestDegree: {
      type: String,
      trim: true,
    },
    collegeName: {
      type: String,
      trim: true,
    },
    collegeCity: {
      type: String,
      trim: true,
    },
    studyYears: {
      type: String,
      trim: true,
    },
    // Where the applicant found the job (from ?src= on shared links): linkedin, indeed, whatsapp...
    source: { type: String, trim: true, lowercase: true, maxlength: 30 },
    whatsappMessages: [whatsappMessageSchema],
    emails: [emailMessageSchema],
    // Interview the admin team has scheduled (admins get reminders the day before and shortly before).
    interview: {
      scheduledAt: { type: Date, index: true },
      mode: { type: String, enum: ['in-person', 'phone', 'video'] },
      venue: { type: String, trim: true }, // venue name (in person) or call details (phone)
      link: { type: String, trim: true }, // Google Maps link (in person) or meeting link (video)
      location: { type: String, trim: true }, // older interviews: venue + link in one text
      notes: { type: String, trim: true },
      scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    // "Remind me on <date>" items set by admins.
    followUps: [
      {
        dueAt: { type: Date, required: true },
        note: { type: String, trim: true, required: true },
        done: { type: Boolean, default: false },
        notifiedAt: { type: Date },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    notes: [
      {
        text: { type: String, required: true },
        addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

// Normalised email / phone (lower-case email, last 10 phone digits) for spotting repeat applications.
applicationSchema.add({
  emailKey: { type: String, select: true },
  phoneKey: { type: String },
});
applicationSchema.pre('validate', function setContactKeys(next) {
  if (this.isNew || this.isModified('email')) this.emailKey = emailKey(this.email);
  if (this.isNew || this.isModified('phone')) this.phoneKey = phoneKey(this.phone);
  next();
});
applicationSchema.index({ job: 1, emailKey: 1 });
applicationSchema.index({ job: 1, phoneKey: 1 });
applicationSchema.index({ emailKey: 1 });
applicationSchema.index({ phoneKey: 1 });

// Documents HR asked the candidate for, uploaded through a private link (see controllers/documentController.js).
const documentFileSchema = new mongoose.Schema({
  storageKey: { type: String, required: true }, // encrypted blob in R2 / private disk
  name: { type: String, required: true },
  mime: { type: String },
  size: { type: Number },
  uploadedAt: { type: Date, default: Date.now },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // set when HR uploaded it (not the candidate)
  addedByName: { type: String },
});
const documentRequestSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['documents', 'joining'], default: 'documents' },
    tokenHash: { type: String, index: true }, // sha256 of the link token (the link itself is never stored in plain text)
    tokenEnc: { type: String }, // encrypted token, so HR can send the same link again
    expiresAt: { type: Date },
    message: { type: String, trim: true, maxlength: 2000 },
    items: [
      {
        label: { type: String, required: true, trim: true, maxlength: 120 },
        hint: { type: String, trim: true, maxlength: 200 },
        required: { type: Boolean, default: true },
        status: { type: String, enum: ['pending', 'uploaded', 'approved', 'rejected'], default: 'pending' },
        note: { type: String, trim: true, maxlength: 500 }, // HR's reason when asking for a re-upload
        reviewedAt: { type: Date }, // last approve / re-upload decision
        notifiedAt: { type: Date }, // when the candidate was emailed about this re-upload
        files: [documentFileSchema],
      },
    ],
    bank: {
      wanted: { type: Boolean, default: false },
      holder: { type: String, trim: true },
      accountEnc: { type: String }, // encrypted account number
      accountLast4: { type: String },
      ifsc: { type: String, trim: true, uppercase: true },
      bankName: { type: String, trim: true },
      branch: { type: String, trim: true },
      accountType: { type: String, trim: true },
      submittedAt: { type: Date },
    },
    status: { type: String, enum: ['open', 'submitted', 'completed', 'cancelled'], default: 'open' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    completedAt: { type: Date },
    lastEmailedAt: { type: Date }, // last time the candidate was emailed this link
  },
  { timestamps: true }
);
applicationSchema.add({ documentRequests: [documentRequestSchema] });
// Set when HR added this person to Employees (the employee record keeps its own copy of everything).
applicationSchema.add({ employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' } });

// Answers to the job's screening questions; `screeningFlags` lists the ones that don't meet the requirement.
applicationSchema.add({
  answers: [
    {
      question: { type: mongoose.Schema.Types.ObjectId },
      label: { type: String },
      type: { type: String },
      value: { type: String },
      meets: { type: Boolean },
    },
  ],
  screeningFlags: [{ type: String }],
});

// Timeline of everything that happened on the application (see utils/activity.js).
applicationSchema.add({
  activity: [
    {
      type: { type: String, required: true }, // applied, status, interview, email, note, follow-up, documents, ...
      text: { type: String, required: true },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      byName: { type: String }, // "Candidate", "System", or the admin's name at the time
      meta: { type: mongoose.Schema.Types.Mixed },
      at: { type: Date, default: Date.now },
    },
  ],
});

applicationSchema.index({ status: 1, createdAt: 1 });
applicationSchema.index({ 'followUps.dueAt': 1, 'followUps.done': 1 });

module.exports = mongoose.model('Application', applicationSchema);
