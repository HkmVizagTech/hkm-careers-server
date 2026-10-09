const path = require('path');
const fs = require('fs');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client } = require('../config/r2');
const { prefixFromTitle } = require('./applicationNumber');

const RESUME_TYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** "FSD_Chaitanya_Kumar.pdf": role short form + applicant name. */
function resumeFileName(application, ext) {
  const fromNumber = /^([A-Z]+)\d+$/.exec(application.applicationNumber || '')?.[1];
  const prefix = fromNumber || prefixFromTitle(application.job?.title);
  const name =
    String(application.name || 'Applicant')
      .normalize('NFC')
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '') // keeps Telugu/Hindi names too
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'Applicant';
  return `${prefix}_${name}${ext}`;
}

/** Readable stream + content type for the stored resume, from R2, local disk, or its public URL. */
async function openResume(application) {
  const key = application.resumeKey;
  if (s3Client && key) {
    const obj = await s3Client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    return { body: obj.Body, type: obj.ContentType, length: obj.ContentLength };
  }
  if (application.resumeUrl?.startsWith('/uploads/')) {
    const file = path.join(__dirname, '..', '..', application.resumeUrl.replace(/^\/+/, ''));
    if (fs.existsSync(file)) return { body: fs.createReadStream(file), length: fs.statSync(file).size };
  }
  if (/^https?:\/\//.test(application.resumeUrl || '')) {
    const res = await fetch(application.resumeUrl);
    if (res.ok) {
      const { Readable } = require('stream');
      return { body: Readable.fromWeb(res.body), type: res.headers.get('content-type'), length: Number(res.headers.get('content-length')) || undefined };
    }
  }
  return null;
}


/** Whole resume as a Buffer (for email attachments). Null if missing or larger than maxBytes. */
async function readResumeBuffer(application, maxBytes = 8 * 1024 * 1024) {
  const file = await openResume(application);
  if (!file) return null;
  if (file.length && file.length > maxBytes) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of file.body) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(Buffer.from(chunk));
  }
  const ext = (path.extname(application.resumeKey || application.resumeUrl || '').toLowerCase().split('?')[0]) || '.pdf';
  return { content: Buffer.concat(chunks), filename: resumeFileName(application, ext), contentType: RESUME_TYPES[ext] || file.type };
}

module.exports = { RESUME_TYPES, resumeFileName, openResume, readResumeBuffer };
