const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const RefreshToken = require('../models/RefreshToken');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');

const REFRESH_BYTES = 48;

const signAccessToken = (user) =>
  jwt.sign(
    { sub: user._id.toString(), role: user.role, username: user.username },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessTtl },
  );

const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, env.jwt.accessSecret);
  } catch {
    throw ApiError.unauthorized('Invalid or expired access token');
  }
};

const hashToken = (plainToken) => crypto.createHash('sha256').update(plainToken).digest('hex');

const refreshExpiryDate = () =>
  new Date(Date.now() + env.jwt.refreshTtlDays * 24 * 60 * 60 * 1000);

/** Issues a brand new opaque refresh token for `user` and persists its hash. */
const issueRefreshToken = async (user, meta = {}) => {
  const plainToken = crypto.randomBytes(REFRESH_BYTES).toString('hex');
  await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(plainToken),
    expiresAt: refreshExpiryDate(),
    userAgent: meta.userAgent || '',
    ip: meta.ip || '',
  });
  return plainToken;
};

/**
 * Validates a presented refresh token, revokes it, and issues a replacement
 * (rotation). Reusing an already-rotated/revoked token is treated as
 * evidence of theft: every other live token for that user is revoked too.
 */
const rotateRefreshToken = async (plainToken, meta = {}) => {
  if (!plainToken) throw ApiError.unauthorized('Refresh token required');
  const tokenHash = hashToken(plainToken);
  const record = await RefreshToken.findOne({ tokenHash });

  if (!record) throw ApiError.unauthorized('Refresh token not recognized');

  if (record.revokedAt || record.expiresAt < new Date()) {
    await RefreshToken.updateMany(
      { user: record.user, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    throw ApiError.unauthorized('Refresh token no longer valid, please sign in again');
  }

  const user = await User.findById(record.user);
  if (!user || user.status !== 'active') {
    throw ApiError.unauthorized('Account is no longer active');
  }

  const nextPlainToken = crypto.randomBytes(REFRESH_BYTES).toString('hex');
  const nextHash = hashToken(nextPlainToken);

  record.revokedAt = new Date();
  record.replacedByHash = nextHash;
  await record.save();

  await RefreshToken.create({
    user: user._id,
    tokenHash: nextHash,
    expiresAt: refreshExpiryDate(),
    userAgent: meta.userAgent || '',
    ip: meta.ip || '',
  });

  return { user, refreshToken: nextPlainToken };
};

const revokeRefreshToken = async (plainToken) => {
  if (!plainToken) return;
  await RefreshToken.updateOne(
    { tokenHash: hashToken(plainToken), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
};

const revokeAllForUser = async (userId) => {
  await RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
};

module.exports = {
  hashToken,
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
};
