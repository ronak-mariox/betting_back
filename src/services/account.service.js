const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { hashPassword } = require('./password.service');
const Partner = require('../models/Partner');
const { ROLE_ORDER, CHILD_ROLE, CAN_CREATE_ANY_LEVEL, roleIndex } = require('../constants/roles');

/** The role that must sit directly above a given role in the hierarchy. */
const IMMEDIATE_PARENT_ROLE = {
  franchise: 'super-admin',
  'super-agent': 'franchise',
  agent: 'super-agent',
  player: 'agent',
};

/**
 * Can `creatorRole` create an account of `targetRole` at all? Any role may
 * create roles below itself; accounts more than one level down must be
 * parented under someone in the creator's own downline (see resolveParent).
 */
function assertCanCreateRole(creatorRole, targetRole) {
  if (targetRole === 'super-admin') {
    throw ApiError.forbidden('super-admin accounts cannot be created through the API');
  }
  if (CAN_CREATE_ANY_LEVEL.has(creatorRole)) return;
  if (roleIndex(targetRole) <= roleIndex(creatorRole)) {
    throw ApiError.forbidden(`A ${creatorRole} account cannot create a ${targetRole} account`);
  }
}

/**
 * Resolves and validates the parent for a new account.
 *   - A direct child (franchise under super-admin, super-agent under
 *     franchise, …) defaults to the creator as parent.
 *   - Deeper accounts need an explicit parentId of the role directly above
 *     the new one; for anyone but super-admin that parent must also sit in
 *     the creator's own downline.
 *   - Players may be left unassigned by super-admin only.
 */
async function resolveParent({ creator, targetRole, parentId }) {
  const isDirectCreation = CHILD_ROLE[creator.role] === targetRole;

  if (isDirectCreation && (!parentId || String(parentId) === String(creator._id))) {
    return creator;
  }

  if (targetRole === 'franchise') {
    return creator;
  }

  if (targetRole === 'player' && !parentId && CAN_CREATE_ANY_LEVEL.has(creator.role)) {
    return null;
  }

  if (!parentId) {
    throw ApiError.badRequest(`Choose a ${IMMEDIATE_PARENT_ROLE[targetRole]} to create this ${targetRole} under`);
  }

  const requiredParentRole = IMMEDIATE_PARENT_ROLE[targetRole];
  const parent = await User.findById(parentId);
  if (!parent) throw ApiError.badRequest('parentId does not reference an existing account');
  if (parent.role !== requiredParentRole) {
    throw ApiError.badRequest(`parentId must reference a ${requiredParentRole} account`);
  }
  if (!CAN_CREATE_ANY_LEVEL.has(creator.role) && !(await isWithinSubtree(creator._id, parent._id))) {
    throw ApiError.forbidden('You can only create accounts inside your own downline');
  }
  return parent;
}

/**
 * True when `ancestorId` is `candidateId` itself or one of its ancestors —
 * used to confirm an actor is only ever reading/mutating their own downline.
 */
async function isWithinSubtree(ancestorId, candidateId) {
  if (String(ancestorId) === String(candidateId)) return true;
  let current = await User.findById(candidateId).select('parent');
  const guard = new Set();
  while (current && current.parent) {
    const parentId = String(current.parent);
    if (guard.has(parentId)) return false; // corrupt cycle guard
    guard.add(parentId);
    if (parentId === String(ancestorId)) return true;
    current = await User.findById(parentId).select('parent');
  }
  return false;
}

/** BFS down the parent pointers from `rootId`, returning every descendant's id (not including root). */
async function getSubtreeIds(rootId) {
  const ids = [];
  let frontier = [rootId];
  while (frontier.length > 0) {
    // eslint-disable-next-line no-await-in-loop
    const children = await User.find({ parent: { $in: frontier } }).select('_id');
    if (children.length === 0) break;
    frontier = children.map((child) => child._id);
    ids.push(...frontier);
  }
  return ids;
}

const UNIQUE_RETRY_LIMIT = 5;

const PROFILE_FIELDS = ['name', 'email', 'phone', 'city', 'state', 'dob'];
const STAFF_FIELDS = ['businessName', 'bettingLimit', 'maxExposure', 'shareHolding'];
/** Staff terms only the Commission Settings grant may set. */
const GRANTED_FIELDS = ['shareHolding'];
/**
 * Session / match commission an account receives (see commission.service.js).
 * Its direct upline sets them for players and staff alike, never above the
 * upline's own rate.
 */
const COMMISSION_FIELDS = ['matchCommission', 'sessionCommission'];
const COMMISSION_LABEL = { matchCommission: 'Match', sessionCommission: 'Session' };

/** Copies only the editable profile, commission (and, for staff, business) fields present in `payload`. */
function pickProfile(payload, role) {
  const fields = [...PROFILE_FIELDS, ...COMMISSION_FIELDS, ...(role === 'player' ? [] : STAFF_FIELDS)];
  const out = {};
  for (const field of fields) {
    if (payload[field] !== undefined) out[field] = payload[field] === '' && field === 'dob' ? null : payload[field];
  }
  return out;
}

/**
 * An account can be given at most the commission its upline receives.
 * Super-admin is the top: what it gives a franchise is the whole rate.
 */
function assertCommissionWithin(parent, changes) {
  for (const field of COMMISSION_FIELDS) {
    if (changes[field] === undefined) continue; // eslint-disable-line no-continue
    const value = Number(changes[field]) || 0;
    changes[field] = value;
    if (!parent || parent.role === 'super-admin') continue; // eslint-disable-line no-continue
    const max = Number(parent[field]) || 0;
    if (value > max) {
      throw ApiError.badRequest(
        `${COMMISSION_LABEL[field]} commission ${value}% se zyada nahi ho sakta — upline (${parent.username}) ko ${max}% milta hai`,
      );
    }
  }
}

/** Player-only shareable code, e.g. "RAHUL2318" — derived from the username. */
async function generateReferralCode(username) {
  const base = username.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() || 'PLAYER';
  for (let attempt = 0; attempt < UNIQUE_RETRY_LIMIT; attempt += 1) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const candidate = `${base}${suffix}`;
    // eslint-disable-next-line no-await-in-loop
    // Partner codes share the sign-up field, so they're off-limits too.
    const exists = (await User.exists({ referralCode: candidate })) || (await Partner.exists({ referralCode: candidate }));
    if (!exists) return candidate;
  }
  throw new Error('Could not generate a unique referral code, please retry');
}

/**
 * A random active agent — where a self-registered player lands when no agent
 * referral code decides it. Returns null when no active agent exists yet.
 */
async function pickAvailableAgent() {
  const [agent] = await User.aggregate([
    { $match: { role: 'agent', status: 'active' } },
    { $sample: { size: 1 } },
    { $project: { _id: 1 } },
  ]);
  return agent ? agent._id : null;
}

/**
 * Self-registration from the bettingApp SignUpScreen: username + password
 * (+ optional referral code). Every new player is placed under an agent:
 *   - an active agent's referral code puts the player under that agent;
 *   - a player's referral code records the referrer and puts the new player
 *     under the referrer's agent (if that agent is active);
 *   - an active partner's code links the player to that partner (for its
 *     volume and revenue share) and places them like no code would;
 *   - otherwise (no code, unknown code, inactive agent) the player goes to a
 *     random active agent. Unassigned only when no active agent exists.
 */
async function registerPlayer({ username, password, referralCode }) {
  const normalizedUsername = username.trim().toLowerCase();

  const existing = await User.findOne({ username: normalizedUsername });
  if (existing) throw ApiError.conflict('Username is already taken');

  let referredBy = null;
  let parent = null;
  /** A partner (affiliate) code: the player joins through that partner and lands with a random agent. */
  let partner = null;
  const code = referralCode?.trim().toUpperCase();
  if (code) {
    // An unrecognized code is ignored rather than blocking sign-up — the
    // screen treats the field as optional and never validates it up front.
    const owner = await User.findOne({ referralCode: code, role: { $in: ['agent', 'player'] } });
    // eslint-disable-next-line global-require
    if (!owner) partner = (await require('./partnership.service').findActiveByCode(code))?._id ?? null;
    if (owner?.role === 'agent' && owner.status === 'active') {
      parent = owner._id;
    } else if (owner?.role === 'player') {
      referredBy = owner._id;
      if (owner.parent) {
        const agent = await User.findOne({ _id: owner.parent, role: 'agent', status: 'active' }, '_id');
        if (agent) parent = agent._id;
      }
    }
  }
  if (!parent) parent = await pickAvailableAgent();

  const passwordHash = await hashPassword(password);
  const ownReferralCode = await generateReferralCode(normalizedUsername);

  return User.create({
    username: normalizedUsername,
    passwordHash,
    role: 'player',
    parent,
    createdBy: null,
    referralCode: ownReferralCode,
    referredBy,
    partner,
  });
}

/** Gives every agent without one a shareable referral code (run at boot). */
async function ensureAgentReferralCodes() {
  const agents = await User.find({ role: 'agent', $or: [{ referralCode: null }, { referralCode: { $exists: false } }] });
  for (const agent of agents) {
    // eslint-disable-next-line no-await-in-loop
    agent.referralCode = await generateReferralCode(agent.username);
    // eslint-disable-next-line no-await-in-loop
    await agent.save();
  }
}

/**
 * Staff/player provisioning from a panel (Add User / Create Agent / Create
 * Super Agent / Create Franchise modals). `creator` is the authenticated
 * actor; hierarchy + role rules are enforced before anything is written.
 */
async function createManagedAccount(creator, payload, { canSetCommission = true } = {}) {
  const { role, username, password, parentId, ...profile } = payload;
  if (!canSetCommission) for (const field of GRANTED_FIELDS) delete profile[field];

  if (!ROLE_ORDER.includes(role)) throw ApiError.badRequest('Unknown role');
  assertCanCreateRole(creator.role, role);

  const parent = await resolveParent({ creator, targetRole: role, parentId });
  assertCommissionWithin(parent, profile);

  const normalizedUsername = username.trim().toLowerCase();
  const existing = await User.findOne({ username: normalizedUsername });
  if (existing) throw ApiError.conflict('Username is already taken');

  const passwordHash = await hashPassword(password);

  const doc = {
    username: normalizedUsername,
    passwordHash,
    role,
    parent: parent ? parent._id : null,
    createdBy: creator._id,
    ...pickProfile(profile, role),
  };

  // Players share codes with friends; agents share them to bring players onto their panel.
  if (role === 'player' || role === 'agent') {
    doc.referralCode = await generateReferralCode(normalizedUsername);
  }

  return User.create(doc);
}

/**
 * Edits another account's profile/business fields. Caller has already passed
 * requireOwnSubtree; this enforces who may edit what:
 *   - players: the live userManagement.editUser grant;
 *   - staff below the actor: the accountSettings.manageSubAgents grant
 *     (super-admin always). Share holding changes only with
 *     accountSettings.commissionSettings X;
 *   - session / match commission: also the direct upline, which passes it
 *     down, within its own rate.
 * Nobody edits their own account here — that's PATCH /auth/me.
 */
async function updateManagedAccount(actor, account, payload, { canEditPlayers, canManageStaff = false, canSetCommission = false }) {
  if (String(actor._id) === String(account._id)) {
    throw ApiError.badRequest('Use your profile page to edit your own account');
  }
  if (account.role === 'super-admin') throw ApiError.forbidden('super-admin accounts cannot be edited here');
  const isAdmin = actor.role === 'super-admin';
  const canEdit = account.role === 'player' ? canEditPlayers : isAdmin || canManageStaff;
  const isDirectUpline = String(account.parent) === String(actor._id);
  if (!canEdit && !isDirectUpline) {
    throw ApiError.forbidden(
      account.role === 'player'
        ? 'You do not have permission to edit users'
        : 'You do not have permission to manage this account',
    );
  }

  let changes = pickProfile(payload, account.role);
  // Without the edit grant the direct upline may still set the commission it passes down.
  if (!canEdit) changes = Object.fromEntries(Object.entries(changes).filter(([field]) => COMMISSION_FIELDS.includes(field)));
  if (account.role !== 'player' && !isAdmin && !canSetCommission) {
    for (const field of GRANTED_FIELDS) delete changes[field];
  }
  if (COMMISSION_FIELDS.some((field) => changes[field] !== undefined)) {
    const parent = account.parent ? await User.findById(account.parent).select('role username matchCommission sessionCommission') : null;
    assertCommissionWithin(parent, changes);
  }
  Object.assign(account, changes);
  await account.save();
  return account;
}

module.exports = {
  updateManagedAccount,
  PROFILE_FIELDS,
  STAFF_FIELDS,
  COMMISSION_FIELDS,
  IMMEDIATE_PARENT_ROLE,
  assertCanCreateRole,
  resolveParent,
  isWithinSubtree,
  getSubtreeIds,
  generateReferralCode,
  registerPlayer,
  pickAvailableAgent,
  ensureAgentReferralCodes,
  createManagedAccount,
};
