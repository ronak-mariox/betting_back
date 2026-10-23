const Notification = require('../models/Notification');
const User = require('../models/User');
const CmsContent = require('../models/CmsContent');
const WalletRequest = require('../models/WalletRequest');
const Bet = require('../models/Bet');
const ApiError = require('../utils/ApiError');
const { money } = require('../utils/money');

const DEFAULT_PAGE_LIMIT = 50;
const PROMO_WINDOW_DAYS = 30;

/** Creates an admin notification-feed row. Called from other services (wallet, risk, support, …), not directly by routes. */
const notify = async ({ title, body = '', category = 'general', emoji = '🔔', recipientRole = 'super-admin' }) => {
  return Notification.create({ title, body, category, emoji, recipientRole });
};

const listNotifications = async ({ recipientRole = 'super-admin', limit = DEFAULT_PAGE_LIMIT } = {}) => {
  const filter = { recipientRole, recipient: null };
  const items = await Notification.find(filter).sort({ createdAt: -1 }).limit(limit);
  const unreadCount = await Notification.countDocuments({ ...filter, unread: true });
  return { items, unreadCount };
};

const markAllRead = async ({ recipientRole = 'super-admin' } = {}) => {
  await Notification.updateMany({ recipientRole, recipient: null, unread: true }, { $set: { unread: false } });
  return listNotifications({ recipientRole });
};

const clearAll = async ({ recipientRole = 'super-admin' } = {}) => {
  await Notification.deleteMany({ recipientRole, recipient: null });
};

// ---- The player's own feed (bettingApp → Notifications) ----

/**
 * The app's Settings switches, stored on User.preferences. A category with
 * no switch (welcome) is always delivered; a switch never touched is on.
 */
const PREFERENCE_FOR = {
  bet: 'notifyLive',
  live: 'notifyLive',
  wallet: 'notifyMoney',
  promo: 'notifyPromos',
  security: 'notifySecurity',
};

const wants = (user, category) => {
  const key = PREFERENCE_FOR[category];
  if (!key) return true;
  const prefs = user.preferences;
  const value = prefs?.get ? prefs.get(key) : prefs?.[key];
  return value !== false;
};

const rupees = money;

/** What each event says, shared by the live hooks and the one-time backfill of older history. */
const compose = {
  walletDecision: (request) => {
    const deposit = request.kind === 'deposit';
    const approved = request.status === 'Approved';
    const where = request.method ? ` via ${request.method}` : '';
    const reason = request.rejectionReason ? ` Reason: ${request.rejectionReason}` : '';
    return {
      category: 'wallet',
      link: 'wallet',
      source: `req:${request._id}`,
      emoji: approved ? '💰' : '⚠️',
      title: `${deposit ? 'Deposit' : 'Withdrawal'} ${approved ? (deposit ? 'Successful' : 'Approved') : 'Rejected'}`,
      body: approved
        ? deposit
          ? `${rupees(request.amount)} credited to your wallet`
          : `${rupees(request.amount)} withdrawal approved${where}`
        : `Your ${rupees(request.amount)} ${request.kind} request was rejected.${reason}`,
    };
  },
  betSettled: (bet, eventName) => {
    const won = bet.status === 'Won';
    return {
      category: 'bet',
      link: 'bets',
      source: `bet:${bet._id}`,
      emoji: won ? '🏆' : '📉',
      title: won ? 'Bet Won!' : 'Bet Lost',
      body: won
        ? `${bet.selection} bet — ${rupees(bet.payout - bet.amount)} winnings added to your wallet`
        : `${bet.selection} bet${eventName ? ` (${eventName})` : ''} — ${rupees(bet.amount)} stake lost`,
    };
  },
  content: (content) => ({
    category: 'promo',
    link: '',
    source: `cms:${content._id}`,
    emoji: { Promotion: '🎁', Announcement: '📢', Notice: 'ℹ️' }[content.kind] || '🔔',
    title: content.kind === 'Promotion' ? 'New Promotion' : content.title,
    body: content.kind === 'Promotion' ? [content.title, content.body].filter(Boolean).join(' — ') : content.body,
  }),
};

/**
 * Adds a row to a player's feed. Never throws: a notification must not undo
 * the deposit, settlement or login it describes. Does nothing for staff
 * accounts, or when the player switched that kind of alert off.
 */
const notifyPlayer = async ({ user, title, body = '', category = 'general', emoji = '🔔', link = '', source, at, unread = true }) => {
  try {
    const player = await User.findById(user?._id || user).select('role preferences');
    if (!player || player.role !== 'player' || !wants(player, category)) return null;
    // Dated by hand (not by the schema's timestamps) so history can carry the day it happened.
    const when = at ? new Date(at) : new Date();
    const row = { recipientRole: 'player', recipient: player._id, title, body, category, emoji, link, unread, createdAt: when, updatedAt: when };
    if (!source) return await Notification.create(row);
    await Notification.updateOne(
      { recipient: player._id, source },
      { $setOnInsert: { ...row, source } },
      { upsert: true, timestamps: false },
    );
    return null;
  } catch (err) {
    if (err?.code !== 11000) console.error('player notification failed:', err.message); // eslint-disable-line no-console
    return null;
  }
};

const notifyWalletDecision = (request) => notifyPlayer({ user: request.user, ...compose.walletDecision(request) });
const notifyBetSettled = (bet, eventName) => notifyPlayer({ user: bet.user, ...compose.betSettled(bet, eventName) });

/** A credit / debit made on the panel (manual entry, fund transfer), outside the request queue. */
const notifyWalletAdjustment = ({ user, amount, from = '', note = '' }) =>
  notifyPlayer({
    user,
    category: 'wallet',
    link: 'wallet',
    emoji: amount >= 0 ? '💰' : '💸',
    title: amount >= 0 ? 'Wallet Credited' : 'Wallet Debited',
    body: [`${rupees(amount)} ${amount >= 0 ? 'added to' : 'deducted from'} your wallet${from ? ` by ${from}` : ''}`, note].filter(Boolean).join(' — '),
  });

/** Tells everyone holding an open bet on the match that it has started. */
const notifyMatchLive = async (event) => {
  try {
    const players = await Bet.distinct('user', { event: event._id, status: 'Pending' });
    await Promise.all(
      players.map((user) =>
        notifyPlayer({
          user,
          category: 'live',
          link: 'live',
          source: `live:${event._id}`,
          emoji: event.emoji || '🏏',
          title: `${event.name} — Live`,
          body: 'The match has started. Follow the score and your open bets.',
        }),
      ),
    );
  } catch (err) {
    console.error('match-live notification failed:', err.message); // eslint-disable-line no-console
  }
};

const describeDevice = (userAgent = '') => {
  if (/okhttp|android/i.test(userAgent)) return 'Android device';
  if (/cfnetwork|darwin|iphone|ipad/i.test(userAgent)) return 'iPhone';
  if (/mozilla|chrome|safari/i.test(userAgent)) return 'a web browser';
  return 'a new device';
};

const notifyLogin = ({ user, userAgent }) =>
  notifyPlayer({
    user,
    category: 'security',
    link: 'profile',
    emoji: '🔐',
    title: 'Login Alert',
    body: `New login from ${describeDevice(userAgent)}`,
  });

const notifyPasswordChanged = ({ user }) =>
  notifyPlayer({
    user,
    category: 'security',
    link: 'profile',
    emoji: '🔑',
    title: 'Password Changed',
    body: 'Your password was changed. All other devices have been signed out.',
  });

const notifyWelcome = ({ user }) =>
  notifyPlayer({
    user,
    category: 'general',
    link: 'wallet',
    source: 'welcome',
    emoji: '🎉',
    title: 'Welcome to BetPro',
    body: 'Add money to your wallet to start betting.',
  });

/** Content the admin published for players (CMS → Announcements / Promotions / Notices). */
const forPlayers = (content) => !content.target || /^(all|everyone)$/i.test(content.target.trim()) || /player|user/i.test(content.target);
/** Content for the staff panels (target All or Staff). */
const forStaff = (content) => !content.target || /^(all|everyone)$/i.test(content.target.trim()) || /staff|agent|franchise/i.test(content.target);

/**
 * Brings the player's feed in line with what's published in the CMS right
 * now: adds what they haven't been shown yet (also for accounts created
 * after it went out) and takes back what the admin has since unpublished.
 */
const syncPublishedContent = async (player) => {
  const since = new Date(Date.now() - PROMO_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const published = (
    await CmsContent.find({ status: 'Published', kind: { $in: ['Announcement', 'Promotion', 'Notice'] }, updatedAt: { $gte: since } })
      .sort({ updatedAt: -1 })
      .limit(20)
  ).filter(forPlayers);
  const live = published.map((content) => `cms:${content._id}`);
  await Notification.deleteMany({ recipient: player._id, source: { $regex: /^cms:/, $nin: live } });
  if (!published.length) return;

  const have = new Set(await Notification.distinct('source', { recipient: player._id, source: { $in: live } }));
  await Promise.all(
    published
      .filter((content) => !have.has(`cms:${content._id}`))
      .map((content) => notifyPlayer({ user: player, ...compose.content(content), at: content.updatedAt })),
  );
};

const toPlayerView = (row) => ({
  _id: row._id,
  emoji: row.emoji,
  title: row.title,
  body: row.body,
  category: row.category,
  link: row.link || '',
  unread: row.unread,
  createdAt: row.createdAt,
});

const listForPlayer = async (player, { limit = DEFAULT_PAGE_LIMIT } = {}) => {
  try {
    await syncPublishedContent(player);
  } catch (err) {
    console.error('promotion sync failed:', err.message); // eslint-disable-line no-console
  }
  const [items, unreadCount] = await Promise.all([
    Notification.find({ recipient: player._id }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || DEFAULT_PAGE_LIMIT, 100)),
    Notification.countDocuments({ recipient: player._id, unread: true }),
  ]);
  return { notifications: items.map(toPlayerView), unreadCount };
};

/**
 * A CMS item counts a view the first time each player reads it in the app
 * (one notification per player per item, so nobody is counted twice).
 */
const countCmsViews = async (rows) => {
  const perContent = new Map();
  rows.forEach((row) => {
    const id = row.source?.startsWith('cms:') ? row.source.slice(4) : null;
    if (id) perContent.set(id, (perContent.get(id) || 0) + 1);
  });
  await Promise.all(
    [...perContent].map(([id, n]) => CmsContent.updateOne({ _id: id }, { $inc: { views: n } }).catch(() => null)),
  );
};

const markReadForPlayer = async (player, id) => {
  // The pre-update row tells whether this read is the first one.
  const row = await Notification.findOneAndUpdate({ _id: id, recipient: player._id }, { $set: { unread: false } });
  if (!row) throw ApiError.notFound('Notification not found');
  if (row.unread) await countCmsViews([row]);
  return listForPlayer(player);
};

const markAllReadForPlayer = async (player) => {
  const unreadCms = await Notification.find({ recipient: player._id, unread: true, source: /^cms:/ }).select('source').lean();
  await Notification.updateMany({ recipient: player._id, unread: true }, { $set: { unread: false } });
  await countCmsViews(unreadCms);
  return listForPlayer(player);
};

/**
 * Players who were active before the app had a real feed start with their
 * own history in it (reviewed requests, settled bets), marked
 * read and dated when each thing happened. Runs on boot; an account that
 * already has a feed is left alone.
 */
const backfillPlayerFeeds = async () => {
  const withFeed = new Set((await Notification.distinct('recipient', { recipient: { $ne: null } })).map(String));
  const players = (await User.find({ role: 'player' }).select('_id')).filter((p) => !withFeed.has(String(p._id)));
  let added = 0;
  for (const player of players) {
    /* eslint-disable no-await-in-loop */
    const [requests, bets] = await Promise.all([
      WalletRequest.find({ user: player._id, status: { $in: ['Approved', 'Rejected'] } }).sort({ createdAt: -1 }).limit(20),
      Bet.find({ user: player._id, status: { $in: ['Won', 'Lost'] } }).populate('event', 'name').sort({ createdAt: -1 }).limit(20),
    ]);
    const rows = [
      ...requests.map((r) => ({ ...compose.walletDecision(r), at: r.reviewedAt || r.updatedAt })),
      ...bets.map((b) => ({ ...compose.betSettled(b, b.event?.name), at: b.settledAt || b.updatedAt })),
    ];
    for (const row of rows) await notifyPlayer({ user: player._id, unread: false, ...row });
    added += rows.length;
    /* eslint-enable no-await-in-loop */
  }
  if (added) console.log(`Backfilled ${added} notifications for ${players.length} players from their history`); // eslint-disable-line no-console
};

module.exports = {
  notify,
  listNotifications,
  markAllRead,
  clearAll,
  notifyPlayer,
  notifyWalletDecision,
  notifyWalletAdjustment,
  notifyBetSettled,
  notifyMatchLive,
  notifyLogin,
  notifyPasswordChanged,
  notifyWelcome,
  listForPlayer,
  markReadForPlayer,
  markAllReadForPlayer,
  backfillPlayerFeeds,
  forPlayers,
  forStaff,
};
