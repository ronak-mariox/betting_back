const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyAccessToken } = require('../services/token.service');
const { hasPermission } = require('../services/permission.service');
const { isWithinSubtree } = require('../services/account.service');

/** Requires a valid Bearer access token; attaches the live user document to req.user. */
const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw ApiError.unauthorized('Missing bearer access token');
  }

  const payload = verifyAccessToken(token);
  const user = await User.findById(payload.sub);
  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (user.status !== 'active') throw ApiError.forbidden('Account is suspended');

  if (
    user.passwordChangedAt &&
    Math.floor(user.passwordChangedAt.getTime() / 1000) > payload.iat
  ) {
    throw ApiError.unauthorized('Session invalidated by a password change, please sign in again');
  }

  req.user = user;
  next();
});

/**
 * Like authenticate, but an expired / missing access token is not an error —
 * req.user is just left unset. For logout, where the refresh token in the
 * body is the credential being revoked.
 */
const optionalAuthenticate = (req, res, next) =>
  authenticate(req, res, (err) => {
    if (err) req.user = undefined;
    next();
  });

/** Restricts a route to a fixed set of roles, e.g. authorize('super-admin'). */
const authorize = (...roles) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!roles.includes(req.user.role)) {
    return next(ApiError.forbidden('You do not have access to this resource'));
  }
  next();
};

/**
 * Gates a route on the live permission matrix (see PermissionsPage.tsx /
 * permission.service.js). super-admin always passes. Roles outside the
 * matrix (e.g. 'player') never do — this guards staff-panel routes only.
 */
const requirePermission = (groupKey, permissionKey, action) =>
  asyncHandler(async (req, _res, next) => {
    if (!req.user) throw ApiError.unauthorized();
    const allowed = await hasPermission(req.user.role, groupKey, permissionKey, action);
    if (!allowed) throw ApiError.forbidden('You do not have permission to do that');
    next();
  });

/**
 * Confirms the account named by `paramName` (default 'id') is the caller
 * itself or lives in the caller's downline. super-admin bypasses the check.
 */
const requireOwnSubtree = (paramName = 'id') =>
  asyncHandler(async (req, _res, next) => {
    if (!req.user) throw ApiError.unauthorized();
    if (req.user.role === 'super-admin') return next();

    const targetId = req.params[paramName];
    const within = await isWithinSubtree(req.user._id, targetId);
    if (!within) throw ApiError.forbidden('That account is outside your downline');
    next();
  });

module.exports = { authenticate, optionalAuthenticate, authorize, requirePermission, requireOwnSubtree };
