const mongoose = require('mongoose');
const Commission = require('../models/Commission');
const Bet = require('../models/Bet');
const Event = require('../models/Event');
const Market = require('../models/Market');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { money } = require('../utils/money');
const ApiError = require('../utils/ApiError');
const { applyScope } = require('./scope.service');
const { inTransaction } = require('../utils/transaction');

/**
 * Session and match commission, paid at the end of every match.
 *
 * Every account in a player's chain (franchise → super agent → agent →
 * player) holds a rate it received from its upline (`sessionCommission`,
 * `matchCommission`). An account keeps what it received minus what it passed
 * on, so the shares along one chain add up to the top account's rate:
 *
 *   franchise 3%, super agent 2%, agent 1.5%, player 1%
 *   → franchise 1%, super agent 0.5%, agent 0.5%, player 1%  (= 3%)
 *
 * - Session: markets decided during the match (toss, fancy, over runs,
 *   odd/even, last digit). The rate applies to the player's session stake,
 *   whether those bets won or lost.
 * - Match: markets decided by the result (Match Odds, Bookmaker). The rate
 *   applies to the player's net loss on them; a profit or break-even pays nothing.
 *
 * Shares are credited straight to each account's wallet, with a ledger row.
 */

const LEVEL_BY_ROLE = { franchise: 'Franchise', 'super-agent': 'Super Agent', agent: 'Agent', player: 'Player' };
/** Market types settled by the match result; everything else is a session market. */
const MATCH_MARKET_TYPES = new Set(['Match Odds', 'Bookmaker', 'Tied Match', 'Winner']);
const RATE_FIELD = { Session: 'sessionCommission', Match: 'matchCommission' };
const SCAN_MS = 60 * 1000;
/** Commission waits this long after a market's settlement so its ledger rows are all written. */
const SETTLE_GRACE_MS = 2 * 60 * 1000;

const kindOfMarket = (market) =>
  ['match', 'match1'].includes(market.providerType) || MATCH_MARKET_TYPES.has(market.type) ? 'Match' : 'Session';

/** Paise precision: 0.5% of ₹150 is ₹0.75, not ₹1. */
const round2 = (value) => Math.round(value * 100) / 100;

const periodOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

/**
 * Each account's share along one chain, top first. A rate above the one
 * above it (an upline lowered its own rate later) counts as that upline's
 * rate, so the shares never add up to more than the top rate.
 */
function sharesFor(chain, field) {
  let cap = Infinity;
  const rates = chain.map((account) => {
    const rate = Math.min(Math.max(Number(account[field]) || 0, 0), cap);
    cap = rate;
    return rate;
  });
  return chain.map((account, i) => ({
    account,
    rate: round2(rates[i] - (rates[i + 1] ?? 0)),
    received: rates[i],
    given: rates[i + 1] ?? 0,
  }));
}

/** The player and the staff above them, top first, stopping below super-admin. */
async function chainOf(playerId, cache) {
  const chain = [];
  let id = playerId;
  while (id) {
    const key = String(id);
    if (!cache.has(key)) {
      // eslint-disable-next-line no-await-in-loop
      cache.set(key, await User.findById(id).select('role parent name username matchCommission sessionCommission').lean());
    }
    const account = cache.get(key);
    if (!account || !LEVEL_BY_ROLE[account.role]) break;
    chain.unshift(account);
    id = account.parent;
  }
  return chain;
}

/** What each player staked on session markets and won/lost on match markets in one match. */
async function playerTotals(eventId) {
  const markets = await Market.find({ event: eventId }).select('type providerType').lean();
  const kindById = new Map(markets.map((m) => [String(m._id), kindOfMarket(m)]));
  const bets = await Bet.find({ event: eventId, status: { $in: ['Won', 'Lost', 'Cashed Out'] } })
    .select('user market amount stake')
    .lean();

  const totals = new Map();
  const totalsFor = (userId) => {
    const key = String(userId);
    if (!totals.has(key)) totals.set(key, { player: userId, sessionStake: 0, matchNet: 0 });
    return totals.get(key);
  };
  const matchBets = [];
  for (const bet of bets) {
    if (kindById.get(String(bet.market)) === 'Match') matchBets.push(bet._id);
    // A session "No" bet holds its liability in `amount`; the stake is what was bet.
    else totalsFor(bet.user).sessionStake += Number(bet.stake ?? bet.amount) || 0;
  }
  // Net result on match markets, from the ledger the settlement wrote (wins, losses, cash-outs).
  const nets = await Transaction.aggregate([
    { $match: { relatedBet: { $in: matchBets }, type: { $in: ['Bet Win', 'Bet Loss'] } } },
    { $group: { _id: '$user', net: { $sum: '$amount' } } },
  ]);
  for (const row of nets) totalsFor(row._id).matchNet += row.net;
  return [...totals.values()];
}

/**
 * Writes one share — the commission row (unique per match, player, account
 * and kind), the wallet credit and its ledger entry — as one transaction, so
 * a share is either fully paid or not at all (and retried on the next run).
 */
async function pay({ event, player, account, kind, base, rate, received, given, when }) {
  const amount = round2((base * rate) / 100);
  if (amount <= 0) return null;
  try {
    return await inTransaction(async (session) => {
      const [row] = await Commission.create(
        [
          {
            entity: account._id,
            level: LEVEL_BY_ROLE[account.role],
            period: periodOf(when),
            event: event._id,
            player,
            kind,
            turnover: round2(base),
            rate,
            receivedRate: received,
            givenRate: given,
            commission: amount,
            status: 'Settled',
            settledAt: when,
          },
        ],
        { session },
      );
      const owner = await User.findOneAndUpdate(
        { _id: account._id },
        { $inc: { walletBalance: amount } },
        { returnDocument: 'after', session },
      );
      const [txn] = await Transaction.create(
        [
          {
            user: account._id,
            type: 'Commission',
            amount,
            status: 'Completed',
            reference: `COMM-${String(row._id).slice(-8).toUpperCase()}`,
            kind,
            relatedEvent: event._id,
            counterparty: player,
            balanceAfter: owner ? owner.walletBalance : null,
            note: `${kind} commission — ${event.name} (${rate}% of ${money(base)}; received ${received}%, passed down ${given}%)`,
          },
        ],
        { session },
      );
      await Commission.updateOne({ _id: row._id }, { $set: { transaction: txn._id } }, { session });
      return row;
    });
  } catch (err) {
    if (err?.code === 11000) return null; // already paid on an earlier run
    throw err;
  }
}

/**
 * Pays session and match commission for one finished match. Safe to run more
 * than once: shares already paid are skipped, and the match is marked done
 * only after every share is written.
 */
async function settleEventCommission(eventId) {
  const event = await Event.findById(eventId).select('name status commissionSettledAt').lean();
  if (!event || event.commissionSettledAt) return [];
  const when = new Date();
  const cache = new Map();
  const paid = [];
  for (const totals of await playerTotals(event._id)) {
    // eslint-disable-next-line no-await-in-loop
    const chain = await chainOf(totals.player, cache);
    const bases = { Session: totals.sessionStake, Match: Math.max(0, -totals.matchNet) };
    for (const kind of ['Session', 'Match']) {
      if (bases[kind] <= 0) continue; // eslint-disable-line no-continue
      for (const { account, rate, received, given } of sharesFor(chain, RATE_FIELD[kind])) {
        if (rate <= 0) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const row = await pay({ event, player: totals.player, account, kind, base: bases[kind], rate, received, given, when });
        if (row) paid.push(row);
      }
    }
  }
  // Commission paid and every bet settled: the match is now fully Settled.
  await Event.updateOne(
    { _id: event._id },
    { $set: { commissionSettledAt: when, ...(event.status === 'Completed' ? { status: 'Settled' } : {}) } },
  );
  if (paid.length) {
    console.log(`Commission paid for ${event.name}: ${paid.length} shares`); // eslint-disable-line no-console
  }
  return paid;
}

/** Finished matches whose bets are all settled and whose commission hasn't been paid yet. */
async function settleFinishedMatches() {
  // A settlement interrupted part-way would otherwise hold its match's commission forever.
  // eslint-disable-next-line global-require
  await require('./playerBet.service').finishInterruptedSettlements();
  const events = await Event.find({ status: { $in: ['Completed', 'Settled'] }, commissionSettledAt: null }).select('_id').lean();
  for (const { _id } of events) {
    // eslint-disable-next-line no-await-in-loop
    if (await Bet.exists({ event: _id, status: 'Pending' })) continue; // eslint-disable-line no-continue
    // A market settled moments ago may still be writing its ledger rows, which match commission reads.
    // eslint-disable-next-line no-await-in-loop
    if (await Market.exists({ event: _id, settledAt: { $gte: new Date(Date.now() - SETTLE_GRACE_MS) } })) continue; // eslint-disable-line no-continue
    try {
      // eslint-disable-next-line no-await-in-loop
      await settleEventCommission(_id);
    } catch (err) {
      console.error('commission settlement failed:', err.message); // eslint-disable-line no-console
    }
  }
}

let busy = false;
function startScheduler() {
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await settleFinishedMatches();
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 10 * 1000);
  setInterval(tick, SCAN_MS);
}

const listCommission = async ({ level, status, kind, event, scope = null }) => {
  const filter = applyScope({}, scope, 'entity');
  if (event) filter.event = event;
  if (level) filter.level = level;
  if (status) filter.status = status;
  if (kind) filter.kind = kind;
  return Commission.find(filter)
    .populate('entity', 'name username role')
    .populate('player', 'name username')
    .populate('event', 'name startTime')
    .sort({ createdAt: -1 })
    .limit(1000);
};

/**
 * The player's statement, one entry per match they bet on (newest first):
 * session and match results, and the commission they kept on each.
 */
async function playerStatement(player, { limit = 30 } = {}) {
  const playerId = new mongoose.Types.ObjectId(String(player._id));
  const recent = await Bet.aggregate([
    { $match: { user: playerId, status: { $in: ['Won', 'Lost', 'Cashed Out'] } } },
    { $group: { _id: '$event', last: { $max: '$settledAt' } } },
    { $sort: { last: -1 } },
    { $limit: limit },
  ]);
  const eventIds = recent.map((row) => row._id);
  const [events, markets, bets, commissions] = await Promise.all([
    Event.find({ _id: { $in: eventIds } }).select('name startTime status commissionSettledAt').lean(),
    Market.find({ event: { $in: eventIds } }).select('type providerType').lean(),
    Bet.find({ user: playerId, event: { $in: eventIds }, status: { $in: ['Won', 'Lost', 'Cashed Out'] } })
      .select('event market')
      .lean(),
    Commission.find({ entity: playerId, event: { $in: eventIds } }).select('event kind commission rate').lean(),
  ]);
  const kindById = new Map(markets.map((m) => [String(m._id), kindOfMarket(m)]));
  const nets = await Transaction.aggregate([
    { $match: { user: playerId, relatedBet: { $in: bets.map((b) => b._id) }, type: { $in: ['Bet Win', 'Bet Loss'] } } },
    { $group: { _id: '$relatedBet', net: { $sum: '$amount' } } },
  ]);
  const netByBet = new Map(nets.map((row) => [String(row._id), row.net]));

  return recent.map(({ _id, last }) => {
    const event = events.find((e) => String(e._id) === String(_id));
    const lines = { sessionResult: 0, matchResult: 0, sessionCommission: 0, matchCommission: 0 };
    for (const bet of bets) {
      if (String(bet.event) !== String(_id)) continue; // eslint-disable-line no-continue
      const net = netByBet.get(String(bet._id)) || 0;
      if (kindById.get(String(bet.market)) === 'Match') lines.matchResult += net;
      else lines.sessionResult += net;
    }
    for (const row of commissions) {
      if (String(row.event) !== String(_id)) continue; // eslint-disable-line no-continue
      if (row.kind === 'Session') lines.sessionCommission += row.commission;
      if (row.kind === 'Match') lines.matchCommission += row.commission;
    }
    const total = lines.sessionResult + lines.matchResult + lines.sessionCommission + lines.matchCommission;
    return {
      event: { _id, name: event?.name || 'Match', startTime: event?.startTime || null },
      settledAt: last,
      /** False until the match is over and its commission has been paid. */
      commissionPaid: Boolean(event?.commissionSettledAt),
      ...Object.fromEntries(Object.entries(lines).map(([key, value]) => [key, round2(value)])),
      total: round2(total),
    };
  });
}

/**
 * The full settlement of one match, for the Complete Match view: each
 * market's result, each player's session stake and session / match result,
 * and every commission share along the chain (rate received, passed down
 * and kept). Staff only see players and shares inside their own network.
 */
async function eventSettlement(eventId, scope = null) {
  const event = await Event.findById(eventId).select('name status startTime commissionSettledAt provider').lean();
  if (!event) throw ApiError.notFound('Match not found');
  const inScope = (id) => !scope || scope.some((s) => String(s) === String(id));

  const [markets, allBets, allCommissions] = await Promise.all([
    Market.find({ event: event._id }).select('name type providerType status winner settledAt bets stake').sort({ createdAt: 1 }).lean(),
    Bet.find({ event: event._id }).select('user market status amount stake payout').lean(),
    Commission.find({ event: event._id })
      .populate('entity', 'name username role')
      .populate('transaction', 'reference balanceAfter')
      .select('entity player kind level turnover rate receivedRate givenRate commission settledAt transaction')
      .lean(),
  ]);
  const bets = allBets.filter((bet) => inScope(bet.user));
  const commissions = allCommissions.filter((row) => row.entity && inScope(row.entity._id));
  const kindById = new Map(markets.map((m) => [String(m._id), kindOfMarket(m)]));
  const nets = await Transaction.aggregate([
    { $match: { relatedBet: { $in: bets.map((b) => b._id) }, type: { $in: ['Bet Win', 'Bet Loss'] } } },
    { $group: { _id: '$relatedBet', net: { $sum: '$amount' } } },
  ]);
  const netByBet = new Map(nets.map((row) => [String(row._id), row.net]));

  const playerIds = [...new Set(bets.map((b) => String(b.user)))];
  const people = await User.find({ _id: { $in: playerIds } }).select('name username parent').lean();
  const players = playerIds.map((id) => {
    const person = people.find((p) => String(p._id) === id);
    const line = { sessionStake: 0, sessionResult: 0, matchResult: 0, openBets: 0 };
    for (const bet of bets) {
      if (String(bet.user) !== id) continue; // eslint-disable-line no-continue
      if (bet.status === 'Pending') line.openBets += 1;
      const net = netByBet.get(String(bet._id)) || 0;
      if (kindById.get(String(bet.market)) === 'Match') line.matchResult += net;
      else {
        line.sessionResult += net;
        if (bet.status !== 'Void') line.sessionStake += Number(bet.stake ?? bet.amount) || 0;
      }
    }
    const shares = commissions
      .filter((row) => String(row.player) === id)
      .map((row) => ({
        kind: row.kind,
        level: row.level,
        account: { _id: row.entity._id, name: row.entity.name, username: row.entity.username, role: row.entity.role },
        base: row.turnover,
        receivedRate: row.receivedRate,
        givenRate: row.givenRate,
        rate: row.rate,
        commission: row.commission,
        reference: row.transaction?.reference || '',
        settledAt: row.settledAt,
      }));
    return {
      player: { _id: id, name: person?.name || '', username: person?.username || '' },
      ...Object.fromEntries(Object.entries(line).map(([key, value]) => [key, key === 'openBets' ? value : round2(value)])),
      shares,
    };
  });

  const totalOf = (kind) => round2(commissions.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.commission, 0));
  const byLevel = {};
  for (const row of commissions) byLevel[row.level] = round2((byLevel[row.level] || 0) + row.commission);
  return {
    event: { ...event, commissionPaid: Boolean(event.commissionSettledAt) },
    markets: markets.map((m) => ({
      _id: m._id,
      name: m.name,
      type: m.type,
      kind: kindOfMarket(m),
      result: m.winner || '',
      settledAt: m.settledAt,
      bets: m.bets || 0,
      settlement: m.winner === 'Void' ? 'Voided' : m.winner ? 'Settled' : m.bets ? 'Awaiting result' : 'No bets',
    })),
    players,
    totals: {
      players: players.length,
      sessionStake: round2(players.reduce((sum, p) => sum + p.sessionStake, 0)),
      sessionResult: round2(players.reduce((sum, p) => sum + p.sessionResult, 0)),
      matchResult: round2(players.reduce((sum, p) => sum + p.matchResult, 0)),
      sessionCommission: totalOf('Session'),
      matchCommission: totalOf('Match'),
      byLevel,
    },
  };
}

module.exports = {
  eventSettlement,
  listCommission,
  settleEventCommission,
  settleFinishedMatches,
  startScheduler,
  playerStatement,
  sharesFor,
  kindOfMarket,
};
