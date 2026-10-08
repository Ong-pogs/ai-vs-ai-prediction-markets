// Contestants come from the config file. Each has a name, a kind and that kind's settings.
// Every kind answers the same question and returns the same shape, so the rest of the harness treats them alike.
import {claudeCli} from './claudeCli.mjs';
import {codexCli} from './codexCli.mjs';
import {jev} from './jev.mjs';
import {openaiChat} from './openaiChat.mjs';
import {iso, seededRandom} from '../util.mjs';

/** Kind "random": not an AI. It leans to a random side with a random strength, from a saved seed, as a baseline. */
function random(def) {
  return async function ask({ids, roundNumber}) {
    const next = seededRandom((def.seed ?? 1) * 1000003 + roundNumber);
    const answers = {};
    for (const id of ids) answers[id] = {call: 'SKIP', pYes: null, lean: next() < 0.5 ? 'YES' : 'NO', strength: Number((next() * 100).toFixed(2)), reason: ''};
    return {status: 'ok', answers, problems: [], model: `random picks, seed ${def.seed ?? 1}`, usage: {}};
  };
}

export const KINDS = {'claude-cli': claudeCli, 'codex-cli': codexCli, jev, 'openai-chat': openaiChat, random};

export function createContestant(def, ctx) {
  const make = KINDS[def.kind];
  if (!make) throw new Error(`Unknown contestant kind "${def.kind}" for "${def.name}". Known kinds: ${Object.keys(KINDS).join(', ')}`);
  const askRaw = make(def, ctx);
  return {
    def,
    /** Never throws. A late or unusable answer comes back with status late, invalid or error and counts as a skip. */
    async ask(round) {
      const started = Date.now();
      let timer;
      const late = new Promise(resolve => { timer = setTimeout(() => resolve({status: 'late', problems: [`no answer within ${Math.round(round.deadlineMs / 1000)} s`]}), round.deadlineMs + 3000); });
      let result;
      try { result = await Promise.race([askRaw(round), late]); }
      catch (error) { result = {status: 'error', error: String(error?.message || error).slice(0, 300)}; }
      clearTimeout(timer);
      return {answers: {}, problems: [], usage: {}, model: null, ...result, latencyMs: Date.now() - started, answeredAt: iso()};
    },
  };
}
