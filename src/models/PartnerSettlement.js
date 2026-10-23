const mongoose = require('mongoose');

const { Schema } = mongoose;

/** A per-period settlement owed to (or paid to) a Partner. */
const partnerSettlementSchema = new Schema(
  {
    partner: { type: Schema.Types.ObjectId, ref: 'Partner', required: true, index: true },
    period: { type: String, required: true, trim: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['Pending', 'Paid'], default: 'Pending', index: true },
    paidAt: { type: Date, default: null },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

partnerSettlementSchema.index({ partner: 1, period: 1 }, { unique: true });

module.exports = mongoose.model('PartnerSettlement', partnerSettlementSchema);
