const mongoose = require('mongoose');
const { COMMISSION_KINDS, COMMISSION_LEVELS, COMMISSION_STATUSES } = require('../constants/admin');

const { Schema } = mongoose;

/**
 * Commission one account earned. Rows written at a match's end (see
 * commission.service.js) carry the match, the player whose bets produced it
 * and the kind (Session / Match); they are paid on creation, so they are
 * always Settled.
 */
const commissionSchema = new Schema(
  {
    entity: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    level: { type: String, enum: COMMISSION_LEVELS, required: true },
    /** Month the row belongs to, e.g. "2026-10". */
    period: { type: String, required: true, trim: true },
    event: { type: Schema.Types.ObjectId, ref: 'Event', default: null, index: true },
    /** The player whose bets earned it. */
    player: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    kind: { type: String, enum: COMMISSION_KINDS, default: null },
    /** What the rate applies to: the session stake or the player's match net loss. */
    turnover: { type: Number, default: 0 },
    /** Percent this account keeps, e.g. 0.5 = 0.5%. */
    rate: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },
    status: { type: String, enum: COMMISSION_STATUSES, default: 'Pending', index: true },
    settledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

commissionSchema.index({ entity: 1, period: 1, status: 1 });
// One payout per account, player, match and kind — a second run of the same match writes nothing.
commissionSchema.index(
  { event: 1, player: 1, entity: 1, kind: 1 },
  { unique: true, partialFilterExpression: { event: { $type: 'objectId' } } },
);

module.exports = mongoose.model('Commission', commissionSchema);
