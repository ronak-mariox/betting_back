const mongoose = require('mongoose');
const { PARTNER_STATUSES } = require('../constants/admin');
const { maskKey } = require('../utils/mask');

const { Schema } = mongoose;

/** A partnership (affiliate/white-label/data) record. */
const partnerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, trim: true, default: '' },
    /** Percent of revenue shared with this partner, e.g. 20 = 20%. */
    revShare: { type: Number, default: 0 },
    monthlyFee: { type: Number, default: 0 },
    /** Stake (excluding voided bets) placed by this partner's players, all time. Kept by partnership.service#recompute. */
    betVolume: { type: Number, default: 0 },
    /** Players who signed up with this partner's code. Kept by partnership.service#recompute. */
    playerCount: { type: Number, default: 0 },
    /** Sign-up code a player enters to join through this partner (unique across partner and user codes). */
    referralCode: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    status: { type: String, enum: PARTNER_STATUSES, default: 'Active', index: true },
    since: { type: Date, default: Date.now },
    contact: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    website: { type: String, trim: true, default: '' },
    apiKey: { type: String, default: '' },
    notes: { type: String, default: '' },
    /** The partner's share per month ("YYYY-MM"): revShare% of the house's net betting win from its players. */
    revenueHistory: [{ month: { type: String, required: true }, value: { type: Number, required: true } }],
  },
  { timestamps: true },
);

partnerSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    if (ret.apiKey) ret.apiKey = maskKey(ret.apiKey);
    return ret;
  },
});

module.exports = mongoose.model('Partner', partnerSchema);
