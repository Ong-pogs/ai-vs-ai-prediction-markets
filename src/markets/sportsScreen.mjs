// Candidate games come from Predictefy's sports screen (GET /v1/sports/screen, 5 credits a page).
// The screen lists every game with one price per venue and Predictefy's own no-vig fair price. Its cells also say
// whether a quote is live and fresh, and those are exactly the outcomes Predictefy's paper engine will take an
// order on. A cell that is stale, or only a catalogue price, is refused with 409 PAPER_NO_LIVE_BOOK.
const VENUE_NAMES = {polymarket: 'Polymarket', kalshi: 'Kalshi'};
export const venueName = venue => VENUE_NAMES[venue] || venue;
const HOME_AND_AWAY = new Set(['american_football', 'basketball', 'baseball', 'ice_hockey']);   // "A at B" reads right for these; players and esports teams get "A v B"
const isoSeconds = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

export const SPORTS_SCREEN_DEFAULTS = {
  marketType: 'moneyline',
  venues: ['polymarket', 'kalshi'],
  kickoffFromHours: -3,   // in play for up to three hours
  kickoffToHours: 1.5,    // or starting within the next hour and a half
  priceMin: 0.05,
  priceMax: 0.95,
  minSizeAtPrice: 100,    // shares on offer at the quoted price, and never less than four times the order (see fillCover)
  fillCover: 4,           // the paper engine fills at most a quarter of a displayed lot per book update
  stakeUsd: 5,
  maxQuoteAgeSec: null,   // when set, a quote older than this is skipped: the paper engine only fills when the book updates
  maxPerSport: 3,
  maxPages: 4,
  prefer: ['NFL', 'College Football', 'NBA', 'NHL', 'MLB', 'UFC', 'UEFA Champions League', 'Premier League', 'EuroLeague', 'ATP Tour', 'WTA Tour', 'LoL', 'Dota 2', 'KBO', 'NPB'],
  exclude: [],
};

/** Turns one screen row into a game the harness can ask about, or null when it cannot be traded right now. */
export function toGame(row, source, nowMs) {
  const market = row.market;
  if (!market || market.selections?.length !== 2) return null;
  if (!['scheduled', 'live'].includes(row.status)) return null;
  if (!row.kickoffAt || row.kickoffPrecision !== 'exact') return null;
  const kickoffMs = Date.parse(row.kickoffAt);
  const hours = (kickoffMs - nowMs) / 3600000;
  if (hours < source.kickoffFromHours || hours > source.kickoffToHours) return null;
  const competition = row.competition?.name || row.sport;
  if (source.exclude.includes(competition) || (source.sports && !source.sports.includes(row.sport))) return null;
  const sides = market.selections.map(sel => {
    const fresh = sel.cells.filter(c => c.source === 'live' && !c.stale && c.gross);
    const recent = c => !source.maxQuoteAgeSec || (c.asOf && nowMs - Date.parse(c.asOf) <= source.maxQuoteAgeSec * 1000);
    const cells = fresh
      .filter(c => source.venues.includes(c.venue) && c.marketId && c.outcomeId && recent(c)
        && c.gross.probability >= source.priceMin && c.gross.probability <= source.priceMax
        && (c.sizeAtPrice ?? 0) >= Math.max(source.minSizeAtPrice, source.fillCover * source.stakeUsd / (c.net?.probability ?? c.gross.probability)))
      .map(c => ({
        venue: c.venue, marketId: String(c.marketId), outcomeId: String(c.outcomeId),
        ask: c.gross.probability, net: c.net?.probability ?? c.gross.probability, feeKnown: !c.feeUnknown,
        size: c.sizeAtPrice, asOf: c.asOf,
      }))
      .sort((a, b) => a.net - b.net || a.venue.localeCompare(b.venue));
    return {name: sel.selection?.team?.name || sel.selection?.key || 'Unknown', cells, fair: sel.fair?.probability ?? null, liveVenues: fresh.length};
  });
  if (sides.some(side => !side.cells.length)) return null;
  const home = row.home?.name, away = row.away?.name;
  const title = HOME_AND_AWAY.has(row.sport) && home && away && home !== away ? `${competition}: ${away} at ${home}` : `${competition}: ${sides[0].name} v ${sides[1].name}`;
  return {
    id: row.fixtureId, title, sport: row.sport, competition, kickoffAt: row.kickoffAt, kickoffMs, status: row.status,
    yes: sides[0], no: sides[1], hold: market.hold?.average ?? null,
    venues: [...new Set(sides.flatMap(side => side.cells.map(c => c.venue)))].sort(),
  };
}

/** Picks this round's slate: new games first, then games yet to start, games on both venues, well-known competitions, soonest. */
export function rankGames(games, source, {asked = new Set(), held = new Set(), max = 8, minGames = 4, nowMs = Date.now()} = {}) {
  const priority = game => {
    const at = source.prefer.indexOf(game.competition);
    return at < 0 ? source.prefer.length : at;
  };
  const inPlay = game => game.status === 'live' ? 1 : 0;   // games that have not started come first: a pick is a judgement there, not a guess at the score
  const order = (a, b) => inPlay(a) - inPlay(b) || b.venues.length - a.venues.length || priority(a) - priority(b)
    || Math.abs(a.kickoffMs - nowMs) - Math.abs(b.kickoffMs - nowMs) || a.id.localeCompare(b.id);
  const open = games.filter(game => !held.has(game.id));
  const fresh = open.filter(game => !asked.has(game.id)).sort(order);
  const again = open.filter(game => asked.has(game.id)).sort(order);
  const picked = [], perSport = {};
  const take = list => {
    for (const game of list) {
      if (picked.length >= max) break;
      if ((perSport[game.sport] || 0) >= source.maxPerSport) continue;
      perSport[game.sport] = (perSport[game.sport] || 0) + 1;
      picked.push(game);
    }
  };
  take(fresh);
  if (picked.length < minGames) take(again);
  return picked;
}

export async function findGames({client, source: given, nowMs = Date.now(), asked, held, max, minGames}) {
  const source = {...SPORTS_SCREEN_DEFAULTS, ...given};
  const rows = [];
  let cursor = null, pages = 0, error = null;
  do {
    const params = new URLSearchParams({
      marketType: source.marketType,
      from: isoSeconds(nowMs + source.kickoffFromHours * 3600000),
      to: isoSeconds(nowMs + source.kickoffToHours * 3600000),
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);
    const res = await client.get(`/v1/sports/screen?${params}`, {label: '/v1/sports/screen'});
    if (!res.ok) { error = res.error || {code: `HTTP_${res.status}`}; break; }
    rows.push(...(res.data || []));
    cursor = res.json?.page?.hasMore ? (res.json.page.nextCursor || res.json.nextCursor) : null;
    pages++;
  } while (cursor && pages < source.maxPages);
  const tradable = rows.map(row => toGame(row, source, nowMs)).filter(Boolean);
  return {
    games: rankGames(tradable, source, {asked, held, max, minGames, nowMs}),
    stats: {fixtures: rows.length, tradable: tradable.length, pages, error},
  };
}
