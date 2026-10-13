/**
 * One application per person per job: the same email OR the same phone number can't apply
 * to the same job twice. Applying to other jobs is fine; HR sees those on the application.
 */
const fs = require('fs');
const path = require('path');
const Application = require('../models/Application');
const { emailKey, phoneKey } = require('./contactKeys');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match conditions for "same person", including older records saved before the keys existed. */
function samePersonQuery(email, phone) {
  const e = emailKey(email);
  const p = phoneKey(phone);
  const or = [];
  if (e) {
    or.push({ emailKey: e });
    or.push({ emailKey: { $exists: false }, email: new RegExp(`^\\s*${escapeRe(e)}\\s*$`, 'i') });
  }
  if (p) {
    or.push({ phoneKey: p });
    // Older records: the same digits with any spaces / dashes between them, at the end of the number.
    or.push({ phoneKey: { $exists: false }, phone: new RegExp(`${p.split('').join('\\D*')}\\D*$`) });
  }
  return or.length ? { $or: or } : null;
}

/** The earlier application for this job by the same email or phone, or null. */
async function findDuplicate(jobId, email, phone) {
  const q = samePersonQuery(email, phone);
  if (!q) return null;
  return Application.findOne({ job: jobId, ...q })
    .sort({ createdAt: -1 })
    .select('applicationNumber email phone status createdAt name');
}

/** The same person's applications for other jobs (for the admin page). */
async function otherApplicationsOf(application) {
  const q = samePersonQuery(application.email, application.phone);
  if (!q) return [];
  return Application.find({ _id: { $ne: application._id }, ...q })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('applicationNumber status createdAt job')
    .populate('job', 'title');
}

/** Remove a resume that was uploaded for a submission we then refused. Never throws. */
async function discardUpload(file) {
  if (!file) return;
  try {
    if (file.key && file.bucket) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const { s3Client } = require('../config/r2');
      if (s3Client) await s3Client.send(new DeleteObjectCommand({ Bucket: file.bucket, Key: file.key }));
    } else if (file.path) {
      await fs.promises.unlink(file.path);
    } else if (file.filename) {
      await fs.promises.unlink(path.join(__dirname, '..', '..', 'uploads', 'resumes', file.filename));
    }
  } catch (err) {
    console.error('[applications] could not remove refused upload:', err.message);
  }
}

/** Fill emailKey / phoneKey on records created before they existed. Runs once at start-up, in batches. */
async function backfillContactKeys() {
  try {
    let fixed = 0;
    for (;;) {
      const batch = await Application.find({ $or: [{ emailKey: { $exists: false } }, { phoneKey: { $exists: false } }] })
        .select('email phone')
        .limit(500)
        .lean();
      if (!batch.length) break;
      await Application.bulkWrite(
        batch.map((a) => ({
          updateOne: {
            filter: { _id: a._id },
            update: { $set: { emailKey: emailKey(a.email) ?? null, phoneKey: phoneKey(a.phone) ?? null } },
          },
        }))
      );
      fixed += batch.length;
      if (batch.length < 500) break;
    }
    if (fixed) console.log(`[applications] added contact keys to ${fixed} older applications`);
  } catch (err) {
    console.error('[applications] contact key backfill failed:', err.message);
  }
}

module.exports = { findDuplicate, otherApplicationsOf, discardUpload, backfillContactKeys, samePersonQuery };
