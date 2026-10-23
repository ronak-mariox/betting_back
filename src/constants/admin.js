/** Shared enums for the super-admin panel's modules (wallet, betting, risk, commission, …). */
const TRANSACTION_TYPES = ['Deposit', 'Withdrawal', 'Bet Win', 'Bet Loss', 'Adjustment', 'Commission', 'Payment', 'Referral Bonus'];
const TRANSACTION_STATUSES = ['Pending', 'Completed', 'Failed'];

const WALLET_REQUEST_KINDS = ['deposit', 'withdrawal'];
const WALLET_REQUEST_STATUSES = ['Pending', 'Approved', 'Rejected'];

/** Sports players can bet on for now; events for anything else can't be created. */
const ENABLED_SPORTS = ['Cricket'];

const EVENT_STATUSES = ['Live', 'Upcoming', 'Suspended', 'Completed', 'Settled'];
const MARKET_STATUSES = ['Active', 'Suspended'];
const BET_STATUSES = ['Pending', 'Won', 'Lost', 'Void', 'Cashed Out'];

const COMMISSION_LEVELS = ['Franchise', 'Super Agent', 'Agent', 'Player'];
const COMMISSION_STATUSES = ['Pending', 'Settled'];
/**
 * Session: markets decided during the match (toss, fancy, over runs, odd/even, …), paid on stake.
 * Match: markets decided by the result (Match Odds, Bookmaker, …), paid on the player's net loss.
 */
const COMMISSION_KINDS = ['Session', 'Match'];

const PARTNER_STATUSES = ['Active', 'Inactive', 'Pending'];

const TICKET_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const TICKET_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

const CMS_KINDS = ['Announcement', 'Banner', 'Promotion', 'Notice'];
const CMS_STATUSES = ['Draft', 'Published', 'Archived'];
/** Who a CMS item is for: everyone, the app's players, or the staff panels. */
const CMS_TARGETS = ['All', 'Players', 'Staff'];

/** risk / wallet / general feed the admin panel; the rest are the player app's (notification.service.js#notifyPlayer). */
const NOTIFICATION_CATEGORIES = ['risk', 'wallet', 'general', 'bet', 'live', 'security', 'promo'];
/** Screen a player notification opens in the app when tapped. */
const NOTIFICATION_LINKS = ['', 'wallet', 'bets', 'live', 'profile'];

module.exports = {
  TRANSACTION_TYPES,
  TRANSACTION_STATUSES,
  WALLET_REQUEST_KINDS,
  WALLET_REQUEST_STATUSES,
  ENABLED_SPORTS,
  EVENT_STATUSES,
  MARKET_STATUSES,
  BET_STATUSES,
  COMMISSION_LEVELS,
  COMMISSION_STATUSES,
  COMMISSION_KINDS,
  PARTNER_STATUSES,
  TICKET_STATUSES,
  TICKET_PRIORITIES,
  CMS_KINDS,
  CMS_STATUSES,
  CMS_TARGETS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_LINKS,
};
