const mongoose = require('mongoose');

const { Schema } = mongoose;

/** Risk panel: a detected suspicious betting/wallet pattern, possibly involving several users. */
const suspiciousPatternSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    relatedUsers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    severity: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Medium', index: true },
    detectedAt: { type: Date, default: Date.now },
    resolved: { type: Boolean, default: false, index: true },
    /** Identifies what was detected (e.g. "shared-ip:1.2.3.4"), so a re-scan updates instead of duplicating. */
    key: { type: String, default: '', index: true },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('SuspiciousPattern', suspiciousPatternSchema);
