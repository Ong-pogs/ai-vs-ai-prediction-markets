import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPrompt, parseAnswers, parseJevAnswer, jevQuestions, jevState, rulesText, ANSWER_SCHEMA} from '../src/prompt.mjs';
import {extractJson} from '../src/util.mjs';

const facts = [
  {id: 'g1', game: 'NFL: Tampa Bay Buccaneers at Dallas Cowboys', when: 'Starts in 1 hour.', yes_means: 'Dallas Cowboys to win', no_means: 'Tampa Bay Buccaneers to win', prices: 'YES costs 80 cents on Kalshi. NO costs 20 cents on Polymarket. A winning share pays 100 cents.', fair_price: 'x', value: 'y'},
  {id: 'g2', game: 'KHL: Traktor v Amur Khabarovsk', when: 'In play. It started 10 minutes ago.', yes_means: 'Traktor to win', no_means: 'Amur Khabarovsk to win', prices: 'p', fair_price: 'f'},
];
const rules = {startingCash: 100, stakeUsd: 5, betsPerRound: {min: 2, max: 2}};

test('the prompt states the forced-bet rule, the money and every game', () => {
  const prompt = buildPrompt(facts, rules);
  assert.match(prompt, /must place its two best bets/);
  assert.match(prompt, /\$5 on each of your two highest strength scores/);
  assert.match(prompt, /starts with \$100 of pretend money/);
  assert.match(prompt, /^g1$/m);
  assert.match(prompt, /^yes_means: Traktor to win$/m);
  assert.ok(!/undefined/.test(prompt));
});

test('with no minimum the rule says betting is a choice', () => {
  assert.match(rulesText({stakeUsd: 2, betsPerRound: {min: 0, max: 1}}), /betting is your choice/);
});

test('a clean answer is read into the five fields', () => {
  const r = parseAnswers('{"answers":[{"id":"g1","call":"BUY_NO","p_yes":0.7,"lean":"NO","strength":80,"reason":"r"},{"id":"g2","call":"SKIP","p_yes":0.5,"lean":"YES","strength":10,"reason":""}]}', ['g1', 'g2']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.answers.g1, {call: 'BUY_NO', pYes: 0.7, lean: 'NO', strength: 80, reason: 'r'});
  assert.equal(r.problems.length, 0);
});

test('a code fence or a stray sentence around the JSON does no harm', () => {
  const fence = '`'.repeat(3);
  const r = parseAnswers(`Here you go:\n${fence}json\n{"answers":[{"id":"G1","call":"buy_yes","p_yes":"0.61","strength":"70","reason":"x"}]}\n${fence}`, ['g1']);
  assert.equal(r.ok, true);
  assert.equal(r.answers.g1.call, 'BUY_YES');
  assert.equal(r.answers.g1.pYes, 0.61);
  assert.equal(r.answers.g1.lean, 'YES', 'a buy call implies the lean when lean is missing');
  assert.equal(r.answers.g1.strength, 70);
});

test('a missing game is a skip, and bad fields are noted but never throw', () => {
  const r = parseAnswers({answers: [{id: 'g1', call: 'MAYBE', p_yes: 7, lean: 'UP', strength: 400}]}, ['g1', 'g2']);
  assert.equal(r.answers.g1.call, 'SKIP');
  assert.equal(r.answers.g1.pYes, null);
  assert.equal(r.answers.g1.lean, null);
  assert.equal(r.answers.g1.strength, 100);
  assert.match(r.answers.g1.problem, /call was not/);
  assert.equal(r.answers.g2.problem, 'no answer for this game');
});

test('a reply that is not the JSON asked for is invalid', () => {
  assert.equal(parseAnswers('I would rather not say.', ['g1']).ok, false);
  assert.equal(parseAnswers('{"picks":[]}', ['g1']).ok, false);
  assert.equal(extractJson('no braces'), null);
});

test('the typed answers from Jev map onto the same fields', () => {
  const body = {
    model: 'jev-1.13.0',
    answers: {
      call: {type: 'choice', choice: 'SKIP', confidence: 0.51, probabilities: {BUY_YES: 0.32, BUY_NO: 0.01, SKIP: 0.67}},
      yes_wins: {type: 'noul', noul: 0.65},
      lean: {type: 'choice', choice: 'YES', confidence: 0.4, probabilities: {YES: 0.8, NO: 0.2}},
    },
    usage: {input_tokens: 700, output_tokens: 60},
  };
  const a = parseJevAnswer(body);
  assert.equal(a.call, 'SKIP');
  assert.equal(a.pYes, 0.65);
  assert.equal(a.lean, 'YES');
  assert.equal(a.strength, 33);
  assert.equal(parseJevAnswer({answers: {call: {choice: 'HOLD'}}}), null);
});

test('Jev gets the facts without the id and three typed questions', () => {
  assert.deepEqual(Object.keys(jevState(facts[1])), ['game', 'when', 'yes_means', 'no_means', 'prices', 'fair_price']);
  const q = jevQuestions(facts[0]);
  assert.deepEqual(Object.keys(q.call.criteria), ['BUY_YES', 'BUY_NO', 'SKIP']);
  assert.equal(q.yes_wins.type, 'noul');
  assert.deepEqual(Object.keys(q.lean.criteria), ['YES', 'NO']);
});

test('the schema given to Codex requires every field', () => {
  const item = ANSWER_SCHEMA.properties.answers.items;
  assert.deepEqual(item.required.slice().sort(), Object.keys(item.properties).sort());
  assert.equal(item.additionalProperties, false);
});
