const express = require('express');
const router = express.Router();
const D = require('../controllers/documentController');

// Public: the candidate's private upload link (/documents/<token> on the site).
router.get('/:token', D.getForCandidate);
router.post('/:token/items/:itemId', D.receiveFile, D.uploadItemFile);
router.delete('/:token/items/:itemId/files/:fileId', D.removeItemFile);
router.post('/:token/bank', D.saveBank);
router.post('/:token/submit', D.submit);

module.exports = router;
