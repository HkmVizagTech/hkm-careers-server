/**
 * Encrypted storage for candidate documents (ID proofs, certificates, bank proof) and bank account numbers.
 *
 * Files are encrypted with AES-256-GCM on the server before they are stored, so they stay private even
 * if the storage bucket has a public URL. They live in R2 (DOCUMENTS_BUCKET, or the resume bucket) under
 * "documents/", or on local disk outside the public uploads folder when R2 isn't configured.
 *
 * Key: DOCUMENTS_KEY (32 random bytes, base64 or hex). Set it once and never change it, or older files
 * can't be opened. Without it the key is derived from JWT_SECRET (works, but set a dedicated key).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client } = require('../config/r2');

const LOCAL_DIR = path.join(__dirname, '..', '..', 'private-documents');

function key() {
  const raw = process.env.DOCUMENTS_KEY;
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
    console.error('[documents] DOCUMENTS_KEY must be 32 bytes (64 hex chars or 44 base64 chars); falling back to JWT_SECRET');
  }
  return crypto.createHash('sha256').update(`careers-documents:${process.env.JWT_SECRET || 'dev-only-secret'}`).digest();
}

const hasDedicatedKey = () => !!process.env.DOCUMENTS_KEY;

/** Buffer -> [iv(12) | tag(16) | ciphertext] */
function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function decrypt(blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

/** Short text (bank account number) -> base64 string. */
const encryptText = (s) => encrypt(Buffer.from(String(s), 'utf8')).toString('base64');
const decryptText = (b64) => decrypt(Buffer.from(b64, 'base64')).toString('utf8');

const bucket = () => process.env.DOCUMENTS_BUCKET || process.env.R2_BUCKET_NAME;

/** Store an uploaded file encrypted. Returns the storage key. */
async function saveFile(buffer, applicationId) {
  const storageKey = `documents/${applicationId}/${crypto.randomBytes(16).toString('hex')}.bin`;
  const blob = encrypt(buffer);
  if (s3Client && bucket()) {
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket(), Key: storageKey, Body: blob, ContentType: 'application/octet-stream' })
    );
  } else {
    const file = path.join(LOCAL_DIR, storageKey);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, blob);
  }
  return storageKey;
}

async function readFile(storageKey) {
  let blob;
  if (s3Client && bucket()) {
    const obj = await s3Client.send(new GetObjectCommand({ Bucket: bucket(), Key: storageKey }));
    blob = Buffer.from(await obj.Body.transformToByteArray());
  } else {
    blob = await fs.promises.readFile(path.join(LOCAL_DIR, storageKey));
  }
  return decrypt(blob);
}

async function deleteFile(storageKey) {
  try {
    if (s3Client && bucket()) await s3Client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: storageKey }));
    else await fs.promises.unlink(path.join(LOCAL_DIR, storageKey));
  } catch (err) {
    console.error('[documents] could not delete file:', err.message);
  }
}

module.exports = { encrypt, decrypt, encryptText, decryptText, saveFile, readFile, deleteFile, hasDedicatedKey };
