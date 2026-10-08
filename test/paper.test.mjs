import test from 'node:test';
import assert from 'node:assert/strict';
import {paperBuy, sizeOrder} from '../src/execution/paper.mjs';

const cfg = {slippage: 0.02, fillWaitSec: 4, pollEverySec: 1};
const cell = (venue, ask, net = ask) => ({venue, marketId: `${venue}-m`, outcomeId: `${venue}-o`, ask, net});
const noPause = async () => {};

/** A stand-in for the paper engine: orders are stored by Idempotency-Key, as the real one stores them. */
function engine(behaviour) {
  const byKey = new Map(), byId = new Map(), log = [];
  return {
    log, byKey,
    async post(path, body, options = {}) {
      log.push(['POST', path, options.headers?.['Idempotency-Key'] || null]);
      if (path === '/v1/paper/orders') {
        const key = options.headers['Idempotency-Key'];
        if (byKey.has(key)) return {ok: true, status: 200, replay: true, data: byKey.get(key)};
        const plan = behaviour(body) || {};
        if (plan.refuse) return {ok: false, status: 409, error: {code: plan.refuse, message: 'refused'}};
        const order = {id: `ord-${byKey.size + 1}`, ...body, status: plan.fillAfter ? 'open' : (plan.fill === 0 ? 'canceled' : 'filled'), filledSize: plan.fillAfter ? 0 : (plan.fill ?? body.size), avgFillPrice: plan.fillAfter ? null : (plan.price ?? body.price - 0.02), feesPaid: plan.fillAfter ? 0 : (plan.fee ?? 0.05), polls: 0, plan, fills: []};
        byKey.set(key, order); byId.set(order.id, order);
        return {ok: true, status: 201, replay: false, data: {...order}};
      }
      const cancel = /^\/v1\/paper\/orders\/(.+)\/cancel$/.exec(path);
      if (cancel) { const order = byId.get(cancel[1]); if (order.status === 'open' || order.status === 'partially_filled') order.status = 'canceled'; return {ok: true, data: {...order}}; }
      throw new Error(`unexpected POST ${path}`);
    },
    async get(path) {
      log.push(['GET', path]);
      const order = byId.get(path.split('/').pop());
      order.polls++;
      if (order.status === 'open' && order.plan.fillAfter && order.polls >= order.plan.fillAfter) Object.assign(order, {status: 'filled', filledSize: order.size, avgFillPrice: order.price - 0.02, feesPaid: 0.05});
      return {ok: true, data: {...order}};
    },
  };
}

test('five dollars at 20 cents is 24 shares once the fee is counted, with a limit two cents above the quote', () => {
  assert.deepEqual(sizeOrder(cell('polymarket', 0.2, 0.2048), 5, 100, 0.02), {limit: 0.22, shares: 24, wanted: 24, worstPerShare: 0.2298});
  assert.equal(sizeOrder(cell('polymarket', 0.985, 0.985), 5, 100, 0.02).limit, 0.99, 'the limit never passes 99 cents');
  assert.equal(sizeOrder(cell('polymarket', 0.2, 0.2048), 5, 2.5, 0.02).shares, 10, 'free cash caps the order');
  assert.equal(sizeOrder(cell('polymarket', 0.6, 0.607), 5, 0.4, 0.02).shares, 0);
});

test('an order that fills at once is one call and one position', async () => {
  const client = engine(() => ({price: 0.2, fee: 0.12}));
  const r = await paperBuy({client, key: 'ai-vs-ai-run-claude-r001-fx-yes', cells: [cell('polymarket', 0.2, 0.2048)], stakeUsd: 5, cash: 100, cfg, pause: noPause});
  assert.equal(r.status, 'filled');
  assert.deepEqual([r.venue, r.shares, r.avgPrice, r.fees, r.cost, r.limit], ['polymarket', 24, 0.2, 0.12, 4.92, 0.22]);
  assert.equal(r.key, 'ai-vs-ai-run-claude-r001-fx-yes-polymarket');
  assert.deepEqual(client.log.map(l => l[0]), ['POST']);
});

test('an order waits for the book to update and is read until it fills', async () => {
  const client = engine(() => ({fillAfter: 2}));
  const r = await paperBuy({client, key: 'k', cells: [cell('kalshi', 0.5)], stakeUsd: 5, cash: 100, cfg, pause: noPause});
  assert.equal(r.status, 'filled');
  assert.equal(client.log.filter(l => l[0] === 'GET').length, 2);
});

test('when the cheaper venue has no live book the other venue is tried', async () => {
  const client = engine(body => body.venue === 'kalshi' ? {refuse: 'PAPER_NO_LIVE_BOOK'} : {price: 0.81});
  const r = await paperBuy({client, key: 'k', cells: [cell('kalshi', 0.8, 0.8112), cell('polymarket', 0.81, 0.8146)], stakeUsd: 5, cash: 100, cfg, pause: noPause});
  assert.equal(r.status, 'filled');
  assert.equal(r.venue, 'polymarket');
  assert.deepEqual(r.attempts.map(a => [a.venue, a.result]), [['kalshi', 'refused'], ['polymarket', 'filled']]);
});

test('no live book on any venue is reported as that, with nothing bought', async () => {
  const client = engine(() => ({refuse: 'PAPER_NO_LIVE_BOOK'}));
  const r = await paperBuy({client, key: 'k', cells: [cell('kalshi', 0.8), cell('polymarket', 0.81)], stakeUsd: 5, cash: 100, cfg, pause: noPause});
  assert.equal(r.status, 'no-live-book');
  assert.equal(r.shares, undefined);
});

test('an order that never fills is cancelled, so nothing rests on the shared paper account', async () => {
  const client = engine(() => ({fillAfter: 9999}));
  const r = await paperBuy({client, key: 'k', cells: [cell('polymarket', 0.4)], stakeUsd: 5, cash: 100, cfg: {...cfg, fillWaitSec: 0}, pause: noPause});
  assert.equal(r.status, 'no-fill');
  assert.ok(client.log.some(l => l[0] === 'POST' && /\/cancel$/.test(l[1])));
  assert.equal([...client.byKey.values()][0].status, 'canceled');
});

test('with less than one stake of free cash nothing is sent at all', async () => {
  const client = engine(() => ({}));
  for (const cash of [0.3, 4.99]) {
    const r = await paperBuy({client, key: 'k', cells: [cell('polymarket', 0.6, 0.607)], stakeUsd: 5, cash, cfg, pause: noPause});
    assert.equal(r.status, 'no-cash');
  }
  assert.equal(client.log.length, 0);
  const justEnough = await paperBuy({client, key: 'k2', cells: [cell('polymarket', 0.6, 0.607)], stakeUsd: 5, cash: 5, cfg, pause: noPause});
  assert.equal(justEnough.status, 'filled');
  assert.ok(justEnough.cost <= 5, 'the order is trimmed so the worst case still fits the cash');
});

test('any other refusal stops the bet and is reported with its code', async () => {
  const client = engine(() => ({refuse: 'VALIDATION_ERROR'}));
  const r = await paperBuy({client, key: 'k', cells: [cell('polymarket', 0.6), cell('kalshi', 0.61)], stakeUsd: 5, cash: 100, cfg, pause: noPause});
  assert.equal(r.status, 'error');
  assert.equal(r.code, 'VALIDATION_ERROR');
  assert.equal(client.log.length, 1);
});

test('the same key can never buy twice: a repeat gets the stored order back', async () => {
  const client = engine(() => ({price: 0.5}));
  const args = {client, key: 'ai-vs-ai-run-jev-r003-fx-no', cells: [cell('polymarket', 0.5)], stakeUsd: 5, cash: 100, cfg, pause: noPause};
  const first = await paperBuy(args), second = await paperBuy(args);
  assert.equal(first.orderId, second.orderId);
  assert.equal(client.byKey.size, 1);
  assert.equal(second.attempts[0].replay, true);
});

test('a partial fill is kept as the size that really filled', async () => {
  const client = engine(body => ({fill: 3, price: body.price - 0.02, fee: 0.02}));
  const r = await paperBuy({client, key: 'k', cells: [cell('polymarket', 0.5)], stakeUsd: 5, cash: 100, cfg, pause: noPause});
  assert.equal(r.status, 'partial');
  assert.equal(r.shares, 3);
  assert.equal(r.ordered, 10);
});
