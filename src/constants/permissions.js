/**
 * Default permission matrix — mirrors bettingWeb/src/features/permissions/permissionsData.ts
 * exactly (same groups, same seed grants) so the Permissions screen can be
 * pointed at this API without changing its shape.
 *
 * A grant is a compact code built from 'E' (enable), 'V' (view), 'X' (edit).
 * '' means the permission is off. super-admin is intentionally absent: it is
 * always fully granted and is never stored or editable.
 */
const ROLE_KEYS = ['superAgent', 'agent', 'franchise'];

/** Maps a permission-matrix role key to the staff role stored on User. */
const ROLE_KEY_TO_ROLE = {
  superAgent: 'super-agent',
  agent: 'agent',
  franchise: 'franchise',
};
const ROLE_TO_ROLE_KEY = {
  'super-agent': 'superAgent',
  agent: 'agent',
  franchise: 'franchise',
};

const PERMISSION_GROUPS = [
  {
    key: 'finance',
    name: 'Finance & Wallet',
    permissions: [
      { key: 'walletBalance', name: 'Wallet Balance', description: 'View & manage wallet balance', grants: { superAgent: 'EVX', agent: 'EV', franchise: 'EV' } },
      { key: 'deposit', name: 'Deposit', description: 'Initiate deposit requests', grants: { superAgent: 'EVX', agent: 'EVX', franchise: '' } },
      { key: 'withdrawal', name: 'Withdrawal', description: 'Initiate withdrawal requests', grants: { superAgent: 'EVX', agent: 'EVX', franchise: '' } },
      { key: 'fundTransfer', name: 'Fund Transfer', description: 'Transfer funds to sub-accounts', grants: { superAgent: 'EVX', agent: '', franchise: '' } },
      { key: 'commission', name: 'Commission', description: 'View commission earnings', grants: { superAgent: 'EV', agent: '', franchise: 'EV' } },
    ],
  },
  {
    key: 'userManagement',
    name: 'User Management',
    permissions: [
      { key: 'userList', name: 'User List', description: 'View list of all users', grants: { superAgent: 'EV', agent: 'EV', franchise: 'EV' } },
      { key: 'createUser', name: 'Create User', description: 'Add new users to the platform', grants: { superAgent: 'EVX', agent: 'EVX', franchise: '' } },
      { key: 'editUser', name: 'Edit User', description: 'Modify user profile & details', grants: { superAgent: 'EVX', agent: '', franchise: '' } },
      { key: 'suspendUser', name: 'Suspend User', description: 'Suspend or activate user accounts', grants: { superAgent: '', agent: '', franchise: '' } },    ],
  },
  {
    key: 'bettingMarkets',
    name: 'Betting & Markets',
    permissions: [
      { key: 'viewBets', name: 'View Bets', description: 'View betting history & records', grants: { superAgent: 'EV', agent: 'EV', franchise: 'EV' } },
      { key: 'markets', name: 'Markets', description: 'View active markets & odds', grants: { superAgent: 'EV', agent: 'EV', franchise: 'EV' } },
      { key: 'events', name: 'Events', description: 'View upcoming & live events', grants: { superAgent: 'EV', agent: 'EV', franchise: '' } },
      { key: 'voidBet', name: 'Void Bet', description: 'Cancel or void placed bets', grants: { superAgent: '', agent: '', franchise: '' } },
    ],
  },
  {
    key: 'reportsAnalytics',
    name: 'Reports & Analytics',
    permissions: [
      { key: 'reports', name: 'Reports', description: 'View financial & activity reports', grants: { superAgent: 'EV', agent: 'EV', franchise: 'EV' } },
      { key: 'analytics', name: 'Analytics', description: 'View analytics dashboard', grants: { superAgent: 'EV', agent: 'EV', franchise: '' } },
      { key: 'exportData', name: 'Export Data', description: 'Export reports as CSV / PDF', grants: { superAgent: 'EVX', agent: '', franchise: '' } },
    ],
  },
  {
    key: 'accountSettings',
    name: 'Account & Settings',
    permissions: [
      { key: 'editProfile', name: 'Edit Profile', description: 'Update own profile details', grants: { superAgent: 'EVX', agent: 'EVX', franchise: 'EVX' } },
      { key: 'changePassword', name: 'Change Password', description: 'Change account password', grants: { superAgent: 'EVX', agent: 'EVX', franchise: 'EVX' } },
      { key: 'manageSubAgents', name: 'Manage Sub-Agents', description: 'Create & manage sub-agents', grants: { superAgent: 'EVX', agent: '', franchise: '' } },
      { key: 'commissionSettings', name: 'Commission Settings', description: 'Configure commission rates', grants: { superAgent: 'EV', agent: '', franchise: '' } },
    ],
  },
  {
    key: 'support',
    name: 'Support',
    permissions: [
      { key: 'contactSupport', name: 'Contact Support', description: 'Access support channels', grants: { superAgent: 'EV', agent: 'EV', franchise: 'EV' } },
      { key: 'raiseTicket', name: 'Raise Ticket', description: 'Submit support tickets', grants: { superAgent: 'EVX', agent: 'EVX', franchise: '' } },
      { key: 'viewTickets', name: 'View Tickets', description: 'View own ticket history', grants: { superAgent: 'EV', agent: '', franchise: '' } },
    ],
  },
];

/**
 * Builds the flat key used both as the Mongoose Map key in Permission.grants
 * and inside a Mongo $set dot-path (`grants.<flatKey>`). Mongoose Maps
 * reject "." in keys (it collides with dot-notation), so ":" is used
 * instead — e.g. "finance:deposit".
 */
const flatKey = (groupKey, permissionKey) => `${groupKey}:${permissionKey}`;

/** Flat lookup: 'finance:deposit' -> { group, permission } definition. */
const PERMISSION_INDEX = new Map();
PERMISSION_GROUPS.forEach((group) => {
  group.permissions.forEach((permission) => {
    PERMISSION_INDEX.set(flatKey(group.key, permission.key), { group, permission });
  });
});

module.exports = {
  ROLE_KEYS,
  ROLE_KEY_TO_ROLE,
  ROLE_TO_ROLE_KEY,
  PERMISSION_GROUPS,
  PERMISSION_INDEX,
  flatKey,
};
