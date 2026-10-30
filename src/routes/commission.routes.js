const { Router } = require('express');
const { param, query } = require('express-validator');
const commissionController = require('../controllers/commission.controller');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { COMMISSION_KINDS, COMMISSION_LEVELS, COMMISSION_STATUSES } = require('../constants/admin');

const router = Router();
router.use(authenticate, authorize('super-admin', 'franchise', 'super-agent', 'agent'));

router.get(
  '/',
  [
    query('level').optional().isIn(COMMISSION_LEVELS),
    query('status').optional().isIn(COMMISSION_STATUSES),
    query('kind').optional().isIn(COMMISSION_KINDS),
    query('event').optional().isMongoId(),
  ],
  validate,
  commissionController.list,
);

/** One match's full settlement: results, each player's P/L and every commission share. */
router.get('/events/:id/settlement', [param('id').isMongoId()], validate, commissionController.eventSettlement);

module.exports = router;
