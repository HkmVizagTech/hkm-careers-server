/**
 * Activity log on each application: who did what, and when. Shown as a timeline to HR.
 * logActivity never throws; a failed log must not break the action it describes.
 */
const Application = require('../models/Application');

const STATUS_LABEL = {
  received: 'Received',
  'under-review': 'Under Review',
  shortlisted: 'Shortlisted',
  interview: 'Interview',
  selected: 'Selected',
  rejected: 'Not Selected',
};
const statusLabel = (s) => STATUS_LABEL[s] || s;

/**
 * @param {string|object} applicationId
 * @param {{ type: string, text: string, by?: object|string|null, byName?: string, meta?: object }} entry
 *   `by` is the admin user (or their id); leave it out for the candidate / the system and set byName.
 */
async function logActivity(applicationId, { type, text, by, byName, meta }) {
  try {
    const userId = by && typeof by === 'object' ? by._id : by;
    const name = byName || (by && typeof by === 'object' ? by.name : undefined);
    await Application.updateOne(
      { _id: applicationId },
      {
        $push: {
          activity: {
            $each: [{ type, text: String(text).slice(0, 500), by: userId || undefined, byName: name, meta, at: new Date() }],
            $slice: -500, // keep the latest 500 entries
          },
        },
      }
    );
  } catch (err) {
    console.error('[activity] could not log:', err.message);
  }
}

/** Same entry for many applications at once (e.g. "close remaining"). */
async function logActivityMany(ids, entry) {
  if (!ids?.length) return;
  try {
    const userId = entry.by && typeof entry.by === 'object' ? entry.by._id : entry.by;
    await Application.updateMany(
      { _id: { $in: ids } },
      {
        $push: {
          activity: {
            $each: [{ type: entry.type, text: entry.text, by: userId || undefined, byName: entry.byName || entry.by?.name, at: new Date() }],
            $slice: -500,
          },
        },
      }
    );
  } catch (err) {
    console.error('[activity] could not log:', err.message);
  }
}

module.exports = { logActivity, logActivityMany, statusLabel };
