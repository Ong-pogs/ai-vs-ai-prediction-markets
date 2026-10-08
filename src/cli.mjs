// Commands:
//   node src/cli.mjs start      resume the active run, or create one from the config (this is what `npm start` runs)
//   node src/cli.mjs launch     the same, as a background process that keeps running after this terminal closes
//   node src/cli.mjs status     where the run is
//   node src/cli.mjs stop       ask the run to stop after its current step (resume later with start)
//   node src/cli.mjs settle     settle a stopped or finished run again from the markets' resolutions
//   node src/cli.mjs dashboard  serve the dashboard for a run without running it
//   node src/cli.mjs check      ask every contestant one sample question and show what comes back
//   node src/cli.mjs compare    the result over every round, and over only the rounds in which every AI answered (--save, --json)
// Options: --config <file>  --run-id <id>  --new  --start-at <HH:MM>  --rounds <n>  --interval-min <m>  --settle-grace-hours <h>  --port <p>  --no-dashboard
import {spawn} from 'node:child_process';
import {existsSync, openSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {loadConfig, DEFAULT_CONFIG, RUNS, REPO} from './config.mjs';
import {readEnvFile, requireKey} from './env.mjs';
import {makePredictefy} from './predictefy.mjs';
import {createContestant} from './contestants/index.mjs';
import {cleanEnv} from './contestants/proc.mjs';
import {runStore, listRuns, readActive, writeActive} from './store.mjs';
import {createState, newRunId, runLoop, settlePass, finishedSummary, roundTime} from './runner.mjs';
import {startServer} from './server.mjs';
import {buildPrompt} from './prompt.mjs';
import {summary} from './ledger.mjs';
import {likeForLike, comparisonLines} from './compare.mjs';
import {iso, sleep, writeJsonAtomic} from './util.mjs';

function parseArgs(argv) {
  const args = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true; else { args[key] = next; i++; }
  }
  return args;
}
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = message => console.log(`[${stamp()}] ${message}`);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = store => existsSync(store.paths.pid) ? JSON.parse(readFileSync(store.paths.pid, 'utf8')) : null;

function overridesFrom(args) {
  const o = {};
  if (args['interval-min']) o.intervalMinutes = Number(args['interval-min']);
  if (args.rounds) o.durationHours = Number(args.rounds) * (o.intervalMinutes ?? loadConfig(args.config || DEFAULT_CONFIG).intervalMinutes) / 60;
  if (args['settle-grace-hours'] !== undefined) o.settleGraceHours = Number(args['settle-grace-hours']);
  if (args.port) o.dashboardPort = Number(args.port);
  if (args['no-finished-file']) o.finishedFile = null;
  return o;
}

/** --start-at takes a local clock time today ("17:30") or a full ISO time. Without it the run starts now. */
function startTime(args) {
  const given = args['start-at'];
  if (!given || given === true) return Date.now();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(String(given));
  const ms = clock ? new Date().setHours(Number(clock[1]), Number(clock[2]), 0, 0) : Date.parse(given);
  if (!Number.isFinite(ms)) throw new Error(`--start-at "${given}" is not a time. Use HH:MM or an ISO time.`);
  if (ms < Date.now() - 60000) throw new Error(`--start-at ${given} is in the past.`);
  return ms;
}

/** Which run a command is about: an explicit id, else the active run, else (for start) a new one. */
function resolveRun(args, config) {
  if (args['run-id']) return {runId: String(args['run-id']), explicit: true};
  const active = readActive(RUNS);
  if (active && !args.new) return {runId: active.runId, explicit: false};
  return {runId: newRunId(config, startTime(args)), explicit: false, fresh: true};
}

async function start(args) {
  const config = loadConfig(args.config || DEFAULT_CONFIG, overridesFrom(args));
  const {runId, explicit} = resolveRun(args, config);
  const store = runStore(RUNS, runId);
  let state, runConfig = config;
  if (store.exists()) {
    state = store.load();
    if (state.status === 'finished') { log(`Run ${runId} finished at ${state.finished?.writtenAt}. Start another with: npm start -- --new`); return; }
    runConfig = {...state.config, envFile: config.envFile};   // a run keeps the settings it was created with
    log(`resuming run ${runId} (round ${state.nextRound + 1} of ${state.rounds} is next)`);
  } else {
    store.prepare();
    state = createState(config, runId, startTime(args));
    store.save(state);
    store.event('run_created', {runId, config: config.file, startAt: state.startAt, endAt: state.endAt});
    log(`created run ${runId}: ${state.rounds} rounds, one every ${config.intervalMinutes} minutes, from ${state.startAt} to ${state.endAt}`);
  }
  if (!explicit || args['make-active']) writeActive(RUNS, {runId, config: runConfig.file, setAt: iso()});
  const running = readPid(store);
  if (running && running.pid !== process.pid && alive(running.pid)) { log(`Run ${runId} is already running as process ${running.pid}. Stop it first with: npm run stop`); process.exitCode = 1; return; }
  store.prepare();
  store.clearStop();
  writeFileSync(store.paths.pid, JSON.stringify({pid: process.pid, startedAt: iso()}));

  const env = readEnvFile(runConfig.envFile);
  const client = makePredictefy({apiKey: requireKey(env, 'PREDICTEFY_API_KEY', `Put it in ${runConfig.envFile} (see .env.example). Keys are made at https://portal.predictefy.com/keys`)});
  const contestants = runConfig.contestants.map(def => createContestant(def, {env, agentDir: store.paths.agentRoom, tmpDir: store.paths.tmp}));
  const ctx = {config: runConfig, state, store, client, contestants, log, usageBase: structuredClone(state.predictefy)};
  process.on('uncaughtException', error => { log(`unexpected error: ${error?.stack || error}`); store.event('uncaught', {message: String(error?.stack || error).slice(0, 800)}); });
  process.on('unhandledRejection', error => { log(`unexpected rejection: ${error?.stack || error}`); store.event('unhandled', {message: String(error?.stack || error).slice(0, 800)}); });
  const server = args['no-dashboard'] ? null : startServer({store, port: runConfig.dashboardPort, log});
  let outcome;
  for (;;) {
    try { outcome = await runLoop(ctx); break; }
    catch (error) {
      // nothing should get here, but a 24-hour run must not die of one surprise: note it and carry on from the saved state
      log(`the run loop stopped unexpectedly: ${error?.stack || error}`);
      try { store.event('loop_error', {message: String(error?.stack || error).slice(0, 800)}); } catch { /* keep going */ }
      await sleep(30000);
    }
  }
  rmSync(store.paths.pid, {force: true});
  server?.close();
  log(`run ${runId}: ${outcome}`);
  process.exit(0);
}

async function launch(args) {
  const config = loadConfig(args.config || DEFAULT_CONFIG, overridesFrom(args));
  const {runId} = resolveRun(args, config);
  const store = runStore(RUNS, runId);
  store.prepare();
  const running = readPid(store);
  if (running && alive(running.pid)) { console.log(`Run ${runId} is already running as process ${running.pid}.`); return; }
  const passOn = ['config', 'rounds', 'interval-min', 'settle-grace-hours', 'port', 'start-at'].flatMap(k => args[k] !== undefined ? [`--${k}`, String(args[k])] : []);
  const flags = [...passOn, '--run-id', runId, ...(args['run-id'] && !args['make-active'] ? [] : ['--make-active']), ...['no-dashboard', 'no-finished-file'].filter(k => args[k]).map(k => `--${k}`)];
  const out = openSync(store.paths.log, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start', ...flags], {cwd: REPO, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: cleanEnv()});
  child.unref();
  await sleep(2500);
  const pid = readPid(store);
  console.log(JSON.stringify({runId, launcherChildPid: child.pid, runPid: pid?.pid ?? null, log: store.paths.log, state: store.paths.state}, null, 1));
}

function pickStore(args) {
  const runId = args['run-id'] || readActive(RUNS)?.runId || listRuns(RUNS).at(-1);
  if (!runId) throw new Error('There is no run yet. Start one with: npm start');
  const store = runStore(RUNS, runId);
  if (!store.exists()) throw new Error(`No run named ${runId} under ${RUNS}`);
  return store;
}

function status(args) {
  const store = pickStore(args), state = store.load(), pid = readPid(store);
  const next = state.nextRound < state.rounds ? iso(roundTime(state, state.nextRound)) : null;
  console.log(`run        ${state.runId}`);
  console.log(`status     ${state.status} (${state.stage})${pid ? `, process ${pid.pid} ${alive(pid.pid) ? 'is running' : 'is NOT running'}` : ', no process'}`);
  console.log(`schedule   started ${state.startAt}, ends ${state.endAt}`);
  console.log(`rounds     ${state.roundsDone} done of ${state.rounds}, ${state.missedRounds.length} missed${next ? `, next at ${next}` : ''}`);
  for (const c of Object.values(state.contestants)) {
    const s = summary(c.account);
    console.log(`${c.name.padEnd(10)} $${s.equity.toFixed(2).padStart(7)}  cash $${s.cash.toFixed(2).padStart(6)}  bets ${String(s.bets).padStart(3)} (won ${s.won}, lost ${s.lost}, open ${s.open})  answers ok ${c.usage.ok}, late ${c.usage.late}, invalid ${c.usage.invalid}, errors ${c.usage.errors}  ${c.reportedModel || ''}`);
  }
  console.log(`predictefy ${state.predictefy.credits} credits in ${state.predictefy.calls} calls`);
  if (state.lastError) console.log(`last error ${state.lastError.at}: ${state.lastError.message.split('\n')[0]}`);
}

/** Reads the saved run and changes nothing in it, so it is safe on a run that is still going. --save writes the result beside the run. */
function compare(args) {
  const store = pickStore(args), state = store.load();
  const result = likeForLike(state, store.roundNumbers().map(n => store.loadRound(n)).filter(Boolean));
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else for (const line of comparisonLines(result)) console.log(line);
  if (args.save) {
    const file = join(store.dir, 'like-for-like.json');
    writeJsonAtomic(file, {writtenAt: iso(), ...result});
    if (!args.json) console.log(`saved      ${file}`);
  }
}

function stop(args) {
  const store = pickStore(args);
  store.requestStop();
  console.log(`Stop requested for ${store.runId}. It saves and exits within about 15 seconds once the current step is done. Resume with: npm start`);
}

async function settle(args) {
  const store = pickStore(args), state = store.load(), pid = readPid(store);
  if (pid && alive(pid.pid)) throw new Error(`Run ${store.runId} is running as process ${pid.pid}; it settles by itself every round.`);
  const config = loadConfig(args.config || state.config.file || DEFAULT_CONFIG);
  const env = readEnvFile(config.envFile);
  const client = makePredictefy({apiKey: requireKey(env, 'PREDICTEFY_API_KEY')});
  const ctx = {config: state.config, state, store, client, contestants: [], log, usageBase: structuredClone(state.predictefy)};
  const settled = await settlePass(ctx, 'manual');
  state.equity.push({round: 'manual', at: iso(), values: Object.fromEntries(Object.values(state.contestants).map(c => [c.name, summary(c.account).equity]))});
  const stage = state.status === 'finished' ? 'final' : (state.finished?.stage || 'in-progress');
  const result = finishedSummary(state, stage);
  store.save(state);
  if (state.finished) { writeJsonAtomic(store.paths.finished, result); if (state.config.finishedFile) writeJsonAtomic(state.config.finishedFile, result); }
  console.log(`settled ${settled.length} bet(s); ${result.unsettled.length} still unsettled`);
  for (const row of settled) console.log(`  ${row.name}: ${row.result} ${row.title} (${row.sideName}) ${row.pnl >= 0 ? '+' : ''}${row.pnl.toFixed(2)}`);
}

async function dashboard(args) {
  const store = pickStore(args);
  const port = Number(args.port || store.load().config.dashboardPort || 8815);
  startServer({store, port, log});
  await new Promise(() => {});
}

async function check(args) {
  const config = loadConfig(args.config || DEFAULT_CONFIG);
  const env = readEnvFile(config.envFile);
  const store = runStore(RUNS, '_check');
  store.prepare();
  const facts = [
    {id: 'g1', game: 'Sample League: Rivertown Otters v Lakeside Herons', when: 'Starts in 1 hour.', yes_means: 'Rivertown Otters to win', no_means: 'Lakeside Herons to win', prices: 'YES costs 58 cents on Polymarket. NO costs 43 cents on Polymarket. A winning share pays 100 cents.', fair_price: "Predictefy's no-vig fair price across 3 venues is 57.5% for YES and 42.5% for NO.", value: 'After fees, the cheapest YES is 1 cents above the fair price, and the cheapest NO is 1 cents above the fair price.'},
    {id: 'g2', game: 'Sample League: Hillford Rams v Eastbay Gulls', when: 'In play. It started 20 minutes ago.', yes_means: 'Hillford Rams to win', no_means: 'Eastbay Gulls to win', prices: 'YES costs 31 cents on Polymarket. NO costs 70 cents on Polymarket. A winning share pays 100 cents.', fair_price: 'Predictefy has no cross-venue fair price for this game.'},
  ];
  const rules = {startingCash: config.startingCash, stakeUsd: config.stakeUsd, betsPerRound: config.betsPerRound};
  const prompt = buildPrompt(facts, rules);
  for (const def of config.contestants) {
    const contestant = createContestant(def, {env, agentDir: store.paths.agentRoom, tmpDir: store.paths.tmp});
    const r = await contestant.ask({facts, prompt, ids: ['g1', 'g2'], deadlineMs: config.answerDeadlineSec * 1000, roundNumber: 0});
    console.log(`${def.name.padEnd(10)} ${r.status.padEnd(8)} ${(r.latencyMs / 1000).toFixed(1).padStart(5)} s  model ${r.model || '-'}  usage ${JSON.stringify(r.usage)}${r.error ? `  error: ${r.error}` : ''}`);
    for (const [id, a] of Object.entries(r.answers)) console.log(`    ${id}: ${a.call} p_yes ${a.pYes} lean ${a.lean} strength ${a.strength}${a.problem ? `  (${a.problem})` : ''}`);
  }
}

const commands = {start, launch, status, stop, settle, dashboard, check, compare};
const [name = 'start', ...rest] = process.argv.slice(2);
const command = commands[name];
if (!command) { console.error(`Unknown command "${name}". Use one of: ${Object.keys(commands).join(', ')}`); process.exit(1); }
try { await command(parseArgs(rest)); }
catch (error) { console.error(error.message); process.exit(1); }
