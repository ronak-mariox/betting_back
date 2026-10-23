const mongoose = require('mongoose');
const { EVENT_STATUSES } = require('../constants/admin');

const { Schema } = mongoose;

/** A sporting fixture — unifies what the Betting board calls a "Match" and the Events page calls a "SportEvent". */
const eventSchema = new Schema(
  {
    sport: { type: String, required: true, trim: true, index: true },
    league: { type: String, trim: true, default: '' },
    name: { type: String, required: true, trim: true },
    emoji: { type: String, default: '🏆' },
    score: { type: String, trim: true, default: '' },
    startTime: { type: Date, required: true, index: true },
    status: { type: String, enum: EVENT_STATUSES, default: 'Upcoming', index: true },
    /** Cached rollups from this event's markets/bets, refreshed on bet placement/settlement. */
    stake: { type: Number, default: 0 },
    exposure: { type: Number, default: 0 },
    /** When open stake first crossed Settings → Exposure → Warning Threshold (one alert per crossing). */
    exposureWarnedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Where the fixture comes from: 'manual' (created in the panel) or 'diamond' (odds feed). */
    provider: { type: String, default: 'manual', index: true },
    /** The provider's match id (Diamond `gmid`); null for manual events. */
    externalId: { type: String, default: null },
    /** Provider says a video stream exists for this match. */
    hasStream: { type: Boolean, default: false },
    /** Set when an admin suspends the event, so the feed sync doesn't reopen it. */
    adminSuspended: { type: Boolean, default: false },
    /** Last time the feed listed this match. */
    syncedAt: { type: Date, default: null },
    /** Set while a not-yet-finished match is missing from the feed (held Suspended, prices not polled). */
    feedMissingSince: { type: Date, default: null },
    /** When session + match commission was paid out for this match (commission.service.js). */
    commissionSettledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

eventSchema.index(
  { provider: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } },
);

/** Live updates: an admin suspending / resuming a match reaches the apps at once (see realtime.js). */
function announceList() {
  // eslint-disable-next-line global-require
  require('../realtime').emitMatchesChanged();
}
eventSchema.post('findOneAndUpdate', announceList);

module.exports = mongoose.model('Event', eventSchema);
