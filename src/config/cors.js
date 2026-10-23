const env = require('./env');

/**
 * Which browser origins may call the API and open the live socket.
 * CORS_ORIGINS is a comma-separated list; an entry may use `*` for any run
 * of characters, so every Vercel preview deploy of the panel matches one
 * line: https://betting-*-ronak-6443.vercel.app
 */
const patterns = env.corsOrigins.map((entry) =>
  entry.includes('*')
    ? new RegExp(`^${entry.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('[a-z0-9-]*')}$`, 'i')
    : entry.replace(/\/$/, ''),
);

const isAllowedOrigin = (origin) =>
  patterns.some((pattern) => (pattern instanceof RegExp ? pattern.test(origin) : pattern === origin));

/** For the `cors` package and Socket.IO. Requests without an Origin (apps, curl, server pings) are let through. */
const corsOrigin = (origin, callback) => callback(null, !origin || isAllowedOrigin(origin));

module.exports = { corsOrigin, isAllowedOrigin };
