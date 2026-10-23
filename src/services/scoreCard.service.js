const env = require('../config/env');

/**
 * The provider's live score card is an HTML widget (fixed 190px, built for a
 * desktop iframe) that overlaps itself on a phone. This reads the same page
 * and returns its figures as JSON, so the app can draw its own card.
 *
 * `score.akamaized.uk/diamond-live-score?gmid=G` redirects to `/?id=N`, whose
 * frame reloads `/live-src?id=N` every second; that inner page holds the data.
 */

const ID_TTL_MS = 10 * 60 * 1000;
const CARD_TTL_MS = 1500;
// No score for a match is rechecked less often than a live one is refreshed.
const MISSING_TTL_MS = 30 * 1000;
const ids = new Map(); // gmid → { id, at }
const cards = new Map(); // gmid → { card, at, pending }

const decode = (s) =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** The HTML between the first `from` class marker and the next `to` one. */
function section(html, from, to) {
  const start = html.indexOf(from);
  if (start < 0) return '';
  const end = to ? html.indexOf(to, start + from.length) : -1;
  return html.slice(start, end < 0 ? undefined : end);
}

const texts = (html, cls) =>
  [...html.matchAll(new RegExp(`class="${cls}(?: [^"]*)?"[^>]*>([\\s\\S]*?)</(?:span|div)>`, 'g'))].map((m) => decode(m[1]));

/** `[{ runs: '425/9', overs: '127.1' }, …]` and `{ CRR: '1.86', … }` from one side's score column. */
function side(html) {
  const big = texts(html, 'sc_cw-header-score-big-desktop');
  const small = [...html.matchAll(/class="sc_cw-header-score-bg-desktop"[\s\S]*?score-small-desktop">([^<]*)</g)].map((m) => decode(m[1]));
  const innings = big.map((runs, i) => ({ runs, overs: (small[i] || '').replace(/[()]/g, '') }));
  const rates = {};
  for (const m of html.matchAll(/([A-Z]{2,4}):\s*<span>([^<]*)<\/span>/g)) rates[m[1]] = decode(m[2]);
  return { innings, rates };
}

/** One stats table (Batsmen / Bowler): its headings and rows. */
function table(html) {
  const head = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => decode(m[1]));
  const rows = [...html.matchAll(/<tr>\s*([\s\S]*?)<\/tr>/g)]
    .map((m) => {
      const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
      if (!cells.length) return null;
      return {
        name: decode(cells[0].replace(/<svg[\s\S]*?<\/svg>/g, '')),
        // The batter on strike carries a second (bat) icon after the name.
        onStrike: (cells[0].match(/<svg/g) || []).length > 1,
        stats: cells.slice(1).map(decode),
      };
    })
    .filter((r) => r && r.name);
  return { title: head[0] || '', columns: head.slice(1), rows };
}

function parse(page) {
  // Class names also appear in the page's <style>: read the body only.
  const html = page.slice(Math.max(0, page.indexOf('<body')));
  const header = section(html, 'sc_cw-header-desktop', 'sc_cw-header-mobile');
  const teams = texts(header, 'sc_cw-header-team-name-desktop');
  if (teams.length < 2) return null;
  const left = side(section(header, 'sc_cw-header-score-container-left-desktop', 'sc_cw-header-score-container-right-desktop'));
  const right = side(section(header, 'sc_cw-header-score-container-right-desktop'));
  // The right column is mirrored: its latest innings comes first.
  right.innings.reverse();

  const info = section(html, 'sc_cw-info-section-desktop', 'sc_cw-info-section-mobile');
  const facts = [...info.matchAll(/class="sc_cw-info-part-desktop">([\s\S]*?)<\/div>/g)]
    .map((m) => [...m[1].matchAll(/<span>([\s\S]*?)<\/span>/g)].map((s) => decode(s[1])))
    .filter((spans) => spans.length >= 2 && spans[0])
    .map(([label, value]) => ({ label: label.replace(/:$/, ''), value }));

  const overHtml = section(html, 'sc_cw-over-desktop', 'sc_cw-over-mobile');
  const overs = overHtml
    .split('sc_cw-current-over-desktop')
    .slice(1)
    .map((part) => ({
      name: texts(part, 'sc_cw-over-part-name-desktop')[0] || '',
      balls: texts(part, 'sc_cw-over-part-balls'),
    }))
    .filter((o) => o.name);

  const tables = html
    .split('class="sc_cw-table-desktop"')
    .slice(1)
    .map((part) => table(part.split('class="sc_cw-table-mobile"')[0]))
    .filter((t) => t.title);

  return {
    teams: [
      { name: teams[0], ...left },
      { name: teams[1], ...right },
    ],
    comment: texts(header, 'sc_cw-header-primary-comment-desktop')[0] || '',
    target: texts(header, 'sc_cs-header-target-desktop')[0] || '',
    facts,
    overs,
    batsmen: tables.find((t) => /bats/i.test(t.title)) || null,
    bowlers: tables.find((t) => /bowl/i.test(t.title)) || null,
  };
}

async function scoreId(gmid) {
  const known = ids.get(gmid);
  if (known && Date.now() - known.at < ID_TTL_MS) return known.id;
  const res = await fetch(`${env.diamond.scoreUrl}${gmid}`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
  const id = /[?&]id=(\d+)/.exec(res.headers.get('location') || '')?.[1] || null;
  ids.set(gmid, { id, at: Date.now() });
  return id;
}

async function load(gmid) {
  prune();
  const id = await scoreId(gmid);
  if (!id) return null;
  const res = await fetch(new URL(`/live-src?id=${id}`, env.diamond.scoreUrl), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  return parse(await res.text());
}

/**
 * The live score of a feed match as JSON, or null when the provider has none.
 * Shared by every viewer for a moment, so polling apps don't multiply calls.
 */
async function scoreFor(event) {
  if (event.provider !== 'diamond' || !event.externalId) return null;
  const gmid = String(event.externalId);
  const cached = cards.get(gmid);
  if (cached && (cached.pending || Date.now() - cached.at < (cached.card ? CARD_TTL_MS : MISSING_TTL_MS))) {
    return cached.pending || cached.card;
  }
  const pending = load(gmid)
    .catch(() => cached?.card ?? null)
    .then((card) => {
      cards.set(gmid, { card, at: Date.now() });
      return card;
    });
  cards.set(gmid, { card: cached?.card ?? null, at: cached?.at ?? 0, pending });
  return pending;
}

/** Drops cached cards of matches nobody has asked about for a while. */
function prune() {
  const cutoff = Date.now() - ID_TTL_MS;
  for (const [gmid, entry] of cards) if (!entry.pending && entry.at < cutoff) cards.delete(gmid);
  for (const [gmid, entry] of ids) if (entry.at < cutoff) ids.delete(gmid);
}

module.exports = { scoreFor, parse, prune };
