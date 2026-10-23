const { Router } = require('express');
const { body, param } = require('express-validator');
const partnershipController = require('../controllers/partnership.controller');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { PARTNER_STATUSES } = require('../constants/admin');

const router = Router();
router.use(authenticate, authorize('super-admin'));

router.get('/partners', partnershipController.listPartners);

router.post(
  '/partners',
  [
    body('name').trim().notEmpty(),
    body('type').optional().isString(),
    body('revShare').optional().isFloat({ min: 0, max: 100 }),
    body('monthlyFee').optional().isFloat({ min: 0 }),
    body('email').optional({ checkFalsy: true }).isEmail(),
  ],
  validate,
  partnershipController.createPartner,
);

router.patch(
  '/partners/:id',
  [
    param('id').isMongoId(),
    body('name').optional().trim().notEmpty(),
    body('revShare').optional().isFloat({ min: 0, max: 100 }),
    body('monthlyFee').optional().isFloat({ min: 0 }),
    body('email').optional({ checkFalsy: true }).isEmail(),
  ],
  validate,
  partnershipController.updatePartner,
);

router.patch(
  '/partners/:id/status',
  [param('id').isMongoId(), body('status').isIn(PARTNER_STATUSES)],
  validate,
  partnershipController.updatePartnerStatus,
);

router.get('/revenue', partnershipController.revenue);
router.get('/settlements', partnershipController.settlements);
router.post('/settlements/:id/pay', [param('id').isMongoId()], validate, partnershipController.paySettlement);

module.exports = router;
