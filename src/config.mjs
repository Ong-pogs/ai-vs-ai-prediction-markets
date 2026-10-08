// A run is described by one JSON file: who plays, on which markets, how often and for how long.
// A new line-up is a new config file, not a code change. config/local.json (not committed) can override paths.
import {existsSync, readFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {KINDS} from './contestants/index.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS = join(REPO, 'runs');
export const DEFAULT_CONFIG = join(REPO, 'config', 'games-24h.json');

const DEFAULTS = {
  title: 'AI vs AI on prediction markets',
  startingCash: 100,
  stakeUsd: 5,
  betsPerRound: {min: 2, max: 2},
  intervalMinutes: 30,
  durationHours: 24,
  answerDeadlineSec: 150,
  maxMarketsPerRound: 8,
  minMarketsPerRound: 4,
  settleGraceHours: 3,
  dashboardPort: 8815,
  envFile: '.env',
  finishedFile: null,
  facts: {fairPrice: true},
  execution: {mode: 'predictefy-paper', slippage: 0.02, fillWaitSec: 90, pollEverySec: 2},
};
export const MARKET_KINDS = ['sports-screen'];

export function validateConfig(config) {
  const problems = [];
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(config.name || '')) problems.push('name must be lower-case letters, digits and dashes');
  const names = new Set();
  if (!Array.isArray(config.contestants) || !config.contestants.length) problems.push('contestants must list at least one contestant');
  for (const c of config.contestants || []) {
    if (!/^[a-z0-9]{2,20}$/.test(c.name || '')) problems.push(`contestant name "${c.name}" must be 2 to 20 lower-case letters or digits`);
    if (names.has(c.name)) problems.push(`contestant name "${c.name}" is used twice`);
    names.add(c.name);
    if (!KINDS[c.kind]) problems.push(`contestant "${c.name}" has unknown kind "${c.kind}" (known: ${Object.keys(KINDS).join(', ')})`);
  }
  if (!Array.isArray(config.markets) || !config.markets.length) problems.push('markets must list at least one market source');
  for (const m of config.markets || []) if (!MARKET_KINDS.includes(m.kind)) problems.push(`unknown market source kind "${m.kind}" (known: ${MARKET_KINDS.join(', ')})`);
  for (const key of ['startingCash', 'stakeUsd', 'intervalMinutes', 'durationHours', 'answerDeadlineSec', 'maxMarketsPerRound']) {
    if (!(typeof config[key] === 'number' && config[key] > 0)) problems.push(`${key} must be a number above zero`);
  }
  const {min, max} = config.betsPerRound || {};
  if (!(Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max >= 1 && min <= max)) problems.push('betsPerRound needs whole numbers with 0 <= min <= max and max >= 1');
  if (config.answerDeadlineSec >= config.intervalMinutes * 60) problems.push('answerDeadlineSec must be shorter than the round interval');
  if (config.execution?.mode !== 'predictefy-paper') problems.push('execution.mode must be "predictefy-paper"');
  if (config.stakeUsd > config.startingCash) problems.push('stakeUsd cannot be larger than startingCash');
  return problems;
}

export function loadConfig(file = DEFAULT_CONFIG, overrides = {}) {
  const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
  const given = JSON.parse(readFileSync(path, 'utf8'));
  const localFile = join(REPO, 'config', 'local.json');
  const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, 'utf8')) : {};
  const config = {
    ...DEFAULTS, ...given, ...(local.all || {}), ...(local[given.name] || {}), ...overrides,
    betsPerRound: {...DEFAULTS.betsPerRound, ...given.betsPerRound, ...overrides.betsPerRound},
    execution: {...DEFAULTS.execution, ...given.execution, ...overrides.execution},
    facts: {...DEFAULTS.facts, ...given.facts, ...overrides.facts},
  };
  config.contestants = (given.contestants || []).map(c => ({...c, ...(local.contestants?.[c.name] || {})}));
  // ARENA_ENV_FILE points at a keys file kept somewhere else, so a fresh clone can run without its own copy of the keys.
  const envFile = process.env.ARENA_ENV_FILE || config.envFile;
  config.envFile = isAbsolute(envFile) ? envFile : join(REPO, envFile);
  const problems = validateConfig(config);
  if (problems.length) throw new Error(`The config ${path} has problems:\n- ${problems.join('\n- ')}`);
  config.intervalSec = Math.round(config.intervalMinutes * 60);
  config.rounds = Math.max(1, Math.round(config.durationHours * 3600 / config.intervalSec));
  config.file = path;
  return config;
}
