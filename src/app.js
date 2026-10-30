const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { corsOrigin } = require('./config/cors');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Public liveness check for uptime pings (see keepAlive.js); registered before every other middleware.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', time: Date.now() });
});

app.use(helmet());
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);
// Raised from Express's 100kb default so a base64-encoded profile photo (see
// User.avatar) fits comfortably in the request body.
// A deposit request carries the payment screenshot (up to 5MB, base64).
app.use('/api/player/wallet/requests', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '3mb' }));

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
