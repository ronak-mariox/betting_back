const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Commission = require('../models/Commission');

const MONTHS_BACK = 6;

const monthsRange = () => {
  const months = [];
  const now = new Date();
  for (let i = MONTHS_BACK - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
};

const monthStart = (label) => {
  const [year, month] = label.split('-').map(Number);
  return new Date(year, month - 1, 1);
};

const monthEnd = (label) => {
  const [year, month] = label.split('-').map(Number);
  return new Date(year, month, 1);
};

const seriesFor = async (dimension) => {
  const months = monthsRange();

  if (dimension === 'revenue') {
    return Promise.all(
      months.map(async (month) => {
        const agg = await Transaction.aggregate([
          { $match: { createdAt: { $gte: monthStart(month), $lt: monthEnd(month) }, type: { $in: ['Bet Win', 'Bet Loss'] } } },
          { $group: { _id: null, total: { $sum: { $multiply: ['$amount', -1] } } } },
        ]);
        return { month, value: agg[0]?.total || 0 };
      }),
    );
  }

  if (dimension === 'users') {
    return Promise.all(
      months.map(async (month) => {
        const count = await User.countDocuments({ createdAt: { $lt: monthEnd(month) } });
        return { month, value: count };
      }),
    );
  }

  if (dimension === 'sports') {
    const agg = await Bet.aggregate([
      { $lookup: { from: 'events', localField: 'event', foreignField: '_id', as: 'event' } },
      { $unwind: '$event' },
      { $group: { _id: '$event.sport', value: { $sum: '$amount' } } },
      { $project: { _id: 0, sport: '$_id', value: 1 } },
      { $sort: { value: -1 } },
    ]);
    return agg;
  }

  if (dimension === 'commission') {
    return Promise.all(
      months.map(async (month) => {
        const agg = await Commission.aggregate([
          { $match: { period: month } },
          { $group: { _id: null, total: { $sum: '$commission' } } },
        ]);
        return { month, value: agg[0]?.total || 0 };
      }),
    );
  }

  return [];
};

const getHighlights = async () => {
  const [totalUsers, totalBets, turnoverAgg, totalCommissionAgg] = await Promise.all([
    User.countDocuments(),
    Bet.countDocuments(),
    Bet.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
    Commission.aggregate([{ $group: { _id: null, total: { $sum: '$commission' } } }]),
  ]);

  return {
    totalUsers,
    totalBets,
    totalTurnover: turnoverAgg[0]?.total || 0,
    totalCommission: totalCommissionAgg[0]?.total || 0,
  };
};

/** Monthly deposits vs withdrawals from the ledger; `value` is the net inflow. */
const walletFlowSeries = async () => {
  const months = monthsRange();
  const agg = await Transaction.aggregate([
    {
      $match: {
        type: { $in: ['Deposit', 'Withdrawal'] },
        status: 'Completed',
        createdAt: { $gte: monthStart(months[0]), $lt: monthEnd(months[months.length - 1]) },
      },
    },
    {
      $group: {
        _id: { month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, type: '$type' },
        total: { $sum: { $abs: '$amount' } },
      },
    },
  ]);

  return months.map((month) => {
    const sum = (type) => agg.find((row) => row._id.month === month && row._id.type === type)?.total || 0;
    const deposits = sum('Deposit');
    const withdrawals = sum('Withdrawal');
    return { month, deposits, withdrawals, value: deposits - withdrawals };
  });
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Analytics headline cards: the last 30 days against the 30 days before.
 * Revenue is the house's betting P&L (−Σ Bet Win/Loss), volume excludes
 * voided stakes, and "active" means a player signed in within the window.
 */
const getGrowth = async () => {
  const now = Date.now();
  const windows = [
    { $gte: new Date(now - 30 * DAY_MS), $lt: new Date(now) },
    { $gte: new Date(now - 60 * DAY_MS), $lt: new Date(now - 30 * DAY_MS) },
  ];
  const revenue = (createdAt) =>
    Transaction.aggregate([
      { $match: { createdAt, type: { $in: ['Bet Win', 'Bet Loss'] }, status: 'Completed' } },
      { $group: { _id: null, total: { $sum: { $multiply: ['$amount', -1] } } } },
    ]).then((rows) => rows[0]?.total || 0);
  const volume = (createdAt) =>
    Bet.aggregate([
      { $match: { createdAt, status: { $ne: 'Void' } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).then((rows) => rows[0]?.total || 0);
  const newPlayers = (createdAt) => User.countDocuments({ role: 'player', createdAt });

  const [revNow, revPrev, volNow, volPrev, playersNow, playersPrev, activePlayers, totalPlayers] = await Promise.all([
    revenue(windows[0]),
    revenue(windows[1]),
    volume(windows[0]),
    volume(windows[1]),
    newPlayers(windows[0]),
    newPlayers(windows[1]),
    User.countDocuments({ role: 'player', lastLoginAt: { $gte: windows[0].$gte } }),
    User.countDocuments({ role: 'player' }),
  ]);

  return {
    revenue: { current: revNow, previous: revPrev },
    betVolume: { current: volNow, previous: volPrev },
    newPlayers: { current: playersNow, previous: playersPrev },
    activePlayers,
    totalPlayers,
  };
};

module.exports = { seriesFor, getHighlights, walletFlowSeries, getGrowth };
