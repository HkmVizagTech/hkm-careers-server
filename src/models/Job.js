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
    // Ticked qualification checkboxes (e.g. "B.Tech", "Post Graduation"); qualifications holds any extra text.
    qualificationTags: {
      type: [String],
      default: undefined,
    },
    // 'text': description/responsibilities are free text pasted as-is (headings, bullets, paragraphs).
    // Missing on older jobs, where every line was one bullet point.
    descriptionFormat: {
      type: String,
      enum: ['points', 'text'],
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
    // Last day to apply. Stored as the end of that day (India time); the job closes itself after it passes.
    deadline: {
      type: Date,
    },
    // How many people will be hired. When this many are Selected, the job closes itself.
    openings: {
      type: Number,
      default: 1,
      min: 1,
      max: 500,
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
