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
} = require('../controllers/applicationController');

// Public routes
router.get('/track/:id', trackStatus);  // Public — no auth
router.post('/', upload.single('resume'), createValidation, create);

// Protected routes
router.get('/', auth, getAll);
router.get('/:id', auth, getById);
router.patch('/:id/status', auth, updateStatus);
router.post('/:id/notes', auth, addNote);
router.post('/:id/notify', auth, resendNotification);
router.delete('/:id', auth, remove);

module.exports = router;
