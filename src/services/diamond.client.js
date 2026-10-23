const env = require('../config/env');

/**
 * Thin client for the Diamond odds feed (see http://77.37.44.135:3009/docs).
 * The key travels as `?key=`. Requests carry an explicit Accept header —
 * without one some endpoints hang instead of answering.
 */

const TIMEOUT_MS = 15000;
const CRICKET_SID = 4;

/**
 * The key: an Active entry named "Diamond" on Platform Settings → API Keys,
 * else DIAMOND_API_KEY from the environment. Switching it in the panel takes
 * effect on the next request.
 */
const keyEntry = () => {
  // eslint-disable-next-line global-require
  const entry = (require('./settings.service').cached().apiKeys || []).find(
    (k) => /diamond/i.test(k.name) && k.status === 'Active' && k.key,
  );
  return entry ? { id: entry._id, key: entry.key } : { id: null, key: env.diamond.apiKey };
};

const isConfigured = () => Boolean(keyEntry().key);

/** The panel shows how fast the feed answers; saved at most once a minute. */
let latencySavedAt = 0;
const noteLatency = (id, ms) => {
  if (!id || Date.now() - latencySavedAt < 60000) return;
  latencySavedAt = Date.now();
  // eslint-disable-next-line global-require
  require('./settings.service').recordApiLatency(id, ms).catch(() => null);
};

async function request(method, path, { query = {}, body } = {}) {
  const { id, key } = keyEntry();
  const url = new URL(`${env.diamond.baseUrl}${path}`);
  Object.entries({ ...query, key }).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const started = Date.now();
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'betting-backend/1.0' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  noteLatency(id, Date.now() - started);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Diamond ${path}: non-JSON response (${res.status})`);
  }
  if (!res.ok && !json?.message) {
    // Name the match / market, so a log line says which one Diamond refused and why.
    const subject = query.gmid ?? (body && `${body.event_id} ${body.market_name}`);
    const why = json?.error ? ` "${json.error}"` : '';
    throw new Error(`Diamond ${path}${subject ? ` (${subject})` : ''}: HTTP ${res.status}${why}`);
  }
  return json;
}

/** Live + upcoming cricket matches: `t1` holds real fixtures, `t2` virtual / e-cricket ones. */
async function cricketMatches() {
  const json = await request('GET', '/esid', { query: { sid: CRICKET_SID } });
  if (!json?.success) throw new Error(`Diamond /esid: ${json?.msg || json?.message || 'failed'}`);
  return { real: json.data?.t1 || [], virtual: json.data?.t2 || [] };
}

/** Every market (Match Odds, Bookmaker, fancy, …) with current prices for one match. */
async function matchMarkets(gmid) {
  const json = await request('GET', '/getPriveteData', { query: { gmid, sid: CRICKET_SID } });
  if (!json?.success) throw new Error(`Diamond /getPriveteData ${gmid}: ${json?.msg || json?.message || 'failed'}`);
  return json.data || [];
}

/** Tells Diamond a market has bets on it, so its result gets declared to us. */
const registerPlacedBets = (payload) => request('POST', '/placed_bets', { body: payload });

/** The declared result of a market, or `{ message: 'result is not declared yet' }`. */
const marketResult = (payload) => request('POST', '/get-result', { body: payload });

module.exports = { isConfigured, cricketMatches, matchMarkets, registerPlacedBets, marketResult, CRICKET_SID };
