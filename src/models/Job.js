const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Job title is required'],
      trim: true,
    },
    slug: {
      type: String,
      unique: true,
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: [true, 'Department is required'],
    },
    location: {
      type: String,
      required: [true, 'Location is required'],
      trim: true,
    },
    type: {
      type: String,
      enum: ['full-time', 'part-time', 'volunteer', 'intern'],
      required: [true, 'Job type is required'],
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
    },
    responsibilities: {
      type: String,
    },
    qualifications: {
      type: String,
    },
    experience: {
      type: String,
      trim: true,
    },
    salaryRange: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['draft', 'active', 'closed'],
      default: 'draft',
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    askEducationalDetails: {
      type: Boolean,
      default: false,
    },
    targetGender: {
      type: String,
      enum: ['any', 'male', 'female'],
      default: 'any',
    },
    applicationCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

jobSchema.pre('save', function (next) {
  if (this.isModified('title')) {
    this.slug =
      this.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') +
      '-' +
      Date.now().toString(36);
  }
  next();
});

module.exports = mongoose.model('Job', jobSchema);
