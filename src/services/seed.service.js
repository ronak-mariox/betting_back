const mongoose = require('mongoose');
const env = require('../config/env');
const User = require('../models/User');
const Event = require('../models/Event');
const Market = require('../models/Market');
const Bet = require('../models/Bet');
const WalletRequest = require('../models/WalletRequest');
const Transaction = require('../models/Transaction');
const ApiProvider = require('../models/ApiProvider');
const Partner = require('../models/Partner');
const CmsContent = require('../models/CmsContent');
const Notification = require('../models/Notification');
const Ticket = require('../models/Ticket');
const Settings = require('../models/Settings');
const { hashPassword } = require('./password.service');
const { generateReferralCode } = require('./account.service');

/** Every demo player logs in with this password (app login). */
const DEMO_PLAYER_PASSWORD = 'player@123';

const hoursFromNow = (h) => new Date(Date.now() + h * 60 * 60 * 1000);

/**
 * Three players under agent01, with balances that equal the sum of their
 * ledger rows:
 *   demo_rahul  5,000 deposit + 500 bet win   = 5,500
 *   demo_priya  20,000 deposit                = 20,000
 *   demo_amit   15,000 deposit − 1,000 loss    = 14,000
 */
const DEMO_PLAYERS = [
  { username: 'demo_rahul', name: 'Rahul Verma', city: 'Noida', state: 'Uttar Pradesh', deposit: 5000 },
  { username: 'demo_priya', name: 'Priya Sharma', city: 'Pune', state: 'Maharashtra', deposit: 20000 },
  { username: 'demo_amit', name: 'Amit Kumar', city: 'Delhi', state: 'Delhi', deposit: 15000 },
];

async function seedPlayers(agent) {
  const passwordHash = await hashPassword(DEMO_PLAYER_PASSWORD);
  const players = {};
  for (const demo of DEMO_PLAYERS) {
    // eslint-disable-next-line no-await-in-loop
    const user = await User.create({
      username: demo.username,
      passwordHash,
      role: 'player',
      parent: agent._id,
      createdBy: agent._id,
      name: demo.name,
      city: demo.city,
      state: demo.state,
      phone: '',
      // eslint-disable-next-line no-await-in-loop
      referralCode: await generateReferralCode(demo.username),
      walletBalance: demo.deposit,
    });
    players[demo.username] = user;

    // eslint-disable-next-line no-await-in-loop
    await Transaction.create({
      user: user._id,
      type: 'Deposit',
      amount: demo.deposit,
      method: 'UPI',
      reference: `UPI${demo.deposit}${demo.username.slice(-3).toUpperCase()}`,
      status: 'Completed',
      note: 'Opening deposit',
      createdBy: agent._id,
    });
  }
  return players;
}

async function seedBook(players) {
  const [live, upcoming, completed] = await Event.create([
    { sport: 'Cricket', league: 'IPL', name: 'Mumbai Indians vs Chennai Super Kings', emoji: '🏏', score: '142/3 (16.2)', startTime: hoursFromNow(-1), status: 'Live', stake: 3000, exposure: 3000 },
    { sport: 'Football', league: 'Premier League', name: 'Arsenal vs Chelsea', emoji: '⚽', startTime: hoursFromNow(3), status: 'Upcoming' },
    { sport: 'Tennis', league: 'ATP Masters', name: 'Djokovic vs Alcaraz', emoji: '🎾', score: '6-4, 3-6, 6-2', startTime: hoursFromNow(-26), status: 'Completed', stake: 2000 },
  ]);

  const [liveMo, liveBm, , doneMo] = await Market.create([
    {
      event: live._id, code: 'MO', name: 'Match Odds', type: 'Match Odds', backOdds: 1.85, layOdds: 1.87, maxBet: 50000, maxExposure: 500000, status: 'Active', bets: 1, stake: 2000, exposure: 2000,
      runners: [{ name: 'Mumbai Indians', odds: 1.85 }, { name: 'Chennai Super Kings', odds: 2.05 }],
    },
    {
      event: live._id, code: 'BM', name: 'Bookmaker', type: 'Bookmaker', backOdds: 1.9, layOdds: 2.1, maxBet: 25000, maxExposure: 250000, status: 'Active', bets: 1, stake: 1000, exposure: 1000,
      runners: [{ name: 'Mumbai Indians', odds: 1.9 }, { name: 'Chennai Super Kings', odds: 2.1 }],
    },
    {
      event: upcoming._id, code: 'MO', name: 'Match Odds', type: 'Match Odds', backOdds: 2.4, layOdds: 2.9, maxBet: 50000, maxExposure: 500000, status: 'Active',
      runners: [{ name: 'Arsenal', odds: 2.4 }, { name: 'Chelsea', odds: 2.9 }, { name: 'Draw', odds: 3.2 }],
    },
    {
      event: completed._id, code: 'MO', name: 'Match Odds', type: 'Match Odds', backOdds: 1.5, layOdds: 2.6, maxBet: 30000, maxExposure: 300000, status: 'Suspended', bets: 2, stake: 2000,
      runners: [{ name: 'Djokovic', odds: 1.5 }, { name: 'Alcaraz', odds: 2.6 }], winner: 'Djokovic', settledAt: hoursFromNow(-23),
    },
  ]);

  const { demo_rahul: rahul, demo_priya: priya, demo_amit: amit } = players;
  await Bet.create([
    { event: live._id, market: liveMo._id, user: amit._id, selection: 'Mumbai Indians', odds: 1.85, amount: 2000, status: 'Pending' },
    { event: live._id, market: liveBm._id, user: priya._id, selection: 'Chennai Super Kings', odds: 2.1, amount: 1000, status: 'Pending' },
    { event: completed._id, market: doneMo._id, user: rahul._id, selection: 'Djokovic', odds: 1.5, amount: 1000, status: 'Won', payout: 1500, settledAt: hoursFromNow(-23) },
    { event: completed._id, market: doneMo._id, user: amit._id, selection: 'Alcaraz', odds: 2.6, amount: 1000, status: 'Lost', settledAt: hoursFromNow(-23) },
  ]);

  await Transaction.create([
    { user: rahul._id, type: 'Bet Win', amount: 500, status: 'Completed', note: 'Djokovic vs Alcaraz — Match Odds' },
    { user: amit._id, type: 'Bet Loss', amount: -1000, status: 'Completed', note: 'Djokovic vs Alcaraz — Match Odds' },
  ]);
  rahul.walletBalance += 500;
  amit.walletBalance -= 1000;
  await Promise.all([rahul.save(), amit.save()]);

  await WalletRequest.create([
    { user: rahul._id, kind: 'deposit', amount: 2000, method: 'UPI', reference: 'UPI2000RAH', status: 'Pending' },
    { user: amit._id, kind: 'withdrawal', amount: 3000, method: 'Bank Transfer', reference: 'WD3000AMI', status: 'Pending' },
  ]);

  await Ticket.create({
    subject: 'Deposit not credited yet',
    category: 'Wallet',
    raisedBy: rahul._id,
    role: 'player',
    priority: 'High',
    status: 'Open',
    assignedTeam: 'Finance',
    messages: [{ author: rahul._id, fromSupport: false, body: 'Maine ₹2,000 UPI se bheje the, abhi tak wallet mein nahi aaye.' }],
  });

  await Notification.create([
    { title: 'Withdrawal pending review', body: '₹3,000 withdrawal from demo_amit awaiting approval', category: 'wallet', emoji: '💰' },
  ]);
}

async function seedPlatform() {
  await ApiProvider.create([
    { name: 'Bet365 Odds Feed', latency: 42, marketsCount: 12, uptime: 99.9, status: 'Connected', healthy: true, lastSyncAt: new Date() },
    { name: 'Betfair Exchange API', latency: 65, marketsCount: 8, uptime: 99.5, status: 'Connected', healthy: true, lastSyncAt: new Date() },
  ]);
  await Partner.create({
    name: 'SportsData Global', type: 'Data Feed', revShare: 15, monthlyFee: 25000, status: 'Active',
    contact: 'Priya Nair', email: 'partnerships@sportsdata.example', website: 'https://sportsdata.example',
    apiKey: 'sk_demo_51H9x8Kq2mP', revenueHistory: [],
  });
  await CmsContent.create({
    kind: 'Announcement', status: 'Published', target: 'All', title: 'IPL Special Odds',
    body: 'Enhanced odds on all IPL matches this week.',
  });
}

/**
 * Seeds the demo book for the panels and the app, once: skipped if any
 * player already exists (a real or previously-seeded platform), and in
 * production unless SEED_DEMO_DATA=true.
 */
async function seedAdminDemoData() {
  // SEED_DEMO_DATA=false keeps the database as it is (no demo players or matches).
  if (process.env.SEED_DEMO_DATA === 'false') return;
  if (env.nodeEnv === 'production' && process.env.SEED_DEMO_DATA !== 'true') return;
  await withDemoSeedLock(seedDemoBook);
}

/**
 * Two server processes booting together (e.g. a nodemon restart while
 * another instance is still seeding) could both seed and leave half the demo
 * book behind. Seeding takes this lock (a single Mongo document) and backs
 * off while another process holds it. A lock older
 * than LOCK_TTL_MS is treated as abandoned (a crashed run).
 */
const LOCK_ID = 'demo-seed';
const LOCK_TTL_MS = 2 * 60 * 1000;

async function withDemoSeedLock(fn, { wait = false } = {}) {
  const locks = mongoose.connection.db.collection('locks');
  const started = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await locks.deleteOne({ _id: LOCK_ID, at: { $lt: new Date(Date.now() - LOCK_TTL_MS) } });
    try {
      // eslint-disable-next-line no-await-in-loop
      await locks.insertOne({ _id: LOCK_ID, at: new Date(), pid: process.pid });
      break;
    } catch (err) {
      if (err.code !== 11000) throw err;
      // Re-entrant: a caller already holding the lock can seed inside it.
      // eslint-disable-next-line no-await-in-loop
      if (await locks.findOne({ _id: LOCK_ID, pid: process.pid })) return fn().then(() => true);
      if (!wait) {
        console.log('Demo seed skipped: another process is seeding right now'); // eslint-disable-line no-console
        return false;
      }
      if (Date.now() - started > LOCK_TTL_MS) throw new Error('Timed out waiting for the demo seed lock');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }
  }
  try {
    await fn();
    return true;
  } finally {
    await locks.deleteOne({ _id: LOCK_ID, pid: process.pid });
  }
}

async function seedDemoBook() {
  if (await User.exists({ role: 'player' })) return;

  const [agent, superAgent] = await Promise.all([
    User.findOne({ username: 'agent01' }),
    User.findOne({ username: 'superagent01' }),
  ]);
  if (!agent || !superAgent) return;

  const players = await seedPlayers(agent);
  await seedBook(players);
  await seedPlatform();

  await Settings.findByIdAndUpdate(
    'main',
    {
      $setOnInsert: {
        _id: 'main',
        general: { platformName: 'BetPlatform', supportEmail: 'support@betplatform.example', timezone: 'Asia/Kolkata' },
        walletRules: { minDeposit: 500, maxDeposit: 500000, minWithdrawal: 500, maxWithdrawal: 200000 },
        bettingLimits: { minBet: 100, maxBet: 100000 },
        exposureLimits: { maxMarketExposure: 500000, maxUserExposure: 100000 },
        // Only the referral bonus lives here; session / match commission is set per account.
        commissionRates: { referral: 0 },
        smtp: { host: '', port: 587, user: '' },
        sms: { provider: '', senderId: '' },
        brand: { primaryColor: '#0F172A', logoUrl: '' },
        cms: { marqueeText: 'Welcome to BetPlatform — bet responsibly.' },
      },
    },
    { upsert: true },
  );

  console.log('Seeded demo book: demo_rahul / demo_priya / demo_amit (password player@123)'); // eslint-disable-line no-console
}

module.exports = { seedAdminDemoData, withDemoSeedLock, DEMO_PLAYER_PASSWORD };
