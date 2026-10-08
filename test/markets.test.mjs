import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {toGame, rankGames, findGames, SPORTS_SCREEN_DEFAULTS} from '../src/markets/sportsScreen.mjs';
import {buildFacts} from '../src/facts.mjs';

// Real rows from GET /v1/sports/screen (2026-10-08): an NFL game on both venues, a college game whose Kalshi quotes
// were stale, a KHL game on Polymarket only, and a fixture with no moneyline block.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/sports-screen-rows.json', import.meta.url), 'utf8'));
const [nfl, college, khl, empty] = fixture.rows;
const source = {...SPORTS_SCREEN_DEFAULTS};
const hourBefore = row => Date.parse(row.kickoffAt) - 3600000;

test('a game on both venues keeps both, cheapest after fees first', () => {
  const game = toGame(nfl, source, hourBefore(nfl));
  assert.equal(game.title, 'NFL: Tampa Bay Buccaneers at Dallas Cowboys');
  assert.equal(game.yes.name, 'Dallas Cowboys');
  assert.deepEqual(game.yes.cells.map(c => [c.venue, c.ask, c.net]), [['kalshi', 0.8, 0.8112], ['polymarket', 0.81, 0.8146]]);
  assert.deepEqual(game.no.cells.map(c => c.venue), ['polymarket', 'kalshi']);
  assert.deepEqual(game.venues, ['kalshi', 'polymarket']);
  assert.equal(game.yes.fair, 0.7988);
  assert.ok(game.yes.cells.every(c => c.marketId && c.outcomeId));
});

test('a stale quote is dropped, because the paper engine has no live book behind it', () => {
  const game = toGame(college, source, hourBefore(college));
  assert.deepEqual(game.venues, ['polymarket']);
  assert.ok(game.yes.cells.every(c => c.venue === 'polymarket'));
});

test('a game is left out when it is outside the window, has no moneyline, or is too thin on one side', () => {
  assert.equal(toGame(nfl, source, Date.parse(nfl.kickoffAt) - 5 * 3600000), null, 'starts too far ahead');
  assert.equal(toGame(nfl, source, Date.parse(nfl.kickoffAt) + 4 * 3600000), null, 'started too long ago');
  assert.equal(toGame(empty, source, hourBefore(empty)), null);
  const thin = structuredClone(khl);
  for (const cell of thin.market.selections[0].cells) cell.sizeAtPrice = 10;
  assert.equal(toGame(thin, source, hourBefore(thin)), null);
  assert.equal(toGame({...nfl, status: 'final'}, source, hourBefore(nfl)), null);
});

test('a quote must show at least four times the order, because the paper engine fills a quarter of a lot per update', () => {
  const row = structuredClone(khl);   // Traktor at 64 cents with 162 shares on offer: a $5 order is 7 shares, a $40 order is 61
  assert.ok(toGame(row, source, hourBefore(row)));
  assert.equal(toGame(row, {...source, stakeUsd: 40}, hourBefore(row)), null);
});

test('players and esports teams read "A v B", home-and-away sports read "A at B"', () => {
  const tennis = {...structuredClone(khl), sport: 'tennis', competition: {name: 'ATP Tour'}};
  assert.match(toGame(tennis, source, hourBefore(tennis)).title, /^ATP Tour: .+ v .+$/);
  assert.match(toGame(khl, source, hourBefore(khl)).title, /^KHL: .+ (at|v) .+$/);
});

test('with a quote-age limit, a quote that has not moved lately is skipped', () => {
  const quotedAt = Date.parse(nfl.market.selections[0].cells.find(c => c.venue === 'polymarket').asOf);
  const row = {...structuredClone(nfl), kickoffAt: new Date(quotedAt + 3600000).toISOString()};
  assert.ok(toGame(row, {...source, maxQuoteAgeSec: 60}, quotedAt + 20000));
  assert.equal(toGame(row, {...source, maxQuoteAgeSec: 60}, quotedAt + 300000), null);
});

test('prices outside the allowed range are not offered', () => {
  const lopsided = structuredClone(khl);
  for (const cell of lopsided.market.selections[0].cells) if (cell.gross) cell.gross.probability = 0.97;
  assert.equal(toGame(lopsided, source, hourBefore(lopsided)), null);
});

test('the slate takes new games first, then games on both venues, and caps each sport', () => {
  const now = Date.now();
  const game = (id, sport, venues, competition = 'Other') => ({id, sport, competition, venues, kickoffMs: now + 3600000});
  const games = [game('a', 'tennis', ['polymarket']), game('b', 'tennis', ['polymarket']), game('c', 'tennis', ['polymarket']), game('d', 'tennis', ['polymarket']), game('e', 'ice_hockey', ['polymarket'], 'NHL'), game('f', 'american_football', ['kalshi', 'polymarket'], 'NFL'), game('g', 'basketball', ['polymarket'], 'NBA')];
  const picked = rankGames(games, source, {asked: new Set(['g']), held: new Set(['e']), max: 5, minGames: 2, nowMs: now});
  assert.equal(picked[0].id, 'f', 'both venues first');
  assert.ok(!picked.some(p => p.id === 'e'), 'a game somebody already holds is never asked again');
  assert.ok(!picked.some(p => p.id === 'g'), 'a game that was asked before is only used to fill a short slate');
  assert.equal(picked.filter(p => p.sport === 'tennis').length, 3);
  const short = rankGames([game('g', 'basketball', ['polymarket'], 'NBA')], source, {asked: new Set(['g']), max: 5, minGames: 2, nowMs: now});
  assert.equal(short.length, 1);
});

test('the facts are plain sentences with the comparison already made', () => {
  const now = hourBefore(nfl);
  const facts = buildFacts(toGame(nfl, source, now), 'g1', now);
  assert.equal(facts.when, 'Starts in 1 hour.');
  assert.equal(facts.yes_means, 'Dallas Cowboys to win');
  assert.equal(facts.prices, 'YES costs 80 cents on Kalshi and 81 cents on Polymarket. NO costs 20 cents on Polymarket and 21 cents on Kalshi. A winning share pays 100 cents.');
  assert.equal(facts.fair_price, "Predictefy's no-vig fair price across 5 venues is 79.9% for YES and 20.1% for NO.");
  assert.equal(facts.value, 'After fees, the cheapest YES is 1.2 cents above the fair price, and the cheapest NO is about the same as the fair price.');
  const inPlay = buildFacts({...toGame(nfl, source, now), status: 'live'}, 'g1', Date.parse(nfl.kickoffAt) + 35 * 60000);
  assert.equal(inPlay.when, 'In play. It started 35 minutes ago.');
});

test('the fair price can be kept out of what contestants see, while staying on the game for scoring', () => {
  const now = hourBefore(nfl), game = toGame(nfl, source, now);
  const facts = buildFacts(game, 'g1', now, {fairPrice: false});
  assert.deepEqual(Object.keys(facts), ['id', 'game', 'when', 'yes_means', 'no_means', 'prices']);
  assert.equal(game.yes.fair, 0.7988);
});

test('games yet to start come before games in play', () => {
  const now = Date.now();
  const game = (id, status) => ({id, sport: id, competition: 'Other', venues: ['polymarket'], kickoffMs: now + 600000, status});
  assert.deepEqual(rankGames([game('a', 'live'), game('b', 'scheduled'), game('c', 'live')], source, {max: 5, nowMs: now}).map(g => g.id), ['b', 'a', 'c']);
});

test('a game with no cross-venue fair price says so and has no value line', () => {
  const row = structuredClone(khl);
  for (const sel of row.market.selections) sel.fair = null;
  const facts = buildFacts(toGame(row, source, hourBefore(row)), 'g1', hourBefore(row));
  assert.equal(facts.fair_price, 'Predictefy has no cross-venue fair price for this game.');
  assert.equal(facts.value, undefined);
});

test('findGames pages the sports screen and reports what it saw', async () => {
  const now = hourBefore(nfl);
  const calls = [];
  const client = {get: async path => { calls.push(path); return calls.length === 1 ? {ok: true, data: [nfl, empty], json: {page: {hasMore: true, nextCursor: 'abc'}}} : {ok: true, data: [college], json: {page: {hasMore: false}}}; }};
  const found = await findGames({client, source: {kickoffFromHours: -3, kickoffToHours: 3}, nowMs: now, max: 8, minGames: 4});
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^\/v1\/sports\/screen\?marketType=moneyline&from=.*&to=.*&limit=200$/);
  assert.match(calls[1], /cursor=abc/);
  assert.deepEqual(found.stats, {fixtures: 3, tradable: 2, pages: 2, error: null});
  assert.equal(found.games[0].competition, 'NFL');
  const down = await findGames({client: {get: async () => ({ok: false, status: 404, error: {code: 'ROUTE_NOT_FOUND'}})}, source: {}, nowMs: now});
  assert.equal(down.games.length, 0);
  assert.equal(down.stats.error.code, 'ROUTE_NOT_FOUND');
});
