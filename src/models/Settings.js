const mongoose = require('mongoose');
const { maskKey } = require('../utils/mask');

const { Schema } = mongoose;

/** Singleton platform configuration document — always read/written via the fixed id "main" (see settings.service.js). */
const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'main' },
    general: { type: Schema.Types.Mixed, default: {} },
    walletRules: { type: Schema.Types.Mixed, default: {} },
    bettingLimits: { type: Schema.Types.Mixed, default: {} },
    exposureLimits: { type: Schema.Types.Mixed, default: {} },
    commissionRates: { type: Schema.Types.Mixed, default: {} },
    smtp: { type: Schema.Types.Mixed, default: {} },
    sms: { type: Schema.Types.Mixed, default: {} },
    brand: { type: Schema.Types.Mixed, default: {} },
    apiKeys: {
      type: [
        {
          name: { type: String, required: true },
          status: { type: String, default: 'Active' },
          latency: { type: Number, default: 0 },
          key: { type: String, default: '' },
        },
      ],
      default: [],
    },
    cms: {
      marqueeText: { type: String, default: '' },
    },
  },
  { timestamps: true },
);

settingsSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    // Secrets go out masked; the settings form sends the mask back to mean "keep it".
    if (ret.smtp?.pass) ret.smtp = { ...ret.smtp, pass: maskKey(ret.smtp.pass) };
    if (ret.sms?.apiKey) ret.sms = { ...ret.sms, apiKey: maskKey(ret.sms.apiKey) };
    if (Array.isArray(ret.apiKeys)) {
      ret.apiKeys = ret.apiKeys.map((entry) => ({ ...entry, key: maskKey(entry.key) }));
    }
    return ret;
  },
});

module.exports = mongoose.model('Settings', settingsSchema);
