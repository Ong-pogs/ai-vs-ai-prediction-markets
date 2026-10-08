// Kind "jev": TypeSafe's decision model. It does not write text; it answers typed questions about a state.
// One request per market (unrelated fields make it less accurate), all of a round's markets in parallel.
// Docs: https://docs.typesafe.ai/api . Input costs $0.042 per million tokens and output is free.
import {jevQuestions, jevState, parseJevAnswer} from '../prompt.mjs';
import {sleep} from '../util.mjs';

const BUSY = new Set([429, 529]);
function explain(status, text) {
  if (status === 401) return 'TypeSafe rejected the API key (HTTP 401)';
  if (status === 402) return 'out of TypeSafe credit (HTTP 402)';
  if (status === 422) return `TypeSafe refused the request (HTTP 422): ${text.slice(0, 160)}`;
  if (BUSY.has(status)) return `TypeSafe is busy (HTTP ${status})`;
  return `TypeSafe error (HTTP ${status})`;
}

export function jev(def, ctx) {
  const url = def.url || 'https://api.typesafe.ai/v1/systemone';
  const model = def.model || 'jev-1.13.0';
  const doFetch = ctx.fetchImpl || fetch;
  const pricePerMTok = def.pricePerMTok ?? 0.042;
  async function one(facts, deadlineAt) {
    const body = JSON.stringify({state: jevState(facts), model, questions: jevQuestions(facts)});
    for (let attempt = 1; ; attempt++) {
      const left = deadlineAt - Date.now();
      if (left <= 0) return {error: 'ran past the deadline'};
      try {
        const res = await doFetch(url, {method: 'POST', headers: {Authorization: `Bearer ${ctx.env[def.keyName || 'TYPESAFE_API_KEY']}`, 'content-type': 'application/json'}, body, signal: AbortSignal.timeout(Math.min(left, 15000))});
        const text = await res.text();
        if (!res.ok) {
          if (BUSY.has(res.status) && attempt < 3) { await sleep(attempt * 1000); continue; }
          return {error: explain(res.status, text)};
        }
        const json = JSON.parse(text);
        const answer = parseJevAnswer(json);
        return answer ? {answer, model: json.model, inputTokens: json.usage?.input_tokens || 0, outputTokens: json.usage?.output_tokens || 0} : {error: `unexpected answer from Jev: ${text.slice(0, 160)}`};
      } catch (error) {
        if (attempt < 2 && deadlineAt - Date.now() > 3000) continue;
        return {error: error.name === 'TimeoutError' ? 'Jev did not answer in time' : `could not reach TypeSafe (${String(error.message).slice(0, 120)})`};
      }
    }
  }
  return async function ask({facts, deadlineMs}) {
    if (!ctx.env[def.keyName || 'TYPESAFE_API_KEY']) return {status: 'error', error: `${def.keyName || 'TYPESAFE_API_KEY'} is missing from the env file`};
    const deadlineAt = Date.now() + deadlineMs;
    const results = await Promise.all(facts.map(f => one(f, deadlineAt)));
    const answers = {}, problems = [];
    let inputTokens = 0, outputTokens = 0, reported = null;
    results.forEach((result, i) => {
      const id = facts[i].id;
      if (result.answer) { answers[id] = result.answer; inputTokens += result.inputTokens; outputTokens += result.outputTokens; reported = result.model || reported; }
      else { answers[id] = {call: 'SKIP', pYes: null, lean: null, strength: 0, reason: '', problem: result.error}; problems.push(`${id}: ${result.error}`); }
    });
    const answered = results.filter(r => r.answer).length;
    if (!answered) return {status: 'error', error: results[0]?.error || 'no answer', problems};
    return {
      status: 'ok', answers, problems, model: reported,
      usage: {inputTokens, outputTokens, costUsd: Number((inputTokens * pricePerMTok / 1e6).toFixed(6)), requests: facts.length},
    };
  };
}
