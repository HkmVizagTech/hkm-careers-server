const mongoose = require('mongoose');

// One document per application-number prefix (e.g. FSD). Incremented atomically.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model('Counter', counterSchema);
