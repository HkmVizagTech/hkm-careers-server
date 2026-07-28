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
