const mongoose = require('mongoose');
const { makeAppendOnly } = require('../utils/immutable');

const { Schema } = mongoose;

/**
 * One wallet-to-wallet transfer attempt (staff → own downline), kept even
 * when it fails or is cancelled. A Completed transfer also has its two
 * ledger rows in Transaction (same `reference`).
 */
const fundTransferSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    from: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    amount: { type: Number, required: true },
    note: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['Pending', 'Completed', 'Failed', 'Cancelled'], default: 'Pending', index: true },
    failureReason: { type: String, default: '' },
    /** Sent by the panel per transfer form; the same key never moves money twice. */
    idempotencyKey: { type: String, default: null },
    /** Sender's balance after the debit (Completed only). */
    balanceAfter: { type: Number, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

fundTransferSchema.index({ createdAt: -1 });
fundTransferSchema.index(
  { from: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

// Only the outcome of a Pending attempt may be filled in afterwards.
makeAppendOnly(fundTransferSchema, 'Fund transfer', { allow: ['status', 'failureReason', 'balanceAfter', 'completedAt'] });

module.exports = mongoose.model('FundTransfer', fundTransferSchema);
