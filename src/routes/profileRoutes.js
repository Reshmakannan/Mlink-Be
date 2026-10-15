const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const auth = require('../middleware/Authmiddleware');
const ctrl = require('../controllers/profileController');
const tpl = require('../controllers/templateController');
const linkCtrl = require('../controllers/linkController');
const customizeCtrl = require('../controllers/customizeController'); // added

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

function photoUpload(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'Photo must be 2 MB or smaller.' : 'Upload failed.';
    return res.status(400).json({ message });
  });
}

const bgUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
});

function backgroundUpload(req, res, next) {
  bgUpload.single('background')(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'Background image must be 4 MB or smaller.' : 'Upload failed.';
    return res.status(400).json({ message });
  });
}

router.use(auth);
router.use(limiter);

router.get('/me', ctrl.getMe);
router.get('/username-available', ctrl.usernameAvailable);
router.put('/me', ctrl.saveDetails);
router.put('/social', ctrl.saveSocial);
router.put('/category', ctrl.saveCategory);
router.post('/photo', photoUpload, ctrl.uploadPhoto);
router.put('/publish', ctrl.setPublished);

router.get('/template-access', tpl.getAccess);
router.put('/template', tpl.saveTemplate);

router.get('/links', linkCtrl.list);
router.post('/links', linkCtrl.create);
router.put('/links/reorder', linkCtrl.reorder);
router.put('/links/:id', linkCtrl.update);
router.delete('/links/:id', linkCtrl.remove);

router.get('/customize-access', customizeCtrl.getAccess); // added
router.put('/customize', customizeCtrl.save); // added
router.post('/customize/background', backgroundUpload, customizeCtrl.uploadBackground);

module.exports = router;