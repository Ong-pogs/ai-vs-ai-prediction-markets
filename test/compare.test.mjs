import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyAnswer, likeForLike, comparisonLines, betValue} from '../src/compare.mjs';

const kindOf = (status, error) => classifyAnswer({status, error}).kind;
const causeOf = error => classifyAnswer({status: 'error', error}).cause;

test('a usable answer, a late one and an unreadable one are the contestant\'s own', () => {
  assert.equal(kindOf('ok'), 'answered');
  assert.equal(classifyAnswer({status: 'late', problems: ['no answer within 150 s']}).kind, 'late');
  assert.equal(classifyAnswer({status: 'invalid', problems: ['g3: call must be BUY_YES, BUY_NO or SKIP']}).kind, 'invalid');
});

test('a call stopped by a plan limit is unavailable, not a failure of the AI', () => {
  for (const text of [
    'Claude AI usage limit reached|1791460800',
    "You've hit your session limit · resets 7:20pm (Asia/Kuala_Lumpur)",
    "You've hit your weekly limit · resets Oct 15, 6pm",
    "ERROR: You've hit your usage limit. Upgrade to Pro or try again in 3 hours 12 minutes.",
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}',
    'stream error: exceeded retry limit, last status: 429 Too Many Requests',
    'Credit balance is too low',
    'out of TypeSafe credit (HTTP 402)',
    'HTTP 429: You exceeded your current quota',
  ]) assert.deepEqual([kindOf('error', text), causeOf(text)], ['unavailable', 'plan limit'], text);
});

test('an expired login and a service outage are unavailable too, each with its own cause', () => {
  for (const text of ['Codex is not signed in (its login has expired)', 'Invalid API key · Please run /login', 'TypeSafe rejected the API key (HTTP 401)', 'TYPESAFE_API_KEY is missing from the env file']) {
    assert.deepEqual([kindOf('error', text), causeOf(text)], ['unavailable', 'not signed in'], text);
  }
  for (const text of ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'TypeSafe is busy (HTTP 503)', 'could not reach http://127.0.0.1:9/v1 (fetch failed)', 'error: unexpected status 502 Bad Gateway']) {
    assert.deepEqual([kindOf('error', text), causeOf(text)], ['unavailable', 'service error'], text);
  }
});

test('an error that names no outside cause stays a plain failure', () => {
  for (const text of ['claude exited with 1', 'codex exited with 1 and no answer', 'spawn claude ENOENT', '']) assert.equal(kindOf('error', text), 'failed', text);
  assert.equal(classifyAnswer(undefined).kind, 'failed', 'a finished round with no saved answer');
  assert.equal(classifyAnswer(undefined, {finished: false}).kind, 'pending', 'a round still being played');
});

test('the dashboard page carries exactly the same list of causes', () => {
  const block = file => { const text = readFileSync(new URL(file, import.meta.url), 'utf8'); return text.slice(text.indexOf('/* causes:start */'), text.indexOf('/* causes:end */')); };
  assert.ok(block('../src/compare.mjs').includes("['plan limit'"));
  assert.equal(block('../src/dashboard/index.html'), block('../src/compare.mjs'));
});

// ---- a small run: three AIs and the random picker over four rounds ----
const bet = (round, state, cost, extra = {}) => ({round, state, cost, shares: 10, avgPrice: cost / 10, ...extra});
const account = positions => {
  const startingCash = 100;
  const cash = startingCash - positions.reduce((sum, p) => sum + p.cost, 0) + positions.filter(p => p.state === 'won').reduce((sum, p) => sum + p.shares, 0);
  return {startingCash, cash, positions};
};
const state = {
  runId: 'test-run', rounds: 6, missedRounds: [5],
  contestants: {
    claude: {name: 'claude', label: 'Claude', account: account([bet(1, 'won', 4, {pnl: 6}), bet(2, 'lost', 5, {pnl: -5}), bet(4, 'open', 5, {mark: 0.6})])},
    gpt6: {name: 'gpt6', label: 'GPT', account: account([bet(1, 'lost', 5, {pnl: -5}), bet(2, 'won', 5, {pnl: 5}), bet(3, 'won', 2, {pnl: 8}), bet(4, 'open', 5, {mark: 0.4})])},
    jev: {name: 'jev', label: 'Jev', account: account([bet(1, 'won', 5, {pnl: 5}), bet(3, 'lost', 5, {pnl: -5}), bet(4, 'open', 5)])},
    random: {name: 'random', label: 'Random picks', baseline: true, account: account([bet(1, 'lost', 5, {pnl: -5}), bet(2, 'lost', 5, {pnl: -5}), bet(3, 'won', 5, {pnl: 5}), bet(4, 'open', 5, {mark: 0.5})])},
  },
};
const ok = ms => ({status: 'ok', latencyMs: ms});
const everyone = extra => ({claude: ok(7000), gpt6: ok(28000), jev: ok(300), random: ok(1), ...extra});
const slate = [{gid: 'g1'}, {gid: 'g2'}];
const rounds = [
  {round: 4, finishedAt: 't4', slate, answers: everyone()},
  {round: 1, finishedAt: 't1', slate, answers: everyone()},
  {round: 2, finishedAt: 't2', slate, answers: everyone({jev: {status: 'late', problems: ['no answer within 150 s'], latencyMs: 153000}})},
  {round: 3, finishedAt: 't3', slate, answers: everyone({claude: {status: 'error', error: "You've hit your session limit · resets 7:20pm", latencyMs: 1200}})},
  {round: 6, finishedAt: 't6', slate: [], answers: {}, notes: ['No tradable games this round.']},
  {round: 7, slate, answers: {random: ok(1)}},
];

test('the comparison is given over every round and over only the rounds in which every AI answered', () => {
  const result = likeForLike(state, rounds);
  assert.deepEqual(result.ais, ['claude', 'gpt6', 'jev']);
  assert.equal(result.roundsPlayed, 4, 'a round with no games and a round still being played are left out');
  assert.equal(result.roundsWithoutGames, 1);
  assert.equal(result.roundsInProgress, 1);
  assert.equal(result.roundsMissed, 1);
  assert.deepEqual(result.likeForLikeRounds, [1, 4]);
  const by = Object.fromEntries(result.contestants.map(c => [c.name, c]));
  assert.deepEqual(by.claude.rounds, {answered: 3, late: 0, invalid: 0, unavailable: 1, failed: 0});
  assert.deepEqual(by.claude.unavailableRounds, [3]);
  assert.deepEqual(by.jev.rounds, {answered: 3, late: 1, invalid: 0, unavailable: 0, failed: 0});
  // every round: claude +6 -5 +1 (open bet worth 6 against a cost of 5), gpt6 -5 +5 +8 -1, jev +5 -5 +0
  assert.deepEqual([by.claude.all.pnl, by.gpt6.all.pnl, by.jev.all.pnl, by.random.all.pnl], [2, 7, 0, -5]);
  // rounds 1 and 4 only: the round GPT won while Claude was unavailable no longer counts for anyone
  assert.deepEqual([by.claude.likeForLike.pnl, by.gpt6.likeForLike.pnl, by.jev.likeForLike.pnl, by.random.likeForLike.pnl], [7, -6, 5, -5]);
  assert.deepEqual([by.gpt6.all.bets, by.gpt6.likeForLike.bets], [4, 2]);
  assert.equal(by.random.baseline, true, 'the random picker is listed but never decides which rounds count');
  for (const c of result.contestants) assert.equal(c.balanceCheck, 0, `${c.name}: profit over every bet equals balance minus starting cash`);
  assert.equal(by.claude.averageSecondsWhenAnswered, 7, 'a call that failed in a second does not make Claude look faster');
  assert.equal(by.jev.averageSecondsWhenAnswered, 0.3, 'a late round does not count as a 153-second answer');
  assert.deepEqual(result.notAnswered.map(m => [m.round, m.name, m.kind, m.cause]), [[2, 'jev', 'late', null], [3, 'claude', 'unavailable', 'plan limit']]);
});

test('rounds in which two AIs placed exactly the same bets are counted', () => {
  const holds = (name, bets) => ({name, label: name, account: account(bets.map(([round, gameId, side]) => bet(round, 'open', 5, {gameId, side})))});
  const twins = {
    runId: 'twins', rounds: 3, missedRounds: [],
    contestants: {
      claude: holds('claude', [[1, 'fx_a', 'YES'], [1, 'fx_b', 'NO'], [2, 'fx_c', 'YES'], [2, 'fx_d', 'YES'], [3, 'fx_e', 'NO']]),
      gpt6: holds('gpt6', [[1, 'fx_b', 'NO'], [1, 'fx_a', 'YES'], [2, 'fx_c', 'YES'], [2, 'fx_d', 'NO'], [3, 'fx_e', 'NO']]),
      jev: holds('jev', [[1, 'fx_a', 'YES'], [1, 'fx_z', 'NO'], [3, 'fx_e', 'YES']]),
    },
  };
  const all = {claude: ok(1), gpt6: ok(1), jev: ok(1)};
  const result = likeForLike(twins, [1, 2, 3].map(round => ({round, finishedAt: 't', slate, answers: all})));
  const pair = (a, b) => result.sameBets.find(p => p.a === a && p.b === b);
  assert.deepEqual(pair('claude', 'gpt6'), {a: 'claude', b: 'gpt6', roundsBothBet: 3, rounds: [1, 3]}, 'the order the bets were placed in does not matter; the side does');
  assert.deepEqual(pair('claude', 'jev'), {a: 'claude', b: 'jev', roundsBothBet: 2, rounds: []});
  assert.match(comparisonLines(result).join('\n'), /claude and gpt6 placed exactly the same bets in 2 of the 3 rounds in which both bet \(rounds 1, 3\)/);
});

test('an open bet is worth its last price, and its fill price until one is read', () => {
  assert.equal(betValue(bet(1, 'open', 5, {mark: 0.6})), 1);
  assert.equal(betValue(bet(1, 'open', 5)), 0);
  assert.equal(betValue(bet(1, 'lost', 5, {pnl: -5, mark: 0.01})), -5);
});

test('the terminal report names each round a contestant sat out and why', () => {
  const text = comparisonLines(likeForLike(state, rounds)).join('\n');
  assert.match(text, /every AI \(claude, gpt6, jev\) answered in 2 of 4/);
  assert.match(text, /round {2}3 {2}claude {3}unavailable \(plan limit\): You've hit your session limit/);
  assert.match(text, /round {2}2 {2}jev {6}late: no answer within 150 s/);
  assert.match(text, /claude .*sat out: 1 unavailable/);
  assert.match(text, /check: for every contestant/);
  const clean = comparisonLines(likeForLike(state, rounds.filter(r => r.round === 1 || r.round === 4))).join('\n');
  assert.match(clean, /no contestant missed a round/);
});
