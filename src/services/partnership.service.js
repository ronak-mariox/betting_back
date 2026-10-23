const crypto = require('crypto');
const Partner = require('../models/Partner');
const PartnerSettlement = require('../models/PartnerSettlement');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Transaction = require('../models/Transaction');
const ApiError = require('../utils/ApiError');

/** What the panel may write on a partner. Volume, revenue, code and counts are computed, never sent. */
const EDITABLE = ['name', 'type', 'revShare', 'monthlyFee', 'status', 'since', 'contact', 'email', 'website', 'apiKey', 'notes'];
const pick = (data) => Object.fromEntries(EDITABLE.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));

/** "YYYY-MM" in India time, matching the aggregation's timezone. */
const monthOf = (date) => {
  const ist = new Date(date.getTime() + 330 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * "PT" + 6 characters. Partner and user referral codes share one sign-up
 * field, so a code must not be in use by either.
 */
async function generatePartnerCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `PT${crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;
    // eslint-disable-next-line no-await-in-loop
    const taken = (await Partner.exists({ referralCode: candidate })) || (await User.exists({ referralCode: candidate }));
    if (!taken) return candidate;
  }
  throw new Error('Could not generate a unique partner code, please retry');
}

/** Gives every partner without one a sign-up code (run at boot). */
async function ensurePartnerCodes() {
  const partners = await Partner.find({ $or: [{ referralCode: null }, { referralCode: { $exists: false } }, { referralCode: '' }] });
  for (const partner of partners) {
    // eslint-disable-next-line no-await-in-loop
    partner.referralCode = await generatePartnerCode();
    // eslint-disable-next-line no-await-in-loop
    await partner.save();
  }
}

/**
 * Rebuilds every partner's figures from its players' real activity:
 *  - betVolume: stake on their bets, voided bets excluded;
 *  - revenueHistory: per month, revShare% of the house's net betting win
 *    from those players (−Σ Bet Win/Bet Loss; a losing month shares 0);
 *  - settlements: one per finished month with something to pay. A Paid
 *    settlement is never changed; a Pending one follows late settlements.
 */
async function recomputeAll() {
  const [partners, players] = await Promise.all([
    Partner.find(),
    User.find({ role: 'player', partner: { $ne: null } }).select('_id partner').lean(),
  ]);
  const partnerOf = new Map(players.map((p) => [String(p._id), String(p.partner)]));
  const ids = players.map((p) => p._id);

  const [volumeRows, ggrRows] = ids.length
    ? await Promise.all([
        Bet.aggregate([
          { $match: { user: { $in: ids }, status: { $ne: 'Void' } } },
          { $group: { _id: '$user', total: { $sum: '$amount' } } },
        ]),
        Transaction.aggregate([
          { $match: { user: { $in: ids }, type: { $in: ['Bet Win', 'Bet Loss'] }, status: 'Completed' } },
          {
            $group: {
              _id: { user: '$user', month: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: require('../utils/time').timezone() } } },
              total: { $sum: { $multiply: ['$amount', -1] } },
            },
          },
        ]),
      ])
    : [[], []];

  const volume = new Map();
  volumeRows.forEach((row) => {
    const key = partnerOf.get(String(row._id));
    volume.set(key, (volume.get(key) || 0) + row.total);
  });
  const ggr = new Map(); // partnerId -> Map(month -> house net win)
  ggrRows.forEach((row) => {
    const key = partnerOf.get(String(row._id.user));
    if (!ggr.has(key)) ggr.set(key, new Map());
    const months = ggr.get(key);
    months.set(row._id.month, (months.get(row._id.month) || 0) + row.total);
  });
  const playerCount = new Map();
  players.forEach((p) => playerCount.set(String(p.partner), (playerCount.get(String(p.partner)) || 0) + 1));

  const currentMonth = monthOf(new Date());
  for (const partner of partners) {
    const key = String(partner._id);
    const months = [...(ggr.get(key) || new Map()).entries()].sort(([a], [b]) => a.localeCompare(b));
    const history = months.map(([month, net]) => ({
      month,
      value: Math.round((Math.max(0, net) * (partner.revShare || 0)) / 100),
    }));

    partner.betVolume = volume.get(key) || 0;
    partner.playerCount = playerCount.get(key) || 0;
    partner.revenueHistory = history;
    // eslint-disable-next-line no-await-in-loop
    await partner.save();

    for (const { month, value } of history) {
      if (month >= currentMonth) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const existing = await PartnerSettlement.findOne({ partner: partner._id, period: month });
      if (existing?.status === 'Paid') continue; // eslint-disable-line no-continue
      if (existing) {
        if (existing.amount !== value) {
          existing.amount = value;
          // eslint-disable-next-line no-await-in-loop
          await existing.save();
        }
      } else if (value > 0) {
        // eslint-disable-next-line no-await-in-loop
        await PartnerSettlement.create({ partner: partner._id, period: month, amount: value });
      }
    }
  }
}

/** Several panel calls arrive together; they share one recompute instead of racing. */
let inFlight = null;
const recompute = () => {
  if (!inFlight) {
    inFlight = recomputeAll().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
};

const listPartners = async () => {
  await recompute();
  return Partner.find().sort({ createdAt: -1 });
};

const createPartner = async (data) => Partner.create({ ...pick(data), referralCode: await generatePartnerCode() });

const updatePartner = async (id, updates) => {
  const partner = await Partner.findByIdAndUpdate(id, pick(updates), { new: true, runValidators: true });
  if (!partner) throw ApiError.notFound('Partner not found');
  return partner;
};

const updatePartnerStatus = async (id, status) => {
  const partner = await Partner.findByIdAndUpdate(id, { status }, { new: true });
  if (!partner) throw ApiError.notFound('Partner not found');
  return partner;
};

const getRevenue = async () => {
  await recompute();
  const partners = await Partner.find().select('name revenueHistory betVolume revShare playerCount');
  const totalByMonth = {};
  partners.forEach((partner) => {
    partner.revenueHistory.forEach(({ month, value }) => {
      totalByMonth[month] = (totalByMonth[month] || 0) + value;
    });
  });
  return { partners, totalByMonth };
};

const listSettlements = async () => {
  await recompute();
  return PartnerSettlement.find().populate('partner', 'name type').sort({ period: -1, createdAt: -1 });
};

/** Records that a settlement was paid out; from then on recomputes leave it alone. */
const paySettlement = async (id, actor) => {
  const settlement = await PartnerSettlement.findOneAndUpdate(
    { _id: id, status: 'Pending' },
    { $set: { status: 'Paid', paidAt: new Date(), paidBy: actor._id } },
    { new: true },
  ).populate('partner', 'name type');
  if (settlement) return settlement;
  if (await PartnerSettlement.exists({ _id: id })) throw ApiError.conflict('This settlement is already paid');
  throw ApiError.notFound('Settlement not found');
};

/** The active partner a sign-up code belongs to, or null. */
const findActiveByCode = async (code) => Partner.findOne({ referralCode: code, status: 'Active' }).select('_id');

module.exports = {
  listPartners,
  createPartner,
  updatePartner,
  updatePartnerStatus,
  getRevenue,
  listSettlements,
  paySettlement,
  recompute,
  ensurePartnerCodes,
  findActiveByCode,
};
