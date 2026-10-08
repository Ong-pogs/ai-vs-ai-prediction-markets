import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {loadConfig, validateConfig, DEFAULT_CONFIG, REPO} from '../src/config.mjs';

const lineUp = {
  name: 'two-models',
  contestants: [{name: 'alpha', kind: 'random', seed: 1}, {name: 'beta', kind: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', model: 'some-model', keyName: 'OPENROUTER_API_KEY'}],
  markets: [{kind: 'sports-screen'}],
};
function writeConfig(config) {
  const file = join(mkdtempSync(join(tmpdir(), 'arena-config-')), 'config.json');
  writeFileSync(file, JSON.stringify(config));
  return file;
}
function withEnvFile(value, run) {
  const before = process.env.ARENA_ENV_FILE;
  if (value === undefined) delete process.env.ARENA_ENV_FILE; else process.env.ARENA_ENV_FILE = value;
  try { return run(); } finally { if (before === undefined) delete process.env.ARENA_ENV_FILE; else process.env.ARENA_ENV_FILE = before; }
}

test('the config used in the video loads: four contestants, 48 rounds half an hour apart', () => {
  const config = loadConfig(DEFAULT_CONFIG);
  assert.deepEqual(config.contestants.map(c => c.name), ['claude', 'gpt6', 'jev', 'random']);
  assert.equal(config.rounds, 48);
  assert.equal(config.intervalSec, 1800);
  assert.deepEqual(config.betsPerRound, {min: 2, max: 2});
  assert.equal(config.facts.fairPrice, false);
});

test('a new line-up is only a new config file: other contestants, another interval and length', () => {
  const config = loadConfig(writeConfig({...lineUp, intervalMinutes: 5, durationHours: 1, answerDeadlineSec: 60}));
  assert.deepEqual(config.contestants.map(c => c.kind), ['random', 'openai-chat']);
  assert.equal(config.rounds, 12);
  assert.equal(config.startingCash, 100, 'settings the file leaves out keep their defaults');
});

test('command-line overrides win over the file', () => {
  const config = loadConfig(writeConfig(lineUp), {intervalMinutes: 10, durationHours: 2});
  assert.equal(config.rounds, 12);
});

test('ARENA_ENV_FILE names the keys file, absolute or inside the repository', () => {
  const elsewhere = join(tmpdir(), 'keys-kept-elsewhere.env');
  assert.equal(withEnvFile(elsewhere, () => loadConfig(writeConfig(lineUp)).envFile), elsewhere);
  assert.equal(withEnvFile('other.env', () => loadConfig(writeConfig(lineUp)).envFile), join(REPO, 'other.env'));
});

test('a config with mistakes is refused with every mistake named', () => {
  const problems = validateConfig({
    name: 'Bad Name', contestants: [{name: 'a', kind: 'nope'}, {name: 'same', kind: 'random'}, {name: 'same', kind: 'random'}], markets: [{kind: 'crypto'}],
    startingCash: 100, stakeUsd: 500, intervalMinutes: 1, durationHours: 24, answerDeadlineSec: 150, maxMarketsPerRound: 8,
    betsPerRound: {min: 3, max: 2}, execution: {mode: 'real-money'},
  });
  for (const part of ['name must be', '"a" must be', 'unknown kind "nope"', 'used twice', 'unknown market source kind "crypto"', 'betsPerRound', 'shorter than the round interval', 'predictefy-paper', 'larger than startingCash']) {
    assert.ok(problems.some(p => p.includes(part)), `expected a problem mentioning: ${part}\n${problems.join('\n')}`);
  }
  assert.throws(() => loadConfig(writeConfig({...lineUp, contestants: []})), /at least one contestant/);
});
