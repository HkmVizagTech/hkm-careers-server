const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  list,
  create,
  createValidation,
  remove,
  updateMe,
  updateMeValidation,
} = require('../controllers/userController');

router.get('/', auth, list);
router.post('/', auth, createValidation, create);
router.put('/me', auth, updateMeValidation, updateMe);
router.delete('/:id', auth, remove);

module.exports = router;
