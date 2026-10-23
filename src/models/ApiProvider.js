const mongoose = require('mongoose');

const { Schema } = mongoose;

/** Connection status for an odds-feed provider. The Diamond row is kept by diamondSync.service (real latency / uptime / markets). */
const apiProviderSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    latency: { type: Number, default: 0 },
    marketsCount: { type: Number, default: 0 },
    uptime: { type: Number, default: 100 },
    status: { type: String, enum: ['Connected', 'Disconnected', 'Syncing'], default: 'Connected' },
    healthy: { type: Boolean, default: true },
    lastSyncAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('ApiProvider', apiProviderSchema);
