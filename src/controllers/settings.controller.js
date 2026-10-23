const asyncHandler = require('../utils/asyncHandler');
const settingsService = require('../services/settings.service');
const mailService = require('../services/mail.service');
const smsService = require('../services/sms.service');
const ApiError = require('../utils/ApiError');
const { normalizeMobile } = require('../utils/phone');

const get = asyncHandler(async (_req, res) => {
  res.json({ settings: await settingsService.getSettings() });
});

const updateSection = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSection(req.params.section, req.body);
  res.json({ settings });
});

const addApiKey = asyncHandler(async (req, res) => {
  const settings = await settingsService.addApiKey(req.body);
  res.status(201).json({ settings });
});

const updateApiKey = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateApiKey(req.params.keyId, req.body);
  res.json({ settings });
});

const deleteApiKey = asyncHandler(async (req, res) => {
  const settings = await settingsService.deleteApiKey(req.params.keyId);
  res.json({ settings });
});

/** Sends a test message through the saved gateway; any provider error comes back as the message. */
const tryGateway = async (send, notConfigured) => {
  let sent;
  try {
    sent = await send();
  } catch (err) {
    throw ApiError.badRequest(`Could not send: ${err.message}`);
  }
  if (!sent) throw ApiError.badRequest(notConfigured);
};

const testEmail = asyncHandler(async (req, res) => {
  await tryGateway(
    () =>
      mailService.sendMail({
        to: req.body.to,
        subject: 'Test email from your betting platform',
        text: 'This is a test from Platform Settings → Notifications. Your SMTP settings work.',
      }),
    'Save the SMTP host first — no email server is configured.',
  );
  res.json({ message: `Test email sent to ${req.body.to}` });
});

const testSms = asyncHandler(async (req, res) => {
  await tryGateway(
    () => smsService.sendSms({ to: normalizeMobile(req.body.to), text: 'Test SMS from Platform Settings. Your SMS gateway works.' }),
    'Save the SMS provider and API key first — no SMS gateway is configured.',
  );
  res.json({ message: `Test SMS sent to ${req.body.to}` });
});

module.exports = { get, updateSection, addApiKey, updateApiKey, deleteApiKey, testEmail, testSms };
