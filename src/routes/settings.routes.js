const { Router } = require('express');
const { body, param } = require('express-validator');
const settingsController = require('../controllers/settings.controller');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { SECTIONS } = require('../services/settings.service');
const { normalizeMobile } = require('../utils/phone');

const router = Router();
router.use(authenticate, authorize('super-admin'));

router.get('/', settingsController.get);

router.patch('/api-keys/:keyId', [param('keyId').isMongoId()], validate, settingsController.updateApiKey);
router.delete('/api-keys/:keyId', [param('keyId').isMongoId()], validate, settingsController.deleteApiKey);
router.post(
  '/api-keys',
  [body('name').trim().notEmpty(), body('key').trim().notEmpty()],
  validate,
  settingsController.addApiKey,
);

// "Send test" buttons on the Email / SMS cards: checks the saved gateway really delivers.
router.post('/smtp/test', [body('to').trim().isEmail().withMessage('Enter an email address to send the test to')], validate, settingsController.testEmail);
router.post(
  '/sms/test',
  [body('to').trim().custom((v) => normalizeMobile(v) !== null).withMessage('Enter a 10-digit mobile number')],
  validate,
  settingsController.testSms,
);

/** Deposit QR / UPI shown on the app's Deposit screen. */
router.put(
  '/payment-details',
  [
    body('qrImage')
      .optional()
      .custom((value) => value === '' || (typeof value === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(value) && value.length <= 2_800_000))
      .withMessage('Upload the QR as a PNG, JPG or WebP image under 2MB'),
    body('upiId')
      .optional()
      .custom((value) => value === '' || /^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(String(value).trim()))
      .withMessage('Enter a valid UPI ID, e.g. name@bank'),
    body('payeeName').optional().isString().trim().isLength({ max: 80 }),
    body('note').optional().isString().trim().isLength({ max: 200 }),
  ],
  validate,
  settingsController.updatePaymentDetails,
);

router.patch('/:section', [param('section').isIn(SECTIONS)], validate, settingsController.updateSection);

module.exports = router;
