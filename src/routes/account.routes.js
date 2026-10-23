const { phoneRule } = require('../utils/phone');
const { Router } = require('express');
const { body, param, query } = require('express-validator');
const accountController = require('../controllers/account.controller');
const validate = require('../middleware/validate');
const { authenticate, authorize, requireOwnSubtree } = require('../middleware/auth');
const { grant } = require('../services/scope.service');

/** Listing / opening accounts: staff only, and only with "User List" (view). */
const userList = [
  authorize('super-admin', 'franchise', 'super-agent', 'agent'),
  grant('userManagement', 'userList', 'V', 'You do not have permission to view users'),
];
const { ROLE_ORDER } = require('../constants/roles');
const STAFF_FIELD_RULES = [
  body('businessName').optional().isString().trim().isLength({ max: 80 }),
  body('bettingLimit').optional().isFloat({ min: 0 }).toFloat(),
  body('maxExposure').optional().isFloat({ min: 0 }).toFloat(),
  body('shareHolding').optional({ nullable: true }).isFloat({ min: 0, max: 100 }).toFloat(),
  // Session / match commission received from the upline — players and staff alike.
  ...['matchCommission', 'sessionCommission'].map((field) =>
    body(field).optional({ nullable: true }).isFloat({ min: 0, max: 100 }).withMessage('Commission must be 0–100%').toFloat(),
  ),
];

const router = Router();
router.use(authenticate);

router.get(
  '/',
  [
    query('role').optional().isIn(ROLE_ORDER),
    query('status').optional().isIn(['active', 'suspended']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  ...userList,
  accountController.list,
);

router.get('/me/permissions', accountController.myPermissions);

router.post(
  '/',
  [
    body('role').isIn(ROLE_ORDER).withMessage('Unknown role'),
    body('username')
      .trim()
      .toLowerCase()
      .isLength({ min: 4, max: 32 })
      .matches(/^[a-z0-9_]+$/)
      .withMessage('Username may only contain lowercase letters, numbers and underscores'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('parentId').optional({ checkFalsy: true }).isMongoId(),
    body('name').optional().isString().trim().isLength({ max: 80 }),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Enter a valid email address'),
    phoneRule(),
    body('dob').optional({ checkFalsy: true }).isISO8601(),
    ...STAFF_FIELD_RULES,
  ],
  validate,
  accountController.create,
);

router.get('/:id', [param('id').isMongoId()], validate, ...userList, requireOwnSubtree('id'), accountController.getOne);

router.patch(
  '/:id',
  [
    param('id').isMongoId(),
    body('name').optional().isString().trim().isLength({ max: 80 }),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Enter a valid email address'),
    phoneRule(),
    body('city').optional().isString().trim().isLength({ max: 60 }),
    body('state').optional().isString().trim().isLength({ max: 60 }),
    body('dob').optional({ checkFalsy: true }).isISO8601(),
    ...STAFF_FIELD_RULES,
  ],
  validate,
  requireOwnSubtree('id'),
  accountController.update,
);

router.patch(
  '/:id/status',
  [param('id').isMongoId(), body('status').isIn(['active', 'suspended'])],
  validate,
  requireOwnSubtree('id'),
  accountController.updateStatus,
);

module.exports = router;
