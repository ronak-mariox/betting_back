const User = require('../models/User');
const Transaction = require('../models/Transaction');

const escapeRegex = require('../utils/escapeRegex');
const { applyScope } = require('./scope.service');

const DEFAULT_PAGE_LIMIT = 20;

const TAB_TYPES = {
  deposits: ['Deposit'],
  withdrawals: ['Withdrawal'],
  bets: ['Bet Win', 'Bet Loss'],
  commission: ['Commission', 'Referral Bonus'],
  payments: ['Payment'],
  adjustments: ['Adjustment'],
};

const listTransactions = async ({ tab, q, page = 1, limit = DEFAULT_PAGE_LIMIT, scope = null }) => {
  const filter = applyScope({}, scope);
  if (tab && TAB_TYPES[tab]) filter.type = { $in: TAB_TYPES[tab] };

  if (q) {
    const regex = new RegExp(escapeRegex(q), 'i');
    // Also by who it belongs to — the usual way staff look a payment up.
    const people = await User.find(applyScope({ $or: [{ name: regex }, { username: regex }] }, scope, '_id'), '_id').lean();
    filter.$or = [{ reference: regex }, { note: regex }, { method: regex }, { user: { $in: people.map((p) => p._id) } }];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    Transaction.find(filter)
      .populate('user', 'name username')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Transaction.countDocuments(filter),
  ]);

  return { items, total, page: Number(page), limit: Number(limit) };
};

module.exports = { listTransactions };
