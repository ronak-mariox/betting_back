const { Router } = require('express');
const { body, param, query } = require('express-validator');
const supportController = require('../controllers/support.controller');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { grant } = require('../services/scope.service');
const { ROLE_ORDER } = require('../constants/roles');
const { TICKET_STATUSES, TICKET_PRIORITIES } = require('../constants/admin');

const router = Router();
router.use(authenticate);

const adminOnly = authorize('super-admin');
const staff = authorize('super-admin', 'franchise', 'super-agent', 'agent');
/** Players raise tickets from the app's Help screen; staff from the panel. */
const ticketOwner = authorize('super-admin', 'franchise', 'super-agent', 'agent', 'player');
/** The Permissions page governs staff only — a player always has its own tickets. */
const staffGrant = (...args) => {
  const check = grant(...args);
  return (req, res, next) => (req.user.role === 'player' ? next() : check(req, res, next));
};

/**
 * Own tickets (staff and players): raising one needs the "Raise Ticket" grant, reading
 * the history (and replying in it) the "View Tickets" grant. Each account
 * only ever reaches the tickets it raised itself.
 */
router.get('/my-tickets', ticketOwner, staffGrant('support', 'viewTickets', 'V', 'You do not have permission to view tickets'), supportController.listMine);

router.post(
  '/my-tickets',
  ticketOwner,
  staffGrant('support', 'raiseTicket', 'X', 'You do not have permission to raise tickets'),
  [
    body('subject').trim().isLength({ min: 4, max: 120 }).withMessage('Write a subject (4 to 120 characters)'),
    body('category').optional().isString().trim().isLength({ max: 40 }),
    body('priority').optional().isIn(TICKET_PRIORITIES),
    body('body').trim().isLength({ min: 10, max: 2000 }).withMessage('Describe the problem (at least 10 characters)'),
  ],
  validate,
  supportController.createMine,
);

router.get(
  '/my-tickets/:id',
  ticketOwner,
  staffGrant('support', 'viewTickets', 'V', 'You do not have permission to view tickets'),
  [param('id').isMongoId()],
  validate,
  supportController.getMine,
);

router.post(
  '/my-tickets/:id/messages',
  ticketOwner,
  staffGrant('support', 'viewTickets', 'V', 'You do not have permission to view tickets'),
  [param('id').isMongoId(), body('body').trim().isLength({ min: 1, max: 2000 })],
  validate,
  supportController.replyMine,
);

// ---- The support desk (super-admin) ----
router.get(
  '/tickets',
  adminOnly,
  [
    query('status').optional().isIn(TICKET_STATUSES),
    query('priority').optional().isIn(TICKET_PRIORITIES),
    query('q').optional().isString(),
  ],
  validate,
  supportController.list,
);

router.post(
  '/tickets',
  adminOnly,
  [
    body('subject').trim().notEmpty(),
    body('raisedBy').isMongoId(),
    body('category').optional().isString(),
    body('role').optional().isIn(ROLE_ORDER),
    body('priority').optional().isIn(TICKET_PRIORITIES),
    body('body').optional().isString(),
  ],
  validate,
  supportController.create,
);

router.get('/tickets/:id', adminOnly, [param('id').isMongoId()], validate, supportController.getOne);

router.patch(
  '/tickets/:id/status',
  adminOnly,
  [param('id').isMongoId(), body('status').isIn(TICKET_STATUSES)],
  validate,
  supportController.updateStatus,
);

router.post(
  '/tickets/:id/messages',
  adminOnly,
  [param('id').isMongoId(), body('body').trim().notEmpty()],
  validate,
  supportController.addMessage,
);

module.exports = router;
