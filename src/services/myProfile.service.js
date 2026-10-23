const AuditLog = require('../models/AuditLog');
const RefreshToken = require('../models/RefreshToken');
const networkService = require('./network.service');
const Settings = require('../models/Settings');

/**
 * The signed-in staff member's Profile page: real quick stats, recent
 * actions, sign-in history, live sessions and (for staff) their wallet —
 * all read from the audit log, refresh-token sessions and their own network.
 */
/**
 * The limits that actually apply to this account's book: its own value where
 * the upline set one, otherwise the platform default from Settings (flagged,
 * so the page can say which it is).
 */
function effectiveLimits(actor, settings, detail) {
  const own = (value) => Number(value) > 0;
  const platform = (value) => (Number(value) > 0 ? Number(value) : null);
  return {
    /** Session / match commission this account receives from its upline, in percent. */
    matchCommission: Number(actor.matchCommission) || 0,
    sessionCommission: Number(actor.sessionCommission) || 0,
    bettingLimit: {
      value: own(actor.bettingLimit) ? actor.bettingLimit : platform(settings?.bettingLimits?.maxBet),
      isDefault: !own(actor.bettingLimit),
    },
    minBet: platform(settings?.bettingLimits?.minBet),
    /** Cap on the open stakes of the whole book; null = none set. */
    maxExposure: own(actor.maxExposure) ? actor.maxExposure : null,
    /** Platform cap on one player's open stakes. */
    maxUserExposure: platform(settings?.exposureLimits?.maxUserExposure),
    /** Sum of the wallet balances of everyone below this account. */
    creditLimit: detail ? detail.summary.downlineBalance : null,
    walletRules: settings?.walletRules || null,
  };
}

async function getMyProfile(actor, currentSessionUserAgent = '') {
  const LOGIN_ACTIONS = ['login_success', 'login_failed'];
  const [totalActions, loginCount, activity, logins, sessions, detail, settings] = await Promise.all([
    AuditLog.countDocuments({ actor: actor._id, action: { $nin: [...LOGIN_ACTIONS, 'logout'] } }),
    AuditLog.countDocuments({ actor: actor._id, action: 'login_success' }),
    // Signing in and out is the Login History tab's business, not an "action performed".
    AuditLog.find({ actor: actor._id, action: { $nin: [...LOGIN_ACTIONS, 'logout'] } })
      .populate('target', 'name username')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    AuditLog.find({ $or: [{ actor: actor._id }, { target: actor._id }], action: { $in: LOGIN_ACTIONS } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    RefreshToken.find({ user: actor._id, revokedAt: null, expiresAt: { $gt: new Date() } }, 'ip userAgent createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean(),
    actor.role === 'super-admin' ? null : networkService.getAccountDetail(actor, actor._id),
    Settings.findById('main').select('bettingLimits exposureLimits walletRules').lean(),
  ]);

  return {
    stats: {
      totalActions,
      loginCount,
      lastLoginAt: actor.lastLoginAt,
      memberSince: actor.createdAt,
    },
    activity,
    logins,
    sessions,
    currentUserAgent: currentSessionUserAgent,
    wallet: detail && { ...detail.wallet, transactions: detail.transactions },
    preferences: Object.fromEntries(actor.preferences || []),
    limits: effectiveLimits(actor, settings, detail),
  };
}

module.exports = { getMyProfile };
