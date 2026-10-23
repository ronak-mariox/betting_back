const { Router } = require('express');
const { query } = require('express-validator');
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
  ],
  validate,
  commissionController.list,
);

module.exports = router;
