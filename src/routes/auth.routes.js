const { phoneRule } = require('../utils/phone');
const { Router } = require('express');
const env = require('../config/env');
const { body, param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/auth.controller');
const { requireGrant } = require('../services/scope.service');

/** Staff accounts follow the Permissions page here; players always manage their own profile. */
const staffGrant = (groupKey, permissionKey, message) => async (req, _res, next) => {
  try {
    if (req.user.role !== 'player') await requireGrant(req.user, groupKey, permissionKey, 'X', message);
    next();
  } catch (err) {
    next(err);
  }
};
const validate = require('../middleware/validate');
const { authenticate, optionalAuthenticate, authorize } = require('../middleware/auth');

const router = Router();

/**
 * Slows down credential-stuffing / brute-force attempts against login & register.
 * Development allows more, since an emulator and the panel share one IP while testing.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.nodeEnv === 'production' ? 20 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later' } },
});

const usernameRule = body('username')
  .trim()
  .toLowerCase()
  .isLength({ min: 4, max: 32 })
  .withMessage('Username must be at least 4 characters')
  .matches(/^[a-z0-9_]+$/)
  .withMessage('Username may only contain lowercase letters, numbers and underscores');

router.post(
  '/register',
  authLimiter,
  [
    usernameRule,
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('referralCode').optional({ checkFalsy: true }).trim().isLength({ max: 32 }),
  ],
  validate,
  authController.register,
);

router.post(
  '/login',
  authLimiter,
  [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required'),
    body('roleId')
      .optional({ checkFalsy: true })
      .isIn(['super-admin', 'franchise', 'super-agent', 'agent', 'player']),
  ],
  validate,
  authController.login,
);

router.post(
  '/refresh',
  [body('refreshToken').notEmpty().withMessage('refreshToken is required')],
  validate,
  authController.refresh,
);

router.post('/logout', optionalAuthenticate, authController.logout);

router.get('/me', authenticate, authController.me);

router.patch(
  '/me',
  authenticate,
  staffGrant('accountSettings', 'editProfile', 'You do not have permission to edit your profile'),
  [
    body('name').optional({ checkFalsy: true }).trim().isLength({ max: 80 }),
    body('email').optional({ checkFalsy: true }).trim().isEmail().withMessage('Enter a valid email'),
    phoneRule(),
    body('city').optional({ checkFalsy: true }).trim().isLength({ max: 60 }),
    body('state').optional({ checkFalsy: true }).trim().isLength({ max: 60 }),
    body('dob').optional({ checkFalsy: true }).isISO8601().withMessage('dob must be an ISO date (YYYY-MM-DD)'),
    body('preferences').optional().isObject(),
    body('preferences.*').optional().isBoolean(),
    body('avatar')
      .optional({ checkFalsy: true })
      .isString()
      .isLength({ max: 2_000_000 })
      .matches(/^data:image\/(png|jpe?g|webp);base64,/)
      .withMessage('avatar must be a PNG/JPEG/WebP data URI'),
  ],
  validate,
  authController.updateMe,
);

router.post(
  '/change-password',
  authenticate,
  staffGrant('accountSettings', 'changePassword', 'You do not have permission to change your password'),
  [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  validate,
  authController.changePassword,
);

/** Tighter than authLimiter: each request can send an email. */
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.nodeEnv === 'production' ? 5 : 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many reset attempts, please try again later' } },
});

router.post(
  '/forgot-password',
  resetLimiter,
  [body('username').trim().notEmpty().withMessage('Username is required').isLength({ max: 32 })],
  validate,
  authController.forgotPassword,
);

router.post(
  '/reset-password',
  authLimiter,
  [
    body('username').trim().notEmpty().withMessage('Username is required').isLength({ max: 32 }),
    body('code').trim().matches(/^\d{6}$/).withMessage('Enter the 6-digit code'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  validate,
  authController.resetPassword,
);

router.get('/sessions', authenticate, authController.listSessions);
router.delete(
  '/sessions/:id',
  authenticate,
  [param('id').isMongoId()],
  validate,
  authController.revokeSession,
);

router.get('/audit-logs', authenticate, authorize('super-admin'), authController.auditLogs);

// Security console (super-admin): platform-wide sessions and headline figures.
router.get('/security/stats', authenticate, authorize('super-admin'), authController.securityStats);
router.get('/security/sessions', authenticate, authorize('super-admin'), authController.allSessions);
router.post('/security/sessions/revoke-all', authenticate, authorize('super-admin'), authController.revokeAllSessions);

module.exports = router;
