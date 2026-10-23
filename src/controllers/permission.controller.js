const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const permissionService = require('../services/permission.service');
const auditService = require('../services/audit.service');
const { ROLE_TO_ROLE_KEY } = require('../constants/permissions');

const getFullMatrix = asyncHandler(async (_req, res) => {
  res.json({ roles: await permissionService.getFullMatrix() });
});

const getOne = asyncHandler(async (req, res) => {
  const { roleKey } = req.params;
  const own = ROLE_TO_ROLE_KEY[req.user.role] === roleKey;
  if (req.user.role !== 'super-admin' && !own) {
    throw ApiError.forbidden('You can only view your own role\'s permissions');
  }
  res.json({ groups: await permissionService.getMatrixForRoleKey(roleKey) });
});

const updateGrant = asyncHandler(async (req, res) => {
  const { roleKey, groupKey, permissionKey } = req.params;
  const { grant } = req.body;

  await permissionService.setGrant({
    roleKey,
    groupKey,
    permissionKey,
    grant,
    updatedBy: req.user._id,
  });

  await auditService.record({
    actor: req.user,
    action: 'permission_updated',
    req,
    metadata: { roleKey, groupKey, permissionKey, grant },
  });

  // That role's open panels reload their menu and buttons (realtime.js).
  // eslint-disable-next-line global-require
  require('../realtime').emitPermissionsChanged(roleKey);
  res.json({ groups: await permissionService.getMatrixForRoleKey(roleKey) });
});

module.exports = { getFullMatrix, getOne, updateGrant };
