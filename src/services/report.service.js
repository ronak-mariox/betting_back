const Transaction = require('../models/Transaction');
const Bet = require('../models/Bet');
const User = require('../models/User');
const WalletRequest = require('../models/WalletRequest');
const Commission = require('../models/Commission');
const Market = require('../models/Market');
const ApiError = require('../utils/ApiError');
const { applyScope } = require('./scope.service');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The range picked on the Reports page. A plain date means that whole day in
 * India time: "from" starts at its midnight, "to" runs to its last moment —
 * so a range ending today includes today.
 */
const dateFilter = (from, to) => {
  const filter = {};
  if (from) filter.$gte = new Date(DATE_ONLY.test(from) ? `${from}T00:00:00.000+05:30` : from);
  if (to) filter.$lte = new Date(DATE_ONLY.test(to) ? `${to}T23:59:59.999+05:30` : to);
  return Object.keys(filter).length ? filter : undefined;
};

const REPORT_BUILDERS = {
  financial: async ({ from, to, scope }) => {
    const match = applyScope({}, scope);
    const created = dateFilter(from, to);
    if (created) match.createdAt = created;
    const rows = await Transaction.find(match).populate('user', 'name username').sort({ createdAt: -1 }).limit(1000).lean();
    return rows.map((r) => ({
      date: r.createdAt,
      type: r.type,
      user: r.user?.username || '',
      amount: r.amount,
      status: r.status,
      note: r.note,
    }));
  },
  betting: async ({ from, to, scope }) => {
    const match = applyScope({}, scope);
    const created = dateFilter(from, to);
    if (created) match.createdAt = created;
    const rows = await Bet.find(match).populate('user', 'username').populate('event', 'name sport').sort({ createdAt: -1 }).limit(1000).lean();
    return rows.map((r) => ({
      date: r.createdAt,
      event: r.event?.name || '',
      sport: r.event?.sport || '',
      user: r.user?.username || '',
      selection: r.selection,
      odds: r.odds,
      amount: r.amount,
      status: r.status,
    }));
  },
  user: async ({ scope }) => {
    const rows = await User.find(applyScope({}, scope, '_id'))
      .select('username name phone role status walletBalance lastLoginAt createdAt')
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
    return rows.map((r) => ({
      username: r.username,
      name: r.name || '',
      phone: r.phone || '',
      role: r.role,
      status: r.status,
      walletBalance: r.walletBalance,
      lastLogin: r.lastLoginAt,
      joined: r.createdAt,
    }));
  },
  wallet: async ({ from, to, scope }) => {
    const match = applyScope({}, scope);
    const created = dateFilter(from, to);
    if (created) match.createdAt = created;
    const rows = await WalletRequest.find(match).populate('user', 'username').sort({ createdAt: -1 }).limit(1000).lean();
    return rows.map((r) => ({
      date: r.createdAt,
      user: r.user?.username || '',
      kind: r.kind,
      amount: r.amount,
      status: r.status,
    }));
  },
  commission: async ({ scope }) => {
    const rows = await Commission.find(applyScope({}, scope, 'entity')).populate('entity', 'username role').sort({ period: -1 }).limit(1000).lean();
    return rows.map((r) => ({
      period: r.period,
      entity: r.entity?.username || '',
      level: r.level,
      turnover: r.turnover,
      rate: r.rate,
      commission: r.commission,
      status: r.status,
    }));
  },
  exposure: async ({ scope }) => {
    if (scope) {
      // A network's exposure is its own players' open bets, per market.
      const rows = await Bet.aggregate([
        { $match: { user: { $in: scope }, status: 'Pending' } },
        { $group: { _id: '$market', stake: { $sum: '$amount' }, bets: { $sum: 1 } } },
        { $lookup: { from: 'markets', localField: '_id', foreignField: '_id', as: 'market' } },
        { $unwind: '$market' },
        { $lookup: { from: 'events', localField: 'market.event', foreignField: '_id', as: 'event' } },
        { $unwind: '$event' },
        { $sort: { stake: -1 } },
      ]);
      return rows.map((r) => ({
        event: r.event.name,
        sport: r.event.sport,
        market: r.market.name,
        bets: r.bets,
        stake: r.stake,
        exposure: r.stake,
      }));
    }
    const rows = await Market.find({ status: 'Active' }).populate('event', 'name sport').sort({ exposure: -1 }).limit(1000).lean();
    return rows.map((r) => ({
      event: r.event?.name || '',
      sport: r.event?.sport || '',
      market: r.name,
      stake: r.stake,
      exposure: r.exposure,
      maxExposure: r.maxExposure,
    }));
  },
};

const { timezone } = require('../utils/time');

/** The label of the period a date falls in: a day, the week's Monday, a month or a quarter (platform timezone). */
function periodOf(date, groupBy) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone(), year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(date))
      .map((part) => [part.type, part.value]),
  );
  const { year, month, day } = parts;
  if (groupBy === 'Monthly') return `${year}-${month}`;
  if (groupBy === 'Quarterly') return `${year} Q${Math.ceil(Number(month) / 3)}`;
  if (groupBy === 'Weekly') {
    const local = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const sinceMonday = (local.getUTCDay() + 6) % 7;
    local.setUTCDate(local.getUTCDate() - sinceMonday);
    return `Week of ${local.toISOString().slice(0, 10)}`;
  }
  return `${year}-${month}-${day}`;
}

/** What one period's row adds up, per kind of report — each in the terms that report is read in. */
const ROLLUPS = {
  // Ledger: signed amounts, so money in, money out and the net.
  financial: {
    start: () => ({ entries: 0, moneyIn: 0, moneyOut: 0, net: 0 }),
    add: (bucket, row) => {
      const amount = Number(row.amount) || 0;
      bucket.entries += 1;
      if (amount >= 0) bucket.moneyIn += amount;
      else bucket.moneyOut += -amount;
      bucket.net += amount;
    },
  },
  // Bets: how many, what was staked, and how they ended.
  betting: {
    start: () => ({ bets: 0, stake: 0, won: 0, lost: 0, cashedOut: 0, open: 0, void: 0 }),
    add: (bucket, row) => {
      bucket.bets += 1;
      // A voided bet is counted, but its stake never counted as turnover.
      if (row.status !== 'Void') bucket.stake += Number(row.amount) || 0;
      const outcome = { Won: 'won', Lost: 'lost', 'Cashed Out': 'cashedOut', Pending: 'open', Void: 'void' }[row.status];
      if (outcome) bucket[outcome] += 1;
    },
  },
  // Requests: only approved ones moved money; the rest are counted, not summed.
  wallet: {
    start: () => ({ requests: 0, depositsApproved: 0, withdrawalsApproved: 0, pending: 0, rejected: 0 }),
    add: (bucket, row) => {
      bucket.requests += 1;
      if (row.status === 'Approved') bucket[row.kind === 'withdrawal' ? 'withdrawalsApproved' : 'depositsApproved'] += Number(row.amount) || 0;
      else if (row.status === 'Pending') bucket.pending += 1;
      else if (row.status === 'Rejected') bucket.rejected += 1;
    },
  },
};

/**
 * Rolls a dated report up into one row per period. Reports without a date
 * column (users, commission, exposure) have nothing to group and are
 * returned as they are.
 */
function grouped(kind, rows, groupBy) {
  const rollup = ROLLUPS[kind];
  if (!groupBy || !rollup || !rows.length) return rows;
  const buckets = new Map();
  for (const row of rows) {
    const period = periodOf(row.date, groupBy);
    if (!buckets.has(period)) buckets.set(period, { period, ...rollup.start(), first: row.date });
    const bucket = buckets.get(period);
    rollup.add(bucket, row);
    if (new Date(row.date) < new Date(bucket.first)) bucket.first = row.date;
  }
  return [...buckets.values()]
    .sort((a, b) => new Date(b.first) - new Date(a.first))
    .map(({ first, ...bucket }) => bucket);
}

const buildReport = async (kind, params) => {
  const builder = REPORT_BUILDERS[kind];
  if (!builder) throw ApiError.badRequest(`Unknown report kind: ${kind}`);
  return grouped(kind, await builder(params), params.groupBy);
};

module.exports = { buildReport, REPORT_KINDS: Object.keys(REPORT_BUILDERS) };
