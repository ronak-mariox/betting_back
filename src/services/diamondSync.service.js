const env = require('../config/env');
const Event = require('../models/Event');
const Market = require('../models/Market');
const Bet = require('../models/Bet');
const diamond = require('./diamond.client');
const notificationService = require('./notification.service');
const ApiProvider = require('../models/ApiProvider');
const realtime = require('../realtime');
const { isStale } = require('./feedFreshness');

const PROVIDER_NAME = 'Diamond (Cricket)';

/**
 * While the feed is unreachable every call fails every second; one line per
 * kind of failure per minute is enough to see it, without flooding the log.
 */
const lastLogged = new Map();
function logFailure(kind, message) {
  const key = `${kind}|${message}`;
  const now = Date.now();
  if (now - (lastLogged.get(key) || 0) < 60 * 1000) return;
  lastLogged.set(key, now);
  console.error(`diamond ${kind}: ${message} (repeats are muted for a minute)`); // eslint-disable-line no-console
}
let feedDown = false;
/** Outcome of the last few match-list calls, for the provider card's uptime figure. */
const recentCalls = [];

/**
 * Keeps Events / Markets in step with the Diamond cricket feed:
 *  - the match list (real fixtures only; virtual / e-cricket are skipped),
 *  - prices for each match's back markets: Match Odds, Tied Match,
 *    Bookmaker (its "rate" turned into decimal odds) and fancy1 props,
 *  - results: markets with bets are registered with Diamond and polled
 *    until it declares a winner, then settled (or voided) the usual way.
 *
 * Every market type Diamond sends for a match is imported and kept live:
 *  - back markets (pick a selection at decimal odds): Match Odds / Tied Match
 *    (`match`), Bookmaker and player-vs-player (`match1`, rate → decimal),
 *    fancy1 propositions (Yes), odd / even (`oddeven`) and last-digit
 *    number markets (`cricketcasino`);
 *  - session markets (No / Yes on a run line at a rate): `fancy` (Normal,
 *    Over By Over, …) and `fancy2` line markets;
 *  - meter (and any type not known yet) is shown live but not open for bets.
 *
 * An admin's suspension (Event/Market.adminSuspended) always wins over the
 * feed, and settled markets are never touched.
 */

const SPORT = 'Cricket';
/** A fixture missing from this many list syncs in a row is treated as finished. */
const MISSES_TO_FINISH = 3;
/** A not-yet-live fixture missing this long after its start time is treated as over. */
const MISSING_GRACE_MS = 12 * 60 * 60 * 1000;

const missCount = new Map();
const lastOddsAt = new Map();
/**
 * Diamond answers 400 "something went wrong" for a match it no longer serves
 * (finished, or replaced by a new id). Such a match is retried after this
 * pause instead of every second, until the match list retires it.
 */
const ODDS_FAILURE_BACKOFF_MS = 30 * 1000;

// ------------------------------------------------------------------ parsing

/** Diamond start times are India time, "10/9/2026 7:00:00 PM". */
function parseStartTime(stime) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ?(AM|PM)$/i.exec(String(stime || '').trim());
  if (!m) return new Date();
  let hour = Number(m[4]) % 12;
  if (m[7].toUpperCase() === 'PM') hour += 12;
  const utc = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]), Number(m[6]));
  return new Date(utc - 330 * 60 * 1000);
}

const titleCase = (s) => String(s).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** A section's price level ("back1", "lay1") as { odds, size }; zeros when missing. */
const level = (section, name) => {
  const o = section.odds?.find((x) => x.oname === name);
  return { odds: Number(o?.odds) || 0, size: Number(o?.size) || 0 };
};
const backPrice = (section) => level(section, 'back1').odds || Number(section.odds?.find((o) => o.otype === 'back')?.odds) || 0;

const sectionOpen = (section) => !/SUSPEND|CLOSED|BALL|INACTIVE/i.test(section.gstatus || '');
/** What a closed section says ("Ball Running", "SUSPENDED") — shown on the market. */
const sectionNote = (section) => (sectionOpen(section) ? '' : titleCase(section.gstatus || 'Suspended'));

/** Bookmaker prices come as a "rate" (24 = 1.24 in decimal odds). */
const toDecimal = (gtype, price) => (gtype === 'match1' ? (price > 0 ? 1 + price / 100 : 0) : price);

const round2 = (n) => Math.round(n * 100) / 100;
/** Decimal equivalents of a session side, so wallet / settlement maths stay one formula: payout = held × odds. */
const sessionOdds = (side, rate) => (rate > 0 ? (side === 'Yes' ? 1 + rate / 100 : 1 + 100 / rate) : 0);

/** The tab a market is listed under in the app. */
const GROUPS = { match: 'Match Odds', match1: 'Bookmaker', fancy1: 'Fancy', fancy2: 'Line', oddeven: 'Odd Even', cricketcasino: 'Number', meter: 'Meter' };

/**
 * No / Yes on a run line. `fancy` sends Yes as back1 and No as lay1, each
 * { odds: line, size: rate }; `fancy2` line markets are exchange-style
 * (back = under at the lower line, lay = over at the higher one, even money).
 * The No line can never sit above the Yes line, or both sides could win.
 */
function sessionRunners(gtype, section) {
  const open = sectionOpen(section);
  let no;
  let yes;
  if (gtype === 'fancy2') {
    no = { line: level(section, 'back1').odds, rate: 100 };
    yes = { line: level(section, 'lay1').odds, rate: 100 };
  } else {
    no = { line: level(section, 'lay1').odds, rate: level(section, 'lay1').size };
    yes = { line: level(section, 'back1').odds, rate: level(section, 'back1').size };
  }
  const sane = no.line > 0 && yes.line > 0 && no.line <= yes.line;
  return [
    { name: 'No', ...no, price: round2(sessionOdds('No', no.rate)), active: open && sane && no.rate > 0, externalId: `${section.sid}:no` },
    { name: 'Yes', ...yes, price: round2(sessionOdds('Yes', yes.rate)), active: open && sane && yes.rate > 0, externalId: `${section.sid}:yes` },
  ];
}

/**
 * Diamond market → the markets this platform stores. Match Odds style
 * markets map 1:1; fancy-style ones hold independent propositions (one per
 * section: "35 over run AUS", "IND Will Win Toss"), each its own market.
 */
function mapMarkets(raw) {
  const out = [];
  for (const m of raw) {
    const marketOpen = /OPEN|ACTIVE/i.test(m.status || '');
    const remark = String(m.rem || '').trim();
    const sections = m.section || [];
    const perSection = (build) =>
      sections.forEach((section) => {
        const base = {
          externalId: `${m.mid}:${section.sid}`,
          providerType: m.gtype,
          providerName: section.nat,
          code: `DMD-${m.mid}-${section.sid}`,
          name: section.nat,
          maxBet: Number(section.max) || Number(m.max) || 0,
          remark: [String(section.rem || '').trim(), sectionNote(section)].filter(Boolean).join(' · '),
        };
        out.push({ ...base, ...build(section) });
      });

    if (m.gtype === 'fancy1') {
      perSection((section) => {
        const price = backPrice(section);
        return {
          type: 'Fancy',
          group: 'Fancy',
          betStyle: 'back',
          open: marketOpen && sectionOpen(section) && price >= 1.01,
          runners: [{ name: 'Yes', price, active: sectionOpen(section) && price >= 1.01, externalId: String(section.sid) }],
        };
      });
    } else if (m.gtype === 'fancy' || m.gtype === 'fancy2' || m.gtype === 'meter') {
      // fancy: one market per proposition, grouped by Diamond's tab ("Normal", "Over By Over").
      const group = m.gtype === 'fancy' ? titleCase(m.mname || 'Session') : GROUPS[m.gtype];
      perSection((section) => {
        const runners = sessionRunners(m.gtype, section);
        const view = m.gtype === 'meter';
        return {
          // fancy2 sections are named generically ("Total Runs"): the market name says which line.
          name: m.gtype === 'fancy2' && sections.length === 1 ? m.mname : section.nat,
          type: 'Session',
          group,
          betStyle: view ? 'view' : 'session',
          open: marketOpen && runners.some((r) => r.active),
          runners: view ? runners.map((r) => ({ ...r, active: false })) : runners,
        };
      });
    } else if (m.gtype === 'oddeven') {
      perSection((section) => {
        const odd = level(section, 'back1').odds;
        const even = level(section, 'lay1').odds;
        const open = sectionOpen(section);
        return {
          type: 'Odd Even',
          group: GROUPS.oddeven,
          betStyle: 'back',
          open: marketOpen && open && (odd >= 1.01 || even >= 1.01),
          runners: [
            { name: 'Odd', price: round2(odd), active: open && odd >= 1.01, externalId: `${section.sid}:odd` },
            { name: 'Even', price: round2(even), active: open && even >= 1.01, externalId: `${section.sid}:even` },
          ],
        };
      });
    } else if (m.gtype === 'match' || m.gtype === 'match1' || m.gtype === 'cricketcasino') {
      const runners = sections.map((section) => {
        const price = round2(toDecimal(m.gtype, backPrice(section)));
        return { name: section.nat, price, active: sectionOpen(section) && price >= 1.01, externalId: String(section.sid) };
      });
      if (runners.length < 2) continue; // eslint-disable-line no-continue
      const name =
        m.mname === 'MATCH_ODDS' ? 'Match Odds' : m.gtype === 'match1' && /^bookmaker$/i.test(m.mname) ? 'Bookmaker' : m.gtype === 'match1' ? m.mname : titleCase(m.mname);
      out.push({
        externalId: String(m.mid),
        providerType: m.gtype,
        providerName: m.mname,
        code: `DMD-${m.mid}`,
        name,
        type: m.gtype === 'match' ? 'Match Odds' : m.gtype === 'match1' ? 'Bookmaker' : 'Number',
        // Match Odds / Tied Match / Bookmaker each get their own tab; number markets share one.
        group: m.gtype === 'cricketcasino' ? GROUPS.cricketcasino : name,
        betStyle: 'back',
        remark,
        open: marketOpen,
        maxBet: Number(m.max) || 0, // feed's stake cap (`maxb` is only a flag)
        runners,
      });
    } else {
      // A type this platform doesn't know yet: still shown, read-only, so nothing the feed sends is hidden.
      perSection((section) => ({
        type: titleCase(m.gtype || 'Other'),
        group: titleCase(m.mname || m.gtype || 'Other'),
        betStyle: 'view',
        open: marketOpen,
        runners: (section.odds || [])
          .filter((o) => Number(o.odds) > 0)
          .slice(0, 6)
          .map((o) => ({ name: titleCase(o.oname || o.otype), price: Math.max(1.01, Number(o.odds)), active: false, externalId: `${section.sid}:${o.oname}` })),
      }));
    }
  }
  return out;
}

// --------------------------------------------------------------- the match list

const isRealFixture = (m) => Number(m.iscc) === 0 && !/\(e\)|virtual|dim cricket/i.test(`${m.ename} ${m.cname}`);

/** Records how the feed answered on the Betting page's provider card (and the dashboard health). */
async function recordHealth(ok, latency) {
  if (!ok && !feedDown) console.warn('Diamond feed unreachable — matches shown paused until it answers again'); // eslint-disable-line no-console
  if (ok && feedDown) console.log('Diamond feed reachable again — live prices resumed'); // eslint-disable-line no-console
  feedDown = !ok;
  recentCalls.push(ok);
  if (recentCalls.length > 100) recentCalls.shift();
  const uptime = Math.round((recentCalls.filter(Boolean).length / recentCalls.length) * 1000) / 10;
  const marketsCount = await Market.countDocuments({ externalId: { $ne: null }, status: 'Active' });
  await ApiProvider.updateOne(
    { name: PROVIDER_NAME },
    {
      $set: {
        status: ok ? 'Connected' : 'Disconnected',
        healthy: ok,
        uptime,
        marketsCount,
        ...(ok ? { latency, lastSyncAt: new Date() } : {}),
      },
    },
    { upsert: true },
  );
}

async function syncMatchList() {
  const started = Date.now();
  let real;
  try {
    ({ real } = await diamond.cricketMatches());
  } catch (err) {
    await recordHealth(false).catch(() => null);
    throw err;
  }
  await recordHealth(true, Date.now() - started).catch(() => null);
  const fixtures = real.filter(isRealFixture);
  const seen = new Set();

  for (const m of fixtures) {
    const externalId = String(m.gmid);
    seen.add(externalId);
    missCount.delete(externalId);
    // eslint-disable-next-line no-await-in-loop
    const existing = await Event.findOne({ provider: 'diamond', externalId });
    if (existing && ['Completed', 'Settled'].includes(existing.status)) continue;

    const wanted = existing?.adminSuspended ? 'Suspended' : m.iplay ? 'Live' : 'Upcoming';
    const fields = {
      sport: SPORT,
      league: m.cname || '',
      name: String(m.ename || '').replace(/\s+/g, ' ').trim(),
      emoji: '🏏',
      startTime: parseStartTime(m.stime),
      status: wanted,
      hasStream: Boolean(m.tv),
      syncedAt: new Date(),
      feedMissingSince: null,
    };
    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      const created = await Event.create({ ...fields, provider: 'diamond', externalId });
      realtime.emitMatchesChanged();
      if (created.status === 'Live') await notificationService.notifyMatchLive(created).catch(() => null); // eslint-disable-line no-await-in-loop
    } else {
      const wentLive = existing.status !== 'Live' && wanted === 'Live';
      if (existing.status !== wanted) realtime.emitMatchesChanged();
      existing.set(fields);
      // eslint-disable-next-line no-await-in-loop
      await existing.save();
      if (wentLive) await notificationService.notifyMatchLive(existing).catch(() => null); // eslint-disable-line no-await-in-loop
    }
  }

  // A fixture that dropped off the feed: a live one is over; one that hasn't
  // started yet may be postponed or briefly pulled, so it is only held
  // (Suspended, prices not polled) and reopens if it comes back — unless it is
  // still missing long after its start time. A single empty or failed answer
  // must not touch anything, so it takes a few misses in a row.
  if (!fixtures.length) return { fixtures: 0 };
  const open = await Event.find({ provider: 'diamond', status: { $in: ['Live', 'Upcoming', 'Suspended'] } });
  for (const event of open) {
    if (seen.has(event.externalId)) continue; // eslint-disable-line no-continue
    const misses = (missCount.get(event.externalId) || 0) + 1;
    missCount.set(event.externalId, misses);
    if (misses < MISSES_TO_FINISH) continue; // eslint-disable-line no-continue
    missCount.delete(event.externalId);
    const over = event.status === 'Live' || Date.now() > new Date(event.startTime).getTime() + MISSING_GRACE_MS;
    if (!over && event.feedMissingSince) continue; // eslint-disable-line no-continue
    if (over) {
      event.status = 'Completed';
    } else {
      event.status = 'Suspended';
      event.feedMissingSince = new Date();
    }
    // eslint-disable-next-line no-await-in-loop
    await event.save();
    realtime.emitMatchesChanged();
    // eslint-disable-next-line no-await-in-loop
    await Market.updateMany({ event: event._id, status: 'Active' }, { $set: { status: 'Suspended' } });
  }
  return { fixtures: fixtures.length };
}

// ---------------------------------------------------------------------- odds

async function syncEventOdds(event) {
  const mapped = mapMarkets(await diamond.matchMarkets(event.externalId));
  const now = new Date();
  const seen = new Set();
  const eventOpen = event.status === 'Live' || event.status === 'Upcoming';

  const stored = new Map(
    (await Market.find({ event: event._id, externalId: { $ne: null } })).map((doc) => [doc.externalId, doc]),
  );
  const changed = []; // pushed to clients as { _id, name, type, status, maxBet, runners }
  let listChanged = false; // a market opened, closed or appeared: clients refetch the list

  for (const m of mapped) {
    seen.add(m.externalId);
    const existing = stored.get(m.externalId);
    if (existing?.winner) continue; // settled: frozen
    // A price must stay ≥ 1.01 to be stored; a suspended selection keeps its last good price.
    const runners = m.runners.map((r) => {
      const prev = existing?.runners?.find((p) => p.externalId === r.externalId || p.name === r.name);
      return {
        name: r.name,
        odds: r.price >= 1.01 ? r.price : prev?.odds || 1.01,
        active: r.active,
        externalId: r.externalId,
        line: r.line ?? null,
        rate: r.rate ?? null,
      };
    });
    const status = m.open && eventOpen && !existing?.adminSuspended ? 'Active' : 'Suspended';
    const fields = {
      name: m.name,
      type: m.type,
      group: m.group,
      betStyle: m.betStyle,
      remark: m.remark || '',
      providerType: m.providerType,
      providerName: m.providerName,
      runners,
      backOdds: runners[0]?.odds || 0,
      layOdds: runners[1]?.odds || 0,
      status,
      ...(m.maxBet > 0 ? { maxBet: m.maxBet } : {}),
    };
    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      await Market.create({ event: event._id, externalId: m.externalId, code: m.code, oddsAt: now, ...fields });
      if (status === 'Active') listChanged = true;
      continue; // eslint-disable-line no-continue
    }
    const priceKey = (rs) => rs.map((r) => `${r.name}|${r.odds}|${r.line ?? ''}|${r.rate ?? ''}|${r.active !== false}`).join(';');
    const differs =
      existing.status !== status ||
      existing.name !== fields.name ||
      existing.remark !== fields.remark ||
      existing.betStyle !== fields.betStyle ||
      existing.group !== fields.group ||
      existing.providerName !== fields.providerName ||
      priceKey(existing.runners) !== priceKey(runners) ||
      (fields.maxBet !== undefined && existing.maxBet !== fields.maxBet);
    if (!differs) continue; // eslint-disable-line no-continue
    // Session / fancy lines flip suspended every ball: the odds push carries that; only the
    // headline markets opening or closing makes clients refetch the match list.
    if (existing.status !== status && existing.betStyle !== 'session' && fields.type !== 'Fancy') listChanged = true;
    // eslint-disable-next-line no-await-in-loop
    await Market.updateOne({ _id: existing._id }, { $set: fields });
    changed.push({
      _id: String(existing._id),
      name: fields.name,
      type: fields.type,
      group: fields.group,
      betStyle: fields.betStyle,
      remark: fields.remark,
      status,
      maxBet: fields.maxBet ?? existing.maxBet,
      runners: runners.map(({ name, odds, active, line, rate }) => ({ name, odds, active, line, rate })),
    });
  }

  // Unchanged prices are still fresh prices: one write keeps every market's oddsAt current.
  await Market.updateMany({ event: event._id, externalId: { $in: [...seen] } }, { $set: { oddsAt: now } });

  // Markets the feed no longer offers are closed for betting (never deleted: bets may sit on them).
  const closed = await Market.updateMany(
    { event: event._id, externalId: { $ne: null, $nin: [...seen] }, status: 'Active', winner: { $in: ['', null] } },
    { $set: { status: 'Suspended' } },
  );
  if (closed.modifiedCount) listChanged = true;

  realtime.emitOdds(event._id, changed);
  if (listChanged) realtime.emitMatchesChanged();
  lastOddsAt.set(String(event._id), Date.now());
  return mapped.length;
}

/** Live matches every few seconds, upcoming ones about once a minute. */
async function syncDueOdds() {
  const events = await Event.find({ provider: 'diamond', status: { $in: ['Live', 'Upcoming', 'Suspended'] }, feedMissingSince: null });
  const now = Date.now();
  await Promise.all(
    events
      .filter((e) => now - (lastOddsAt.get(String(e._id)) || 0) >= (e.status === 'Live' ? env.diamond.liveOddsMs : env.diamond.upcomingOddsMs))
      .map((e) =>
        syncEventOdds(e).catch((err) => {
          lastOddsAt.set(String(e._id), Date.now() + ODDS_FAILURE_BACKOFF_MS);
          logFailure('odds', err.message);
        }),
      ),
  );
}

// ------------------------------------------------------------------- results

/** What Diamond expects to identify a market (fancy propositions go by their own name). */
/** The market's name at Diamond. Markets stored before `providerName` existed: "Match Odds" -> "MATCH_ODDS". */
const providerNameOf = (market) =>
  market.providerName || (market.providerType === 'match' ? market.name.toUpperCase().replace(/\s+/g, '_') : market.name);

/** Diamond's result `market_type` per feed type (match markets go by their own name, e.g. MATCH_ODDS). */
const RESULT_TYPES = {
  match1: 'BOOKMAKER',
  fancy1: 'FANCY',
  fancy: 'FANCY',
  fancy2: 'FANCY',
  oddeven: 'ODDEVEN',
  meter: 'METER',
  cricketcasino: 'CRICKETCASINO',
};

const resultPayload = (event, market) => ({
  event_id: Number(event.externalId),
  event_name: event.name,
  market_id: Number(String(market.externalId).split(':')[0]),
  market_name: providerNameOf(market),
  market_type: RESULT_TYPES[market.providerType] || providerNameOf(market),
});

/** Pulls a winner out of whatever shape the result comes in. */
function readResult(json) {
  const candidates = [json?.result, json?.data?.result, json?.winner, json?.data?.winner, json?.data?.nat, json?.data]
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v).trim())
    .filter(Boolean);
  return candidates[0] || null;
}

const VOID_WORDS = /abandon|cancel|void|no result|refund/i;

async function settleFromResult(event, market) {
  // eslint-disable-next-line global-require
  const playerBet = require('./playerBet.service');
  const payload = resultPayload(event, market);
  // Registered once — again if it was registered under another name (earlier versions sent the display name).
  // A failed registration (Diamond answers 500 for markets of finished matches) must not stop the
  // result check below: /get-result still answers for them. It is retried on the next run.
  if (!market.resultRegisteredAt || market.resultRegisteredName !== payload.market_name) {
    try {
      await diamond.registerPlacedBets(payload);
      await Market.updateOne(
        { _id: market._id },
        { $set: { resultRegisteredAt: new Date(), resultRegisteredName: payload.market_name } },
      );
    } catch (err) {
      logFailure('result', err.message);
    }
  }
  const json = await diamond.marketResult(payload);
  await Market.updateOne({ _id: market._id }, { $set: { lastResult: JSON.stringify(json).slice(0, 500), lastResultAt: new Date() } });
  if (/not declared/i.test(json?.message || '')) return 'pending';

  const result = readResult(json);
  if (!result) return 'unreadable';
  if (VOID_WORDS.test(result)) {
    await playerBet.voidMarket(market._id, `Diamond: ${result}`);
    return 'voided';
  }
  // Run-based markets (session lines, odd / even, last digit): the result is the runs.
  if (market.betStyle === 'session' || ['oddeven', 'cricketcasino'].includes(market.providerType)) {
    const named = market.runners.some((r) => r.name.toLowerCase() === result.toLowerCase());
    if (!named && playerBet.resultNumber(result) === null) return 'unmatched';
    await playerBet.settleMarketResult(market._id, result);
    return 'settled';
  }
  const runner = market.runners.find((r) => r.name.toLowerCase() === result.toLowerCase());
  if (runner) {
    await playerBet.settleMarket(market._id, runner.name);
    return 'settled';
  }
  // A one-selection proposition ("Yes") that did not happen: every bet on it loses.
  if (market.providerType === 'fancy1' && /^(no|false|0)$/i.test(result)) {
    await playerBet.settleMarket(market._id, 'No', { allowUnlisted: true });
    return 'settled';
  }
  return 'unmatched'; // left for the admin to settle by hand; lastResult shows what came back
}

async function syncResults() {
  const openMarkets = await Market.find({ externalId: { $ne: null }, winner: { $in: ['', null] } }).select('_id event').lean();
  if (!openMarkets.length) return;
  const withBets = new Set((await Bet.distinct('market', { market: { $in: openMarkets.map((m) => m._id) }, status: 'Pending' })).map(String));
  const markets = await Market.find({ _id: { $in: [...withBets] } });
  for (const market of markets) {
    // eslint-disable-next-line no-await-in-loop
    const event = await Event.findById(market.event);
    if (!event || event.provider !== 'diamond') continue; // eslint-disable-line no-continue
    try {
      // eslint-disable-next-line no-await-in-loop
      await settleFromResult(event, market);
    } catch (err) {
      logFailure('result', err.message);
    }
  }
}

// ----------------------------------------------------------------- scheduler

const timers = [];

function every(ms, task, label) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await task();
    } catch (err) {
      logFailure(label, err.message);
    } finally {
      busy = false;
    }
  };
  run();
  const timer = setInterval(run, ms);
  timer.unref?.();
  timers.push(timer);
}

/** Starts the feed (index.js, or when a Diamond key is saved in Settings). Does nothing without a key. */
function start() {
  if (!diamond.isConfigured() || timers.length) return false;
  every(env.diamond.matchListMs, syncMatchList, 'match list');
  every(Math.min(env.diamond.liveOddsMs, env.diamond.upcomingOddsMs), syncDueOdds, 'odds');
  every(env.diamond.resultsMs, syncResults, 'results');
  every(5000, watchFreshness, 'freshness');
  every(10 * 60 * 1000, pruneFinished, 'cleanup');
  console.log('Diamond cricket feed sync started'); // eslint-disable-line no-console
  return true;
}

/**
 * The provider doesn't have a score card / video for every match: its score page
 * then loads a blank frame (the inner `live-src` answers 400) and the video page
 * answers 403. Each URL is probed in the background and only handed to the apps
 * once it actually opens, so a match never shows an empty black box.
 */
const MEDIA_RECHECK_MS = 2 * 60 * 1000;
const mediaChecks = new Map(); // url → { ok, at, pending }

async function opens(url) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  // Score card: a redirect to `/?id=N`, whose frame loads `/live-src?id=N`.
  const id = res.status >= 300 && res.status < 400 && /[?&]id=(\d+)/.exec(res.headers.get('location') || '')?.[1];
  if (id) {
    const inner = await fetch(new URL(`/live-src?id=${id}`, url), { signal: AbortSignal.timeout(10000) });
    return inner.ok;
  }
  return res.ok || (res.status >= 300 && res.status < 400);
}

function available(url) {
  const check = mediaChecks.get(url);
  if (!check || (!check.pending && Date.now() - check.at > MEDIA_RECHECK_MS)) {
    const next = { ok: check?.ok ?? false, at: Date.now(), pending: true };
    mediaChecks.set(url, next);
    opens(url)
      .then((ok) => { next.ok = ok; })
      // Unreachable this time: keep the last answer and try again next round.
      .catch(() => {})
      .finally(() => { next.pending = false; next.at = Date.now(); });
  }
  return mediaChecks.get(url).ok;
}

/** The embeddable score card / video for a feed match (null for manual events or when the provider has none). */
function mediaFor(event) {
  if (event.provider !== 'diamond' || !event.externalId) return { scoreUrl: null, streamUrl: null };
  const scoreUrl = `${env.diamond.scoreUrl}${event.externalId}`;
  const streamUrl = event.hasStream ? `${env.diamond.streamUrl}${event.externalId}` : null;
  return {
    scoreUrl: available(scoreUrl) ? scoreUrl : null,
    streamUrl: streamUrl && available(streamUrl) ? streamUrl : null,
  };
}

/**
 * Prices go stale purely with time when the feed stops answering, so nothing
 * else would tell the apps. This notices a match's prices turning stale (or
 * fresh again) and nudges every client to refetch, which shows it paused /
 * reopened within seconds.
 */
let lastStaleKey = '';
async function watchFreshness() {
  const events = await Event.find({ provider: 'diamond', status: { $in: ['Live', 'Upcoming'] } }).select('status').lean();
  if (!events.length) return;
  const markets = await Market.find({ event: { $in: events.map((e) => e._id) }, status: 'Active', externalId: { $ne: null } })
    .select('event externalId oddsAt')
    .lean();
  const now = Date.now();
  const stale = events
    .filter((e) => markets.some((m) => String(m.event) === String(e._id) && isStale(e, m, now)))
    .map((e) => String(e._id))
    .sort()
    .join(',');
  if (stale !== lastStaleKey) {
    lastStaleKey = stale;
    realtime.emitMatchesChanged();
  }
}

/**
 * Feed matches are only kept once they matter: a finished one (Completed /
 * Settled) that nobody bet on is removed with its markets. A match with any
 * bet stays — the bets point to it and the admin may still settle it.
 */
async function pruneFinished() {
  const finished = await Event.find({ provider: 'diamond', status: { $in: ['Completed', 'Settled'] } }).select('_id').lean();
  if (!finished.length) return 0;
  const withBets = new Set((await Bet.distinct('event', { event: { $in: finished.map((e) => e._id) } })).map(String));
  const removable = finished.map((e) => e._id).filter((id) => !withBets.has(String(id)));
  if (!removable.length) return 0;
  await Market.deleteMany({ event: { $in: removable } });
  await Event.deleteMany({ _id: { $in: removable } });
  console.log(`Removed ${removable.length} finished match(es) with no bets`); // eslint-disable-line no-console
  realtime.emitMatchesChanged();
  return removable.length;
}

/** "Sync All" on the Betting page: refresh the list and every open match's prices now. */
async function syncNow() {
  await syncMatchList();
  const events = await Event.find({ provider: 'diamond', status: { $in: ['Live', 'Upcoming', 'Suspended'] } });
  await Promise.all(events.map((e) => syncEventOdds(e).catch(() => null)));
}

module.exports = {
  pruneFinished,
  start,
  syncNow,
  syncMatchList,
  syncEventOdds,
  syncDueOdds,
  syncResults,
  mapMarkets,
  parseStartTime,
  readResult,
  mediaFor,
  isRealFixture,
};
