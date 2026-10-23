const mongoose = require('mongoose');
const { ROLE_ORDER } = require('../constants/roles');

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 4,
      maxlength: 32,
      match: /^[a-z0-9_]+$/,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      required: true,
      enum: ROLE_ORDER,
      index: true,
    },
    /** Direct parent in the staff hierarchy (or the agent for a player, if assigned). Null for the root super-admin and for un-assigned players. */
    parent: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    /** Who provisioned this account. Null for self-registered players and the seeded root super-admin. */
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    name: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    dob: { type: Date, default: null },
    /**
     * Profile photo as a data URI ("data:image/jpeg;base64,..."), picked
     * client-side and resized/compressed before upload. The 2MB cap here is
     * on the base64 text itself (~1.5MB of actual image data), generous
     * headroom over the ~150-300KB a resized photo typically produces.
     */
    avatar: { type: String, default: '', maxlength: 2_000_000 },
    /** Players and agents: this account's own referral code. A player's earns the sign-up bonus; an agent's places new players on its panel. */
    referralCode: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true,
    },
    /** Player-only: the partner (affiliate) whose code was used at sign-up; drives the partner's volume and revenue share. */
    partner: {
      type: Schema.Types.ObjectId,
      ref: 'Partner',
      default: null,
      index: true,
    },
    /** Player-only: the account whose referral code was used at sign-up, if any. */
    referredBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      index: true,
    },
    lastLoginAt: { type: Date, default: null },
    /** Bumped whenever the password changes, so tokens issued earlier stop verifying. */
    passwordChangedAt: { type: Date, default: null },
    /** Panel notification/display toggles from Profile → Preferences, keyed by setting label. */
    preferences: { type: Map, of: Boolean, default: {} },
    /** Live cash balance, in rupees. Moved only via wallet.service.js (requests, manual entries, transfers). */
    walletBalance: { type: Number, default: 0 },

    /** Staff-only: trading name shown in the panel, e.g. "Mumbai Franchise" (the person's own name stays in `name`). */
    businessName: { type: String, trim: true, default: '' },
    /** Staff-only: max single-bet stake allowed across this account's book, in rupees (0 = platform default). */
    bettingLimit: { type: Number, min: 0, default: 0 },
    /** Staff-only: max open exposure allowed across this account's book, in rupees (0 = platform default). */
    maxExposure: { type: Number, min: 0, default: 0 },
    /** Staff-only share (percent), as captured by the Create Franchise form. */
    shareHolding: { type: Number, min: 0, max: 100, default: null },
    /**
     * Commission rates this account receives from its upline, in percent (see
     * commission.service.js). Set by the upline, never above the upline's own
     * rate; the account keeps what it doesn't pass on to its own downline.
     */
    matchCommission: { type: Number, min: 0, max: 100, default: 0 },
    sessionCommission: { type: Number, min: 0, max: 100, default: 0 },
  },
  { timestamps: true },
);

userSchema.index({ parent: 1, role: 1 });

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    delete ret.__v;
    // Left on older records by removed features (KYC, the old monthly commission); never sent out.
    delete ret.kyc;
    delete ret.commissionRate;
    delete ret.commissionType;
    delete ret.settlementCycle;
    delete ret.myMatchCommission;
    delete ret.mySessionCommission;
    ret.matchCommission = ret.matchCommission ?? 0;
    ret.sessionCommission = ret.sessionCommission ?? 0;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
