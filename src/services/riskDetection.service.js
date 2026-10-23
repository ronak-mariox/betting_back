const Bet = require('../models/Bet');
const Transaction = require('../models/Transaction');
const WalletRequest = require('../models/WalletRequest');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const FlaggedUser = require('../models/FlaggedUser');
const SuspiciousPattern = require('../models/SuspiciousPattern');
const notificationService = require('./notification.service');
const { money } = require('../utils/money');

/**
 * Risk detection: scans real activity and fills the Risk console's
 * High Risk Users (FlaggedUser) and Suspicious Patterns panels.
 *
 * Every finding has a stable identity (user + rule, or a pattern key), so a
 * re-scan updates it instead of adding a duplicate. A finding the admin
 * resolved stays resolved for RESOLVED_QUIET_DAYS before the same rule may
 * raise it again. Nothing here changes balances, bets or accounts — it only
 * writes review items and an admin notification.
 */

const DAY = 24 * 60 * 60 * 1000;
const RESOLVED_QUIET_DAYS = 7;

/** Thresholds, in one place so they're easy to tune. */
const RULES = {
  winRate: { days: 30, minSettled: 10, minRate: 0.75 },
  bigWinner: { days: 7, minNet: 50000 },
  cashCycling: { days: 7, minDeposits: 10000, withdrawShare: 0.8, maxStakeShare: 0.3 },
  failedLogins: { hours: 24, min: 5 },
  sharedIp: { days: 30, minAccounts: 3 },
  coordinated: { hours: 24, windowMinutes: 10, minPlayers: 3, minStake: 1000 },
  bruteForce: { hours: 1, min: 10 },
};

const rupees = money;
const since = (ms) => new Date(Date.now() - ms);
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** Loopback / private addresses (adb reverse, office NAT, dev machines) say nothing about who is behind them. */
const isPublicIp = (ip) =>
  Boolean(ip) &&
  !/^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd|fe80|localhost|unknown)/i.test(ip.replace(/^::ffff:/, ''));

// ---------------------------------------------------------------- user rules

/** Wins far more often than odds allow, over a meaningful number of bets. */
async function winRateFindings() {
  const { days, minSettled, minRate } = RULES.winRate;
  const rows = await Bet.aggregate([
    { $match: { status: { $in: ['Won', 'Lost'] }, settledAt: { $gte: since(days * DAY) } } },
    { $group: { _id: '$user', settled: { $sum: 1 }, won: { $sum: { $cond: [{ $eq: ['$status', 'Won'] }, 1, 0] } } } },
    { $match: { settled: { $gte: minSettled } } },
  ]);
  return rows
    .filter((row) => row.won / row.settled >= minRate)
    .map((row) => {
      const rate = row.won / row.settled;
      return {
        user: row._id,
        rule: 'win-rate',
        score: clamp(55 + (rate - minRate) * 160 + Math.min(row.settled, 50) * 0.3),
        reason: `Won ${row.won} of ${row.settled} settled bets in ${days} days (${Math.round(rate * 100)}%)`,
      };
    });
}

/** Large net winnings in a short time. */
async function bigWinnerFindings() {
  const { days, minNet } = RULES.bigWinner;
  const rows = await Transaction.aggregate([
    { $match: { type: { $in: ['Bet Win', 'Bet Loss'] }, status: 'Completed', user: { $ne: null }, createdAt: { $gte: since(days * DAY) } } },
    { $group: { _id: '$user', net: { $sum: '$amount' } } },
    { $match: { net: { $gte: minNet } } },
  ]);
  return rows.map((row) => ({
    user: row._id,
    rule: 'big-winner',
    score: clamp(60 + (row.net / minNet - 1) * 15),
    reason: `Net betting win of ${rupees(row.net)} in ${days} days`,
  }));
}

/** Money in and straight back out with little betting in between (possible laundering / bonus abuse). */
async function cashCyclingFindings() {
  const { days, minDeposits, withdrawShare, maxStakeShare } = RULES.cashCycling;
  const from = since(days * DAY);
  const deposits = await Transaction.aggregate([
    { $match: { type: 'Deposit', status: 'Completed', user: { $ne: null }, createdAt: { $gte: from } } },
    { $group: { _id: '$user', total: { $sum: { $abs: '$amount' } } } },
    { $match: { total: { $gte: minDeposits } } },
  ]);
  if (!deposits.length) return [];
  const ids = deposits.map((row) => row._id);
  const [withdrawals, stakes] = await Promise.all([
    WalletRequest.aggregate([
      { $match: { user: { $in: ids }, kind: 'withdrawal', status: { $in: ['Pending', 'Approved'] }, createdAt: { $gte: from } } },
      { $group: { _id: '$user', total: { $sum: '$amount' } } },
    ]),
    Bet.aggregate([
      { $match: { user: { $in: ids }, status: { $ne: 'Void' }, createdAt: { $gte: from } } },
      { $group: { _id: '$user', total: { $sum: '$amount' } } },
    ]),
  ]);
  const out = new Map(withdrawals.map((row) => [String(row._id), row.total]));
  const staked = new Map(stakes.map((row) => [String(row._id), row.total]));
  return deposits
    .filter((row) => {
      const w = out.get(String(row._id)) || 0;
      const s = staked.get(String(row._id)) || 0;
      return w >= row.total * withdrawShare && s < row.total * maxStakeShare;
    })
    .map((row) => ({
      user: row._id,
      rule: 'cash-cycling',
      score: 75,
      reason: `Deposited ${rupees(row.total)}, withdrew ${rupees(out.get(String(row._id)) || 0)} but staked only ${rupees(
        staked.get(String(row._id)) || 0,
      )} in ${days} days`,
    }));
}

/** Repeated wrong passwords on one account (someone may be trying to break in). */
async function failedLoginFindings() {
  const { hours, min } = RULES.failedLogins;
  const rows = await AuditLog.aggregate([
    { $match: { action: 'login_failed', createdAt: { $gte: since(hours * 60 * 60 * 1000) } } },
    { $group: { _id: { $ifNull: ['$target', '$metadata.username'] }, count: { $sum: 1 }, ips: { $addToSet: '$ip' } } },
    { $match: { count: { $gte: min } } },
  ]);
  if (!rows.length) return [];
  // A failed attempt on an unknown username names it; on a real one it names the account.
  const usernames = rows.filter((row) => typeof row._id === 'string').map((row) => row._id);
  const byName = new Map((await User.find({ username: { $in: usernames } }).select('_id username').lean()).map((u) => [u.username, u._id]));
  return rows
    .map((row) => ({ row, user: typeof row._id === 'string' ? byName.get(row._id) : row._id }))
    .filter(({ user }) => user)
    .map(({ row, user }) => ({
      user,
      rule: 'failed-logins',
      score: clamp(40 + row.count * 3),
      reason: `${row.count} failed sign-ins in ${hours} hours from ${row.ips.length} IP${row.ips.length === 1 ? '' : 's'}`,
    }));
}

// ------------------------------------------------------------- pattern rules

/** Several player accounts signing in from the same public IP. */
async function sharedIpPatterns() {
  const { days, minAccounts } = RULES.sharedIp;
  const rows = await AuditLog.aggregate([
    { $match: { action: { $in: ['login_success', 'register'] }, actor: { $ne: null }, createdAt: { $gte: since(days * DAY) } } },
    { $group: { _id: '$ip', users: { $addToSet: '$actor' } } },
  ]);
  const candidates = rows.filter((row) => isPublicIp(row._id) && row.users.length >= minAccounts);
  if (!candidates.length) return [];
  const players = new Set(
    (await User.find({ _id: { $in: candidates.flatMap((row) => row.users) }, role: 'player' }).select('_id').lean()).map((u) => String(u._id)),
  );
  return candidates
    .map((row) => ({ ...row, users: row.users.filter((id) => players.has(String(id))) }))
    .filter((row) => row.users.length >= minAccounts)
    .map((row) => ({
      key: `shared-ip:${row._id}`,
      description: `${row.users.length} player accounts signed in from the same IP (${row._id.replace(/^::ffff:/, '')}) in ${days} days`,
      relatedUsers: row.users,
      severity: row.users.length >= 5 ? 'High' : 'Medium',
    }));
}

/** Several players backing the same selection on the same market within minutes. */
async function coordinatedBetPatterns() {
  const { hours, windowMinutes, minPlayers, minStake } = RULES.coordinated;
  const windowMs = windowMinutes * 60 * 1000;
  const rows = await Bet.aggregate([
    { $match: { createdAt: { $gte: since(hours * 60 * 60 * 1000) }, amount: { $gte: minStake }, status: { $ne: 'Void' } } },
    {
      $group: {
        _id: { market: '$market', selection: '$selection', slot: { $floor: { $divide: [{ $toLong: '$createdAt' }, windowMs] } } },
        users: { $addToSet: '$user' },
        total: { $sum: '$amount' },
        event: { $first: '$event' },
      },
    },
  ]);
  const hits = rows.filter((row) => row.users.length >= minPlayers);
  if (!hits.length) return [];
  // eslint-disable-next-line global-require
  const Event = require('../models/Event');
  const events = new Map((await Event.find({ _id: { $in: hits.map((h) => h.event) } }).select('name').lean()).map((e) => [String(e._id), e.name]));
  return hits.map((row) => ({
    key: `coordinated:${row._id.market}:${row._id.selection}:${row._id.slot}`,
    description: `${row.users.length} players backed ${row._id.selection} (${events.get(String(row.event)) || 'a market'}) within ${windowMinutes} minutes — ${rupees(row.total)} in total`,
    relatedUsers: row.users,
    severity: row.total >= 50000 || row.users.length >= 5 ? 'High' : 'Medium',
  }));
}

/** Many failed sign-ins from one IP in a short time, across any accounts. */
async function bruteForcePatterns() {
  const { hours, min } = RULES.bruteForce;
  const rows = await AuditLog.aggregate([
    { $match: { action: 'login_failed', createdAt: { $gte: since(hours * 60 * 60 * 1000) } } },
    { $group: { _id: '$ip', count: { $sum: 1 }, targets: { $addToSet: '$target' }, names: { $addToSet: '$metadata.username' } } },
    { $match: { count: { $gte: min } } },
  ]);
  const hourSlot = Math.floor(Date.now() / (60 * 60 * 1000));
  return rows.map((row) => ({
    key: `brute-force:${row._id}:${hourSlot}`,
    description: `${row.count} failed sign-ins from IP ${String(row._id || 'unknown').replace(/^::ffff:/, '')} in the last hour, trying ${
      row.names.filter(Boolean).length
    } username(s)`,
    relatedUsers: row.targets.filter(Boolean),
    severity: row.count >= 30 ? 'High' : 'Medium',
  }));
}

// ------------------------------------------------------------------- writing

const quietSince = () => since(RESOLVED_QUIET_DAYS * DAY);

async function saveFlag(finding) {
  const existing = await FlaggedUser.findOne({ user: finding.user, rule: finding.rule }).sort({ createdAt: -1 });
  if (existing?.active) {
    existing.score = finding.score;
    existing.reason = finding.reason;
    await existing.save();
    return false;
  }
  if (existing && existing.resolvedAt && existing.resolvedAt > quietSince()) return false;
  await FlaggedUser.create({ ...finding, active: true });
  return true;
}

async function savePattern(finding) {
  const existing = await SuspiciousPattern.findOne({ key: finding.key }).sort({ createdAt: -1 });
  if (existing && !existing.resolved) {
    existing.description = finding.description;
    existing.relatedUsers = finding.relatedUsers;
    existing.severity = finding.severity;
    await existing.save();
    return false;
  }
  if (existing && existing.resolvedAt && existing.resolvedAt > quietSince()) return false;
  await SuspiciousPattern.create({ ...finding, detectedAt: new Date() });
  return true;
}

/**
 * Runs every rule once. Returns how many new flags / patterns it raised; the
 * admin gets one Risk notification per scan that found something new.
 */
async function runScan() {
  const settle = (promise) => promise.catch((err) => {
    console.error('risk rule failed:', err.message); // eslint-disable-line no-console
    return [];
  });
  const flags = (await Promise.all([winRateFindings(), bigWinnerFindings(), cashCyclingFindings(), failedLoginFindings()].map(settle))).flat();
  const patterns = (await Promise.all([sharedIpPatterns(), coordinatedBetPatterns(), bruteForcePatterns()].map(settle))).flat();

  let newFlags = 0;
  let newPatterns = 0;
  for (const finding of flags) {
    // eslint-disable-next-line no-await-in-loop
    if (await saveFlag(finding)) newFlags += 1;
  }
  for (const finding of patterns) {
    // eslint-disable-next-line no-await-in-loop
    if (await savePattern(finding)) newPatterns += 1;
  }

  if (newFlags || newPatterns) {
    await notificationService.notify({
      title: 'New risk findings',
      body: [newFlags ? `${newFlags} user(s) flagged` : '', newPatterns ? `${newPatterns} suspicious pattern(s)` : '']
        .filter(Boolean)
        .join(', ') + ' — review them in Risk.',
      category: 'risk',
      emoji: '🚨',
    });
  }
  return { newFlags, newPatterns, checkedFlags: flags.length, checkedPatterns: patterns.length };
}

const SCAN_EVERY_MS = 10 * 60 * 1000;
let timer = null;
let running = null;

/** One scan at a time; a scan already running is shared. */
const scanOnce = () => {
  if (!running) {
    running = runScan().finally(() => {
      running = null;
    });
  }
  return running;
};

/** Starts the periodic scan (index.js). Errors are logged; they never stop the API. */
function startScheduler() {
  if (timer) return;
  const tick = () => scanOnce().catch((err) => console.error('risk scan failed:', err.message)); // eslint-disable-line no-console
  setTimeout(tick, 5000);
  timer = setInterval(tick, SCAN_EVERY_MS);
  timer.unref?.();
}

const resolveFlag = async (id, actor) =>
  FlaggedUser.findOneAndUpdate({ _id: id }, { $set: { active: false, resolvedBy: actor._id, resolvedAt: new Date() } }, { new: true });

const resolvePattern = async (id, actor) =>
  SuspiciousPattern.findOneAndUpdate({ _id: id }, { $set: { resolved: true, resolvedBy: actor._id, resolvedAt: new Date() } }, { new: true });

module.exports = { runScan, scanOnce, startScheduler, resolveFlag, resolvePattern, RULES, isPublicIp };
