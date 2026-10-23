const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Bet = require('../models/Bet');
const Event = require('../models/Event');
const Commission = require('../models/Commission');
const FlaggedUser = require('../models/FlaggedUser');
const ApiProvider = require('../models/ApiProvider');
const AuditLog = require('../models/AuditLog');
const analyticsService = require('./analytics.service');

/** Midnight in the platform's timezone (Settings → General), not the server's. */
const startOfToday = () => require('../utils/time').startOfDay(0); // eslint-disable-line global-require

const getDashboard = async () => {
  const [
    totalUsers,
    activeUsers,
    balanceAgg,
    todayTurnoverAgg,
    revenue,
    sports,
    walletFlow,
    commission,
    commissionTotalAgg,
    liveMatches,
    riskAlerts,
    providers,
    recentTransactions,
    recentBets,
    activity,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ status: 'active' }),
    User.aggregate([{ $group: { _id: null, total: { $sum: '$walletBalance' } } }]),
    Bet.aggregate([
      { $match: { createdAt: { $gte: startOfToday() } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    analyticsService.seriesFor('revenue'),
    analyticsService.seriesFor('sports'),
    analyticsService.walletFlowSeries(),
    analyticsService.seriesFor('commission'),
    Commission.aggregate([{ $group: { _id: null, total: { $sum: '$commission' } } }]),
    Event.find({ status: 'Live' }).sort({ startTime: 1 }).limit(10),
    FlaggedUser.find({ active: true }).populate('user', 'name username').sort({ score: -1 }).limit(10),
    ApiProvider.find(),
    Transaction.find().populate('user', 'name username').sort({ createdAt: -1 }).limit(10),
    Bet.find().populate('user', 'name username').populate('event', 'name').sort({ createdAt: -1 }).limit(10),
    AuditLog.find().populate('actor', 'name username').sort({ createdAt: -1 }).limit(15),
  ]);

  const healthyProviders = providers.filter((p) => p.healthy).length;

  return {
    stats: {
      totalUsers,
      activeUsers,
      totalWalletBalance: balanceAgg[0]?.total || 0,
      todayTurnover: todayTurnoverAgg[0]?.total || 0,
    },
    revenue,
    sports,
    walletFlow,
    commission,
    commissionTotal: commissionTotalAgg[0]?.total || 0,
    liveMatches,
    riskAlerts,
    health: {
      providers: providers.length,
      healthyProviders,
      status: providers.length === 0 ? 'No providers' : healthyProviders === providers.length ? 'Operational' : 'Degraded',
    },
    transactions: recentTransactions,
    bets: recentBets,
    activity,
  };
};

module.exports = { getDashboard };
