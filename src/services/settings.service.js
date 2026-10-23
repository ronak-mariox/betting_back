const mongoose = require('mongoose');
const Settings = require('../models/Settings');
const ApiError = require('../utils/ApiError');

const SECTIONS = [
  'general',
  'walletRules',
  'bettingLimits',
  'exposureLimits',
  'commissionRates',
  'smtp',
  'sms',
  'brand',
];

const getSettings = async () => {
  return Settings.findByIdAndUpdate('main', { $setOnInsert: { _id: 'main' } }, { new: true, upsert: true });
};

/**
 * The settings document, kept in memory so hot paths (every bet, the 1 s feed
 * poll, "today" boundaries) read it synchronously. Reloaded after every save
 * here and every 30 s (another server may have saved).
 */
let cache = null;
const reloadCache = async () => {
  cache = (await Settings.findById('main').lean()) || {};
  return cache;
};
/** After a save: reload, and tell the apps / panels to refetch what they show from it. */
const saved = async () => {
  await reloadCache();
  require('../realtime').emitConfigChanged(); // eslint-disable-line global-require
  // A Diamond key added on the API Keys tab starts the feed without a restart.
  require('./diamondSync.service').start(); // eslint-disable-line global-require
};
/** Last loaded settings ({} before the first load). */
const cached = () => cache || {};
/** Loads once at boot and keeps refreshing. */
const startSettingsCache = async () => {
  await reloadCache();
  setInterval(() => reloadCache().catch(() => null), 30000).unref();
};

/** Secrets stored in a section: never sent back in clear, kept when the form sends them blank / masked. */
const SECRET_FIELDS = { smtp: ['pass'], sms: ['apiKey'] };
const CURRENCIES = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AED: 'AED ',
  BDT: '৳',
  PKR: 'Rs ',
  NPR: 'Rs ',
  LKR: 'Rs ',
};
const SMS_PROVIDERS = ['', 'Fast2SMS', 'Twilio'];
const isTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
};

/** Validates / normalises a non-brand section before it replaces the stored one. */
function cleanSection(section, updates, current) {
  const out = {};
  for (const [key, value] of Object.entries(updates || {})) {
    // Blank / null = not set (a cleared limit is off, not 0).
    if (value === null || value === undefined || value === '') continue; // eslint-disable-line no-continue
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  for (const key of SECRET_FIELDS[section] || []) {
    const sent = updates?.[key];
    if (sent === null) delete out[key]; // explicit null clears the secret
    else if (sent === undefined || sent === '' || String(sent).includes('•')) {
      if (current?.[key]) out[key] = current[key];
      else delete out[key];
    }
  }
  if (section === 'general') {
    if (out.currency !== undefined) {
      out.currency = String(out.currency).toUpperCase();
      if (!CURRENCIES[out.currency]) throw ApiError.badRequest(`Currency must be one of ${Object.keys(CURRENCIES).join(', ')}`);
    }
    if (out.timezone !== undefined && !isTimezone(out.timezone)) {
      throw ApiError.badRequest('Timezone must be an IANA name like Asia/Kolkata');
    }
    if (out.supportEmail !== undefined && !/^\S+@\S+\.\S+$/.test(out.supportEmail)) {
      throw ApiError.badRequest('Support email is not a valid email address');
    }
  }
  if (section === 'sms' && out.provider !== undefined && !SMS_PROVIDERS.includes(out.provider)) {
    throw ApiError.badRequest(`SMS provider must be one of ${SMS_PROVIDERS.filter(Boolean).join(', ')}`);
  }
  if (section === 'smtp' && out.fromEmail !== undefined && !/^\S+@\S+\.\S+$/.test(out.fromEmail)) {
    throw ApiError.badRequest('From Email is not a valid email address');
  }
  const percents = { exposureLimits: ['autoSuspendPercent', 'warningPercent'], commissionRates: Object.keys(out) };
  for (const key of (percents[section] || []).filter((k) => out[k] !== undefined)) {
    const n = Number(out[key]);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw ApiError.badRequest(`${key} must be between 0 and 100`);
  }
  if (section !== 'general' && section !== 'smtp' && section !== 'sms') {
    for (const [key, value] of Object.entries(out)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest(`${key} must be a positive number`);
      out[key] = n;
    }
  }
  if (section === 'smtp' && out.port !== undefined) out.port = Number(out.port);
  if (section === 'sms' && out.otpValidityMinutes !== undefined) out.otpValidityMinutes = Number(out.otpValidityMinutes);
  return out;
}

/** The platform's currency: `code` (INR) and the `symbol` amounts are written with. */
const currency = () => {
  const code = CURRENCIES[cached().general?.currency] ? cached().general.currency : 'INR';
  return { code, symbol: CURRENCIES[code] };
};
/** The platform's timezone — what "today" means for daily limits, stats and reports. */
const timezone = () => {
  const tz = cached().general?.timezone;
  return tz && isTimezone(tz) ? tz : 'Asia/Kolkata';
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const BRAND_COLORS = ['primaryColor', 'accentColor', 'backgroundColor', 'successColor'];
/** Brightness a primary / accent colour needs to read on the dark panel (#2196f3 is ~0.5). */
const MIN_ACCENT_LUMINANCE = 0.2;

/** "#abc" -> "#aabbcc", lower-case. */
const fullHex = (value) => {
  const hex = value.trim().toLowerCase();
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
};

/** Relative luminance 0 (black) … 1 (white). */
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/**
 * The panel applies the brand section live (colours on its theme, name /
 * tagline / logo in the shell), so it must be valid before it's stored.
 */
function cleanBrand(updates) {
  const out = {};
  const text = (key, max) => {
    if (updates[key] === undefined) return;
    const value = String(updates[key] ?? '').trim();
    if (value.length > max) throw ApiError.badRequest(`${key} can be at most ${max} characters`);
    out[key] = value;
  };
  text('brandName', 40);
  text('tagline', 80);
  if (updates.logoUrl !== undefined) {
    const url = String(updates.logoUrl ?? '').trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw ApiError.badRequest('Logo URL must start with http:// or https://');
    out.logoUrl = url;
  }
  for (const key of BRAND_COLORS) {
    if (updates[key] === undefined) continue; // eslint-disable-line no-continue
    const value = String(updates[key] ?? '').trim();
    if (!value) {
      out[key] = ''; // empty = the panel's default
      continue; // eslint-disable-line no-continue
    }
    if (!HEX.test(value)) throw ApiError.badRequest(`${key} must be a hex colour like #2196f3`);
    out[key] = fullHex(value);
  }
  // The panel is dark-only (white text): a light background would make it unreadable.
  if (out.backgroundColor && luminance(out.backgroundColor) > 0.25) {
    throw ApiError.badRequest('Background must be a dark colour — the panel uses white text');
  }
  // Primary / accent colour links, tabs and selected chips on that dark background: they must stand out from it.
  for (const key of ['primaryColor', 'accentColor']) {
    if (out[key] && luminance(out[key]) < MIN_ACCENT_LUMINANCE) {
      throw ApiError.badRequest(`${key} is too dark to read on the dark panel — pick a brighter colour`);
    }
  }
  return out;
}

/** What every visitor (login page included) sees: name, tagline, logo and valid colours. */
const getBranding = async () => {
  const settings = await Settings.findById('main').lean();
  const brand = settings?.brand || {};
  const color = (v) => (typeof v === 'string' && HEX.test(v) ? fullHex(v) : '');
  return {
    brandName: brand.brandName || settings?.general?.platformName || '',
    tagline: brand.tagline || '',
    logoUrl: typeof brand.logoUrl === 'string' && /^https?:\/\//i.test(brand.logoUrl) ? brand.logoUrl : '',
    // Colours saved before validation existed are only used when readable.
    primaryColor: color(brand.primaryColor) && luminance(color(brand.primaryColor)) >= MIN_ACCENT_LUMINANCE ? color(brand.primaryColor) : '',
    accentColor: color(brand.accentColor) && luminance(color(brand.accentColor)) >= MIN_ACCENT_LUMINANCE ? color(brand.accentColor) : '',
    backgroundColor: color(brand.backgroundColor) && luminance(fullHex(brand.backgroundColor)) <= 0.25 ? fullHex(brand.backgroundColor) : '',
    successColor: color(brand.successColor),
  };
};

const updateSection = async (section, updates) => {
  if (!SECTIONS.includes(section)) throw ApiError.badRequest(`Unknown settings section: ${section}`);
  const stored = (await Settings.findById('main').lean())?.[section] || {};
  // Brand: saving one card keeps what the other card stored.
  const next = section === 'brand' ? { ...stored, ...cleanBrand(updates) } : cleanSection(section, updates, stored);
  const settings = await Settings.findByIdAndUpdate(
    'main',
    { $set: { [section]: next } },
    { new: true, upsert: true, runValidators: true },
  );
  await saved();
  return settings;
};

const addApiKey = async ({ name, key }) => {
  const settings = await Settings.findByIdAndUpdate(
    'main',
    { $push: { apiKeys: { name, key, status: 'Active', latency: 0 } } },
    { new: true, upsert: true },
  );
  await saved();
  return settings;
};

const updateApiKey = async (keyId, updates) => {
  const settings = await Settings.findById('main');
  if (!settings) throw ApiError.notFound('Settings not found');
  const entry = settings.apiKeys.id(keyId);
  if (!entry) throw ApiError.notFound('API key not found');
  const { name, key, status } = updates;
  if (name !== undefined) entry.name = String(name).trim();
  if (key) entry.key = String(key).trim();
  if (status !== undefined) {
    if (!['Active', 'Inactive'].includes(status)) throw ApiError.badRequest('Status must be Active or Inactive');
    entry.status = status;
  }
  await settings.save();
  await saved();
  return settings;
};

const deleteApiKey = async (keyId) => {
  const settings = await Settings.findByIdAndUpdate(
    'main',
    { $pull: { apiKeys: { _id: new mongoose.Types.ObjectId(keyId) } } },
    { new: true },
  );
  if (!settings) throw ApiError.notFound('Settings not found');
  await saved();
  return settings;
};

/** Records how long the provider behind an API key took to answer (shown on the API Keys tab). */
const recordApiLatency = async (keyId, latency) => {
  await Settings.updateOne({ _id: 'main', 'apiKeys._id': keyId }, { $set: { 'apiKeys.$.latency': Math.round(latency) } });
};

module.exports = {
  getSettings,
  updateSection,
  addApiKey,
  updateApiKey,
  deleteApiKey,
  recordApiLatency,
  SECTIONS,
  CURRENCIES,
  SMS_PROVIDERS,
  getBranding,
  cached,
  reloadCache,
  startSettingsCache,
  currency,
  timezone,
};
