// Small helpers shared by every module. No dependencies.
import {writeFileSync, renameSync, appendFileSync, readFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const iso = (ms = Date.now()) => new Date(ms).toISOString();
export const round2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
export const round4 = x => Math.round((x + Number.EPSILON) * 10000) / 10000;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Write JSON so a crash mid-write can never leave a half-written file behind. */
export function writeJsonAtomic(file, data) {
  mkdirSync(dirname(file), {recursive: true});
  const pending = `${file}.${process.pid}.tmp`;
  writeFileSync(pending, JSON.stringify(data, null, 1));
  for (let attempt = 0; ; attempt++) {
    try { renameSync(pending, file); return; }
    catch (error) {
      // On Windows the rename fails for a moment while another program has the file open to read it.
      if (attempt >= 40) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
export const readJson = (file, fallback = null) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
export function appendJsonLine(file, data) { mkdirSync(dirname(file), {recursive: true}); appendFileSync(file, JSON.stringify(data) + '\n'); }

/** Seeded random numbers (mulberry32), so the random baseline can be replayed from its saved seed. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (h && m) return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
  if (h) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}
/** 0.2 -> "20 cents", 0.205 -> "20.5 cents". */
export const cents = p => `${Number((p * 100).toFixed(1))} cent${Math.abs(p * 100 - 1) < 1e-9 ? '' : 's'}`;
export const percent = p => `${Number((p * 100).toFixed(1))}%`;
/** Pull the first JSON object out of a model's reply, whether or not it wrapped it in a code fence or added a sentence. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
