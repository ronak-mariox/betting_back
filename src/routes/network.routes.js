const { Router } = require('express');
const { body, param, query } = require('express-validator');
const { grant } = require('../services/scope.service');
const networkController = require('../controllers/network.controller');
const validate = require('../middleware/validate');
const { authenticate, authorize, requireOwnSubtree } = require('../middleware/auth');

/**
 * Downline directory for the Users / Franchise / Super Agent / Agent pages.
 * Open to every staff role — results are always limited to the caller's own
 * downline (everyone, for super-admin).
 */
const router = Router();
router.use(authenticate, authorize('super-admin', 'franchise', 'super-agent', 'agent'));

/** The signed-in account's own dashboard (the Agent dashboard screen). */
router.get('/dashboard', networkController.myDashboard);

/** The signed-in account's Profile page data (stats, activity, logins, sessions, wallet). */
router.get('/me/profile', networkController.myProfile);

router.get(
  '/accounts',
  [
    query('role').optional().isIn(['franchise', 'super-agent', 'agent', 'player']),
    query('status').optional().isIn(['active', 'suspended']),
    query('q').optional().isString().isLength({ max: 100 }),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  networkController.userList,
  networkController.list,
);

router.get('/accounts/:id', [param('id').isMongoId()], validate, networkController.userList, requireOwnSubtree('id'), networkController.getOne);

// Betting side for staff, each behind its Permissions-page grant.
router.get('/events', grant('bettingMarkets', 'events', 'V', 'You do not have permission to view events'), networkController.events);
router.get(
  '/markets',
  grant('bettingMarkets', 'markets', 'V', 'You do not have permission to view markets'),
  [query('eventId').optional().isMongoId()],
  validate,
  networkController.markets,
);
router.get('/analytics', grant('reportsAnalytics', 'analytics', 'V', 'You do not have permission to view analytics'), networkController.analytics);
router.post(
  '/bets/:id/void',
  grant('bettingMarkets', 'voidBet', 'X', 'You do not have permission to void bets'),
  [param('id').isMongoId(), body('reason').optional().isString().trim().isLength({ max: 200 })],
  validate,
  networkController.voidBet,
);

module.exports = router;
