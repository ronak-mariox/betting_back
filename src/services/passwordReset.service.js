const crypto = require('crypto');
const env = require('../config/env');
const User = require('../models/User');
const PasswordReset = require('../models/PasswordReset');
const ApiError = require('../utils/ApiError');
const mailService = require('./mail.service');
const smsService = require('./sms.service');
const tokenService = require('./token.service');
const { hashPassword } = require('./password.service');
const { cached } = require('./settings.service');

const { maxAttempts, resendCooldownSeconds } = env.passwordReset;

/** Keyed hash, so a leaked PasswordReset row can't be brute-forced offline in a million guesses. */
const hashCode = (userId, code) =>
  crypto.createHmac('sha256', env.jwt.accessSecret).update(`${userId}:${code}`).digest('hex');

const INVALID_CODE = 'Invalid or expired reset code';

/** The fixed testing code (env.passwordReset.masterCode) — only outside production. */
const isMasterCode = (code) =>
  env.nodeEnv !== 'production' && Boolean(env.passwordReset.masterCode) && code === env.passwordReset.masterCode;

/**
 * "Forgot password?" step 1: sends a 6-digit code to the account's email
 * (SMTP) and / or mobile (SMS gateway) on file. Silently does nothing for
 * unknown, suspended or unreachable accounts (and within the resend cooldown), so the caller's response never
 * reveals which usernames exist. Returns true when a code was issued.
 */
async function requestReset({ username, ip }) {
  const user = await User.findOne({ username: username.trim().toLowerCase() });
  if (!user || user.status !== 'active') return false;
  const byEmail = Boolean(user.email) && mailService.isConfigured();
  const bySms = Boolean(user.phone) && smsService.isConfigured();
  // With no gateway at all (development) the code is logged, so any account can still be tested.
  if (!byEmail && !bySms && (mailService.isConfigured() || smsService.isConfigured())) return false;
  const codeTtlMinutes = smsService.otpValidityMinutes();

  const existing = await PasswordReset.findOne({ user: user._id });
  if (existing && Date.now() - existing.updatedAt.getTime() < resendCooldownSeconds * 1000) return false;

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  await PasswordReset.findOneAndUpdate(
    { user: user._id },
    {
      codeHash: hashCode(user._id, code),
      expiresAt: new Date(Date.now() + codeTtlMinutes * 60 * 1000),
      attempts: 0,
      ip: ip || '',
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  const brand = cached().brand?.brandName || cached().general?.platformName || 'Your account';
  const sends = [];
  if (byEmail || !bySms) {
    sends.push(
      mailService.sendMail({
        to: user.email,
        subject: 'Your password reset code',
        text:
          `Hi ${user.name || user.username},\n\n` +
          `Your password reset code is ${code}. It expires in ${codeTtlMinutes} minutes.\n\n` +
          'If you did not ask to reset your password, ignore this email — your password stays the same.',
      }),
    );
  }
  if (bySms) {
    sends.push(
      smsService.sendSms({
        to: user.phone,
        text: `${brand}: your password reset code is ${code}. Valid for ${codeTtlMinutes} minutes. Do not share it.`,
      }),
    );
  }
  // One channel failing (bad SMTP login, SMS balance) shouldn't hide the other.
  const results = await Promise.allSettled(sends);
  results
    .filter((r) => r.status === 'rejected')
    .forEach((r) => console.warn(`[password reset] ${r.reason?.message || r.reason}`)); // eslint-disable-line no-console
  return user;
}

/**
 * Step 2: checks the code and sets the new password. Every existing session
 * is revoked, as with a normal password change. Returns the updated user.
 */
async function resetPassword({ username, code, newPassword }) {
  const user = await User.findOne({ username: username.trim().toLowerCase() });
  const record = user ? await PasswordReset.findOne({ user: user._id }) : null;
  if (!user || user.status !== 'active') throw ApiError.badRequest(INVALID_CODE);

  if (isMasterCode(code)) {
    // Development shortcut — skips the emailed code entirely.
  } else if (!record || record.expiresAt < new Date()) {
    throw ApiError.badRequest(INVALID_CODE);
  } else if (
    !crypto.timingSafeEqual(Buffer.from(record.codeHash, 'hex'), Buffer.from(hashCode(user._id, code), 'hex'))
  ) {
    record.attempts += 1;
    if (record.attempts >= maxAttempts) {
      await record.deleteOne();
      throw ApiError.badRequest('Too many wrong codes. Please request a new one.');
    }
    await record.save();
    throw ApiError.badRequest(INVALID_CODE);
  }

  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();
  if (record) await record.deleteOne();
  await tokenService.revokeAllForUser(user._id);
  return user;
}

module.exports = { requestReset, resetPassword };
