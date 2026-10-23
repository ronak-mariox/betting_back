const http = require('http');
const app = require('./src/app');
const realtime = require('./src/realtime');
const env = require('./src/config/env');
const { connectDb } = require('./src/config/db');
const { runBootstrap } = require('./src/services/bootstrap.service');
const { startSettingsCache } = require('./src/services/settings.service');
const { startScheduler: startRiskScans } = require('./src/services/riskDetection.service');
const { start: startDiamondFeed } = require('./src/services/diamondSync.service');
const { startScheduler: startCommission } = require('./src/services/commission.service');
const { startKeepAlive } = require('./src/keepAlive');

async function start() {
  await connectDb();
  console.log('Connected to MongoDB'); // eslint-disable-line no-console

  await runBootstrap();
  // Platform settings in memory (currency, timezone, limits, Diamond key) — see settings.service.js.
  await startSettingsCache();
  // Risk detection runs shortly after boot and every 10 minutes (riskDetection.service.js).
  startRiskScans();
  // Real cricket fixtures and prices from the Diamond feed (no-op without DIAMOND_API_KEY).
  startDiamondFeed();
  // Session + match commission for every finished match, checked each minute (commission.service.js).
  startCommission();

  // One HTTP server for the REST API and the Socket.IO live updates.
  const server = http.createServer(app);
  realtime.init(server);
  server.listen(env.port, () => {
    console.log(`Auth/authorization API listening on port ${env.port}`); // eslint-disable-line no-console
    // Render free tier: ping our own /health every 10 minutes so the service never sleeps.
    startKeepAlive();
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err); // eslint-disable-line no-console
  process.exit(1);
});
