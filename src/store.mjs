// Everything a run knows lives in its own folder under runs/, so a run survives a restart and two runs never touch
// each other. state.json is the current truth, events.jsonl is the full log, rounds/ holds one file per round.
import {existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {appendJsonLine, iso, readJson, writeJsonAtomic} from './util.mjs';

export function runStore(root, runId) {
  const dir = join(root, runId);
  const paths = {
    dir, state: join(dir, 'state.json'), events: join(dir, 'events.jsonl'), rounds: join(dir, 'rounds'), stop: join(dir, 'STOP'),
    pid: join(dir, 'run.pid'), log: join(dir, 'harness.log'), tmp: join(dir, 'tmp'), agentRoom: join(dir, 'agent-room'),
    finished: join(dir, 'run-finished.json'), heartbeat: join(dir, 'heartbeat.json'),
  };
  const roundFile = n => join(paths.rounds, `r${String(n).padStart(3, '0')}.json`);
  return {
    runId, dir, paths,
    exists: () => existsSync(paths.state),
    prepare() { for (const p of [dir, paths.rounds, paths.tmp, paths.agentRoom]) mkdirSync(p, {recursive: true}); },
    load: () => readJson(paths.state),
    save: state => writeJsonAtomic(paths.state, state),
    event: (type, data = {}) => appendJsonLine(paths.events, {at: iso(), type, ...data}),
    saveRound: (n, record) => writeJsonAtomic(roundFile(n), record),
    loadRound: n => readJson(roundFile(n)),
    roundNumbers: () => existsSync(paths.rounds) ? readdirSync(paths.rounds).map(f => /^r(\d+)\.json$/.exec(f)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b) : [],
    stopRequested: () => existsSync(paths.stop),
    requestStop: () => writeFileSync(paths.stop, `stop requested ${iso()}\n`),
    clearStop: () => rmSync(paths.stop, {force: true}),
    heartbeat: data => { try { writeJsonAtomic(paths.heartbeat, {at: iso(), pid: process.pid, ...data}); } catch { /* a missed heartbeat is harmless */ } },
  };
}

export function listRuns(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, {withFileTypes: true}).filter(d => d.isDirectory() && existsSync(join(root, d.name, 'state.json'))).map(d => d.name).sort();
}

export const activePointer = root => join(root, 'ACTIVE.json');
export const readActive = root => readJson(activePointer(root));
export const writeActive = (root, data) => writeJsonAtomic(activePointer(root), data);
