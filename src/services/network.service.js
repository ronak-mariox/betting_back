const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Commission = require('../models/Commission');
const FlaggedUser = require('../models/FlaggedUser');
const Transaction = require('../models/Transaction');
const AuditLog = require('../models/AuditLog');
const RefreshToken = require('../models/RefreshToken');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');
const permissionService = require('./permission.service');
const { IMMEDIATE_PARENT_ROLE } = require('./account.service');
const { roleIndex } = require('../constants/roles');
const { loadTree, descendants } = require('./tree.service');

const DETAIL_LIST_LIMIT = 50;
const RECENT_LIMIT = 25;

const toObjectIds = (ids) => ids.map((id) => new mongoose.Types.ObjectId(id));

const monthStart = (offset = 0) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 1);
};

/** The ids the actor may see: everyone for super-admin, else their own downline. */
function scopeIds(tree, actor) {
  if (actor.role === 'super-admin') return [...tree.byId.keys()];
  return descendants(tree, actor._id);
}

/** Per-user bet stats and per-entity commission/risk, for a set of user ids. */
async function loadMetrics(userIds) {
  const thisMonth = monthStart(0);
  const lastMonth = monthStart(-1);
  const [bets, commissions, flags, balances] = await Promise.all([
    Bet.aggregate([
      // Voided bets never counted: nothing was staked in the end.
      { $match: { user: { $in: toObjectIds(userIds) }, status: { $ne: 'Void' } } },
      {
        $group: {
          _id: '$user',
          bets: { $sum: 1 },
          turnover: { $sum: '$amount' },
          monthTurnover: { $sum: { $cond: [{ $gte: ['$createdAt', thisMonth] }, '$amount', 0] } },
          prevMonthTurnover: {
            $sum: {
              $cond: [{ $and: [{ $gte: ['$createdAt', lastMonth] }, { $lt: ['$createdAt', thisMonth] }] }, '$amount', 0],
            },
          },
          exposure: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, '$amount', 0] } },
          openBets: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } },
          won: { $sum: { $cond: [{ $eq: ['$status', 'Won'] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ['$status', 'Lost'] }, 1, 0] } },
        },
      },
    ]),
    Commission.aggregate([
      { $match: { entity: { $in: toObjectIds(userIds) } } },
      {
        $group: {
          _id: '$entity',
          total: { $sum: '$commission' },
          pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, '$commission', 0] } },
        },
      },
    ]),
    FlaggedUser.aggregate([
      { $match: { active: true, user: { $in: toObjectIds(userIds) } } },
      { $group: { _id: '$user', score: { $max: '$score' } } },
    ]),
    User.find({ _id: { $in: toObjectIds(userIds) } }, 'walletBalance').lean(),
  ]);

  const index = (rows) => new Map(rows.map((row) => [String(row._id), row]));
  return {
    bets: index(bets),
    commissions: index(commissions),
    flags: index(flags),
    balances: new Map(balances.map((row) => [String(row._id), Number(row.walletBalance) || 0])),
  };
}

const EMPTY_BETS = { bets: 0, turnover: 0, monthTurnover: 0, prevMonthTurnover: 0, exposure: 0, openBets: 0, won: 0, lost: 0 };

const riskLevel = (score) => {
  if (score === undefined) return 'low';
  if (score >= 75) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
};

/** Rolls bet stats up over an account's own bets plus its whole downline. */
function summarize(tree, metrics, accountId) {
  const id = String(accountId);
  const book = [id, ...descendants(tree, id)];
  const totals = { ...EMPTY_BETS };
  const counts = { franchises: 0, superAgents: 0, agents: 0, players: 0 };
  let downlineBalance = 0;
  for (const memberId of book) {
    const stats = metrics.bets.get(memberId);
    if (stats) for (const key of Object.keys(totals)) totals[key] += stats[key];
    if (memberId === id) continue;
    downlineBalance += metrics.balances.get(memberId) || 0;
    const role = tree.byId.get(memberId)?.role;
    if (role === 'franchise') counts.franchises += 1;
    if (role === 'super-agent') counts.superAgents += 1;
    if (role === 'agent') counts.agents += 1;
    if (role === 'player') counts.players += 1;
  }
  const commission = metrics.commissions.get(id);
  const settled = totals.won + totals.lost;
  return {
    ...counts,
    ...totals,
    /** Credit limit = what everyone below this account holds in their wallets. */
    downlineBalance,
    winRate: settled > 0 ? Math.round((totals.won / settled) * 1000) / 10 : null,
    commission: commission?.total || 0,
    commissionPending: commission?.pending || 0,
    risk: riskLevel(metrics.flags.get(id)?.score),
    riskScore: metrics.flags.get(id)?.score ?? null,
  };
}

const parentRef = (parent) =>
  parent
    ? {
        _id: parent._id,
        name: parent.name,
        username: parent.username,
        businessName: parent.businessName,
        role: parent.role,
        // The most this upline can pass down (see commission.service.js).
        matchCommission: parent.matchCommission ?? 0,
        sessionCommission: parent.sessionCommission ?? 0,
      }
    : null;

/** What the actor may do to accounts of `role` — drives which buttons the panel shows. */
async function abilitiesFor(actor, role) {
  const isAdmin = actor.role === 'super-admin';
  const below = roleIndex(role) > roleIndex(actor.role);
  if (role === 'player') {
    const [create, edit, suspend] = await Promise.all([
      permissionService.hasPermission(actor.role, 'userManagement', 'createUser', 'X'),
      permissionService.hasPermission(actor.role, 'userManagement', 'editUser', 'X'),
      permissionService.hasPermission(actor.role, 'userManagement', 'suspendUser', 'X'),
    ]);
    return { create: below && create, edit: below && edit, suspend: below && suspend };
  }
  // Staff below the actor (a franchise adds super agents and agents, a super agent adds
  // agents): adding, changing or blocking them all need "Manage Sub-Agents".
  const manage = isAdmin || (await permissionService.hasPermission(actor.role, 'accountSettings', 'manageSubAgents', 'X'));
  return { create: below && manage, edit: below && manage, suspend: below && manage };
}

/**
 * Directory listing for one role inside the actor's downline, each row
 * enriched with its book's totals, plus header stats over the whole role
 * (not just the page) and the parents a new account could be placed under.
 */
async function listAccounts(actor, { role = 'player', status, q, page = 1, limit = 25 }) {
  const tree = await loadTree();
  const scope = scopeIds(tree, actor);
  const roleIds = scope.filter((id) => tree.byId.get(id)?.role === role);

  const filter = { _id: { $in: roleIds } };
  if (status) filter.status = status;
  if (q) {
    const regex = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: regex }, { username: regex }, { email: regex }, { phone: regex }, { businessName: regex }];
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 25));

  const [items, total, roleAccounts] = await Promise.all([
    User.find(filter)
      .populate('parent', 'name username businessName role matchCommission sessionCommission')
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * pageSize)
      .limit(pageSize),
    User.countDocuments(filter),
    User.find({ _id: { $in: roleIds } }, 'status').lean(),
  ]);

  const metrics = await loadMetrics(scope);
  const summaries = new Map(roleIds.map((id) => [id, summarize(tree, metrics, id)]));

  const sum = (key) => [...summaries.values()].reduce((acc, row) => acc + row[key], 0);
  const stats = {
    total: roleAccounts.length,
    active: roleAccounts.filter((row) => row.status === 'active').length,
    suspended: roleAccounts.filter((row) => row.status === 'suspended').length,
    players: role === 'player' ? roleAccounts.length : sum('players'),
    turnover: sum('turnover'),
    monthTurnover: sum('monthTurnover'),
    exposure: sum('exposure'),
    commission: sum('commission'),
    balance: 0,
  };
  const balances = await User.aggregate([
    { $match: { _id: { $in: toObjectIds(roleIds) } } },
    { $group: { _id: null, total: { $sum: '$walletBalance' } } },
  ]);
  stats.balance = balances[0]?.total || 0;

  const parentRole = IMMEDIATE_PARENT_ROLE[role];
  let parentOptions = [];
  if (parentRole && parentRole !== 'super-admin') {
    const parentIds = scope.filter((id) => tree.byId.get(id)?.role === parentRole);
    if (actor.role === parentRole) parentIds.unshift(String(actor._id));
    parentOptions = await User.find({ _id: { $in: parentIds }, status: 'active' }, 'name username businessName role matchCommission sessionCommission')
      .sort({ name: 1 })
      .lean();
  }

  return {
    items: items.map((account) => {
      const summary = summaries.get(String(account._id));
      return { ...account.toJSON(), creditLimit: summary.downlineBalance, parent: parentRef(account.parent), summary };
    }),
    total,
    page: pageNum,
    limit: pageSize,
    stats,
    abilities: await abilitiesFor(actor, role),
    parentOptions,
  };
}

/** Full record sheet for one account (caller already passed requireOwnSubtree). */
async function getAccountDetail(actor, id) {
  const account = await User.findById(id);
  if (!account) throw ApiError.notFound('Account not found');

  const tree = await loadTree();
  const downIds = descendants(tree, id);
  const book = [String(id), ...downIds];
  const metrics = await loadMetrics(book);

  // Ancestors up to (not including) super-admin, nearest first.
  const chain = [];
  let cursor = tree.byId.get(String(id))?.parent;
  while (cursor && tree.byId.get(cursor) && tree.byId.get(cursor).role !== 'super-admin' && chain.length < 5) {
    chain.push(cursor);
    cursor = tree.byId.get(cursor).parent;
  }
  const ancestors = await User.find({ _id: { $in: chain } }, 'name username businessName role matchCommission sessionCommission').lean();
  const ancestorList = chain.map((ancestorId) => ancestors.find((row) => String(row._id) === ancestorId)).filter(Boolean);

  const downlineOf = async (role) => {
    const ids = downIds.filter((memberId) => tree.byId.get(memberId)?.role === role);
    const rows = await User.find({ _id: { $in: ids } })
      .populate('parent', 'name username businessName role matchCommission sessionCommission')
      .sort({ createdAt: -1 })
      .limit(DETAIL_LIST_LIMIT);
    return {
      total: ids.length,
      items: rows.map((row) => {
        const summary = summarize(tree, metrics, row._id);
        return { ...row.toJSON(), creditLimit: summary.downlineBalance, parent: parentRef(row.parent), summary };
      }),
    };
  };

  const bookObjectIds = toObjectIds(book);
  const [superAgents, agents, players, bets, transactions, flows, activity, sessions, abilities] = await Promise.all([
    downlineOf('super-agent'),
    downlineOf('agent'),
    downlineOf('player'),
    Bet.find({ user: { $in: bookObjectIds } })
      .populate('event', 'name sport')
      .populate('market', 'name')
      .populate('user', 'name username')
      .sort({ createdAt: -1 })
      .limit(RECENT_LIMIT),
    Transaction.find({ user: { $in: bookObjectIds } })
      .populate('user', 'name username')
      .sort({ createdAt: -1 })
      .limit(RECENT_LIMIT),
    Transaction.aggregate([
      { $match: { user: { $in: bookObjectIds }, status: 'Completed', type: { $in: ['Deposit', 'Withdrawal'] } } },
      { $group: { _id: '$type', total: { $sum: { $abs: '$amount' } } } },
    ]),
    AuditLog.find({ $or: [{ actor: id }, { target: id }] })
      .populate('actor', 'name username')
      .sort({ createdAt: -1 })
      .limit(RECENT_LIMIT),
    RefreshToken.find({ user: id, revokedAt: null, expiresAt: { $gt: new Date() } }, 'ip userAgent createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(10),
    abilitiesFor(actor, account.role),
  ]);

  const flow = (type) => flows.find((row) => row._id === type)?.total || 0;
  const summary = summarize(tree, metrics, id);

  return {
    account: {
      ...account.toJSON(),
      creditLimit: summary.downlineBalance,
      parent: parentRef(ancestorList[0] ?? null),
    },
    ancestors: ancestorList.map(parentRef),
    summary,
    downline: { superAgents, agents, players },
    wallet: {
      balance: account.walletBalance,
      deposited: flow('Deposit'),
      withdrawn: flow('Withdrawal'),
      commissionEarned: summary.commission,
      commissionPending: summary.commissionPending,
    },
    bets,
    transactions,
    activity,
    sessions,
    abilities: String(actor._id) === String(id) ? { create: false, edit: false, suspend: false } : abilities,
  };
}

module.exports = { listAccounts, getAccountDetail };
