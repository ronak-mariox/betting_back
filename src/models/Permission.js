const mongoose = require('mongoose');
const { ROLE_KEYS } = require('../constants/permissions');

const { Schema } = mongoose;

/**
 * One document per editable role (superAgent / agent / franchise — the same
 * RoleKey union PermissionsPage.tsx uses). super-admin is never stored here:
 * it is always fully granted in code, never edited.
 *
 * `grants` maps "groupKey.permissionKey" (e.g. "finance.deposit") to a grant
 * code built from 'E' (enable) / 'V' (view) / 'X' (edit); '' means off.
 */
const permissionSchema = new Schema(
  {
    roleKey: {
      type: String,
      required: true,
      unique: true,
      enum: ROLE_KEYS,
    },
    grants: {
      type: Map,
      of: String,
      default: () => new Map(),
    },
    /** One-time default changes already applied to this role (see permission.service.js#applyDefaultUpgrades). */
    appliedUpgrades: { type: [String], default: [] },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Permission', permissionSchema);
