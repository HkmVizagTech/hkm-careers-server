const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const C = require('../controllers/employeeController');
const { receiveFile } = require('../controllers/documentController');

// Everything here is HR-only.
router.use(auth);

router.get('/', C.list);
router.post('/', C.create);
router.post('/from-application/:appId', C.createFromApplication);
router.get('/:id', C.getOne);
router.put('/:id', C.update);
router.delete('/:id', C.remove);
router.get('/:id/reveal/:field', C.reveal);
router.post('/:id/documents', receiveFile, C.uploadDocument);
router.patch('/:id/documents/:fid', C.renameDocument);
router.get('/:id/documents/:fid', C.downloadDocument);
router.delete('/:id/documents/:fid', C.deleteDocument);

module.exports = router;
