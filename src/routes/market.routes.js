const { Router } = require('express');
const { body, param, query } = require('express-validator');
const marketController = require('../controllers/market.controller');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { MARKET_STATUSES } = require('../constants/admin');

const router = Router();
router.use(authenticate, authorize('super-admin'));

router.get(
  '/',
  [
    query('eventId').optional().isMongoId(),
    query('status').optional().isIn(MARKET_STATUSES),
    query('type').optional().isString(),
  ],
  validate,
  marketController.list,
);

router.post(
  '/',
  [
    body('event').isMongoId(),
    body('code').trim().notEmpty(),
    body('name').trim().notEmpty(),
    body('type').optional().isString(),
    body('backOdds').optional().isFloat({ min: 1.01 }).withMessage('Odds must be 1.01 or higher'),
    body('layOdds').optional().isFloat({ min: 1.01 }).withMessage('Odds must be 1.01 or higher'),
    body('maxBet').optional().isFloat({ min: 0 }),
    body('maxExposure').optional().isFloat({ min: 0 }),
    body('runners').optional().isArray({ min: 2, max: 12 }).withMessage('A market needs 2 to 12 selections'),
    body('status').optional().isIn(MARKET_STATUSES),
  ],
  validate,
  marketController.create,
);

router.post('/suspend-all', [body('eventId').optional().isMongoId()], validate, marketController.suspendAll);

router.patch(
  '/:id',
  [
    param('id').isMongoId(),
    body('code').optional().trim().notEmpty(),
    body('name').optional().trim().notEmpty(),
    body('backOdds').optional().isFloat({ min: 1.01 }).withMessage('Odds must be 1.01 or higher'),
    body('layOdds').optional().isFloat({ min: 1.01 }).withMessage('Odds must be 1.01 or higher'),
    body('maxBet').optional().isFloat({ min: 0 }),
    body('maxExposure').optional().isFloat({ min: 0 }),
    body('status').optional().isIn(MARKET_STATUSES),
    body('runners').optional().isArray({ min: 2, max: 12 }).withMessage('A market needs 2 to 12 selections'),
  ],
  validate,
  marketController.update,
);

router.post(
  '/:id/void',
  [param('id').isMongoId(), body('reason').optional().isString().trim().isLength({ max: 120 })],
  validate,
  marketController.voidMarket,
);

router.post(
  '/:id/settle',
  [param('id').isMongoId(), body('winner').isString().trim().notEmpty()],
  validate,
  marketController.settle,
);

router.patch(
  '/:id/status',
  [param('id').isMongoId(), body('status').isIn(MARKET_STATUSES)],
  validate,
  marketController.updateStatus,
);

module.exports = router;
