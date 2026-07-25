const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema(
  {
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
