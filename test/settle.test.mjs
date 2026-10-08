import test from 'node:test';
import assert from 'node:assert/strict';
import {readResolution, describeResolution} from '../src/settle.mjs';
import {newAccount, openPosition, settlePosition, equity, summary} from '../src/ledger.mjs';

// Shapes copied from real Predictefy responses on 2026-10-08.
const rams = {marketId: '3664837', status: 'resolved', asOf: '2026-09-28T04:16:47.047Z', outcomes: [{outcomeId: 'A', label: 'Rams', price: 0.0005, priceBasis: 'venue-composite'}, {outcomeId: 'B', label: 'Broncos', price: 0.9995, priceBasis: 'venue-composite'}]};
const lions = {marketId: '3398287', status: 'resolved', asOf: '2026-09-18T02:20:01.194Z', outcomes: [{outcomeId: 'A', label: 'Lions', price: 0.065}, {outcomeId: 'B', label: 'Bills', price: 0.935}]};
const kalshi = {marketId: 'KXNFLGAME-26SEP28PHICHI-PHI', status: 'resolved', outcomes: [{outcomeId: 'KXNFLGAME-26SEP28PHICHI-PHI', label: 'Philadelphia', price: 0.01, priceBasis: 'last-trade'}, {outcomeId: 'KXNFLGAME-26SEP28PHICHI-PHI-NO', price: 0.99, priceBasis: 'complement'}]};
const justEnded = {marketId: '5396218', status: 'open', outcomes: [{outcomeId: 'UP', price: 0.9995}, {outcomeId: 'DOWN', price: 0.0005}]};

test('a resolved market with a decisive price settles as won or lost', () => {
  assert.equal(readResolution(rams, 'B').state, 'won');
  assert.equal(readResolution(rams, 'B').payoutPerShare, 1);
  assert.equal(readResolution(rams, 'A').state, 'lost');
  assert.equal(readResolution(kalshi, 'KXNFLGAME-26SEP28PHICHI-PHI').state, 'lost');
  assert.equal(readResolution(kalshi, 'KXNFLGAME-26SEP28PHICHI-PHI-NO').state, 'won');
});

test('a resolved market that still carries an in-game price is not settled', () => {
  assert.equal(readResolution(lions, 'B').state, 'unclear');
  assert.equal(readResolution(lions, 'A').state, 'unclear');
});

test('a market that is not marked resolved stays open even at 99.95 cents', () => {
  const r = readResolution(justEnded, 'UP');
  assert.equal(r.state, 'open');
  assert.equal(r.price, 0.9995);
});

test('an outcome that is not in the market is never settled', () => {
  assert.equal(readResolution(rams, 'Z').state, 'unclear');
  assert.equal(readResolution(null, 'A').state, 'unknown');
});

test('the note on a settlement names the endpoint and what it said', () => {
  assert.match(describeResolution('polymarket', '3664837', readResolution(rams, 'B')), /GET \/api\/polymarket\/fetchMarket\?marketId=3664837: status resolved, outcome price 0\.9995/);
});

test('the ledger takes cost and fees out at the fill and pays a dollar a share on a win', () => {
  const account = newAccount(100);
  openPosition(account, {id: 'a', shares: 24, avgPrice: 0.2, fees: 0.12, cost: 4.92, openedAt: 't'});
  openPosition(account, {id: 'b', shares: 6, avgPrice: 0.81, fees: 0.03, cost: 4.89, openedAt: 't'});
  assert.equal(account.cash, 90.19);
  assert.equal(equity(account), 99.85, 'open bets are valued at their fill price until a newer price is read');
  account.positions[0].mark = 0.25;
  assert.equal(equity(account), 101.05);
  settlePosition(account.positions[0], account, {won: true, how: 'h', at: 't2'});
  settlePosition(account.positions[1], account, {won: false, how: 'h', at: 't2'});
  assert.equal(account.cash, 114.19);
  assert.equal(account.positions[0].pnl, 19.08);
  assert.equal(account.positions[1].pnl, -4.89);
  const s = summary(account);
  assert.deepEqual([s.bets, s.won, s.lost, s.open, s.equity, s.pnl], [2, 1, 1, 0, 114.19, 14.19]);
  assert.equal(s.feesPaid, 0.15);
});
