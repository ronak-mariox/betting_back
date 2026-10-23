const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * A minimal security audit trail for auth/authorization events only — the
 * kind of rows the web panel's Security > Logs/Audit tabs render (login,
 * login failures, account provisioning, suspensions, permission edits).
 * Reviews (deposit / withdrawal requests) are logged too, so both the
 * reviewer's and the user's activity show who decided what. Bets and ledger
 * rows belong to their own modules.
 */
const auditLogSchema = new Schema(
  {
    actor: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    actorUsername: { type: String, default: '' },
    action: {
      type: String,
      required: true,
      enum: [
        'login_success',
        'login_failed',
        'logout',
        'register',
        'profile_updated',
        'password_changed',
        'password_reset_requested',
        'password_reset',
        'bet_voided',
        'account_created',
        'account_updated',
        'account_suspended',
        'account_activated',
        'permission_updated',
        'session_revoked',
        // Reviews staff make on their users — shown in the reviewer's and the user's activity.
        'deposit_approved',
        'deposit_rejected',
        'withdrawal_approved',
        'withdrawal_rejected',
      ],
    },
    target: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: { type: String, enum: ['success', 'failed'], default: 'success' },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    metadata: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
