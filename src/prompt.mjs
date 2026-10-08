// The one question every contestant gets about every market, and the checks on what comes back.
// Text models get all of a round's markets in one prompt and answer with JSON. Jev gets the same facts one market
// at a time as typed questions. Either way the harness ends up with the same five fields per market.
import {extractJson, clamp} from './util.mjs';

export const CALLS = ['BUY_YES', 'BUY_NO', 'SKIP'];
export const SYSTEM_LINE = 'You are a contestant in a paper-trading contest. Reply with JSON only, no code fences.';
const FACT_ORDER = ['game', 'when', 'yes_means', 'no_means', 'prices', 'fair_price', 'value'];
const count = n => ['no', 'one', 'two', 'three', 'four', 'five'][n] ?? String(n);

export function rulesText(rules) {
  const {min, max} = rules.betsPerRound;
  const stake = `$${rules.stakeUsd}`;
  if (min > 0) {
    return `Contest rule: every round each AI must place its ${count(max)} best bet${max === 1 ? '' : 's'}. The harness puts ${stake} on each of your ${count(max)} highest strength scores, on the side you lean to, at whichever venue is cheaper after fees, and holds each bet until the game settles. Give every game a different strength so your top ${count(max)} ${max === 1 ? 'is' : 'are'} clear.`;
  }
  return `Contest rule: betting is your choice. The harness puts ${stake} on each BUY call, strongest first and at most ${count(max)} a round, at whichever venue is cheaper after fees, and holds each bet until it settles. Skipping costs nothing.`;
}

export function buildPrompt(factsList, rules) {
  const lines = [
    `You are one of several AIs in a paper-trading contest. Every AI starts with $${rules.startingCash} of pretend money and sees exactly the same facts. No AI sees another's answers.`,
    '',
    'For each game below give:',
    '- call: what you would do if the choice were yours alone: BUY_YES, BUY_NO or SKIP.',
    '- p_yes: your own probability that YES wins, from 0 to 1.',
    '- lean: YES or NO. The side you would rather hold at these prices if you had to bet on this game.',
    '- strength: a whole number from 0 to 100. How strongly you believe that side is worth more than its price, compared with the other games in this list.',
    '- reason: one short sentence.',
    '',
    rulesText(rules),
    '',
    'Use these facts and what you already know about the teams and players. Do not use tools. Reply with JSON only, in exactly this shape:',
    '{"answers":[{"id":"g1","call":"SKIP","p_yes":0.5,"lean":"YES","strength":10,"reason":"one short sentence"}]}',
  ];
  for (const facts of factsList) {
    lines.push('', facts.id);
    for (const key of FACT_ORDER) if (facts[key]) lines.push(`${key}: ${facts[key]}`);
  }
  return lines.join('\n');
}

/** The JSON Schema handed to tools that can enforce one (Codex --output-schema). */
export const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'call', 'p_yes', 'lean', 'strength', 'reason'],
        properties: {
          id: {type: 'string'}, call: {type: 'string', enum: CALLS}, p_yes: {type: 'number'},
          lean: {type: 'string', enum: ['YES', 'NO']}, strength: {type: 'number'}, reason: {type: 'string'},
        },
      },
    },
  },
};

const number = v => typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** One answer per asked id. Anything missing or malformed becomes a skip with a note; nothing here throws. */
export function parseAnswers(text, ids) {
  const parsed = typeof text === 'object' && text !== null ? text : extractJson(text);
  const rows = Array.isArray(parsed?.answers) ? parsed.answers : null;
  if (!rows) return {ok: false, answers: {}, problems: ['the reply was not the JSON object that was asked for']};
  const answers = {}, problems = [];
  for (const id of ids) {
    const row = rows.find(r => r && String(r.id).trim().toLowerCase() === id);
    if (!row) { answers[id] = {call: 'SKIP', pYes: null, lean: null, strength: 0, reason: '', problem: 'no answer for this game'}; problems.push(`${id}: no answer`); continue; }
    const call = CALLS.includes(String(row.call).toUpperCase()) ? String(row.call).toUpperCase() : null;
    const p = number(row.p_yes);
    const pYes = p !== null && p >= 0 && p <= 1 ? p : null;
    let lean = ['YES', 'NO'].includes(String(row.lean).toUpperCase()) ? String(row.lean).toUpperCase() : null;
    if (!lean && call === 'BUY_YES') lean = 'YES';
    if (!lean && call === 'BUY_NO') lean = 'NO';
    const s = number(row.strength);
    const answer = {call: call || 'SKIP', pYes, lean, strength: s === null ? 0 : clamp(s, 0, 100), reason: String(row.reason ?? '').slice(0, 240)};
    const issues = [!call && 'call was not BUY_YES, BUY_NO or SKIP', pYes === null && 'p_yes was not a number from 0 to 1', !lean && 'lean was not YES or NO'].filter(Boolean);
    if (issues.length) { answer.problem = issues.join('; '); problems.push(`${id}: ${answer.problem}`); }
    answers[id] = answer;
  }
  return {ok: true, answers, problems};
}

/** The same question for Jev, as typed questions over one market's facts. Jev answers each in parallel. */
export function jevQuestions(facts) {
  return {
    call: {
      type: 'choice',
      instructions: "Decide this game's trade. Buying a side costs its price and pays 100 cents per share if that side wins, nothing if it loses. Buy a side only when it is likely enough to win to be worth its price. Skipping costs nothing.",
      criteria: {
        BUY_YES: `Buy YES: "${facts.yes_means}" is likely enough to be worth the YES price.`,
        BUY_NO: `Buy NO: "${facts.no_means}" is likely enough to be worth the NO price.`,
        SKIP: 'No trade: neither side is clearly worth its price.',
      },
    },
    yes_wins: {
      type: 'noul',
      instructions: `YES wins: ${facts.yes_means}.`,
      criteria: {true: `YES wins: ${facts.yes_means}.`, false: `NO wins: ${facts.no_means}.`},
    },
    lean: {
      type: 'choice',
      instructions: 'A bet on this game is required. Decide which side is the better one to hold at these prices.',
      criteria: {YES: `Hold YES: ${facts.yes_means}, bought at the YES price.`, NO: `Hold NO: ${facts.no_means}, bought at the NO price.`},
    },
  };
}

export function jevState(facts) {
  return Object.fromEntries(FACT_ORDER.filter(key => facts[key]).map(key => [key, facts[key]]));
}

/** Jev's typed answers mapped onto the same five fields. Strength is Jev's own probability of buying at all. */
export function parseJevAnswer(body) {
  const call = body?.answers?.call, yes = body?.answers?.yes_wins, lean = body?.answers?.lean;
  const unit = v => typeof v === 'number' && v >= 0 && v <= 1;
  if (!CALLS.includes(call?.choice) || !unit(yes?.noul) || !['YES', 'NO'].includes(lean?.choice)) return null;
  const skip = unit(call.probabilities?.SKIP) ? call.probabilities.SKIP : (call.choice === 'SKIP' ? 1 : 0);
  return {
    call: call.choice, pYes: yes.noul, lean: lean.choice, strength: Number(((1 - skip) * 100).toFixed(2)), reason: '',
    detail: {callProbabilities: call.probabilities, callConfidence: call.confidence, leanProbabilities: lean.probabilities},
  };
}
