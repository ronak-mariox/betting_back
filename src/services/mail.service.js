const nodemailer = require('nodemailer');
const env = require('../config/env');
const { cached } = require('./settings.service');

/**
 * Outgoing mail. The SMTP account is the one saved in Platform Settings →
 * Notifications → Email (super-admin panel); the SMTP_* environment variables
 * are the fallback while nothing is saved there. Without either, development
 * prints mail to the console instead.
 */
const config = () => {
  const saved = cached().smtp || {};
  if (saved.host) {
    const port = Number(saved.port) || 587;
    const fromEmail = saved.fromEmail || saved.user || env.smtp.from;
    return {
      host: saved.host,
      port,
      user: saved.user || '',
      pass: saved.pass || '',
      from: saved.fromName ? `"${saved.fromName}" <${fromEmail}>` : fromEmail,
    };
  }
  return env.smtp.host ? env.smtp : null;
};

/** One transporter per SMTP account, rebuilt when the settings change. */
let transporter = null;
let builtFor = '';
const getTransporter = () => {
  const smtp = config();
  if (!smtp) return null;
  const key = JSON.stringify([smtp.host, smtp.port, smtp.user, smtp.pass]);
  if (!transporter || builtFor !== key) {
    transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      connectionTimeout: 15000,
    });
    builtFor = key;
  }
  return transporter;
};

const isConfigured = () => Boolean(config());

/**
 * Sends a plain-text email. Without SMTP, development prints it to the
 * console instead so flows like password reset can still be tested.
 */
const sendMail = async ({ to, subject, text }) => {
  const mailer = getTransporter();
  if (!mailer) {
    if (env.nodeEnv !== 'production') {
      console.log(`[mail:dev] to=${to || '(no email on file)'} subject="${subject}"\n${text}`); // eslint-disable-line no-console
    } else {
      console.warn(`[mail] SMTP not configured — "${subject}" was not sent`); // eslint-disable-line no-console
    }
    return false;
  }
  await mailer.sendMail({ from: config().from, to, subject, text });
  return true;
};

module.exports = { sendMail, isConfigured };
