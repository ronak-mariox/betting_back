const mongoose = require('mongoose');
const { loadTree, descendants } = require('./tree.service');
const Event = require('../models/Event');
const Market = require('../models/Market');
const Bet = require('../models/Bet');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const WalletRequest = require('../models/WalletRequest');
const Settings = require('../models/Settings');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');
const { ENABLED_SPORTS } = require('../constants/admin');

const { isStale } = require('./feedFreshness');
const { money } = require('../utils/money');
const { startOfDay } = require('../utils/time');

/** Cash-out offers keep a 5% margin, like the app's design copy implies. */
const CASH_OUT_MARGIN = 0.95;

const sides = (eventName) => {
  const [home, away] = String(eventName).split(/\s+(?:vs\.?|v\.?|-)\s+/i);
  return { home: home || eventName, away: away || 'Draw' };
};

/**
 * A market's backable selections. Markets without explicit runners fall back
 * to the event's two sides, priced at the market's back / lay odds.
 */
function runnersFor(market, event) {
  if (market.runners?.length) {
    return market.runners.map((r) => ({
      name: r.name,
      odds: r.odds,
      active: r.active !== false,
      // Session sides: the run line and its rate (100 = even money).
      ...(r.line != null ? { line: r.line, rate: r.rate } : {}),
    }));
  }
  const { home, away } = sides(event.name);
  return [
    { name: home, odds: market.backOdds || 2 },
    { name: away, odds: market.layOdds || 2 },
  ];
}

/**
 * Stake tied up in the player's open bets plus withdrawals awaiting approval.
 * Bets don't debit the wallet until they settle, so this is what's "reserved".
 */
async function reservedFor(userId) {
  const [bets, withdrawals] = await Promise.all([
    Bet.aggregate([{ $match: { user: userId, status: 'Pending' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    WalletRequest.aggregate([
      { $match: { user: userId, kind: 'withdrawal', status: 'Pending' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);
  return { openStake: bets[0]?.total || 0, pendingWithdrawal: withdrawals[0]?.total || 0 };
}

/** The player's agent, super agent and franchise (nearest first) with the limits set on them. */
async function uplinesOf(user) {
  const chain = [];
  let parentId = user.parent;
  while (parentId && chain.length < 5) {
    // eslint-disable-next-line no-await-in-loop
    const parent = await User.findById(parentId).select('parent role bettingLimit maxExposure').lean();
    if (!parent || parent.role === 'super-admin') break;
    chain.push(parent);
    parentId = parent.parent;
  }
  return chain;
}

/** Stake riding on open bets across everyone under a staff account. */
async function bookExposure(staffId) {
  const tree = await loadTree();
  const ids = descendants(tree, staffId).map((id) => new mongoose.Types.ObjectId(id));
  const [row] = await Bet.aggregate([{ $match: { user: { $in: ids }, status: 'Pending' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
  return row?.total || 0;
}

async function availableFor(user) {
  const { openStake, pendingWithdrawal } = await reservedFor(user._id);
  return Math.max(0, user.walletBalance - openStake - pendingWithdrawal);
}

/** Match Odds first (the card's headline prices), then Bookmaker, Tied Match, Fancy; ties by creation order. */
const MARKET_RANK = { 'Match Odds': 0, Bookmaker: 1, Fancy: 3 };
const marketRank = (m) => (m.name === 'Tied Match' ? 2 : MARKET_RANK[m.type] ?? 4);
const marketOrder = (a, b) => marketRank(a) - marketRank(b) || new Date(a.createdAt) - new Date(b.createdAt);

/**
 * A market as the app sees it. Feed prices that have gone stale (the feed
 * stopped answering) are shown paused — every selection suspended — rather
 * than passed off as live; they reopen as soon as fresh prices arrive.
 */
const toAppMarket = (m, event, now) => {
  const paused = isStale(event, m, now);
  // Suspended (ball running, admin hold) and view-only markets are listed with every selection closed.
  const closed = paused || m.status !== 'Active' || m.betStyle === 'view';
  const runners = runnersFor(m, event);
  return {
    _id: m._id,
    name: m.name,
    type: m.type,
    group: m.group || m.type,
    betStyle: m.betStyle || 'back',
    remark: m.remark || '',
    status: m.status,
    maxBet: m.maxBet,
    paused,
    oddsAt: m.oddsAt || null,
    runners: closed ? runners.map((r) => ({ ...r, active: false })) : runners,
  };
};

const toMatch = (event, markets) => {
  const now = Date.now();
  const appMarkets = [...markets].sort(marketOrder).map((m) => toAppMarket(m, event, now));
  return {
    _id: event._id,
    sport: event.sport,
    emoji: event.emoji,
    league: event.league,
    name: event.name,
    ...sides(event.name),
    score: event.score,
    status: event.status,
    startTime: event.startTime,
    markets: appMarkets,
    // Every market's prices are stale: the live feed isn't reaching us right now.
    feedPaused: appMarkets.length > 0 && appMarkets.every((m) => m.paused),
    // Feed matches: embeddable live score card and (when the provider has one) video.
    // eslint-disable-next-line global-require
    ...require('./diamondSync.service').mediaFor(event),
    // The provider may start publishing a score mid-match: the app keeps asking for one.
    hasScoreFeed: event.provider === 'diamond',
  };
};

/** Live and upcoming events with at least one open market — the app's match feed. */
async function listMatches() {
  // Only the sports open for betting reach the app (cricket for now).
  const events = await Event.find({ status: { $in: ['Live', 'Upcoming'] }, sport: { $in: ENABLED_SPORTS } }).sort({ status: 1, startTime: 1 }).lean();
  const markets = await Market.find({ event: { $in: events.map((e) => e._id) }, status: 'Active' }).lean();
  return events
    .map((event) => toMatch(event, markets.filter((m) => String(m.event) === String(event._id))))
    .filter((match) => match.markets.length > 0)
    // Live first, then soonest kickoff.
    .sort((a, b) => (a.status === b.status ? new Date(a.startTime) - new Date(b.startTime) : a.status === 'Live' ? -1 : 1));
}

async function getMatch(eventId) {
  const event = await Event.findById(eventId).lean();
  if (!event) throw ApiError.notFound('Match not found');
  // Everything the feed has for the match right now — suspended ones too (shown closed).
  // Settled markets and ones the feed stopped sending (no price for 2 minutes) are left out.
  const recent = new Date(Date.now() - 2 * 60 * 1000);
  const markets = await Market.find({
    event: event._id,
    winner: { $in: ['', null] },
    $or: [{ status: 'Active' }, { externalId: null }, { oddsAt: { $gte: recent } }],
  }).lean();
  return toMatch(event, markets);
}

/** The live score card of a match, as JSON for the app to draw (null when there is none). */
async function matchScore(eventId) {
  const event = await Event.findById(eventId).select('provider externalId status').lean();
  if (!event) throw ApiError.notFound('Match not found');
  if (event.status !== 'Live') return null;
  // eslint-disable-next-line global-require
  return require('./scoreCard.service').scoreFor(event);
}

/**
 * Places a bet at the market's current price for `selection`. The stake must
 * fit the platform/market limits and the player's available balance (balance
 * minus open stakes and pending withdrawals); it's reserved, not debited.
 */
async function placeBet(player, { marketId, selection, stake, odds, line }) {
  const stakeIn = Math.round(Number(stake));
  const market = await Market.findById(marketId);
  if (!market || market.status !== 'Active') throw ApiError.badRequest('Yeh market abhi band hai');
  if (market.betStyle === 'view') throw ApiError.badRequest('Is market par abhi bet nahi lagti');
  const event = await Event.findById(market.event);
  if (!event || !['Live', 'Upcoming'].includes(event.status)) throw ApiError.badRequest('Is match par betting band hai');

  const runner = runnersFor(market, event).find((r) => r.name === selection);
  if (!runner) throw ApiError.badRequest('Selection is market mein nahi hai');
  if (runner.active === false) throw ApiError.badRequest('Yeh selection abhi suspended hai');
  // Feed markets: never take a bet on prices the feed hasn't refreshed recently.
  if (isStale(event, market)) throw ApiError.badRequest('Odds update ho rahe hain — thodi der baad try karo');
  // Session (No / Yes on a run line): the line can't have moved since the slip was opened.
  const session = market.betStyle === 'session';
  if (session && (runner.line == null || !(runner.rate > 0))) throw ApiError.badRequest('Yeh line abhi band hai');
  if (session && line !== undefined && Number(line) !== runner.line) {
    throw ApiError.conflict(`Line badal gayi (${line} → ${runner.line}) — nayi line dekh kar dobara confirm karo`);
  }
  // The slip showed `odds`: never take the bet at a worse price than the player confirmed.
  if (odds !== undefined && runner.odds < Number(odds)) {
    throw ApiError.conflict(
      session
        ? `Rate badal gaya — nayi rate (${runner.rate}) dekh kar dobara confirm karo`
        : `Odds badal gaye (${Number(odds).toFixed(2)} → ${runner.odds.toFixed(2)}) — naye odds dekh kar dobara confirm karo`,
    );
  }
  /**
   * What is held from the wallet and what a win pays. Indian session rule:
   * Yes @ rate R risks the stake to win stake × R / 100; No @ R risks
   * stake × R / 100 to win the stake. A back bet risks the stake at its odds.
   */
  const side = session ? (runner.name === 'Yes' ? 'yes' : 'no') : null;
  const amount = side === 'no' ? Math.round((stakeIn * runner.rate) / 100) : stakeIn;
  const profit = side === 'yes' ? Math.round((stakeIn * runner.rate) / 100) : side === 'no' ? stakeIn : null;
  const betOdds = session ? (amount + profit) / amount : runner.odds;

  const user = await User.findById(player._id);
  const [settings, uplines] = await Promise.all([Settings.findById('main').lean(), uplinesOf(user)]);
  const rupees = money;
  const positive = (...values) => values.map(Number).filter((n) => Number.isFinite(n) && n > 0);

  // Stake per bet: platform limits, the market's own cap, and any "Betting
  // Limit per User" set on the player's agent / super agent / franchise.
  const minBet = Number(settings?.bettingLimits?.minBet) || 100;
  const maxBet = Math.min(...positive(settings?.bettingLimits?.maxBet, market.maxBet, ...uplines.map((u) => u.bettingLimit)), Infinity);
  if (stakeIn < minBet) throw ApiError.badRequest(`Minimum stake ${rupees(minBet)} hai`);
  if (stakeIn > maxBet) throw ApiError.badRequest(`Maximum stake ${rupees(maxBet)} hai`);

  if (amount > (await availableFor(user))) {
    throw ApiError.badRequest(
      side === 'no' ? `No bet ke liye ${rupees(amount)} liability chahiye — wallet mein itna balance nahi hai` : 'Wallet mein itna balance nahi hai',
    );
  }

  // Per-player limits from Settings → Betting Limits.
  const maxOpenBets = Number(settings?.bettingLimits?.maxOpenBets) || 0;
  if (maxOpenBets && (await Bet.countDocuments({ user: user._id, status: 'Pending' })) >= maxOpenBets) {
    throw ApiError.badRequest(`Ek saath maximum ${maxOpenBets} open bets — pehle koi bet settle hone do`);
  }
  const maxDailyLoss = Number(settings?.bettingLimits?.maxDailyLoss) || 0;
  if (maxDailyLoss) {
    // Worst case for today: what was already lost today, plus every open stake, plus this one.
    const [today] = await Bet.aggregate([
      { $match: { user: user._id, status: { $in: ['Won', 'Lost', 'Cashed Out'] }, settledAt: { $gte: startOfDay(0) } } },
      { $group: { _id: null, net: { $sum: { $subtract: ['$amount', '$payout'] } } } },
    ]);
    const lostToday = Math.max(0, today?.net || 0);
    const { openStake: atRisk } = await reservedFor(user._id);
    if (lostToday + atRisk + amount > maxDailyLoss) {
      const left = Math.max(0, maxDailyLoss - lostToday - atRisk);
      throw ApiError.badRequest(
        left >= minBet
          ? `Daily loss limit ${rupees(maxDailyLoss)} hai — abhi maximum ${rupees(left)} ki bet laga sakte ho`
          : `Aaj ki loss limit ${rupees(maxDailyLoss)} tak pahunch gaye — kal try karo`,
      );
    }
  }

  // Exposure: what this player, this market and each upline's book may have riding at once.
  const { openStake } = await reservedFor(user._id);
  const userCap = Math.min(...positive(settings?.exposureLimits?.maxUserExposure), Infinity);
  if (openStake + amount > userCap) {
    throw ApiError.badRequest(`Aapki open bets ki limit ${rupees(userCap)} hai — pehle koi bet settle hone do`);
  }
  const marketCap = Math.min(...positive(settings?.exposureLimits?.maxMarketExposure, market.maxExposure), Infinity);
  if ((market.exposure || 0) + amount > marketCap) throw ApiError.badRequest('Is market ki limit poori ho gayi hai');
  const matchCap = Math.min(...positive(settings?.exposureLimits?.maxMatchExposure), Infinity);
  if (matchCap < Infinity && (await openStakeOn({ event: event._id })) + amount > matchCap) {
    throw ApiError.badRequest('Is match ki betting limit poori ho gayi hai');
  }
  // Each upline's own "Max Exposure"; an agent without one falls back to Settings → Max Agent Exposure.
  const agentCap = Number(settings?.exposureLimits?.maxAgentExposure) || 0;
  for (const upline of uplines) {
    const cap = upline.maxExposure > 0 ? upline.maxExposure : upline.role === 'agent' ? agentCap : 0;
    if (!cap) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    if ((await bookExposure(upline._id)) + amount > cap) {
      throw ApiError.badRequest('Aapke agent ki exposure limit poori ho gayi hai — agent se baat karo');
    }
  }

  const bet = await Bet.create({
    event: event._id,
    market: market._id,
    user: user._id,
    eventName: event.name,
    marketName: market.name,
    selection: runner.name,
    odds: betOdds,
    amount,
    ...(session ? { stake: stakeIn, side, line: runner.line, rate: runner.rate } : {}),
    status: 'Pending',
  });

  // Two bets sent at the same moment both pass the check above; re-check with
  // this bet counted and take it back if together they overdraw the wallet.
  // Bets are honoured oldest first, so of several racing bets the first ones that fit stay.
  const [fresh, { pendingWithdrawal }, queue] = await Promise.all([
    User.findById(user._id).select('walletBalance'),
    reservedFor(user._id),
    Bet.find({ user: user._id, status: 'Pending' }).sort({ _id: 1 }).select('amount'),
  ]);
  let held = pendingWithdrawal;
  for (const open of queue) {
    held += open.amount;
    if (String(open._id) === String(bet._id)) break;
  }
  if (held > fresh.walletBalance) {
    await Bet.deleteOne({ _id: bet._id });
    throw ApiError.badRequest('Wallet mein itna balance nahi hai');
  }

  await Promise.all([
    Market.updateOne({ _id: market._id }, { $inc: { bets: 1, stake: amount, exposure: amount } }),
    Event.updateOne({ _id: event._id }, { $inc: { stake: amount, exposure: amount } }),
  ]);
  await checkExposureThresholds({ settings, market, event, marketCap, matchCap });
  // Feed markets: the result sync registers it with Diamond; nothing here waits on the feed.
  return bet;
}

/** Stake on open bets matching `filter` (a market or a whole match). */
async function openStakeOn(filter) {
  const [row] = await Bet.aggregate([{ $match: { ...filter, status: 'Pending' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
  return row?.total || 0;
}

/**
 * Settings → Exposure Limits thresholds, checked after every bet against the
 * market's and the match's caps: past Warning Threshold % the admins get one
 * alert; past Auto-Suspend Threshold % the market (or every market of the
 * match) is suspended and stays so until an admin reopens it.
 */
async function checkExposureThresholds({ settings, market, event, marketCap, matchCap }) {
  const limits = settings?.exposureLimits || {};
  const suspendAt = Number(limits.autoSuspendPercent) || 0;
  const warnAt = Number(limits.warningPercent) || 0;
  if (!suspendAt && !warnAt) return;
  const checks = [];
  if (marketCap < Infinity) checks.push({ model: Market, doc: market, cap: marketCap, stake: await openStakeOn({ market: market._id }), label: `${market.name} (${event.name})`, filter: { _id: market._id } });
  if (matchCap < Infinity) checks.push({ model: Event, doc: event, cap: matchCap, stake: await openStakeOn({ event: event._id }), label: event.name, filter: { event: event._id } });
  for (const { model, doc, cap, stake, label, filter } of checks) {
    const percent = Math.round((stake / cap) * 100);
    if (suspendAt && percent >= suspendAt) {
      // eslint-disable-next-line no-await-in-loop
      const result = await Market.updateMany({ ...filter, status: 'Active' }, { $set: { status: 'Suspended', adminSuspended: true } });
      if (result.modifiedCount) {
        // eslint-disable-next-line no-await-in-loop
        await notificationService.notify({
          title: 'Market auto-suspended',
          body: `${label} reached ${percent}% of its ${money(cap)} exposure limit and was suspended. Reopen it from Markets.`,
          category: 'risk',
          emoji: '⛔',
        });
        require('../realtime').emitMatchesChanged(); // eslint-disable-line global-require
      }
    } else if (warnAt && percent >= warnAt && !doc.exposureWarnedAt) {
      // eslint-disable-next-line no-await-in-loop
      await model.updateOne({ _id: doc._id }, { $set: { exposureWarnedAt: new Date() } });
      // eslint-disable-next-line no-await-in-loop
      await notificationService.notify({
        title: 'Exposure warning',
        body: `${label} is at ${percent}% of its ${money(cap)} exposure limit.`,
        category: 'risk',
        emoji: '⚠️',
      });
    }
  }
}

/** Current cash-out offer for an open bet: its value at today's price, less the margin. */
async function cashOutOffer(bet) {
  const market = await Market.findById(bet.market);
  const event = market && (await Event.findById(market.event));
  if (!market || market.status !== 'Active' || !event) return null;
  // Session lines move every ball and price the two sides differently: no cash-out on them.
  if (market.betStyle && market.betStyle !== 'back') return null;
  // A stale feed price would make a wrong offer: no cash-out until prices are fresh again.
  if (isStale(event, market)) return null;
  const current = runnersFor(market, event).find((r) => r.name === bet.selection)?.odds || bet.odds;
  return Math.round(((bet.amount * bet.odds) / current) * CASH_OUT_MARGIN);
}

async function listBets(player) {
  const bets = await Bet.find({ user: player._id })
    .populate('event', 'name league startTime status provider externalId hasStream')
    .populate('market', 'name status runners winner externalId oddsAt')
    .sort({ createdAt: -1 })
    .limit(100);
  // eslint-disable-next-line global-require
  const { mediaFor } = require('./diamondSync.service');
  return Promise.all(
    bets.map(async (bet) => {
      // The selection's price right now, while its market is still open (the bet detail compares it).
      const feedPaused = bet.status === 'Pending' && bet.market?.status === 'Active' && isStale(bet.event, bet.market);
      const runner = bet.market?.status === 'Active' && !feedPaused ? bet.market.runners?.find((r) => r.name === bet.selection) : null;
      const live = bet.event?.status === 'Live';
      return {
        _id: bet._id,
        eventId: bet.event?._id || null,
        league: bet.event?.league || '',
        match: bet.event?.name || bet.eventName || '',
        currentOdds: runner && runner.active !== false ? runner.odds : null,
        // The feed's prices for this bet's market are stale (provider unreachable): no live odds / cash-out.
        feedPaused,
        winner: bet.market?.winner || '',
        // Live score card / video while the match is in play.
        ...(live && bet.event ? mediaFor(bet.event) : { scoreUrl: null, streamUrl: null }),
        // When the match is / was, and where it stands now (Upcoming, Live, Completed…).
        matchStart: bet.event?.startTime || null,
        matchStatus: bet.event?.status || '',
        market: bet.market?.name || bet.marketName || '',
        selection: bet.selection,
        odds: bet.odds,
        // Session bets: what was staked; `liability` is what's held (No risks stake × rate / 100).
        stake: bet.stake ?? bet.amount,
        liability: bet.amount,
        side: bet.side || null,
        line: bet.line ?? null,
        rate: bet.rate ?? null,
        /** Paid back if it wins (stake + profit). */
        potentialPayout: Math.round(bet.amount * bet.odds),
        status: bet.status,
        payout: bet.payout,
        placedAt: bet.createdAt,
        settledAt: bet.settledAt,
        cashOut: bet.status === 'Pending' ? await cashOutOffer(bet) : null,
      };
    }),
  );
}

/** Closes an open bet now for the current offer; the ledger records the difference from the stake. */
async function cashOut(player, betId, expected) {
  const open = await Bet.findOne({ _id: betId, user: player._id });
  if (!open) throw ApiError.notFound('Bet not found');
  if (open.status !== 'Pending') throw ApiError.conflict('Yeh bet already settle ho chuki hai');
  const offer = await cashOutOffer(open);
  if (offer === null) throw ApiError.badRequest('Is bet par abhi cash out available nahi hai');
  // The sheet showed `expected`: never pay less than the player confirmed.
  if (expected !== undefined && offer < Number(expected)) {
    throw ApiError.conflict(`Cash out amount badal gaya (${money(expected)} → ${money(offer)}) — dobara dekh kar confirm karo`);
  }

  // Claimed only while still open, so a double tap (or a settlement landing
  // at the same moment) can't pay the bet twice.
  const bet = await Bet.findOneAndUpdate(
    { _id: betId, user: player._id, status: 'Pending' },
    { $set: { status: 'Cashed Out', payout: offer, settledAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!bet) throw ApiError.conflict('Yeh bet already settle ho chuki hai');

  const net = offer - bet.amount;
  await User.updateOne({ _id: player._id }, { $inc: { walletBalance: net } });
  await Transaction.create({
    user: player._id,
    type: net >= 0 ? 'Bet Win' : 'Bet Loss',
    amount: net,
    status: 'Completed',
    relatedBet: bet._id,
    note: `Cash out — ${bet.selection}`,
  });
  await Promise.all([
    Market.updateOne({ _id: bet.market }, { $inc: { exposure: -bet.amount } }),
    Event.updateOne({ _id: bet.event }, { $inc: { exposure: -bet.amount } }),
  ]);
  return { bet, offer };
}

/**
 * Admin settles a market with its winning selection: every open bet on it is
 * marked Won (profit credited as "Bet Win") or Lost (stake debited as "Bet
 * Loss"), and the market is closed.
 */
/**
 * `allowUnlisted` (feed results only): the winner may be an outcome nobody
 * could back, e.g. "No" on a one-selection "Yes" proposition — every bet loses.
 */
/**
 * The result of a market as a number of runs (session lines, odd / even,
 * last-digit markets): "73", 73, "Runs 73" → 73; null when there's none.
 */
const resultNumber = (value) => {
  const m = /-?\d+(\.\d+)?/.exec(String(value ?? ''));
  return m ? Number(m[0]) : null;
};

/**
 * Settles a market from its result. Back markets take the winning selection
 * (odd / even and number markets may instead get the runs, which are turned
 * into "Odd" / "Even" / "N Number"); session markets take the runs, and each
 * bet wins on its own line: Yes if runs ≥ its line, No if runs < its line.
 */
async function settleMarketResult(marketId, result) {
  const market = await Market.findById(marketId).lean();
  if (!market) throw ApiError.notFound('Market not found');
  const runs = resultNumber(result);
  if (market.betStyle === 'session' || market.betStyle === 'view') {
    if (runs === null) throw ApiError.badRequest('Is session ka result runs mein daalo (jaise 73)');
    return settleMarket(marketId, `${runs} runs`, {
      allowUnlisted: true,
      isWin: (bet) => (bet.side === 'yes' ? runs >= bet.line : bet.side === 'no' ? runs < bet.line : false),
    });
  }
  if (market.providerType === 'oddeven' && !/^(odd|even)$/i.test(String(result).trim()) && runs !== null) {
    return settleMarket(marketId, runs % 2 === 0 ? 'Even' : 'Odd');
  }
  if (market.providerType === 'cricketcasino' && !market.runners.some((r) => r.name === result) && runs !== null) {
    return settleMarket(marketId, `${Math.abs(runs) % 10} Number`);
  }
  const named = market.runners.find((r) => r.name.toLowerCase() === String(result).trim().toLowerCase());
  return settleMarket(marketId, named ? named.name : result);
}

async function settleMarket(marketId, winner, { allowUnlisted = false, isWin: winsBy = null } = {}) {
  const existing = await Market.findById(marketId);
  if (!existing) throw ApiError.notFound('Market not found');
  if (existing.winner) throw ApiError.conflict('Market already settled');
  if (existing.betStyle === 'session' && !winsBy) {
    // A session market is settled by its runs (each bet against its own line).
    return settleMarketResult(marketId, winner);
  }
  const event = await Event.findById(existing.event);
  if (!allowUnlisted && !runnersFor(existing, event).some((r) => r.name === winner)) {
    throw ApiError.badRequest('Winner must be one of the market selections');
  }

  // Closing the market first (only if nobody else has) stops new bets and a second settlement.
  const market = await Market.findOneAndUpdate(
    { _id: marketId, winner: { $in: ['', null] } },
    { $set: { winner, settledAt: new Date(), status: 'Suspended' } },
    { returnDocument: 'after' },
  );
  if (!market) throw ApiError.conflict('Market already settled');

  const openBets = await Bet.find({ market: market._id, status: 'Pending' });
  const bets = [];
  let won = 0;
  let lost = 0;
  for (const open of openBets) {
    const isWin = winsBy ? winsBy(open) : open.selection === winner;
    const net = isWin ? Math.round(open.amount * (open.odds - 1)) : -open.amount;
    // Skips a bet the player cashed out in the meantime.
    // eslint-disable-next-line no-await-in-loop
    const bet = await Bet.findOneAndUpdate(
      { _id: open._id, status: 'Pending' },
      { $set: { status: isWin ? 'Won' : 'Lost', payout: isWin ? Math.round(open.amount * open.odds) : 0, settledAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!bet) continue; // eslint-disable-line no-continue
    bets.push(bet);
    // eslint-disable-next-line no-await-in-loop
    await User.updateOne({ _id: bet.user }, { $inc: { walletBalance: net } });
    // eslint-disable-next-line no-await-in-loop
    await Transaction.create({
      user: bet.user,
      type: isWin ? 'Bet Win' : 'Bet Loss',
      amount: net,
      status: 'Completed',
      relatedBet: bet._id,
      note: `${event.name} — ${market.name}: ${winner}`,
    });
    // eslint-disable-next-line no-await-in-loop
    await notificationService.notifyBetSettled(bet, event.name);
    if (isWin) won += 1;
    else lost += 1;
  }

  const openStake = bets.reduce((sum, b) => sum + b.amount, 0);
  market.exposure = 0;
  await market.save();
  await Event.updateOne({ _id: event._id }, { $inc: { exposure: -openStake } });
  return { market, settled: bets.length, won, lost };
}

/**
 * No result (abandoned match, wrong market): every open bet is voided and its
 * stake released — nothing was debited, so no ledger entry is needed. Claims
 * the market like a settlement does, so it can't be settled afterwards.
 */
async function voidMarket(marketId, reason = '') {
  const existing = await Market.findById(marketId);
  if (!existing) throw ApiError.notFound('Market not found');
  if (existing.winner) throw ApiError.conflict('Market already settled');
  const event = await Event.findById(existing.event);

  const market = await Market.findOneAndUpdate(
    { _id: marketId, winner: { $in: ['', null] } },
    { $set: { winner: 'Void', settledAt: new Date(), status: 'Suspended', exposure: 0 } },
    { returnDocument: 'after' },
  );
  if (!market) throw ApiError.conflict('Market already settled');

  const openBets = await Bet.find({ market: market._id, status: 'Pending' });
  let voided = 0;
  for (const open of openBets) {
    // eslint-disable-next-line no-await-in-loop
    const bet = await Bet.findOneAndUpdate(
      { _id: open._id, status: 'Pending' },
      { $set: { status: 'Void', payout: open.amount, settledAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!bet) continue; // eslint-disable-line no-continue
    voided += 1;
    // eslint-disable-next-line no-await-in-loop
    await notificationService.notifyPlayer({
      user: bet.user,
      category: 'bet',
      link: 'bets',
      source: `bet:${bet._id}`,
      emoji: '↩️',
      title: 'Bet Void',
      body: `${bet.selection} bet (${event?.name || market.name}) — ${reason || 'no result'}. Your ${money(bet.amount)} stake is released.`,
    });
  }
  const released = openBets.reduce((sum, b) => sum + b.amount, 0);
  if (event) await Event.updateOne({ _id: event._id }, { $inc: { exposure: -released } });
  return { market, voided, released };
}

module.exports = {
  runnersFor,
  reservedFor,
  availableFor,
  listMatches,
  getMatch,
  matchScore,
  placeBet,
  listBets,
  cashOut,
  settleMarket,
  settleMarketResult,
  resultNumber,
  voidMarket,
};
