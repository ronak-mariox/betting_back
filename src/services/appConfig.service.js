const CmsContent = require('../models/CmsContent');
const { cached, currency, timezone } = require('./settings.service');
const { forPlayers, forStaff } = require('./notification.service');

const toItem = (content) => ({
  _id: content._id,
  kind: content.kind,
  title: content.title,
  body: content.body,
  imageUrl: content.imageUrl || '',
  link: content.link || '',
  updatedAt: content.updatedAt,
});

/**
 * What the app and the panels show from Platform Settings and the CMS: support
 * contacts, currency, timezone, withdrawal processing time, the marquee
 * ticker and published banners (plus announcements for staff). Public — the
 * app's Help screen and the panel's login page need it before sign-in.
 */
async function getAppConfig(audience = 'player') {
  const settings = cached();
  const general = settings.general || {};
  const wallet = settings.walletRules || {};
  const staff = audience === 'staff';
  const published = await CmsContent.find({
    status: 'Published',
    kind: { $in: staff ? ['Banner', 'Announcement', 'Notice'] : ['Banner'] },
  })
    .sort({ updatedAt: -1 })
    .limit(20)
    .lean();
  const mine = published.filter(staff ? forStaff : forPlayers);
  return {
    platformName: settings.brand?.brandName || general.platformName || '',
    currency: currency(),
    timezone: timezone(),
    support: {
      email: general.supportEmail || '',
      phone: general.supportPhone || '',
      whatsapp: general.supportWhatsapp || '',
      telegram: general.supportTelegram || '',
      hours: general.supportHours || '',
    },
    wallet: {
      processingHours: Number(wallet.processingHours) || null,
      maxWithdrawalPerDay: Number(wallet.maxWithdrawal) || null,
    },
    /** Settings → General → App Download Link: what referral shares point to. */
    appLink: general.appLink || '',
    /** Settings → Commission → User Referral Bonus (% of the friend's first deposit); 0 = none. */
    referralBonusPercent: Number(settings.commissionRates?.referral) || 0,
    marquee: settings.cms?.marqueeText || '',
    banners: mine.filter((c) => c.kind === 'Banner').map(toItem),
    ...(staff ? { announcements: mine.filter((c) => c.kind !== 'Banner').map(toItem) } : {}),
  };
}

module.exports = { getAppConfig };
