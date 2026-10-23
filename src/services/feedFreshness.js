/**
 * How fresh a feed (Diamond) market's prices must be to count as live.
 * Bets and cash-outs are refused on older prices, and the app shows the
 * market as paused instead of passing old prices off as live ones.
 * Markets created in the panel (no externalId) are never stale.
 */
const LIVE_MAX_AGE_MS = 20 * 1000;
const UPCOMING_MAX_AGE_MS = 5 * 60 * 1000;

const maxAgeFor = (event) => (event?.status === 'Live' ? LIVE_MAX_AGE_MS : UPCOMING_MAX_AGE_MS);

/** True when a feed market's last price update is too old to trust. */
function isStale(event, market, now = Date.now()) {
  if (!market?.externalId) return false;
  if (!market.oddsAt) return true;
  return now - new Date(market.oddsAt).getTime() > maxAgeFor(event);
}

module.exports = { isStale, maxAgeFor, LIVE_MAX_AGE_MS, UPCOMING_MAX_AGE_MS };
