const Settings = require('../models/Settings');
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const WalletRequest = require('../models/WalletRequest');
const Payment = require('../models/Payment');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');
const { applyScope } = require('./scope.service');

const LARGE_AMOUNT_THRESHOLD = 50000;
const DEFAULT_PAGE_LIMIT = 20;

/** Midnight in the platform's timezone (Settings → General), not the server's. */
const startOfToday = () => require('../utils/time').startOfDay(0); // eslint-disable-line global-require
const { money } = require('../utils/money');

/** `scope` (from scope.service) limits every figure to those accounts; null = whole platform. */
const getStats = async (scope = null) => {
  const inScope = (filter, field = 'user') => applyScope(filter, scope, field);
  const [pendingDeposits, pendingWithdrawals, balanceAgg, todayAgg] = await Promise.all([
    WalletRequest.countDocuments(inScope({ kind: 'deposit', status: 'Pending' })),
    WalletRequest.countDocuments(inScope({ kind: 'withdrawal', status: 'Pending' })),
    User.aggregate([
      { $match: inScope({ role: 'player' }, '_id') },
      { $group: { _id: null, total: { $sum: '$walletBalance' } } },
    ]),
    Transaction.aggregate([
      { $match: inScope({ createdAt: { $gte: startOfToday() } }) },
      { $group: { _id: null, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
    ]),
  ]);

  return {
    pendingDeposits,
    pendingWithdrawals,
    totalWalletBalance: balanceAgg[0]?.total || 0,
    todayVolume: todayAgg[0]?.total || 0,
    todayTransactionCount: todayAgg[0]?.count || 0,
  };
};

const listRequests = async ({ kind, status, page = 1, limit = DEFAULT_PAGE_LIMIT, scope = null }) => {
  const filter = applyScope({}, scope);
  if (kind) filter.kind = kind;
  if (status) filter.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    WalletRequest.find(filter)
      .populate('user', 'name username email')
      .populate('reviewedBy', 'name username')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    WalletRequest.countDocuments(filter),
  ]);

  return { items, total, page: Number(page), limit: Number(limit) };
};

/**
 * Approves or rejects a pending request. Both steps that matter are atomic,
 * so two reviewers (or a double click) can never pay one request twice:
 * the request is claimed only while it's still Pending, and a withdrawal
 * only debits a wallet that still holds the amount.
 */
/**
 * Settings → Commission → User Referral Bonus: when a player who signed up
 * with another player's code gets their first deposit approved, the referrer
 * is credited that percent of it — once per referred player.
 */
const payReferralBonus = async ({ player, deposit, reviewer }) => {
  if (!player.referredBy) return;
  const percent = Number((await Settings.findById('main').select('commissionRates').lean())?.commissionRates?.referral) || 0;
  if (percent <= 0) return;
  const earlier = await WalletRequest.exists({ user: player._id, kind: 'deposit', status: 'Approved', _id: { $ne: deposit._id } });
  if (earlier) return;
  const bonus = Math.round((deposit.amount * percent) / 100);
  if (bonus <= 0) return;
  const reference = `referral:${player._id}`;
  // The reference makes it once-only even if two first deposits are approved together.
  if (await Transaction.exists({ type: 'Referral Bonus', reference })) return;
  const referrer = await User.findOneAndUpdate(
    { _id: player.referredBy, status: 'active' },
    { $inc: { walletBalance: bonus } },
    { returnDocument: 'after' },
  );
  if (!referrer) return;
  await Transaction.create({
    user: referrer._id,
    type: 'Referral Bonus',
    amount: bonus,
    reference,
    status: 'Completed',
    note: `Referral bonus — ${player.name || player.username} made their first deposit`,
    createdBy: reviewer._id,
  });
  await notificationService.notifyWalletAdjustment({
    user: referrer._id,
    amount: bonus,
    note: `Referral bonus: ${player.name || player.username} ne pehla deposit kiya`,
  });
};

const decideRequest = async ({ requestId, approve, reviewer, reason = '', scope = null }) => {
  const pending = await WalletRequest.findById(requestId);
  if (!pending) throw ApiError.notFound('Wallet request not found');
  if (scope && !scope.some((id) => String(id) === String(pending.user))) {
    throw ApiError.forbidden('That request belongs to a user outside your downline');
  }

  const request = await WalletRequest.findOneAndUpdate(
    { _id: requestId, status: 'Pending' },
    {
      $set: {
        status: approve ? 'Approved' : 'Rejected',
        reviewedBy: reviewer._id,
        reviewedAt: new Date(),
        rejectionReason: approve ? '' : String(reason || '').trim().slice(0, 200),
      },
    },
    { returnDocument: 'after' },
  );
  if (!request) throw ApiError.conflict('Request has already been reviewed');
  if (!approve) {
    await notificationService.notifyWalletDecision(request);
    return request;
  }

  const delta = request.kind === 'deposit' ? request.amount : -request.amount;
  const user = await User.findOneAndUpdate(
    { _id: request.user, ...(delta < 0 ? { walletBalance: { $gte: request.amount } } : {}) },
    { $inc: { walletBalance: delta } },
    { returnDocument: 'after' },
  );
  if (!user) {
    // Nothing was paid: put the request back in the queue.
    await WalletRequest.updateOne({ _id: request._id }, { $set: { status: 'Pending', reviewedBy: null, reviewedAt: null } });
    throw ApiError.badRequest('User has insufficient wallet balance for this withdrawal');
  }

  await Transaction.create({
    user: user._id,
    type: request.kind === 'deposit' ? 'Deposit' : 'Withdrawal',
    amount: delta,
    method: request.method,
    reference: request.reference,
    status: 'Completed',
    note: `Wallet request ${request.kind} approved`,
    createdBy: reviewer._id,
  });
  await notificationService.notifyWalletDecision(request);
  if (request.kind === 'deposit') await payReferralBonus({ player: user, deposit: request, reviewer });

  if (request.amount >= LARGE_AMOUNT_THRESHOLD) {
    await notificationService.notify({
      title: `Large ${request.kind} approved`,
      body: `${money(request.amount)} ${request.kind} approved for user ${user.username}`,
      category: 'wallet',
      emoji: '💰',
    });
  }

  return request;
};

const manualEntry = async ({ actor, userId, action, amount, note }) => {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found');

  const normalizedAmount = Number(amount);
  const delta = action === 'Debit' ? -normalizedAmount : normalizedAmount;
  if (action === 'Debit' && user.walletBalance < normalizedAmount) {
    throw ApiError.badRequest('User has insufficient wallet balance');
  }

  user.walletBalance += delta;
  await user.save();

  const txn = await Transaction.create({
    user: user._id,
    type: 'Adjustment',
    amount: delta,
    status: 'Completed',
    note: note || `Manual ${action}`,
    createdBy: actor._id,
  });
  await notificationService.notifyWalletAdjustment({ user: user._id, amount: delta, note });

  return { user, transaction: txn };
};

const transfer = async ({ actor, fromUserId, toUserId, amount, note }) => {
  if (String(fromUserId) === String(toUserId)) throw ApiError.badRequest('Cannot transfer to the same account');
  const normalizedAmount = Number(amount);

  const [fromUser, toUser] = await Promise.all([User.findById(fromUserId), User.findById(toUserId)]);
  if (!fromUser || !toUser) throw ApiError.notFound('User not found');
  if (fromUser.walletBalance < normalizedAmount) throw ApiError.badRequest('Sender has insufficient wallet balance');

  fromUser.walletBalance -= normalizedAmount;
  toUser.walletBalance += normalizedAmount;
  await Promise.all([fromUser.save(), toUser.save()]);

  const reference = new mongoose.Types.ObjectId().toString();
  const [debitTxn, creditTxn] = await Promise.all([
    Transaction.create({
      user: fromUser._id,
      type: 'Adjustment',
      amount: -normalizedAmount,
      reference,
      status: 'Completed',
      note: note || `Transfer to ${toUser.username}`,
      createdBy: actor._id,
    }),
    Transaction.create({
      user: toUser._id,
      type: 'Adjustment',
      amount: normalizedAmount,
      reference,
      status: 'Completed',
      note: note || `Transfer from ${fromUser.username}`,
      createdBy: actor._id,
    }),
  ]);

  await Promise.all([
    notificationService.notifyWalletAdjustment({ user: fromUser._id, amount: -normalizedAmount, note }),
    notificationService.notifyWalletAdjustment({ user: toUser._id, amount: normalizedAmount, note }),
  ]);

  return { fromUser, toUser, transactions: [debitTxn, creditTxn] };
};

/**
 * A staff member moves money from their own wallet to an account in their
 * downline (an agent's float, a player's balance). The debit only happens
 * while the sender still holds the amount, so two transfers sent together
 * can't overdraw it.
 */
const fundTransfer = async ({ actor, toUserId, amount, note, scope }) => {
  const value = Math.round(Number(amount));
  if (!(value > 0)) throw ApiError.badRequest('Enter an amount to transfer');
  if (String(toUserId) === String(actor._id)) throw ApiError.badRequest('Choose an account other than your own');
  if (scope && !scope.some((id) => String(id) === String(toUserId))) {
    throw ApiError.forbidden('You can only transfer to accounts in your own network');
  }
  const receiver = await User.findById(toUserId).select('username name role status');
  if (!receiver) throw ApiError.notFound('Account not found');
  if (receiver.status !== 'active') throw ApiError.badRequest('That account is suspended');

  const sender = await User.findOneAndUpdate(
    { _id: actor._id, walletBalance: { $gte: value } },
    { $inc: { walletBalance: -value } },
    { returnDocument: 'after' },
  );
  if (!sender) throw ApiError.badRequest('Your wallet balance is not enough for this transfer');
  await User.updateOne({ _id: receiver._id }, { $inc: { walletBalance: value } });

  const reference = `TRF${new mongoose.Types.ObjectId().toString().slice(-8).toUpperCase()}`;
  await Transaction.create([
    {
      user: sender._id,
      type: 'Adjustment',
      amount: -value,
      method: 'Fund Transfer',
      reference,
      status: 'Completed',
      note: note || `Transfer to ${receiver.name || receiver.username}`,
      createdBy: actor._id,
    },
    {
      user: receiver._id,
      type: 'Adjustment',
      amount: value,
      method: 'Fund Transfer',
      reference,
      status: 'Completed',
      note: note || `Transfer from ${sender.name || sender.username}`,
      createdBy: actor._id,
    },
  ]);
  await notificationService.notifyWalletAdjustment({ user: receiver._id, amount: value, from: sender.name || sender.username, note });
  return { reference, amount: value, balance: sender.walletBalance, to: { _id: receiver._id, name: receiver.name, username: receiver.username, role: receiver.role } };
};

const listPayments = async ({ page = 1, limit = DEFAULT_PAGE_LIMIT }) => {
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    Payment.find().populate('createdBy', 'name username').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    Payment.countDocuments(),
  ]);
  return { items, total, page: Number(page), limit: Number(limit) };
};

const createPayment = async ({ actor, recipientType, recipientId, paymentType, method, amount, note }) => {
  let relatedPartner = null;
  if (recipientType === 'Partner') {
    const Partner = require('../models/Partner'); // eslint-disable-line global-require
    const partner = await Partner.findById(recipientId);
    if (!partner) throw ApiError.notFound('Partner not found');
    relatedPartner = partner._id;
  } else {
    const user = await User.findById(recipientId);
    if (!user) throw ApiError.notFound('User not found');
  }

  const payment = await Payment.create({
    recipientType,
    recipient: recipientId,
    paymentType,
    method,
    amount,
    note,
    status: 'Completed',
    createdBy: actor._id,
  });

  await Transaction.create({
    user: recipientType === 'User' ? recipientId : null,
    type: 'Payment',
    amount: -Number(amount),
    method,
    relatedPartner,
    note: note || paymentType,
    status: 'Completed',
    createdBy: actor._id,
  });

  return payment;
};

const listDisbursements = async ({ page = 1, limit = DEFAULT_PAGE_LIMIT }) => {
  const filter = { type: { $in: ['Payment', 'Commission'] } };
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    Transaction.find(filter)
      .populate('user', 'name username')
      .populate('relatedPartner', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Transaction.countDocuments(filter),
  ]);
  return { items, total, page: Number(page), limit: Number(limit) };
};

/** Used until the admin saves Wallet Rules in Settings. */
const DEFAULT_WALLET_RULES = { minDeposit: 100, maxDeposit: 500000, minWithdrawal: 500, maxWithdrawal: 200000 };

/** Deposit / withdrawal limits the admin set on the Settings page. */
const walletRules = async () => {
  const settings = await Settings.findById('main').select('walletRules').lean();
  const rules = { ...DEFAULT_WALLET_RULES };
  for (const key of Object.keys(rules)) {
    const value = Number(settings?.walletRules?.[key]);
    if (Number.isFinite(value) && value > 0) rules[key] = value;
  }
  return rules;
};

/** Withdrawals asked for today (pending or paid) — the "Max Withdrawal / Day" counts these. */
const withdrawnToday = async (userId) => {
  const [row] = await WalletRequest.aggregate([
    { $match: { user: userId, kind: 'withdrawal', status: { $in: ['Pending', 'Approved'] }, createdAt: { $gte: startOfToday() } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row?.total || 0;
};

/** The player's own wallet for the app: balance, pending requests and recent ledger rows. */
const getPlayerWallet = async (player) => {
  const [user, transactions, requests, wonTodayAgg, rules, withdrawn] = await Promise.all([
    User.findById(player._id).select('walletBalance'),
    Transaction.find({ user: player._id }).sort({ createdAt: -1 }).limit(30),
    WalletRequest.find({ user: player._id }).sort({ createdAt: -1 }).limit(30),
    Transaction.aggregate([
      { $match: { user: player._id, type: 'Bet Win', createdAt: { $gte: startOfToday() } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    walletRules(),
    withdrawnToday(player._id),
  ]);
  // eslint-disable-next-line global-require
  const { openStake, pendingWithdrawal } = await require('./playerBet.service').reservedFor(player._id);
  const processingHours = Number((await Settings.findById('main').select('walletRules').lean())?.walletRules?.processingHours) || null;
  return {
    balance: user.walletBalance,
    /** Stake held by open bets (not yet debited — they settle into the ledger). */
    openStake,
    pendingWithdrawal,
    /** What can be bet or withdrawn now: balance minus open stakes and pending withdrawals. */
    available: Math.max(0, user.walletBalance - openStake - pendingWithdrawal),
    wonToday: wonTodayAgg[0]?.total || 0,
    minDeposit: rules.minDeposit,
    maxDeposit: rules.maxDeposit,
    minWithdrawal: rules.minWithdrawal,
    /** What can still be withdrawn today (Max Withdrawal / Day minus today's requests). */
    maxWithdrawal: Math.max(0, rules.maxWithdrawal - withdrawn),
    maxWithdrawalPerDay: rules.maxWithdrawal,
    withdrawnToday: withdrawn,
    /** Settings → Wallet Rules → Withdrawal Processing Time; null when not set. */
    processingHours,
    transactions,
    requests,
  };
};

/**
 * Player raises a deposit (after paying the agent/platform via UPI etc.) or a
 * withdrawal from the app. Nothing moves until an agent / admin approves it
 * on the panel's Wallet page. Withdrawals need enough balance not
 * already tied up in open bets or pending withdrawals.
 */
/** Max decoded size of a payment screenshot (the app says "Max 5MB"). */
const MAX_PROOF_BYTES = 5 * 1024 * 1024;

const toProof = (file) => {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/.exec(file?.data || '');
  if (!match) throw ApiError.badRequest('Payment screenshot JPG, PNG ya WebP photo honi chahiye');
  const size = Buffer.byteLength(match[2], 'base64');
  if (size > MAX_PROOF_BYTES) throw ApiError.badRequest('Payment screenshot 5MB se chhota hona chahiye');
  return { name: String(file.name || 'payment.jpg').slice(0, 120), mime: match[1], size, data: file.data };
};

const createPlayerRequest = async (player, { kind, amount, method, reference, proof }) => {
  const value = Math.round(Number(amount));
  const rules = await walletRules();
  const rupees = money;
  if (kind === 'deposit') {
    if (!String(reference || '').trim()) throw ApiError.badRequest('Transaction ID daalna zaroori hai');
    if (!proof?.data) throw ApiError.badRequest('Payment ka screenshot lagana zaroori hai');
    if (value < rules.minDeposit) throw ApiError.badRequest(`Minimum deposit ${rupees(rules.minDeposit)} hai`);
    if (value > rules.maxDeposit) throw ApiError.badRequest(`Ek baar mein maximum deposit ${rupees(rules.maxDeposit)} hai`);
  }
  if (kind === 'withdrawal') {
    if (value < rules.minWithdrawal) throw ApiError.badRequest(`Minimum withdrawal ${rupees(rules.minWithdrawal)} hai`);
    const left = rules.maxWithdrawal - (await withdrawnToday(player._id));
    if (value > left) {
      throw ApiError.badRequest(
        left > 0
          ? `Aaj aap ${rupees(left)} tak aur withdraw kar sakte ho (daily limit ${rupees(rules.maxWithdrawal)})`
          : `Aaj ki withdrawal limit ${rupees(rules.maxWithdrawal)} poori ho gayi — kal try karo`,
      );
    }
    const user = await User.findById(player._id).select('walletBalance');
    // eslint-disable-next-line global-require
    const { openStake, pendingWithdrawal } = await require('./playerBet.service').reservedFor(player._id);
    if (value > user.walletBalance - openStake - pendingWithdrawal) {
      throw ApiError.badRequest('Wallet mein itna balance nahi hai');
    }
  }
  const created = await WalletRequest.create({
    user: player._id,
    kind,
    amount: value,
    method: method || '',
    reference: reference || '',
    ...(kind === 'deposit' ? { proof: toProof(proof) } : {}),
    status: 'Pending',
  });
  // Read back without the image, so the screenshot isn't sent back to the phone.
  const request = await WalletRequest.findById(created._id);
  if (value >= LARGE_AMOUNT_THRESHOLD) {
    await notificationService.notify({
      title: `Large ${kind} request`,
      body: `${money(value)} ${kind} requested by ${player.username}`,
      category: 'wallet',
      emoji: '💰',
    });
  }
  return request;
};

/** The screenshot attached to a deposit, for the reviewer's screen. */
const getRequestProof = async ({ requestId, scope = null }) => {
  const request = await WalletRequest.findById(requestId).select('user kind +proof.data proof.name proof.mime proof.size');
  if (!request) throw ApiError.notFound('Wallet request not found');
  if (scope && !scope.some((id) => String(id) === String(request.user))) {
    throw ApiError.forbidden('That request belongs to a user outside your downline');
  }
  if (!request.proof?.data) throw ApiError.notFound('No payment screenshot was attached to this request');
  return request.proof;
};

module.exports = {
  getPlayerWallet,
  createPlayerRequest,
  getRequestProof,
  getStats,
  listRequests,
  decideRequest,
  fundTransfer,
  manualEntry,
  transfer,
  listPayments,
  createPayment,
  listDisbursements,
};
