const Market = require('../models/Market');
const Event = require('../models/Event');
const Bet = require('../models/Bet');
const ApiError = require('../utils/ApiError');

/** Fields an admin may set; rollups (bets / stake / exposure) and the result never come from a form. */
const EDITABLE = ['code', 'name', 'type', 'backOdds', 'layOdds', 'maxBet', 'maxExposure', 'status'];
const MIN_ODDS = 1.01;

const listMarkets = async ({ eventId, status, type }) => {
  const filter = {};
  if (eventId) filter.event = eventId;
  if (status) filter.status = status;
  if (type) filter.type = type;
  return Market.find(filter).populate('event', 'name sport status').sort({ createdAt: -1 });
};

const pick = (data) => Object.fromEntries(EDITABLE.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));

const sidesOf = (eventName) => {
  const [home, away] = String(eventName || '').split(/\s+(?:vs\.?|v\.?|-)\s+/i);
  return [home || 'Home', away || 'Away'];
};

/** Trims, validates and de-duplicates the selections sent by the form. */
function cleanRunners(runners) {
  if (!Array.isArray(runners)) throw ApiError.badRequest('Selections must be a list');
  const cleaned = runners.map((r) => ({ name: String(r?.name ?? '').trim(), odds: Number(r?.odds) }));
  if (cleaned.length < 2) throw ApiError.badRequest('A market needs at least two selections');
  if (cleaned.some((r) => !r.name)) throw ApiError.badRequest('Every selection needs a name');
  if (cleaned.some((r) => !Number.isFinite(r.odds) || r.odds < MIN_ODDS)) {
    throw ApiError.badRequest(`Odds must be ${MIN_ODDS} or higher`);
  }
  if (new Set(cleaned.map((r) => r.name.toLowerCase())).size !== cleaned.length) {
    throw ApiError.badRequest('Two selections have the same name');
  }
  return cleaned.map((r) => ({ name: r.name, odds: Math.round(r.odds * 100) / 100 }));
}

/**
 * Players bet on a market's selections, so those are the prices that count.
 * Back / lay odds (the panel's two headline columns) always mirror the first
 * two selections — whichever of the two the admin edited.
 */
function priced(data, current) {
  const next = pick(data);
  if (data.runners !== undefined) {
    next.runners = cleanRunners(data.runners);
  } else if (next.backOdds !== undefined || next.layOdds !== undefined) {
    const runners = current.map((r) => ({ name: r.name, odds: r.odds }));
    if (next.backOdds !== undefined) runners[0].odds = Number(next.backOdds);
    if (next.layOdds !== undefined) runners[1].odds = Number(next.layOdds);
    next.runners = cleanRunners(runners);
  }
  if (next.runners) {
    next.backOdds = next.runners[0].odds;
    next.layOdds = next.runners[1].odds;
  }
  return next;
}

const createMarket = async (data) => {
  const event = await Event.findById(data.event).select('name').lean();
  if (!event) throw ApiError.badRequest('Event not found');
  const [home, away] = sidesOf(event.name);
  const defaults = [
    { name: home, odds: Number(data.backOdds) || 1.9 },
    { name: away, odds: Number(data.layOdds) || 1.9 },
  ];
  return Market.create({ event: data.event, ...priced({ ...data, runners: data.runners ?? defaults }, defaults) });
};

const updateMarket = async (id, updates) => {
  const market = await Market.findById(id);
  if (!market) throw ApiError.notFound('Market not found');
  if (market.winner) throw ApiError.conflict('This market is settled and can no longer be edited');

  const event = await Event.findById(market.event).select('name').lean();
  const [home, away] = sidesOf(event?.name);
  const current = market.runners?.length
    ? market.runners
    : [
        { name: home, odds: market.backOdds || 1.9 },
        { name: away, odds: market.layOdds || 1.9 },
      ];
  const next = priced(updates, current);

  if (next.runners) {
    // Bets are tied to a selection by name: one with open bets can be repriced, not renamed or removed.
    const backed = await Bet.distinct('selection', { market: market._id, status: 'Pending' });
    const missing = backed.find((name) => !next.runners.some((r) => r.name === name));
    if (missing) throw ApiError.conflict(`"${missing}" has open bets — it can be repriced but not renamed or removed`);
  }
  if (next.status === 'Active' && market.winner) throw ApiError.conflict('This market is already settled');

  if (next.status) next.adminSuspended = next.status === 'Suspended';
  market.set(next);
  await market.save();
  return market;
};

const updateMarketStatus = async (id, status) => {
  const market = await Market.findById(id);
  if (!market) throw ApiError.notFound('Market not found');
  // A settled market's bets are paid out; reopening it would take bets on a known result.
  if (market.winner && status === 'Active') throw ApiError.conflict('This market is already settled');
  market.status = status;
  // Feed markets: an admin's choice holds until the admin changes it again.
  market.adminSuspended = status === 'Suspended';
  market.suspendedWithEvent = false;
  // Reopened: a fresh exposure warning can fire again.
  if (status === 'Active') market.exposureWarnedAt = null;
  await market.save();
  return market;
};

/** Suspends every Active market — on one event when `eventId` is given, else platform-wide. */
const suspendAll = async (eventId) => {
  const filter = { status: 'Active', ...(eventId ? { event: eventId } : {}) };
  const result = await Market.updateMany(filter, { $set: { status: 'Suspended', adminSuspended: true } });
  // eslint-disable-next-line global-require
  if (result.modifiedCount) require('../realtime').emitMatchesChanged();
  return { modifiedCount: result.modifiedCount };
};

module.exports = { listMarkets, createMarket, updateMarket, updateMarketStatus, suspendAll };
