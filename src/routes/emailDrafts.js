const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getAll, create, update, reorder, remove } = require('../controllers/emailDraftController');

router.get('/', auth, getAll);
router.post('/', auth, create);
router.put('/order', auth, reorder);
router.put('/:id', auth, update);
router.delete('/:id', auth, remove);

module.exports = router;
