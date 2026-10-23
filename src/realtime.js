const { Server } = require('socket.io');
const { corsOrigin } = require('./config/cors');
const User = require('./models/User');
const { verifyAccessToken } = require('./services/token.service');

/**
 * Live updates over Socket.IO. The odds feed is REST-only, so the backend
 * polls it once and pushes what changed to everyone listening:
 *
 *   rooms        who's in it                 events
 *   matches      every signed-in client      odds, matches:changed
 *   match:<id>   clients on that match       odds
 *   user:<id>    that account's devices      player:changed
 *   staff        panel (non-player) users    admin:changed, permissions:changed
 *   (everyone)   every connected client      config:changed
 *
 * Clients connect with `auth: { token: <access token> }`. Nothing here is
 * trusted for betting — a bet always takes the server's current price.
 */

let io = null;

/** Per-target coalescing, so a burst of writes sends one nudge. */
const pending = new Map();
function coalesce(key, ms, fire) {
  if (pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    fire();
  }, ms));
}

function init(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
    // Phones on mobile data drop and rejoin often; keep the heartbeat short.
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  io.use(async (socket, next) => {
    try {
      const payload = verifyAccessToken(socket.handshake.auth?.token);
      const user = await User.findById(payload.sub).select('role status');
      if (!user || user.status !== 'active') return next(new Error('unauthorized'));
      socket.data.user = { id: String(user._id), role: user.role };
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role } = socket.data.user;
    socket.join(['matches', `user:${id}`]);
    if (role !== 'player') socket.join('staff');

    // The match screen joins its match for every market's prices (the feed room carries them too).
    socket.on('match:join', (eventId) => {
      if (typeof eventId === 'string' && /^[a-f0-9]{24}$/i.test(eventId)) socket.join(`match:${eventId}`);
    });
    socket.on('match:leave', (eventId) => {
      if (typeof eventId === 'string') socket.leave(`match:${eventId}`);
    });
  });
  return io;
}

/** New prices / suspensions for some of a match's markets. */
function emitOdds(eventId, markets) {
  if (!io || !markets.length) return;
  io.to('matches').to(`match:${eventId}`).emit('odds', { eventId: String(eventId), markets });
}

/** The match list itself changed (a match went live / finished, a market opened or closed): refetch it. */
function emitMatchesChanged() {
  if (!io) return;
  coalesce('matches', 500, () => io.to('matches').emit('matches:changed'));
}

/** Something about this player's wallet or bets changed: their app refetches both. */
function emitPlayerChanged(userId) {
  if (!io || !userId) return;
  const id = String(userId);
  coalesce(`user:${id}`, 300, () => io.to(`user:${id}`).emit('player:changed'));
}

/** Bets / ledger moved: open panel pages refresh their figures. */
function emitStaffChanged(kind) {
  if (!io) return;
  coalesce(`staff:${kind}`, 1000, () => io.to('staff').emit('admin:changed', { kind }));
}

/** The Permissions page changed a role's grants: that role's panels reload their menu and buttons. */
function emitPermissionsChanged(roleKey) {
  if (!io) return;
  coalesce(`perm:${roleKey}`, 300, () => io.to('staff').emit('permissions:changed', { roleKey }));
}

/** Platform settings or published CMS content changed: clients refetch /api/app-config. */
function emitConfigChanged() {
  if (!io) return;
  coalesce('config', 500, () => io.emit('config:changed'));
}

const connectedCount = () => (io ? io.engine.clientsCount : 0);

module.exports = {
  init,
  emitOdds,
  emitMatchesChanged,
  emitPlayerChanged,
  emitStaffChanged,
  emitPermissionsChanged,
  emitConfigChanged,
  connectedCount,
};
