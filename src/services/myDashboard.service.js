const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Transaction = require('../models/Transaction');
const WalletRequest = require('../models/WalletRequest');
const AuditLog = require('../models/AuditLog');
const Commission = require('../models/Commission');
const { loadTree, descendants } = require('./tree.service');

const FEED_LIMIT = 6;

/** Midnight `offsetDays` from today in the platform's timezone (Settings → General). */
const { startOfDay, dayKey: platformDayKey, timezone } = require('../utils/time');
const { money } = require('../utils/money');

const sumBy = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);

/**
 * "My" dashboard for a staff account (the Agent dashboard screen): every
 * figure covers only the caller's own players. Commission is what the caller
 * was actually paid at the end of each match (the Commission ledger).
 */
/**
 * How each agent under the caller is doing today: its users, today's bets and
 * stake, what's open, and the requests waiting on it. Agents themselves have
 * no agents below them, so theirs is empty.
 */
async function agentBreakdown(tree, downline, today) {
  const agentIds = downline.filter((id) => tree.byId.get(id)?.role === 'agent');
  if (!agentIds.length) return [];

  const agentOf = new Map();
  for (const agentId of agentIds) {
    for (const id of descendants(tree, agentId)) {
      if (tree.byId.get(id)?.role === 'player') agentOf.set(id, agentId);
    }
  }
  const playerIds = [...agentOf.keys()].map((id) => new mongoose.Types.ObjectId(id));

  const [accounts, todayBets, openBets, pending] = await Promise.all([
    User.find({ _id: { $in: agentIds } }, 'name username status walletBalance').lean(),
    Bet.aggregate([
      { $match: { user: { $in: playerIds }, createdAt: { $gte: today }, status: { $ne: 'Void' } } },
      { $group: { _id: '$user', bets: { $sum: 1 }, stake: { $sum: '$amount' } } },
    ]),
    Bet.aggregate([
      { $match: { user: { $in: playerIds }, status: 'Pending' } },
      { $group: { _id: '$user', exposure: { $sum: '$amount' } } },
    ]),
    WalletRequest.aggregate([
      { $match: { user: { $in: playerIds }, status: 'Pending' } },
      { $group: { _id: '$user', count: { $sum: 1 } } },
    ]),
  ]);

  const rows = new Map(
    accounts.map((agent) => [
      String(agent._id),
      {
        _id: agent._id,
        name: agent.name || agent.username,
        username: agent.username,
        status: agent.status,
        walletBalance: agent.walletBalance || 0,
        users: 0,
        todayBets: 0,
        todayStake: 0,
        exposure: 0,
        pendingRequests: 0,
      },
    ]),
  );
  for (const agentId of agentOf.values()) if (rows.has(agentId)) rows.get(agentId).users += 1;
  const add = (list, apply) => {
    for (const entry of list) {
      const row = rows.get(agentOf.get(String(entry._id)));
      if (row) apply(row, entry);
    }
  };
  add(todayBets, (row, entry) => {
    row.todayBets += entry.bets;
    row.todayStake += entry.stake;
  });
  add(openBets, (row, entry) => {
    row.exposure += entry.exposure;
  });
  add(pending, (row, entry) => {
    row.pendingRequests += entry.count;
  });
  return [...rows.values()].sort((a, b) => b.todayStake - a.todayStake);
}

/** Each super agent under the caller, as the sum of its agents' rows. */
async function superAgentBreakdown(tree, downline, agents) {
  const ids = downline.filter((id) => tree.byId.get(id)?.role === 'super-agent');
  if (!ids.length) return [];
  const accounts = await User.find({ _id: { $in: ids } }, 'name username status walletBalance').lean();
  return accounts
    .map((account) => {
      const below = new Set(descendants(tree, account._id));
      const mine = agents.filter((agent) => below.has(String(agent._id)));
      const sum = (key) => mine.reduce((total, agent) => total + agent[key], 0);
      return {
        _id: account._id,
        name: account.name || account.username,
        username: account.username,
        status: account.status,
        walletBalance: account.walletBalance || 0,
        agents: mine.length,
        users: sum('users'),
        todayBets: sum('todayBets'),
        todayStake: sum('todayStake'),
        exposure: sum('exposure'),
        pendingRequests: sum('pendingRequests'),
      };
    })
    .sort((a, b) => b.todayStake - a.todayStake);
}

async function getMyDashboard(actor) {
  const tree = await loadTree();
  const downline = descendants(tree, actor._id);
  const playerIds = downline
    .filter((id) => tree.byId.get(id)?.role === 'player')
    .map((id) => new mongoose.Types.ObjectId(id));

  const today = startOfDay(0);
  const yesterday = startOfDay(-1);
  const weekStart = startOfDay(-6);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);

  const [players, earnedDays, betDays, activeToday, activeYesterday, revenueAgg, pending, recentBets, recentTxns, recentRequests, audits] =
    await Promise.all([
      User.find({ _id: { $in: playerIds } }, 'status createdAt').lean(),
      // Commission this account was paid, per day (match-end payouts).
      Commission.aggregate([
        { $match: { entity: actor._id, event: { $ne: null }, settledAt: { $gte: weekStart } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$settledAt', timezone: timezone() } },
            commission: { $sum: '$commission' },
          },
        },
      ]),
      Bet.aggregate([
        { $match: { user: { $in: playerIds }, createdAt: { $gte: weekStart }, status: { $ne: 'Void' } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timezone() } },
            bets: { $sum: 1 },
            stake: { $sum: '$amount' },
          },
        },
      ]),
      Bet.distinct('user', { user: { $in: playerIds }, createdAt: { $gte: today } }),
      Bet.distinct('user', { user: { $in: playerIds }, createdAt: { $gte: yesterday, $lt: today } }),
      Transaction.aggregate([
        { $match: { user: { $in: playerIds }, type: { $in: ['Bet Win', 'Bet Loss'] }, createdAt: { $gte: yesterday } } },
        {
          $group: {
            _id: { $cond: [{ $gte: ['$createdAt', today] }, 'today', 'yesterday'] },
            // A player's loss is the book's revenue, a win is its payout.
            revenue: { $sum: { $multiply: ['$amount', -1] } },
          },
        },
      ]),
      WalletRequest.aggregate([
        { $match: { user: { $in: playerIds }, status: 'Pending' } },
        { $group: { _id: '$kind', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]),
      Bet.find({ user: { $in: playerIds } }).populate('user', 'name username').populate('event', 'name').sort({ createdAt: -1 }).limit(FEED_LIMIT),
      Transaction.find({ user: { $in: playerIds } }).populate('user', 'name username').sort({ createdAt: -1 }).limit(FEED_LIMIT),
      WalletRequest.find({ user: { $in: playerIds } }).populate('user', 'name username').sort({ updatedAt: -1 }).limit(FEED_LIMIT),
      AuditLog.find({
        target: { $in: playerIds },
        action: { $in: ['register', 'account_created', 'account_updated', 'account_suspended', 'account_activated'] },
      })
        .populate('target', 'name username')
        .sort({ createdAt: -1 })
        .limit(FEED_LIMIT),
    ]);

  const agents = await agentBreakdown(tree, downline, today);
  const superAgents = await superAgentBreakdown(tree, downline, agents);

  const dayKey = (date) => platformDayKey(date);
  const dayStats = (date) => betDays.find((row) => row._id === dayKey(date)) || { bets: 0, stake: 0 };
  const earnedOn = (date) => Math.round((earnedDays.find((row) => row._id === dayKey(date))?.commission || 0) * 100) / 100;
  const todayStats = dayStats(today);
  const yesterdayStats = dayStats(yesterday);
  const revenueOf = (key) => revenueAgg.find((row) => row._id === key)?.revenue || 0;
  const pendingOf = (kind) => {
    const row = pending.find((entry) => entry._id === kind);
    return { count: row?.count || 0, amount: row?.amount || 0 };
  };

  const commissionWeek = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = startOfDay(-i);
    commissionWeek.push({
      date: dayKey(date),
      stake: dayStats(date).stake,
      commission: earnedOn(date),
    });
  }

  const newThisMonth = players.filter((p) => new Date(p.createdAt) >= monthStart).length;
  const newLastMonth = players.filter((p) => {
    const created = new Date(p.createdAt);
    return created >= lastMonthStart && created < monthStart;
  }).length;

  const name = (ref) => (ref && typeof ref === 'object' ? ref.name || ref.username : 'A user');
  const activity = [
    ...recentBets.map((bet) => ({
      kind: 'bet',
      description: `${name(bet.user)} placed a bet of ${money(bet.amount)}${bet.event?.name ? ` on ${bet.event.name}` : ''}`,
      at: bet.createdAt,
    })),
    ...recentRequests.map((request) => ({
      kind: request.kind,
      description: `${name(request.user)} ${request.kind} ${money(request.amount)} — ${request.status}`,
      at: request.updatedAt,
    })),
    ...audits.map((entry) => ({
      kind: 'account',
      description: `${name(entry.target)} ${
        {
          register: 'signed up from the app and joined your panel',
          account_created: 'joined your panel',
          account_updated: 'profile updated',
          account_suspended: 'account suspended',
          account_activated: 'account reactivated',
        }[entry.action]
      }`,
      at: entry.createdAt,
    })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, FEED_LIMIT);

  // Pending requests aren't in the ledger yet, so they're merged in as Pending rows.
  const transactions = [
    ...recentTxns.map((txn) => ({
      id: String(txn._id),
      user: name(txn.user),
      type: txn.type,
      method: txn.method,
      amount: txn.amount,
      status: txn.status,
      at: txn.createdAt,
    })),
    ...recentRequests
      .filter((request) => request.status === 'Pending')
      .map((request) => ({
        id: String(request._id),
        user: name(request.user),
        type: request.kind === 'deposit' ? 'Deposit' : 'Withdrawal',
        method: request.method,
        amount: request.kind === 'deposit' ? request.amount : -request.amount,
        status: 'Pending',
        at: request.createdAt,
      })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, FEED_LIMIT);

  return {
    /** One row per agent in the book — empty for an agent's own dashboard. */
    agents,
    /** One row per super agent — only a franchise has any. */
    superAgents,
    referralCode: actor.referralCode || null,
    /** Rates this account receives from its upline, in percent. */
    commissionRates: { match: actor.matchCommission || 0, session: actor.sessionCommission || 0 },
    stats: {
      totalUsers: players.length,
      activeToday: activeToday.length,
      activeYesterday: activeYesterday.length,
      walletBalance: actor.walletBalance || 0,
      todayBets: todayStats.bets,
      yesterdayBets: yesterdayStats.bets,
      todayStake: todayStats.stake,
      todayCommission: earnedOn(today),
      yesterdayCommission: earnedOn(yesterday),
      todayRevenue: revenueOf('today'),
      yesterdayRevenue: revenueOf('yesterday'),
      pendingDeposits: pendingOf('deposit'),
      pendingWithdrawals: pendingOf('withdrawal'),
    },
    overview: {
      totalUsers: players.length,
      activeToday: activeToday.length,
      suspended: players.filter((p) => p.status === 'suspended').length,
      newThisMonth,
      newLastMonth,
    },
    commissionWeek,
    activity,
    transactions,
  };
}

module.exports = { getMyDashboard };
