const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const accountService = require('../services/account.service');
const permissionService = require('../services/permission.service');
const auditService = require('../services/audit.service');
const { ROLE_TO_ROLE_KEY } = require('../constants/permissions');
/**
 * Creating a 'player' needs the live "Create User" permission
 * (userManagement.createUser); creating a staff tier below you (franchise /
 * super-agent / agent) needs "Manage Sub-Agents" (accountSettings.manageSubAgents),
 * on top of the role hierarchy. Editing or suspending them needs the same.
 */
const assertCanCreatePlayer = async (creator) => {
  const allowed = await permissionService.hasPermission(creator.role, 'userManagement', 'createUser', 'X');
  if (!allowed) throw ApiError.forbidden('You do not have permission to create users');
};

const create = asyncHandler(async (req, res) => {
  const { role } = req.body;

  const payload = { ...req.body };
  if (role === 'player') {
    await assertCanCreatePlayer(req.user);
  }
  if (role !== 'player') {
    const canManage = await permissionService.hasPermission(req.user.role, 'accountSettings', 'manageSubAgents', 'X');
    if (!canManage) throw ApiError.forbidden('You do not have permission to create sub-agents');
  }
  // The role hierarchy itself is checked in createManagedAccount.

  const canSetCommission = await permissionService.hasPermission(req.user.role, 'accountSettings', 'commissionSettings', 'X');
  const account = await accountService.createManagedAccount(req.user, payload, { canSetCommission });

  await auditService.record({
    actor: req.user,
    action: 'account_created',
    target: account,
    req,
    metadata: { role: account.role },
  });

  res.status(201).json({ account });
});

const list = asyncHandler(async (req, res) => {
  const { role, status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 25);

  const query = {};
  if (req.user.role !== 'super-admin') {
    const subtreeIds = await accountService.getSubtreeIds(req.user._id);
    query._id = { $in: subtreeIds };
  }
  if (role) query.role = role;
  if (status) query.status = status;

  const [items, total] = await Promise.all([
    User.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(query),
  ]);

  res.json({ items, total, page, limit });
});

const getOne = asyncHandler(async (req, res) => {
  const account = await User.findById(req.params.id);
  if (!account) throw ApiError.notFound('Account not found');
  res.json({ account });
});

const updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const account = await User.findById(req.params.id);
  if (!account) throw ApiError.notFound('Account not found');

  if (account.role === 'player') {
    const allowed = await permissionService.hasPermission(req.user.role, 'userManagement', 'suspendUser', 'X');
    if (!allowed) throw ApiError.forbidden('You do not have permission to change this account\'s status');
  } else {
    // Staff accounts: super-admin, or an upline holding "Manage Sub-Agents".
    const canManage = await permissionService.hasPermission(req.user.role, 'accountSettings', 'manageSubAgents', 'X');
    if (!canManage || String(account._id) === String(req.user._id)) {
      throw ApiError.forbidden('You do not have permission to change this account\'s status');
    }
  }

  account.status = status;
  await account.save();

  await auditService.record({
    actor: req.user,
    action: status === 'suspended' ? 'account_suspended' : 'account_activated',
    target: account,
    req,
  });

  res.json({ account });
});

const update = asyncHandler(async (req, res) => {
  const account = await User.findById(req.params.id);
  if (!account) throw ApiError.notFound('Account not found');

  const canEditPlayers = await permissionService.hasPermission(req.user.role, 'userManagement', 'editUser', 'X');
  const [canManageStaff, canSetCommission] = await Promise.all([
    permissionService.hasPermission(req.user.role, 'accountSettings', 'manageSubAgents', 'X'),
    permissionService.hasPermission(req.user.role, 'accountSettings', 'commissionSettings', 'X'),
  ]);
  const updated = await accountService.updateManagedAccount(req.user, account, req.body, {
    canEditPlayers,
    canManageStaff,
    canSetCommission,
  });
  await auditService.record({
    actor: req.user,
    action: 'account_updated',
    target: updated,
    req,
  });

  res.json({ account: updated });
});

/** The caller's own permission matrix, keyed the same way the Permissions screen expects. */
const myPermissions = asyncHandler(async (req, res) => {
  const roleKey = ROLE_TO_ROLE_KEY[req.user.role];
  if (!roleKey) return res.json({ groups: null });
  const groups = await permissionService.getMatrixForRoleKey(roleKey);
  res.json({ groups });
});

module.exports = { create, list, getOne, update, updateStatus, myPermissions };
