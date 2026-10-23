const Event = require('../models/Event');
const Market = require('../models/Market');
const Bet = require('../models/Bet');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');

const listEvents = async ({ status, sport }) => {
  const filter = {};
  if (status) filter.status = status;
  if (sport) filter.sport = sport;
  return Event.find(filter).sort({ startTime: 1 });
};

const getEvent = async (id) => {
  const event = await Event.findById(id);
  if (!event) throw ApiError.notFound('Event not found');
  const markets = await Market.find({ event: event._id }).sort({ createdAt: 1 });
  const recentBets = await Bet.find({ event: event._id })
    .populate('user', 'name username')
    .sort({ createdAt: -1 })
    .limit(20);
  // eslint-disable-next-line global-require
  const media = require('./diamondSync.service').mediaFor(event);
  return { event: { ...event.toJSON(), ...media }, markets, recentBets };
};

const createEvent = async ({ sport, league, name, emoji, startTime }) => {
  return Event.create({ sport, league, name, emoji, startTime });
};

const updateEventStatus = async ({ id, status }) => {
  const before = await Event.findById(id).select('status');
  // A finished match stays finished: reopening it would let players bet on a known result.
  if (['Completed', 'Settled'].includes(before?.status) && ['Live', 'Upcoming'].includes(status)) {
    throw ApiError.conflict(`This match is already ${before.status.toLowerCase()} and can't be reopened`);
  }
  // Feed events: the admin holds or releases betting; Live / Upcoming always comes from the feed.
  const current = await Event.findById(id).select('provider');
  if (current?.provider === 'diamond' && status !== 'Suspended' && !['Completed', 'Settled'].includes(status)) {
    await Event.updateOne({ _id: id }, { $set: { adminSuspended: false } });
    // eslint-disable-next-line global-require
    const diamondSync = require('./diamondSync.service');
    await diamondSync.syncNow().catch(() => null);
    return Event.findById(id);
  }
  // Feed events: an admin's suspension holds until the admin reopens it.
  const event = await Event.findByIdAndUpdate(id, { status, adminSuspended: status === 'Suspended' }, { new: true });
  if (!event) throw ApiError.notFound('Event not found');
  if (status === 'Live' && before?.status !== 'Live') await notificationService.notifyMatchLive(event);
  if (status === 'Suspended') {
    await Market.updateMany({ event: event._id, status: 'Active' }, { $set: { status: 'Suspended', suspendedWithEvent: true } });
  } else if (status === 'Completed' || status === 'Settled') {
    await Market.updateMany({ event: event._id, status: 'Active' }, { $set: { status: 'Suspended' } });
    await Market.updateMany({ event: event._id, suspendedWithEvent: true }, { $set: { suspendedWithEvent: false } });
  } else if (before?.status === 'Suspended') {
    // Reopened: bring back the markets the suspension closed (not ones suspended on their own or settled).
    await Market.updateMany(
      { event: event._id, status: 'Suspended', suspendedWithEvent: true, winner: '' },
      { $set: { status: 'Active', suspendedWithEvent: false } },
    );
  }
  return event;
};

/** The live score line players see on the match ("142/3 (16.2 Ov)", "2 - 1"); '' clears it. */
const updateEventScore = async ({ id, score }) => {
  const event = await Event.findByIdAndUpdate(id, { score: String(score || '').trim() }, { new: true });
  if (!event) throw ApiError.notFound('Event not found');
  return event;
};

module.exports = { listEvents, getEvent, createEvent, updateEventStatus, updateEventScore };
