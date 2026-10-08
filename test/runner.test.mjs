import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runStore} from '../src/store.mjs';
import {createState, runRound, runLoop, settlePass, recoverPending, finishedSummary, newRunId, describeRules} from '../src/runner.mjs';
import {validateConfig} from '../src/config.mjs';
import {buildView} from '../src/server.mjs';
import {equity} from '../src/ledger.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/sports-screen-rows.json', import.meta.url), 'utf8'));

function config(extra = {}) {
  return {
    name: 'test-run', title: 'Test', startingCash: 100, stakeUsd: 5, betsPerRound: {min: 2, max: 2}, intervalMinutes: 30, intervalSec: 1800, rounds: 2, durationHours: 1,
    answerDeadlineSec: 5, maxMarketsPerRound: 8, minMarketsPerRound: 4, settleGraceHours: 0, dashboardPort: 0, finishedFile: null,
    execution: {mode: 'predictefy-paper', slippage: 0.02, fillWaitSec: 0, pollEverySec: 0},
    markets: [{kind: 'sports-screen', kickoffFromHours: -3, kickoffToHours: 3}],
    contestants: [{name: 'alpha', kind: 'random', label: 'Alpha'}, {name: 'beta', kind: 'random', label: 'Beta'}, {name: 'random', kind: 'random', baseline: true, seed: 5}],
    ...extra,
  };
}

/** A stand-in for Predictefy: the real sports-screen rows moved to start in an hour, a paper engine that fills, and markets that can be resolved. */
function world() {
  const rows = structuredClone(fixture.rows).map(row => ({...row, kickoffAt: new Date(Date.now() + 3600000).toISOString()}));
  const orders = new Map(), byId = new Map(), markets = {}, calls = [];
  for (const row of rows) for (const [i, sel] of (row.market?.selections || []).entries()) for (const cell of sel.cells) {
    const m = markets[`${cell.venue}|${cell.marketId}`] ||= {marketId: cell.marketId, status: 'open', asOf: 'now', outcomes: []};
    if (cell.outcomeId && !m.outcomes.some(o => o.outcomeId === cell.outcomeId)) m.outcomes.push({outcomeId: cell.outcomeId, price: cell.gross?.probability ?? 0.5, priceBasis: 'mid', selection: i});
  }
  const usage = {calls: 0, credits: 0, byEndpoint: {}, planNotice: null};
  const count = (label, credits) => { usage.calls++; usage.credits += credits; const row = usage.byEndpoint[label] ||= {calls: 0, credits: 0}; row.calls++; row.credits += credits; };
  const client = {
    usage,
    async get(path) {
      calls.push(['GET', path]);
      if (path.startsWith('/v1/sports/screen')) { count('/v1/sports/screen', 5); return {ok: true, data: rows, json: {page: {hasMore: false}}}; }
      const market = /^\/api\/(\w+)\/fetchMarket\?marketId=(.+)$/.exec(path);
      if (market) { count('/api/{venue}/fetchMarket', 1); const m = markets[`${market[1]}|${decodeURIComponent(market[2])}`]; return m ? {ok: true, data: m} : {ok: false, status: 404, error: {code: 'MARKET_NOT_FOUND'}}; }
      const order = /^\/v1\/paper\/orders\/(.+)$/.exec(path);
      if (order) { count('GET /v1/paper/orders/{id}', 0); return {ok: true, data: byId.get(order[1])}; }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body, options = {}) {
      calls.push(['POST', path, options.headers?.['Idempotency-Key']]);
      count('POST /v1/paper/orders', 0);
      const key = options.headers['Idempotency-Key'];
      if (orders.has(key)) return {ok: true, replay: true, data: orders.get(key)};
      const order = {id: `ord-${orders.size + 1}`, ...body, status: 'filled', filledSize: body.size, avgFillPrice: Number((body.price - 0.02).toFixed(2)), feesPaid: 0.05, fills: []};
      orders.set(key, order); byId.set(order.id, order);
      return {ok: true, replay: false, data: order};
    },
  };
  const resolve = winnerSelection => { for (const m of Object.values(markets)) { m.status = 'resolved'; for (const o of m.outcomes) o.price = o.selection === winnerSelection ? 0.9995 : 0.0005; } };
  return {client, orders, markets, calls, resolve};
}

const fixed = (name, answers, extra = {}) => ({def: {name}, ask: async ({ids}) => ({status: 'ok', latencyMs: 1200, model: `${name}-model`, usage: {inputTokens: 100, outputTokens: 10, costUsd: 0.001}, problems: [], answers: Object.fromEntries(ids.map((id, i) => [id, answers(id, i)])), ...extra})});
function setup(cfg = config(), contestants) {
  const store = runStore(mkdtempSync(join(tmpdir(), 'arena-run-')), 'test-run-1');
  store.prepare();
  const state = createState(cfg, 'test-run-1');
  const w = world();
  const list = contestants || [
    fixed('alpha', (id, i) => ({call: 'SKIP', pYes: 0.5, lean: 'YES', strength: 90 - i * 10, reason: 'a'})),
    fixed('beta', (id, i) => ({call: i === 0 ? 'BUY_NO' : 'SKIP', pYes: 0.4, lean: 'NO', strength: 10 + i * 10, reason: 'b'})),
    {def: {name: 'random'}, ask: async () => ({status: 'late', latencyMs: 5000, answers: {}, problems: ['no answer within 5 s'], usage: {}})},
  ];
  const logs = [];
  const ctx = {config: cfg, state, store, client: w.client, contestants: list, log: m => logs.push(m), usageBase: structuredClone(state.predictefy), pause: async () => {}};
  return {ctx, state, store, w, logs};
}

test('a run id carries the config name and the start time, and the rule reads as one plain sentence', () => {
  assert.equal(newRunId({name: 'games-24h'}, Date.UTC(2026, 9, 8, 10, 30)), 'games-24h-20261008-1030z');
  assert.equal(describeRules(config()), 'Every 30 minutes each contestant must place its 2 best bets, $5 each, from the same list of games. Every contestant starts with $100 of paper money and every bet is held until the game settles.');
  assert.deepEqual(validateConfig({...config(), execution: {mode: 'predictefy-paper'}}), []);
  assert.ok(validateConfig({...config(), contestants: [{name: 'A B', kind: 'psychic'}]}).length >= 2);
});

test('one round: same slate for everyone, two bets each by the fixed rule, everything written down', async () => {
  const {ctx, state, store, w} = setup();
  const record = await runRound(ctx, 0);
  assert.equal(record.slate.length, 3, 'the three tradable real games');
  assert.match(record.prompt, /must place its 2 best bets|must place its two best bets/);
  const alpha = state.contestants.alpha, beta = state.contestants.beta, random = state.contestants.random;
  assert.equal(alpha.account.positions.length, 2);
  assert.deepEqual(alpha.account.positions.map(p => p.side), ['YES', 'YES']);
  assert.deepEqual(record.bets.alpha.map(b => b.gid), ['g1', 'g2'], 'the two highest strengths');
  assert.deepEqual(record.bets.beta.map(b => b.gid), ['g3', 'g2']);
  assert.deepEqual(beta.account.positions.map(p => p.side), ['NO', 'NO']);
  assert.deepEqual([alpha.wanted.buy, alpha.wanted.skip, beta.wanted.buy, beta.wanted.skip], [0, 3, 1, 2], 'what each one wanted is kept apart from what the rule made it bet');
  assert.equal(random.account.positions.length, 0);
  assert.deepEqual([random.usage.late, random.usage.calls], [1, 1]);
  const spent = alpha.account.positions.reduce((s, p) => s + p.cost, 0);
  assert.ok(Math.abs(alpha.account.cash - (100 - spent)) < 1e-9);
  assert.ok(alpha.account.positions.every(p => p.cost <= 5.6 && p.shares >= 1));
  const keys = w.calls.filter(c => c[0] === 'POST').map(c => c[2]);
  assert.equal(keys.length, 4);
  assert.ok(keys.every(k => /^ai-vs-ai-test-run-1-(alpha|beta)-r001-fx_[0-9a-f]+-(yes|no)-(polymarket|kalshi)$/.test(k)), keys.join(' '));
  assert.deepEqual(Object.keys(state.pending), []);
  assert.equal(state.nextRound, 1);
  assert.equal(state.equity.length, 1);
  assert.equal(Object.keys(state.asked).length, 3);
  assert.equal(state.predictefy.byEndpoint['/v1/sports/screen'].credits, 5);
  assert.equal(alpha.reportedModel, 'alpha-model');
  assert.equal(alpha.usage.costUsd, 0.001);
  const saved = store.loadRound(1);
  assert.equal(saved.answers.alpha.status, 'ok');
  assert.ok(saved.finishedAt);
  const events = readFileSync(store.paths.events, 'utf8').trim().split('\n').map(l => JSON.parse(l).type);
  for (const type of ['round_start', 'slate', 'answer', 'order_intent', 'order_result', 'fill', 'round_end']) assert.ok(events.includes(type), type);
  const view = buildView(store);
  assert.equal(view.rounds[0].promptChars > 100, true);
  assert.equal(view.rounds[0].prompt, undefined);
});

test('a game somebody holds is never asked again, and bets settle from the real resolution', async () => {
  const {ctx, state, w} = setup();
  await runRound(ctx, 0);
  const second = await runRound(ctx, 1);
  assert.equal(second.slate.length, 0, 'all three games are held by somebody, so none is asked again');
  assert.match(second.notes[0], /No tradable games this round/);
  assert.equal(state.equity.length, 2, 'the round still counts and still records equity');
  w.resolve(0);
  const settled = await settlePass(ctx, 'test');
  assert.equal(settled.length, 4);
  const alpha = state.contestants.alpha.account, beta = state.contestants.beta.account;
  assert.ok(alpha.positions.every(p => p.state === 'won' && p.payout === p.shares && /fetchMarket\?marketId=/.test(p.how)));
  assert.ok(beta.positions.every(p => p.state === 'lost' && p.payout === 0));
  assert.ok(alpha.cash > 100 && beta.cash < 100);
  assert.equal(equity(alpha), alpha.cash);
  const result = finishedSummary(state, 'final');
  assert.deepEqual(result.contestants.map(c => c.name), ['alpha', 'random', 'beta'], 'ranked by equity');
  assert.equal(result.contestants[0].won, 2);
  assert.equal(result.contestants[0].wanted.skipShare, 1);
  assert.equal(result.unsettled.length, 0);
  assert.equal(result.rounds.done, 2);
});

test('an unresolved bet is valued at the last price and listed as unsettled', async () => {
  const {ctx, state, w} = setup();
  await runRound(ctx, 0);
  for (const m of Object.values(w.markets)) for (const o of m.outcomes) o.price = o.selection === 0 ? 0.7 : 0.3;
  assert.equal((await settlePass(ctx, 'test')).length, 0);
  const position = state.contestants.alpha.account.positions[0];
  assert.equal(position.state, 'open');
  assert.equal(position.mark, 0.7);
  const result = finishedSummary(state, 'closed');
  assert.equal(result.unsettled.filter(u => u.name === 'alpha').length, 2);
  assert.equal(result.unsettled[0].markedAt, 0.7);
});

test('with money tied up a contestant places fewer bets, and the budget is never exceeded', async () => {
  const {ctx, state} = setup();
  state.contestants.alpha.account.cash = 6;
  const record = await runRound(ctx, 0);
  assert.deepEqual(record.bets.alpha.map(b => b.status), ['filled', 'no-cash']);
  assert.match(record.bets.alpha[1].why, /Not enough free cash: \$\d+\.\d\d free/);
  assert.ok(state.contestants.alpha.account.cash >= 0);
  assert.equal(state.contestants.alpha.bets.noCash, 1);
});

test('when an order does not fill, the next strongest pick is tried, so each contestant still gets its two bets', async () => {
  const {ctx, state, w} = setup();
  const post = w.client.post;
  w.client.post = async (path, body, options) => {
    // the paper engine has no live book on either venue for alpha's first pick, the NFL game
    if (/-alpha-r001-fx_4bed49d9e1c5-/.test(options.headers['Idempotency-Key'])) return {ok: false, status: 409, error: {code: 'PAPER_NO_LIVE_BOOK', message: 'no live order book'}};
    return post(path, body, options);
  };
  const record = await runRound(ctx, 0);
  assert.deepEqual(record.bets.alpha.map(b => [b.gid, b.status]), [['g1', 'no-live-book'], ['g2', 'filled'], ['g3', 'filled']]);
  assert.equal(record.bets.alpha[0].why, 'The paper engine had no live order book for this outcome.');
  assert.equal(state.contestants.alpha.account.positions.length, 2);
  assert.equal(state.contestants.alpha.bets.noLiveBook, 1);
  assert.equal(state.contestants.beta.account.positions.length, 2, 'beta stops at two and never reaches its third pick');
  assert.equal(record.bets.beta.length, 2);
});

test('an order that was in flight when the harness stopped is picked up again by its key, not placed twice', async () => {
  const {ctx, state, w} = setup();
  const record = await runRound(ctx, 0);
  const position = state.contestants.alpha.account.positions.pop();
  state.contestants.alpha.account.cash += position.cost;
  const side = record.slate.find(g => g.id === position.gameId)[position.side === 'YES' ? 'yes' : 'no'];
  state.pending[position.key.replace(/-(polymarket|kalshi)$/, '')] = {key: position.key.replace(/-(polymarket|kalshi)$/, ''), name: 'alpha', round: 1, gid: 'g2', gameId: position.gameId, title: position.title, side: position.side, sideName: position.sideName, cells: side.cells};
  const before = w.orders.size;
  await recoverPending(ctx);
  assert.equal(w.orders.size, before, 'no new order was created');
  assert.equal(state.contestants.alpha.account.positions.length, 2);
  assert.equal(state.contestants.alpha.account.positions[1].orderId, position.orderId);
  assert.deepEqual(Object.keys(state.pending), []);
});

test('a whole run: rounds on schedule, a result file at the end, and it resumes where it stopped', async () => {
  const cfg = config({intervalSec: 1, rounds: 2, finishedFile: join(mkdtempSync(join(tmpdir(), 'arena-out-')), 'run-finished.json')});
  const {ctx, state, store, w} = setup(cfg);
  state.intervalSec = 1;
  state.endAt = new Date(Date.parse(state.startAt) + 2000).toISOString();
  ctx.pause = ms => new Promise(r => setTimeout(r, Math.min(ms, 50)));
  store.requestStop();
  assert.equal(await runLoop(ctx), 'stopped');
  assert.equal(state.status, 'stopped');
  store.clearStop();
  w.resolve(1);
  assert.equal(await runLoop(ctx), 'finished');
  assert.equal(state.status, 'finished');
  assert.equal(state.roundsDone + state.missedRounds.length, 2);
  for (const file of [store.paths.finished, cfg.finishedFile]) {
    assert.ok(existsSync(file));
    const result = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(result.stage, 'final');
    assert.equal(result.runId, 'test-run-1');
    assert.equal(result.contestants.length, 3);
    assert.ok(result.contestants.every(c => typeof c.equity === 'number'));
  }
});
