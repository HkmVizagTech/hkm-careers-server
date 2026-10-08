const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  getAll,
  getBySlug,
  getById,
  create,
  createValidation,
  update,
  remove,
  pipeline,
  closeRemaining,
} = require('../controllers/jobController');

// Public routes
router.get('/public', getAll);
router.get('/public/:slug', getBySlug);

// Protected routes
router.get('/', auth, getAll);
router.get('/:id', auth, getById);
router.get('/:id/pipeline', auth, pipeline);
router.post('/:id/close-remaining', auth, closeRemaining);
router.post('/', auth, createValidation, create);
router.put('/:id', auth, update);
router.delete('/:id', auth, remove);

module.exports = router;
