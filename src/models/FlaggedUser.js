const mongoose = require('mongoose');

const { Schema } = mongoose;

/** Risk panel: a user flagged for manual review. */
const flaggedUserSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    reason: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true, index: true },
    /** Detection rule that raised it (risk-detection.service.js), so a re-scan updates instead of duplicating. */
    rule: { type: String, default: '' },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('FlaggedUser', flaggedUserSchema);
