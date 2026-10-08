const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { upload } = require('../config/r2');
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
  scheduleInterview,
  clearInterview,
  addFollowUp,
  updateFollowUp,
  deleteFollowUp,
} = require('../controllers/applicationController');

// Public routes
router.get('/track/:id', trackStatus);  // Public — no auth
router.post('/', upload.single('resume'), createValidation, create);

// Protected routes
router.get('/', auth, getAll);
router.get('/export', auth, exportCsv); // before '/:id'
router.get('/:id', auth, getById);
router.patch('/:id/status', auth, updateStatus);
router.post('/:id/notes', auth, addNote);
router.post('/:id/notify', auth, resendNotification);
router.put('/:id/interview', auth, scheduleInterview);
router.delete('/:id/interview', auth, clearInterview);
router.post('/:id/follow-ups', auth, addFollowUp);
router.patch('/:id/follow-ups/:fid', auth, updateFollowUp);
router.delete('/:id/follow-ups/:fid', auth, deleteFollowUp);
router.delete('/:id', auth, remove);

module.exports = router;
