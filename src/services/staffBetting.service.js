const mongoose = require('mongoose');
const Event = require('../models/Event');
const Market = require('../models/Market');
const Bet = require('../models/Bet');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { loadTree, descendants } = require('./tree.service');
const { money } = require('../utils/money');

/**
 * Staff (franchise / super-agent / agent) views of the betting side, each
 * behind its Permissions-page grant (see network.routes.js):
 *   Events (view)     → live & upcoming fixtures
 *   Markets (view)    → open markets with current prices
 *   Analytics (view)  → the actor's own downline over recent months
 *   Void Bet (edit)   → void an open bet of one of their own players
 * Nothing here exposes platform-wide stake or exposure.
 */

const MONTHS_BACK = 6;

/** The actor's downline players, as ObjectIds. */
async function downlinePlayers(actor) {
  const tree = await loadTree();
  return descendants(tree, actor._id)
    .filter((id) => tree.byId.get(id)?.role === 'player')
    .map((id) => new mongoose.Types.ObjectId(id));
}

async function listEvents() {
  const events = await Event.find({ status: { $in: ['Live', 'Upcoming', 'Suspended'] } })
    .sort({ status: 1, startTime: 1 })
    .select('sport league name emoji status startTime provider')
    .lean();
  const counts = await Market.aggregate([
    { $match: { event: { $in: events.map((e) => e._id) }, status: 'Active' } },
    { $group: { _id: '$event', n: { $sum: 1 } } },
  ]);
  const open = new Map(counts.map((row) => [String(row._id), row.n]));
  return events.map((e) => ({ ...e, openMarkets: open.get(String(e._id)) || 0 }));
}

async function listMarkets({ eventId } = {}) {
  const filter = { status: 'Active' };
  if (eventId) filter.event = eventId;
  const markets = await Market.find(filter)
    .populate('event', 'name league status startTime')
    .select('event name type runners maxBet updatedAt')
    .sort({ createdAt: 1 })
    .limit(500)
    .lean();
  return markets
    .filter((m) => m.event && ['Live', 'Upcoming'].includes(m.event.status))
    .map((m) => ({
      _id: m._id,
      event: m.event,
      name: m.name,
      type: m.type,
      maxBet: m.maxBet,
      runners: (m.runners || []).map((r) => ({ name: r.name, odds: r.odds, active: r.active !== false })),
    }));
}

const monthKeys = () => {
  const now = new Date();
  return Array.from({ length: MONTHS_BACK }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (MONTHS_BACK - 1 - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
};

/** Monthly figures for the actor's own players: house P&L, stakes and sign-ups. */
async function downlineAnalytics(actor) {
  const players = await downlinePlayers(actor);
  const months = monthKeys();
  const since = new Date(`${months[0]}-01T00:00:00+05:30`);
  const month = { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: require('../utils/time').timezone() } };

  const [revenue, volume, signups, totals] = await Promise.all([
    Transaction.aggregate([
      { $match: { user: { $in: players }, type: { $in: ['Bet Win', 'Bet Loss'] }, status: 'Completed', createdAt: { $gte: since } } },
      { $group: { _id: month, value: { $sum: { $multiply: ['$amount', -1] } } } },
    ]),
    Bet.aggregate([
      { $match: { user: { $in: players }, status: { $ne: 'Void' }, createdAt: { $gte: since } } },
      { $group: { _id: month, value: { $sum: '$amount' } } },
    ]),
    User.aggregate([
      { $match: { _id: { $in: players }, createdAt: { $gte: since } } },
      { $group: { _id: month, value: { $sum: 1 } } },
    ]),
    Bet.aggregate([
      { $match: { user: { $in: players }, status: { $ne: 'Void' } } },
      { $group: { _id: null, bets: { $sum: 1 }, stake: { $sum: '$amount' } } },
    ]),
  ]);
  const series = (rows) => months.map((m) => ({ month: m, value: rows.find((r) => r._id === m)?.value || 0 }));
  return {
    totals: { players: players.length, bets: totals[0]?.bets || 0, stake: totals[0]?.stake || 0 },
    revenue: series(revenue),
    volume: series(volume),
    signups: series(signups),
  };
}

/**
 * Voids one open bet of one of the actor's own players: the stake was only
 * held (never debited), so voiding releases it — no ledger entry.
 */
async function voidBet(actor, betId, reason = '') {
  const existing = await Bet.findById(betId);
  if (!existing) throw ApiError.notFound('Bet not found');
  if (actor.role !== 'super-admin') {
    const players = new Set((await downlinePlayers(actor)).map(String));
    if (!players.has(String(existing.user))) throw ApiError.forbidden('That bet is outside your downline');
  }
  const bet = await Bet.findOneAndUpdate(
    { _id: betId, status: 'Pending' },
    { $set: { status: 'Void', payout: existing.amount, settledAt: new Date() } },
    { new: true },
  );
  if (!bet) throw ApiError.conflict('Only an open bet can be voided');

  await Promise.all([
    Market.updateOne({ _id: bet.market }, { $inc: { exposure: -bet.amount } }),
    Event.updateOne({ _id: bet.event }, { $inc: { exposure: -bet.amount } }),
  ]);
  const event = await Event.findById(bet.event).select('name');
  await notificationService.notifyPlayer({
    user: bet.user,
    category: 'bet',
    link: 'bets',
    source: `bet:${bet._id}`,
    emoji: '↩️',
    title: 'Bet Void',
    body: `${bet.selection} bet (${event?.name || 'match'}) was voided${reason ? ` — ${reason}` : ''}. Your ${money(bet.amount)} stake is released.`,
  });
  await auditService.record({ actor, action: 'bet_voided', target: bet.user, metadata: { bet: String(bet._id), amount: bet.amount, reason } });
  return bet;
}

module.exports = { listEvents, listMarkets, downlineAnalytics, voidBet };
