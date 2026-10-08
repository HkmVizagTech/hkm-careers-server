const Counter = require('../models/Counter');

// Numbers start at 10001 (5 digits) for every role prefix.
const START = 10000;
const STOP_WORDS = new Set(['and', 'of', 'the', 'for', 'a', 'an', 'in', 'at', 'to', '&']);

/**
 * Role prefix from a job title, 2-3 letters:
 *   "Full Stack Developer" -> FSD, "Video Editor" -> VE, "Accountant" -> ACC
 */
function prefixFromTitle(title) {
  const words = String(title || '')
    .replace(/[^A-Za-z0-9\s&]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w.toLowerCase()));
  let prefix;
  if (words.length >= 2) prefix = words.slice(0, 3).map((w) => w[0]).join('');
  else if (words.length === 1) prefix = words[0].slice(0, 3);
  prefix = (prefix || 'APP').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return prefix || 'APP';
}

/** Next unique number for a job title, e.g. FSD10001, FSD10002, ... (atomic per prefix). */
async function generateApplicationNumber(jobTitle) {
  const prefix = prefixFromTitle(jobTitle);
  const counter = await Counter.findOneAndUpdate(
    { _id: prefix },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `${prefix}${START + counter.seq}`;
}

module.exports = { prefixFromTitle, generateApplicationNumber };
