/**
 * "Today" in the platform's timezone (Settings → General → Timezone), not the
 * server's — an AWS box runs on UTC while the business day is India's.
 */
const { timezone } = require('../services/settings.service');

/** Offset (ms) of `tz` from UTC at the instant `date`. */
function offsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Midnight that starts the platform's day `offsetDays` from today (0 = today, -1 = yesterday). */
function startOfDay(offsetDays = 0, tz = timezone()) {
  const now = new Date();
  const local = new Date(now.getTime() + offsetMs(now, tz));
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offsetDays);
  // Convert local midnight back to an instant, using the offset in force at that midnight.
  const guess = new Date(midnightLocal - offsetMs(now, tz));
  return new Date(midnightLocal - offsetMs(guess, tz));
}

/** "YYYY-MM-DD" of `date` in the platform's timezone. */
const dayKey = (date, tz = timezone()) => date.toLocaleDateString('en-CA', { timeZone: tz });

module.exports = { startOfDay, dayKey, timezone };
