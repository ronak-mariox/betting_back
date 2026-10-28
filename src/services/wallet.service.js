const Settings = require('../models/Settings');
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const WalletRequest = require('../models/WalletRequest');
const Payment = require('../models/Payment');
const FundTransfer = require('../models/FundTransfer');
const { inTransaction } = require('../utils/transaction');
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

/**
 * A super-admin correction: credit, debit or adjustment (either direction).
 * Every entry is its own ledger row with the reason recorded — old rows are
 * never edited (see utils/immutable.js).
 */
const manualEntry = async ({ actor, userId, action, amount, note, direction }) => {
  const normalizedAmount = Math.round(Number(amount) * 100) / 100;
  const reason = String(note || '').trim();
  if (!reason) throw ApiError.badRequest('Write the reason for this entry');
  const debit = action === 'Debit' || (action === 'Adjustment' && direction === 'debit');
  const delta = debit ? -normalizedAmount : normalizedAmount;

  const { user, txn } = await inTransaction(async (session) => {
    const updated = await User.findOneAndUpdate(
      { _id: userId, ...(debit ? { walletBalance: { $gte: normalizedAmount } } : {}) },
      { $inc: { walletBalance: delta } },
      { returnDocument: 'after', session },
    );
    if (!updated) {
      if (!(await User.exists({ _id: userId }).session(session))) throw ApiError.notFound('User not found');
      throw ApiError.badRequest('User has insufficient wallet balance');
    }
    const [row] = await Transaction.create(
      [
        {
          user: updated._id,
          type: 'Adjustment',
          amount: delta,
          method: `Manual ${action}`,
          status: 'Completed',
          note: reason,
          reason,
          balanceAfter: updated.walletBalance,
          createdBy: actor._id,
        },
      ],
      { session },
    );
    return { user: updated, txn: row };
  });
  await notificationService.notifyWalletAdjustment({ user: user._id, amount: delta, note: reason });

  return { user, transaction: txn };
};

/** Super-admin: move money between any two accounts (both ledger rows share one reference). */
const transfer = async ({ actor, fromUserId, toUserId, amount, note }) => {
  if (String(fromUserId) === String(toUserId)) throw ApiError.badRequest('Cannot transfer to the same account');
  const normalizedAmount = Number(amount);
  const reason = String(note || '').trim();
  if (!reason) throw ApiError.badRequest('Write the reason for this transfer');

  const result = await inTransaction(async (session) => {
    const toUser = await User.findById(toUserId).session(session);
    if (!toUser) throw ApiError.notFound('User not found');
    const fromUser = await User.findOneAndUpdate(
      { _id: fromUserId, walletBalance: { $gte: normalizedAmount } },
      { $inc: { walletBalance: -normalizedAmount } },
      { returnDocument: 'after', session },
    );
    if (!fromUser) {
      if (!(await User.exists({ _id: fromUserId }).session(session))) throw ApiError.notFound('User not found');
      throw ApiError.badRequest('Sender has insufficient wallet balance');
    }
    const credited = await User.findOneAndUpdate(
      { _id: toUser._id },
      { $inc: { walletBalance: normalizedAmount } },
      { returnDocument: 'after', session },
    );
    const reference = `TRF${new mongoose.Types.ObjectId().toString().slice(-8).toUpperCase()}`;
    const transactions = await Transaction.create(
      [
        {
          user: fromUser._id,
          type: 'Adjustment',
          amount: -normalizedAmount,
          method: 'Fund Transfer',
          reference,
          status: 'Completed',
          note: reason,
          reason,
          counterparty: credited._id,
          balanceAfter: fromUser.walletBalance,
          createdBy: actor._id,
        },
        {
          user: credited._id,
          type: 'Adjustment',
          amount: normalizedAmount,
          method: 'Fund Transfer',
          reference,
          status: 'Completed',
          note: reason,
          reason,
          counterparty: fromUser._id,
          balanceAfter: credited.walletBalance,
          createdBy: actor._id,
        },
      ],
      { session, ordered: true },
    );
    return { fromUser, toUser: credited, transactions };
  });

  await Promise.all([
    notificationService.notifyWalletAdjustment({ user: result.fromUser._id, amount: -normalizedAmount, note: reason }),
    notificationService.notifyWalletAdjustment({ user: result.toUser._id, amount: normalizedAmount, note: reason }),
  ]);

  return result;
};

/** What the panel shows for one transfer attempt. */
const transferView = (t) => ({
  _id: t._id,
  reference: t.reference,
  amount: t.amount,
  status: t.status,
  failureReason: t.failureReason,
  note: t.note,
  from: t.from,
  to: t.to,
  balanceAfter: t.balanceAfter,
  createdAt: t.createdAt,
  completedAt: t.completedAt,
});

/**
 * A staff member moves money from their own wallet to an account in their
 * downline (an agent's float, a player's balance). Every attempt is recorded
 * (FundTransfer) — failed ones too, with the reason. The debit, the credit
 * and both ledger rows are applied together or not at all, and a repeated
 * `idempotencyKey` (a double click, a retry) returns the first result instead
 * of moving money again.
 */
const fundTransfer = async ({ actor, toUserId, amount, note, scope, idempotencyKey = null }) => {
  const value = Number(amount);
  if (!Number.isInteger(value) || value <= 0) throw ApiError.badRequest('Enter a whole rupee amount to transfer');
  if (String(toUserId) === String(actor._id)) throw ApiError.badRequest('Choose an account other than your own');
  if (scope && !scope.some((id) => String(id) === String(toUserId))) {
    throw ApiError.forbidden('You can only transfer to accounts in your own network');
  }

  /** The same form sent again (double click, retry): answer with the first attempt's outcome, never move money twice. */
  const replay = (earlier) => {
    if (earlier.status === 'Pending') throw ApiError.conflict('This transfer is already being processed');
    if (earlier.status !== 'Completed') throw ApiError.badRequest(earlier.failureReason || `This transfer was ${earlier.status.toLowerCase()}`);
    return { ...transferView(earlier), balance: earlier.balanceAfter, duplicate: true };
  };
  if (idempotencyKey) {
    const earlier = await FundTransfer.findOne({ from: actor._id, idempotencyKey }).populate('to', 'name username role');
    if (earlier) return replay(earlier);
  }

  const receiver = await User.findById(toUserId).select('username name role status');
  const reference = `TRF${new mongoose.Types.ObjectId().toString().slice(-8).toUpperCase()}`;
  let record;
  try {
    record = await FundTransfer.create({
      reference,
      from: actor._id,
      to: receiver?._id ?? null,
      amount: value,
      note: note || '',
      idempotencyKey,
    });
  } catch (err) {
    // The same form was submitted twice at once: the first one wins.
    if (err?.code === 11000 && idempotencyKey) {
      const earlier = await FundTransfer.findOne({ from: actor._id, idempotencyKey }).populate('to', 'name username role');
      return replay(earlier);
    }
    throw err;
  }

  const fail = async (status, message) => {
    await FundTransfer.updateOne({ _id: record._id }, { $set: { status, failureReason: message } });
  };

  if (!receiver) {
    await fail('Failed', 'Account not found');
    throw ApiError.notFound('Account not found');
  }
  if (receiver.status !== 'active') {
    await fail('Cancelled', 'Receiving account is suspended');
    throw ApiError.badRequest('That account is suspended');
  }

  let sender;
  try {
    sender = await inTransaction(async (session) => {
      const debited = await User.findOneAndUpdate(
        { _id: actor._id, walletBalance: { $gte: value } },
        { $inc: { walletBalance: -value } },
        { returnDocument: 'after', session },
      );
      if (!debited) throw ApiError.badRequest('Your wallet balance is not enough for this transfer');
      const credited = await User.findOneAndUpdate(
        { _id: receiver._id, status: 'active' },
        { $inc: { walletBalance: value } },
        { returnDocument: 'after', session },
      );
      if (!credited) throw ApiError.badRequest('That account is no longer active');
      await Transaction.create(
        [
          {
            user: debited._id,
            type: 'Adjustment',
            amount: -value,
            method: 'Fund Transfer',
            reference,
            status: 'Completed',
            note: note || `Transfer to ${receiver.name || receiver.username}`,
            counterparty: receiver._id,
            balanceAfter: debited.walletBalance,
            createdBy: actor._id,
          },
          {
            user: receiver._id,
            type: 'Adjustment',
            amount: value,
            method: 'Fund Transfer',
            reference,
            status: 'Completed',
            note: note || `Transfer from ${debited.name || debited.username}`,
            counterparty: debited._id,
            balanceAfter: credited.walletBalance,
            createdBy: actor._id,
          },
        ],
        { session, ordered: true },
      );
      return debited;
    });
  } catch (err) {
    await fail('Failed', err instanceof ApiError ? err.message : 'Transfer could not be completed').catch(() => null);
    throw err;
  }

  const completedAt = new Date();
  await FundTransfer.updateOne(
    { _id: record._id },
    { $set: { status: 'Completed', balanceAfter: sender.walletBalance, completedAt } },
  );
  await notificationService.notifyWalletAdjustment({ user: receiver._id, amount: value, from: sender.name || sender.username, note });
  return {
    reference,
    amount: value,
    status: 'Completed',
    balance: sender.walletBalance,
    createdAt: record.createdAt,
    to: { _id: receiver._id, name: receiver.name, username: receiver.username, role: receiver.role },
  };
};

/**
 * Transfer history: what the actor sent and received, or — for super-admin
 * and with `all` — every transfer in the actor's network. Failed and
 * cancelled attempts are included.
 */
const listTransfers = async ({ actor, scope = null, all = false, status, page = 1, limit = DEFAULT_PAGE_LIMIT }) => {
  const filter = all && scope === null ? {} : all ? { from: { $in: scope } } : { $or: [{ from: actor._id }, { to: actor._id }] };
  if (status) filter.status = status;
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    FundTransfer.find(filter)
      .populate('from', 'name username role')
      .populate('to', 'name username role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    FundTransfer.countDocuments(filter),
  ]);
  return { items: items.map(transferView), total, page: Number(page), limit: Number(limit) };
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
/**
 * `reservePercent`: the share of the wallet balance that always stays in the
 * wallet and can't be withdrawn (Settings → Wallet Rules → Wallet Reserve %),
 * e.g. 10 = players withdraw at most 90%. 0 = no reserve.
 */
const DEFAULT_WALLET_RULES = { minDeposit: 100, maxDeposit: 500000, minWithdrawal: 500, maxWithdrawal: 200000, reservePercent: 0 };

/** Deposit / withdrawal limits the admin set on the Settings page. */
const walletRules = async () => {
  const settings = await Settings.findById('main').select('walletRules').lean();
  const rules = { ...DEFAULT_WALLET_RULES };
  for (const key of Object.keys(rules)) {
    const value = Number(settings?.walletRules?.[key]);
    if (Number.isFinite(value) && value > 0) rules[key] = value;
  }
  rules.reservePercent = Math.min(99, rules.reservePercent);
  return rules;
};

/**
 * What a player can withdraw right now: the balance not held by open bets or
 * pending withdrawals, minus the reserve that always stays in the wallet
 * (reservePercent% of the balance).
 */
const withdrawableFor = ({ balance, openStake, pendingWithdrawal, reservePercent }) => {
  const mustStay = Math.ceil((balance * reservePercent) / 100);
  return Math.max(0, Math.floor(balance - openStake - pendingWithdrawal - mustStay));
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
    /** What can be withdrawn now: `available` less the reserve that stays in the wallet. */
    withdrawable: withdrawableFor({ balance: user.walletBalance, openStake, pendingWithdrawal, reservePercent: rules.reservePercent }),
    /** Settings → Wallet Rules → Wallet Reserve %: the share of the balance that can't be withdrawn (0 = none). */
    reservePercent: rules.reservePercent,
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
    const withdrawable = withdrawableFor({
      balance: user.walletBalance,
      openStake,
      pendingWithdrawal,
      reservePercent: rules.reservePercent,
    });
    if (value > withdrawable) {
      throw ApiError.badRequest(
        `Wallet balance ka ${rules.reservePercent}% hamesha wallet mein rehta hai — abhi maximum ${rupees(withdrawable)} nikal sakte ho`,
      );
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
  listTransfers,
  manualEntry,
  transfer,
  listPayments,
  createPayment,
  listDisbursements,
  walletRules,
};
