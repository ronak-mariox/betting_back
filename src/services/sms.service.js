const env = require('../config/env');
const { cached } = require('./settings.service');
const ApiError = require('../utils/ApiError');

/**
 * Outgoing SMS through the gateway saved in Platform Settings → Notifications
 * → SMS / OTP Config:
 *   - Fast2SMS: API Key = the account's authorization key ("Quick SMS" route).
 *   - Twilio:   API Key = "ACCOUNT_SID:AUTH_TOKEN", Sender ID = the Twilio number.
 * Without a gateway, development prints the message to the console.
 */
const config = () => {
  const sms = cached().sms || {};
  return sms.provider && sms.apiKey ? sms : null;
};

const isConfigured = () => Boolean(config());

/** Code lifetime for password-reset OTPs (Settings → SMS → OTP Validity), in minutes. */
const otpValidityMinutes = () => Number(cached().sms?.otpValidityMinutes) || env.passwordReset.codeTtlMinutes;

/** "+91 98765 43210" → digits with country code ("919876543210"). */
const digitsOf = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
};

async function viaFast2Sms({ apiKey }, to, text) {
  const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: { authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ route: 'q', message: text, numbers: digitsOf(to).slice(-10), flash: 0 }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.return === false) throw new Error(`Fast2SMS: ${json?.message || `HTTP ${res.status}`}`);
}

async function viaTwilio({ apiKey, senderId }, to, text) {
  const [sid, token] = String(apiKey).split(':');
  if (!sid || !token) throw new Error('Twilio API Key must be "ACCOUNT_SID:AUTH_TOKEN"');
  if (!senderId) throw new Error('Twilio needs the sending number in Sender ID');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: `+${digitsOf(to)}`, From: senderId, Body: text }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Twilio: ${json?.message || `HTTP ${res.status}`}`);
}

/** Sends one SMS; returns false when no gateway is set up (the text is logged in development). */
async function sendSms({ to, text }) {
  const sms = config();
  if (!sms) {
    if (env.nodeEnv !== 'production') console.log(`[sms:dev] to=${to || '(no phone)'}\n${text}`); // eslint-disable-line no-console
    return false;
  }
  if (!to) throw ApiError.badRequest('No mobile number to send to');
  if (sms.provider === 'Fast2SMS') await viaFast2Sms(sms, to, text);
  else if (sms.provider === 'Twilio') await viaTwilio(sms, to, text);
  else throw new Error(`Unknown SMS provider ${sms.provider}`);
  return true;
}

module.exports = { sendSms, isConfigured, otpValidityMinutes };
