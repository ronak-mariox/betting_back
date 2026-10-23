const Market = require('../models/Market');
const FlaggedUser = require('../models/FlaggedUser');
const SuspiciousPattern = require('../models/SuspiciousPattern');
const WalletRequest = require('../models/WalletRequest');
const ApiError = require('../utils/ApiError');
const { cached } = require('./settings.service');

/**
 * Settings → Exposure Limits: the platform market cap and the Warning /
 * Auto-Suspend percentages the Risk page grades markets by.
 */
const exposureSettings = () => {
  const limits = cached().exposureLimits || {};
  return {
    marketCap: Number(limits.maxMarketExposure) || 0,
    warningPercent: Number(limits.warningPercent) || 60,
    criticalPercent: Number(limits.autoSuspendPercent) || 100,
  };
};
/** The cap in force on a market: its own Max Exposure and the platform's, whichever is lower. */
const capOf = (market, platformCap) => {
  const caps = [market.maxExposure, platformCap].map(Number).filter((n) => n > 0);
  return caps.length ? Math.min(...caps) : 0;
};

const LARGE_PENDING_THRESHOLD = 50000;

const getStats = async () => {
  const [flaggedCount, patternCount, highExposureMarkets, largePendingRequests] = await Promise.all([
    FlaggedUser.countDocuments({ active: true }),
    SuspiciousPattern.countDocuments({ resolved: false }),
    Market.find({ status: 'Active', exposure: { $gt: 0 } }).select('exposure maxExposure').lean(),
    WalletRequest.countDocuments({ status: 'Pending', amount: { $gte: LARGE_PENDING_THRESHOLD } }),
  ]);

  const { marketCap, criticalPercent } = exposureSettings();
  const critical = highExposureMarkets.filter((m) => {
    const cap = capOf(m, marketCap);
    return cap > 0 && (m.exposure / cap) * 100 >= criticalPercent;
  }).length;
  return { flaggedCount, patternCount, highExposureMarkets: critical, largePendingRequests };
};

const getExposure = async () => {
  const { marketCap, warningPercent, criticalPercent } = exposureSettings();
  const markets = await Market.find({ status: 'Active' }).populate('event', 'name sport').sort({ exposure: -1 }).limit(50).lean();
  return {
    // maxExposure here is the cap actually enforced on the market (see playerBet.service#placeBet).
    markets: markets.map((m) => ({ ...m, maxExposure: capOf(m, marketCap) })),
    thresholds: { warningPercent, criticalPercent },
  };
};

const getPanels = async () => {
  const [flaggedUsers, patterns, largePendingRequests] = await Promise.all([
    FlaggedUser.find({ active: true }).populate('user', 'name username role').sort({ score: -1 }).limit(50),
    SuspiciousPattern.find({ resolved: false }).populate('relatedUsers', 'name username').sort({ detectedAt: -1 }).limit(50),
    WalletRequest.find({ status: 'Pending', amount: { $gte: LARGE_PENDING_THRESHOLD } })
      .populate('user', 'name username')
      .sort({ amount: -1 }),
  ]);

  return { flaggedUsers, patterns, largePendingRequests };
};

const suspendExposure = async (marketId) => {
  const market = await Market.findByIdAndUpdate(marketId, { status: 'Suspended', adminSuspended: true }, { new: true });
  if (!market) throw ApiError.notFound('Market not found');
  return market;
};

module.exports = { getStats, getExposure, getPanels, suspendExposure };
