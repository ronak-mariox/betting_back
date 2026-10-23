const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const commissionService = require('../services/commission.service');
const permissionService = require('../services/permission.service');
const { scopeFor } = require('../services/scope.service');

/**
 * Staff see their own and their downline's commission only with the
 * "Commission" view grant (super-admin sees all).
 */
async function commissionScope(actor) {
  const scope = await scopeFor(actor);
  if (!scope) return null;
  // "Commission" (view) on the Permissions page: earnings — own and downline — are hidden without it.
  const canSee = await permissionService.hasPermission(actor.role, 'finance', 'commission', 'V');
  if (!canSee) throw ApiError.forbidden('You do not have permission to view commission');
  return scope;
}

const list = asyncHandler(async (req, res) => {
  const items = await commissionService.listCommission({ ...req.query, scope: await commissionScope(req.user) });
  res.json({ items });
});

module.exports = { list };
