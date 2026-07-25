const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { login, loginValidation, getMe } = require('../controllers/authController');

router.post('/login', loginValidation, login);
router.get('/me', auth, getMe);

module.exports = router;
