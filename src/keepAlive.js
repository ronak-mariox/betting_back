const cron = require('node-cron');

/**
 * Render's free tier puts a web service to sleep after 15 minutes without
 * traffic. Pinging our own /health every 10 minutes keeps it awake. Render
 * sets RENDER_EXTERNAL_URL itself; without it (local development) nothing runs.
 */
function startKeepAlive() {
  const baseUrl = process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl) {
    console.log('Keep-alive skipped'); // eslint-disable-line no-console
    return;
  }
  const url = `${baseUrl.replace(/\/$/, '')}/health`;

  cron.schedule('*/10 * * * *', async () => {
    try {
      const res = await fetch(url);
      console.log(`[${new Date().toISOString()}] Keep-alive ping ${url}: ${res.status}`); // eslint-disable-line no-console
    } catch (err) {
      // A failed ping must never take the server down.
      console.error(`[${new Date().toISOString()}] Keep-alive ping failed: ${err.message}`); // eslint-disable-line no-console
    }
  });
}

module.exports = { startKeepAlive };
