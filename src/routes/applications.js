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
  addNote,
  remove,
} = require('../controllers/applicationController');

// Public route — application submission with resume upload
router.post('/', upload.single('resume'), createValidation, create);

// Protected routes
router.get('/', auth, getAll);
router.get('/:id', auth, getById);
router.patch('/:id/status', auth, updateStatus);
router.post('/:id/notes', auth, addNote);
router.delete('/:id', auth, remove);

module.exports = router;
