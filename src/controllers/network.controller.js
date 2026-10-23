const asyncHandler = require('../utils/asyncHandler');
const networkService = require('../services/network.service');
const myDashboardService = require('../services/myDashboard.service');
const myProfileService = require('../services/myProfile.service');
const permissionService = require('../services/permission.service');
const { grant } = require('../services/scope.service');

/**
 * What a staff role may see inside these combined responses (Permissions
 * page): the wallet / ledger, bets and commission parts are removed unless
 * granted, and `restricted` names what was held back so the panel can hide it.
 */
async function visibility(user) {
  const can = await permissionService.checkerFor(user.role);
  return {
    wallet: can('finance', 'walletBalance', 'V'),
    bets: can('bettingMarkets', 'viewBets', 'V'),
    commission: can('finance', 'commission', 'V'),
  };
}
const restrictedOf = (seen) => Object.keys(seen).filter((key) => !seen[key]);

const list = asyncHandler(async (req, res) => {
  res.json(await networkService.listAccounts(req.user, req.query));
});

const getOne = asyncHandler(async (req, res) => {
  const detail = await networkService.getAccountDetail(req.user, req.params.id);
  const seen = await visibility(req.user);
  if (!seen.bets) detail.bets = [];
  if (!seen.wallet) {
    detail.transactions = [];
    detail.wallet = { ...detail.wallet, balance: null, deposited: null, withdrawn: null };
  }
  if (!seen.commission) detail.wallet = { ...detail.wallet, commissionEarned: null, commissionPending: null };
  res.json({ ...detail, restricted: restrictedOf(seen) });
});

const myDashboard = asyncHandler(async (req, res) => {
  const data = await myDashboardService.getMyDashboard(req.user);
  const seen = await visibility(req.user);
  if (!seen.wallet) {
    data.transactions = [];
    data.stats = { ...data.stats, walletBalance: null, pendingDeposits: null, pendingWithdrawals: null };
  }
  if (!seen.bets) data.stats = { ...data.stats, todayBets: null, yesterdayBets: null, todayStake: null };
  if (!seen.commission) {
    data.commissionWeek = [];
    data.stats = { ...data.stats, todayCommission: null, yesterdayCommission: null };
  }
  res.json({ ...data, restricted: restrictedOf(seen) });
});

const myProfile = asyncHandler(async (req, res) => {
  const profile = await myProfileService.getMyProfile(req.user, req.headers['user-agent'] || '');
  const seen = await visibility(req.user);
  // The Profile page's Wallet tab is the account's own ledger.
  if (!seen.wallet && profile.wallet) profile.wallet = null;
  res.json({ ...profile, restricted: restrictedOf(seen) });
});

/** Users list and account detail need "User List" (view). */
const userList = grant('userManagement', 'userList', 'V', 'You do not have permission to view users');

// eslint-disable-next-line global-require
const staffBetting = () => require('../services/staffBetting.service');

const events = asyncHandler(async (_req, res) => {
  res.json({ events: await staffBetting().listEvents() });
});

const markets = asyncHandler(async (req, res) => {
  res.json({ markets: await staffBetting().listMarkets({ eventId: req.query.eventId }) });
});

const analytics = asyncHandler(async (req, res) => {
  res.json(await staffBetting().downlineAnalytics(req.user));
});

const voidBet = asyncHandler(async (req, res) => {
  res.json({ bet: await staffBetting().voidBet(req.user, req.params.id, req.body?.reason) });
});

module.exports = { list, getOne, myDashboard, myProfile, userList, events, markets, analytics, voidBet };
