const mongoose = require('mongoose');

const whatsappMessageSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['received', 'status'], required: true },
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
    whatsappMessages: [whatsappMessageSchema],
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

module.exports = mongoose.model('Application', applicationSchema);
