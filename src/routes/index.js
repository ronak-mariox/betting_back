const os = require('os');
const mongoose = require('mongoose');
const Event = require('../models/Event');
const { Router } = require('express');
const { optionalAuthenticate } = require('../middleware/auth');
const authRoutes = require('./auth.routes');
const accountRoutes = require('./account.routes');
const permissionRoutes = require('./permission.routes');
const walletRoutes = require('./wallet.routes');
const transactionRoutes = require('./transaction.routes');
const eventRoutes = require('./event.routes');
const marketRoutes = require('./market.routes');
const bettingRoutes = require('./betting.routes');
const riskRoutes = require('./risk.routes');
const commissionRoutes = require('./commission.routes');
const partnershipRoutes = require('./partnership.routes');
const reportRoutes = require('./report.routes');
const analyticsRoutes = require('./analytics.routes');
const cmsRoutes = require('./cms.routes');
const notificationRoutes = require('./notification.routes');
const supportRoutes = require('./support.routes');
const settingsRoutes = require('./settings.routes');
const dashboardRoutes = require('./dashboard.routes');
const networkRoutes = require('./network.routes');
const playerRoutes = require('./player.routes');

const router = Router();

/**
 * Liveness plus the figures the panels' topbar / status bar show: DB round
 * trip, CPU load, process uptime and how many matches are in play.
 */
router.get('/health', async (_req, res) => {
  const started = Date.now();
  let dbOk = true;
  try {
    await mongoose.connection.db.admin().ping();
  } catch {
    dbOk = false;
  }
  const dbMs = Date.now() - started;
  const liveMatches = dbOk ? await Event.countDocuments({ status: 'Live' }) : 0;
  const cpu = Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100));
  // eslint-disable-next-line global-require
  const liveClients = require('../realtime').connectedCount();
  res.json({ status: dbOk ? 'ok' : 'degraded', dbMs, cpu, uptimeSeconds: Math.round(process.uptime()), liveMatches, liveClients });
});

/** Public brand (name, tagline, logo, colours) for the panel's theme — the login page needs it before sign-in. */
router.get('/branding', async (_req, res, next) => {
  try {
    // eslint-disable-next-line global-require
    res.json({ branding: await require('../services/settings.service').getBranding() });
  } catch (err) {
    next(err);
  }
});

/** Support contacts, currency, marquee, banners… for the app / panels (see appConfig.service.js). */
// Public (the app's Help screen and the login page need it); staff announcements only with a staff token.
router.get('/app-config', optionalAuthenticate, async (req, res, next) => {
  try {
    const audience = req.user && req.user.role !== 'player' ? 'staff' : 'player';
    // eslint-disable-next-line global-require
    res.json({ config: await require('../services/appConfig.service').getAppConfig(audience) });
  } catch (err) {
    next(err);
  }
});

router.use('/auth', authRoutes);
router.use('/accounts', accountRoutes);
router.use('/permissions', permissionRoutes);
router.use('/wallet', walletRoutes);
router.use('/transactions', transactionRoutes);
router.use('/events', eventRoutes);
router.use('/markets', marketRoutes);
router.use('/betting', bettingRoutes);
router.use('/risk', riskRoutes);
router.use('/commission', commissionRoutes);
router.use('/partnership', partnershipRoutes);
router.use('/reports', reportRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/cms', cmsRoutes);
router.use('/notifications', notificationRoutes);
router.use('/support', supportRoutes);
router.use('/settings', settingsRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/network', networkRoutes);
router.use('/player', playerRoutes);

module.exports = router;
