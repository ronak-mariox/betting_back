const auditService = require('../services/audit.service');
const asyncHandler = require('../utils/asyncHandler');
const WalletRequest = require('../models/WalletRequest');
const ApiError = require('../utils/ApiError');
const walletService = require('../services/wallet.service');
const { scopeFor, requireGrant } = require('../services/scope.service');

const stats = asyncHandler(async (req, res) => {
  res.json({ stats: await walletService.getStats(await scopeFor(req.user)) });
});

/** Which request kinds the actor may see: "Deposit" / "Withdrawal" (view) on the Permissions page. */
async function visibleKinds(user) {
  // eslint-disable-next-line global-require
  const can = await require('../services/permission.service').checkerFor(user.role);
  return ['deposit', 'withdrawal'].filter((kind) => can('finance', kind, 'V'));
}

const requestProof = asyncHandler(async (req, res) => {
  const request = await WalletRequest.findById(req.params.id).select('kind');
  if (request && !(await visibleKinds(req.user)).includes(request.kind)) {
    throw ApiError.forbidden(`You do not have permission to view ${request.kind}s`);
  }
  const proof = await walletService.getRequestProof({ requestId: req.params.id, scope: await scopeFor(req.user) });
  res.json({ proof });
});

const listRequests = asyncHandler(async (req, res) => {
  const kinds = await visibleKinds(req.user);
  if (req.query.kind && !kinds.includes(req.query.kind)) {
    throw ApiError.forbidden(`You do not have permission to view ${req.query.kind}s`);
  }
  if (!kinds.length) return res.json({ items: [], total: 0, page: 1, limit: Number(req.query.limit) || 0 });
  // No kind asked: only the kinds this role may see.
  const kind = req.query.kind || (kinds.length === 1 ? kinds[0] : undefined);
  const result = await walletService.listRequests({ ...req.query, kind, scope: await scopeFor(req.user) });
  return res.json(result);
});

/** Approving/rejecting needs the Deposit or Withdrawal grant matching the request. */
const decide = (approve) =>
  asyncHandler(async (req, res) => {
    const pending = await WalletRequest.findById(req.params.id).select('kind');
    if (!pending) throw ApiError.notFound('Wallet request not found');
    await requireGrant(
      req.user,
      'finance',
      pending.kind === 'deposit' ? 'deposit' : 'withdrawal',
      'X',
      `You do not have permission to review ${pending.kind}s`,
    );
    const request = await walletService.decideRequest({
      requestId: req.params.id,
      approve,
      reason: req.body?.reason,
      reviewer: req.user,
      scope: await scopeFor(req.user),
    });
    await auditService.record({
      actor: req.user,
      action: `${request.kind}_${approve ? 'approved' : 'rejected'}`,
      target: request.user,
      req,
      metadata: { amount: request.amount, ...(request.rejectionReason ? { reason: request.rejectionReason } : {}) },
    });
    res.json({ request });
  });

const fundTransfer = asyncHandler(async (req, res) => {
  const result = await walletService.fundTransfer({
    actor: req.user,
    toUserId: req.body.toUserId,
    amount: req.body.amount,
    note: req.body.note,
    scope: await scopeFor(req.user),
  });
  res.status(201).json(result);
});

const approveRequest = decide(true);
const rejectRequest = decide(false);


const manualEntry = asyncHandler(async (req, res) => {
  const { userId, toUserId, action, amount, note } = req.body;
  if (action === 'Transfer') {
    const result = await walletService.transfer({ actor: req.user, fromUserId: userId, toUserId, amount, note });
    return res.json(result);
  }
  const result = await walletService.manualEntry({ actor: req.user, userId, action, amount, note });
  return res.json(result);
});

const listPayments = asyncHandler(async (req, res) => {
  const result = await walletService.listPayments(req.query);
  res.json(result);
});

const createPayment = asyncHandler(async (req, res) => {
  const { recipientType, recipientId, paymentType, method, amount, note } = req.body;
  const payment = await walletService.createPayment({
    actor: req.user,
    recipientType,
    recipientId,
    paymentType,
    method,
    amount,
    note,
  });
  res.status(201).json({ payment });
});

const listDisbursements = asyncHandler(async (req, res) => {
  const result = await walletService.listDisbursements(req.query);
  res.json(result);
});

module.exports = {
  stats,
  listRequests,
  requestProof,
  approveRequest,
  fundTransfer,
  rejectRequest,
  manualEntry,
  listPayments,
  createPayment,
  listDisbursements,
};
