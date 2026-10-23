const mongoose = require('mongoose');
const { WALLET_REQUEST_KINDS, WALLET_REQUEST_STATUSES } = require('../constants/admin');

const { Schema } = mongoose;

/**
 * The payment screenshot a player attaches to a deposit, kept as a data URI.
 * `data` is large, so it is left out of every query unless asked for
 * (`.select('+proof.data')`); `name` / `size` are enough to know it's there.
 */
const proofSchema = new Schema(
  {
    name: { type: String, trim: true, default: '' },
    mime: { type: String, trim: true, default: '' },
    size: { type: Number, default: 0 },
    data: { type: String, required: true, select: false },
  },
  { _id: false },
);

/** Pending deposit/withdrawal queue reviewed by an admin; approval writes a Transaction and moves User.walletBalance. */
const walletRequestSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: WALLET_REQUEST_KINDS, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, trim: true, default: '' },
    reference: { type: String, trim: true, default: '' },
    /** Deposits only: the screenshot of the payment, for whoever reviews the request. */
    proof: { type: proofSchema, default: null },
    status: { type: String, enum: WALLET_REQUEST_STATUSES, default: 'Pending', index: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    /** Why it was rejected — shown to the player in the app. */
    rejectionReason: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

walletRequestSchema.index({ createdAt: -1 });

/** Live updates: the owner's app and open panel pages refresh when wallet requests change (see realtime.js). */
function announce(doc) {
  if (!doc) return;
  // eslint-disable-next-line global-require
  const realtime = require('../realtime');
  realtime.emitPlayerChanged(doc.user);
  realtime.emitStaffChanged('wallet');
}
walletRequestSchema.post('save', announce);
walletRequestSchema.post('findOneAndUpdate', announce);
walletRequestSchema.post('insertMany', (docs) => [].concat(docs).forEach(announce));

module.exports = mongoose.model('WalletRequest', walletRequestSchema);
