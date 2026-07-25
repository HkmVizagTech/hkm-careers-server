const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  getAll,
  getById,
  create,
  createValidation,
  update,
  remove,
} = require('../controllers/departmentController');

// Public routes
router.get('/', getAll);
router.get('/:id', getById);

// Protected routes
router.post('/', auth, createValidation, create);
router.put('/:id', auth, update);
router.delete('/:id', auth, remove);

module.exports = router;
