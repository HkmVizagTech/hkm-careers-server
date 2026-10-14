const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { upload } = require('../config/r2');
const D = require('../controllers/documentController');
const {
  getAll,
  getById,
  create,
  createValidation,
  updateStatus,
  resendNotification,
  addNote,
  remove,
  trackStatus,
  exportCsv,
  sendEmail,
  downloadResume,
  scheduleInterview,
  clearInterview,
  resendInterview,
  addFollowUp,
  updateFollowUp,
  deleteFollowUp,
  checkDuplicate,
} = require('../controllers/applicationController');

/** Simple per-IP limit for the public repeat-application check (20 per 10 minutes). */
const checkHits = new Map();
function limitChecks(req, res, next) {
  const now = Date.now();
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  const hits = (checkHits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (hits.length >= 20) return res.json({ duplicate: false }); // stay quiet; the submit itself still checks
  hits.push(now);
  checkHits.set(ip, hits);
  if (checkHits.size > 5000) checkHits.clear();
  next();
}

// Public routes
router.get('/track/:id', trackStatus);  // Public — no auth
router.post('/check', limitChecks, checkDuplicate); // Public — warns about a repeat application early
router.post('/', upload.single('resume'), createValidation, create);

// Protected routes
router.get('/', auth, getAll);
router.get('/export', auth, exportCsv); // before '/:id'
router.get('/:id', auth, getById);
router.get('/:id/resume', auth, downloadResume);
router.patch('/:id/status', auth, updateStatus);
router.post('/:id/notes', auth, addNote);
// Document requests (upload link for the candidate, review by HR)
router.post('/:id/documents', auth, D.createRequest);
router.get('/:id/documents/:rid/files/:fid', auth, D.downloadFile);
router.patch('/:id/documents/:rid/items/:iid', auth, D.reviewItem);
router.post('/:id/documents/:rid/notify', auth, D.notifyCandidate);
router.get('/:id/documents/:rid/bank', auth, D.revealBank);
router.delete('/:id/documents/:rid', auth, D.deleteRequest);
router.post('/:id/notify', auth, resendNotification);
router.post('/:id/email', auth, sendEmail);
router.put('/:id/interview', auth, scheduleInterview);
router.delete('/:id/interview', auth, clearInterview);
router.post('/:id/interview/notify', auth, resendInterview);
router.post('/:id/follow-ups', auth, addFollowUp);
router.patch('/:id/follow-ups/:fid', auth, updateFollowUp);
router.delete('/:id/follow-ups/:fid', auth, deleteFollowUp);
router.delete('/:id', auth, remove);

module.exports = router;
