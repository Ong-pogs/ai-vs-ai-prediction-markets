import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseBets, topBets, wantedCounts} from '../src/rules.mjs';

const slate = [{gid: 'g1'}, {gid: 'g2'}, {gid: 'g3'}, {gid: 'g4'}];
const answers = {
  g1: {call: 'SKIP', lean: 'YES', strength: 20},
  g2: {call: 'SKIP', lean: 'NO', strength: 90},
  g3: {call: 'BUY_YES', lean: 'YES', strength: 55},
  g4: {call: 'SKIP', lean: null, strength: 99},
};

test('with a forced rule the two highest strengths are bet, on the side leaned to', () => {
  const rules = {betsPerRound: {min: 2, max: 2}};
  const ranked = chooseBets(answers, slate, rules);
  assert.deepEqual(topBets(ranked, rules), [{gid: 'g2', side: 'NO', strength: 90}, {gid: 'g3', side: 'YES', strength: 55}]);
  assert.deepEqual(ranked.map(b => b.gid), ['g2', 'g3', 'g1'], 'the rest stay in line in case an order does not fill');
});

test('a game with no lean can never be bet, whatever its strength', () => {
  assert.ok(!chooseBets(answers, slate, {betsPerRound: {min: 2, max: 4}}).some(b => b.gid === 'g4'));
});

test('ties go to the game shown first, and zero strength still counts when a bet is required', () => {
  const flat = {g1: {call: 'SKIP', lean: 'NO', strength: 0}, g2: {call: 'SKIP', lean: 'YES', strength: 0}, g3: {call: 'SKIP', lean: 'YES', strength: 0}};
  assert.deepEqual(chooseBets(flat, slate, {betsPerRound: {min: 2, max: 2}}).map(b => b.gid), ['g1', 'g2', 'g3']);
});

test('a buy call names the side even when the lean points the other way', () => {
  const mixed = {g1: {call: 'BUY_YES', lean: 'NO', strength: 69}, g2: {call: 'BUY_NO', lean: 'YES', strength: 66}, g3: {call: 'SKIP', lean: 'NO', strength: 10}};
  assert.deepEqual(chooseBets(mixed, slate, {betsPerRound: {min: 2, max: 2}}).map(b => [b.gid, b.side]), [['g1', 'YES'], ['g2', 'NO'], ['g3', 'NO']]);
});

test('with no minimum only the buy calls are bet', () => {
  assert.deepEqual(chooseBets(answers, slate, {betsPerRound: {min: 0, max: 2}}), [{gid: 'g3', side: 'YES', strength: 55}]);
});

test('what each contestant wanted is counted separately from what the rule made it bet', () => {
  assert.deepEqual(wantedCounts(answers), {buy: 1, skip: 3});
});
