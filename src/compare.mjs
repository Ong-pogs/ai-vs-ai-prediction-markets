// Which rounds can the contestants be compared on, like for like?
// A call that fails because a plan limit was reached, the service was down or a login had expired is not the AI's
// doing. Such a round is labelled "unavailable" for that contestant, and the comparison is given twice: over every
// round, and over only the rounds in which every AI answered. Everything here is worked out from the saved run
// folder (state.json and rounds/rNNN.json), so it works on a live run and on a finished one, and it changes nothing.
// The dashboard page carries the same list of causes; test/compare.test.mjs checks that the two stay identical.

/* causes:start */
const CAUSES = [
  ['plan limit', /usage limit|session limit|weekly limit|hit your [a-z0-9 -]{0,24}limit|limit reached|limit will reset|rate.?limit|too many requests|\b429\b|quota|out of [a-z ]{0,20}(credit|usage)|credit balance|insufficient[a-z ]{0,14}(credit|quota|funds|balance)|\b402\b|payment required|billing/i],
  ['not signed in', /not signed in|login has expired|sign(ed)? in again|log ?in again|please run \/login|unauthori[sz]ed|\b401\b|\b403\b|oauth|invalid api key|rejected the api key|refresh token|missing from the env file/i],
  ['service error', /overloaded|is busy|service unavailable|temporarily unavailable|bad gateway|gateway time-?out|internal server error|\b(500|502|503|504|520|522|524|529)\b|could not reach|fetch failed|socket hang up|stream (error|disconnected)|connection (error|reset|refused|closed)|econnreset|econnrefused|etimedout|enotfound|eai_again/i],
];
/* causes:end */

/**
 * What one contestant's saved answer for one round amounts to:
 *   answered     a usable answer came back
 *   late         no answer before the deadline (the contestant's own speed)
 *   invalid      an answer came back but could not be read (the contestant's own output)
 *   unavailable  the call failed for a reason outside the contestant: plan limit, login or service
 *   failed       the call failed and the saved text does not say why
 *   pending      the round is still being played
 */
export function classifyAnswer(answer, {finished = true, note = ''} = {}) {
  if (!answer) return finished ? {kind: 'failed', cause: null, text: note || 'no answer was saved for this round'} : {kind: 'pending', cause: null, text: ''};
  if (answer.status === 'ok') return {kind: 'answered', cause: null, text: ''};
  if (answer.status === 'late') return {kind: 'late', cause: null, text: (answer.problems || [])[0] || 'no answer before the deadline'};
  if (answer.status === 'invalid') return {kind: 'invalid', cause: null, text: (answer.problems || [])[0] || 'the answer could not be read'};
  const text = String(answer.error || (answer.problems || [])[0] || '').trim();
  const cause = CAUSES.find(([, pattern]) => pattern.test(text))?.[0] || null;
  return {kind: cause ? 'unavailable' : 'failed', cause, text};
}

/** What a bet is worth to its contestant: its profit once settled, or its value at the last price while open. */
export const betValue = p => p.state === 'open' ? p.shares * (p.mark ?? p.avgPrice) - p.cost : p.pnl;

const cents = x => Math.round(x * 100) / 100;
function tally(positions) {
  const out = {bets: 0, won: 0, lost: 0, open: 0, staked: 0, pnl: 0};
  for (const p of positions) { out.bets++; out[p.state]++; out.staked += p.cost; out.pnl += betValue(p); }
  out.staked = cents(out.staked); out.pnl = cents(out.pnl);
  return out;
}

/**
 * The comparison over every round, and over only the rounds in which every AI answered.
 * `rounds` are the saved round records, in any order. A round with no games, or one still being played, is left out
 * of both counts. The baseline (the random picker) is not an AI: it never decides whether a round counts.
 */
export function likeForLike(state, rounds) {
  const everyone = Object.values(state.contestants), ais = everyone.filter(c => !c.baseline).map(c => c.name);
  const played = [];
  let withoutGames = 0, inProgress = 0;
  for (const r of [...rounds].sort((a, b) => a.round - b.round)) {
    if (!r.finishedAt) { inProgress++; continue; }
    if (!r.slate?.length) { withoutGames++; continue; }
    const note = (r.notes || []).find(line => everyone.some(c => line.startsWith(`${c.name}:`))) || '';
    const answers = Object.fromEntries(everyone.map(c => [c.name, classifyAnswer(r.answers?.[c.name], {note: note.startsWith(`${c.name}:`) ? note : ''})]));
    played.push({round: r.round, games: r.slate.length, answers, allAnswered: ais.every(name => answers[name].kind === 'answered')});
  }
  const fair = new Set(played.filter(p => p.allAnswered).map(p => p.round));
  const notAnswered = played.flatMap(p => everyone.filter(c => p.answers[c.name].kind !== 'answered').map(c => ({round: p.round, name: c.name, label: c.label, ...p.answers[c.name]})));
  const latency = name => {
    const times = rounds.map(r => r.answers?.[name]).filter(a => a?.status === 'ok' && typeof a.latencyMs === 'number').map(a => a.latencyMs);
    return times.length ? Number((times.reduce((a, b) => a + b, 0) / times.length / 1000).toFixed(2)) : null;
  };
  const contestants = everyone.map(c => {
    const kinds = {answered: 0, late: 0, invalid: 0, unavailable: 0, failed: 0};
    for (const p of played) kinds[p.answers[c.name].kind]++;
    const positions = c.account.positions, all = tally(positions);
    return {
      name: c.name, label: c.label, baseline: Boolean(c.baseline), rounds: kinds,
      unavailableRounds: played.filter(p => p.answers[c.name].kind === 'unavailable').map(p => p.round),
      averageSecondsWhenAnswered: latency(c.name),
      all, likeForLike: tally(positions.filter(p => fair.has(p.round))),
      // the bets add up to the balance: profit over every bet equals balance minus starting cash
      balanceCheck: cents(all.pnl - (c.account.cash + positions.filter(p => p.state === 'open').reduce((sum, p) => sum + p.shares * (p.mark ?? p.avgPrice), 0) - c.account.startingCash)),
    };
  });
  // How often two AIs ended a round with exactly the same bets: the same games on the same sides.
  const betsByRound = name => {
    const by = new Map();
    for (const p of state.contestants[name].account.positions) by.set(p.round, [...(by.get(p.round) || []), `${p.gameId}:${p.side}`].sort());
    return by;
  };
  const sameBets = [];
  for (let i = 0; i < ais.length; i++) for (let j = i + 1; j < ais.length; j++) {
    const a = betsByRound(ais[i]), b = betsByRound(ais[j]);
    const both = played.map(p => p.round).filter(n => a.has(n) && b.has(n));
    sameBets.push({a: ais[i], b: ais[j], roundsBothBet: both.length, rounds: both.filter(n => a.get(n).join('|') === b.get(n).join('|'))});
  }
  // Where the bets were filled, and on which venues the games on offer carried a price at all.
  const betsByVenue = {}, gamesWithPriceOn = {};
  let gamesOffered = 0;
  for (const c of everyone) for (const p of c.account.positions) betsByVenue[p.venue] = (betsByVenue[p.venue] || 0) + 1;
  for (const r of rounds) for (const g of r.slate || []) {
    gamesOffered++;
    for (const venue of new Set([...(g.yes?.cells || []), ...(g.no?.cells || [])].map(cell => cell.venue))) gamesWithPriceOn[venue] = (gamesWithPriceOn[venue] || 0) + 1;
  }
  // Which model each AI's answers named, round by round: a silent change of model would show up here.
  const models = Object.fromEntries(ais.map(name => {
    const seen = {};
    for (const r of rounds) { const model = r.answers?.[name]?.model; if (model) seen[model] = (seen[model] || 0) + 1; }
    return [name, seen];
  }));
  return {
    runId: state.runId, ais, roundsPlanned: state.rounds, roundsMissed: (state.missedRounds || []).length, roundsInProgress: inProgress,
    roundsWithoutGames: withoutGames, roundsPlayed: played.length, roundsAllAnswered: fair.size, likeForLikeRounds: [...fair],
    notAnswered, contestants, sameBets, betsByVenue, gamesOffered, gamesWithPriceOn, models,
  };
}

const signed = x => `${x < -0.004 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;
/** The comparison as plain lines for the terminal. */
export function comparisonLines(result) {
  const lines = [
    `run        ${result.runId}`,
    `rounds     ${result.roundsPlayed} played with games (${result.roundsPlanned} planned, ${result.roundsMissed} missed, ${result.roundsWithoutGames} without games${result.roundsInProgress ? `, ${result.roundsInProgress} in progress` : ''})`,
    `           every AI (${result.ais.join(', ')}) answered in ${result.roundsAllAnswered} of ${result.roundsPlayed}`,
  ];
  if (!result.notAnswered.length) lines.push('           no contestant missed a round, so both comparisons below are the same');
  for (const miss of result.notAnswered) lines.push(`  round ${String(miss.round).padStart(2)}  ${miss.name.padEnd(8)} ${miss.kind}${miss.cause ? ` (${miss.cause})` : ''}: ${miss.text}`);
  lines.push('', `${''.padEnd(10)} ${'every round'.padEnd(34)} ${`rounds where every AI answered (${result.roundsAllAnswered})`}`);
  for (const c of result.contestants) {
    const cell = t => `${String(t.bets).padStart(3)} bets  ${String(t.won).padStart(2)} won ${String(t.lost).padStart(2)} lost ${String(t.open).padStart(2)} open  ${signed(t.pnl).padStart(8)}`;
    const sat = Object.entries(c.rounds).filter(([kind, n]) => kind !== 'answered' && n).map(([kind, n]) => `${n} ${kind}`).join(', ');
    lines.push(`${c.name.padEnd(10)} ${cell(c.all)}   ${cell(c.likeForLike)}${sat ? `   sat out: ${sat}` : ''}${c.baseline ? '   (not an AI)' : ''}`);
  }
  lines.push('');
  for (const pair of result.sameBets || []) lines.push(`same bets  ${pair.a} and ${pair.b} placed exactly the same bets in ${pair.rounds.length} of the ${pair.roundsBothBet} rounds in which both bet${pair.rounds.length ? ` (round${pair.rounds.length === 1 ? '' : 's'} ${pair.rounds.join(', ')})` : ''}`);
  const list = counts => Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key} ${n}`).join(', ') || 'none';
  lines.push(`venues     bets filled: ${list(result.betsByVenue)} · ${result.gamesOffered ?? 0} games offered, with a price on: ${list(result.gamesWithPriceOn)}`);
  for (const [name, seen] of Object.entries(result.models || {})) lines.push(`model      ${name}: ${Object.entries(seen).map(([model, n]) => `${model} in ${n} round${n === 1 ? '' : 's'}`).join(', ') || 'none reported'}`);
  const off = result.contestants.filter(c => Math.abs(c.balanceCheck) > 0.02);
  lines.push('', off.length ? `CHECK: the bets do not add up to the balance for ${off.map(c => `${c.name} (${signed(c.balanceCheck)})`).join(', ')}` : 'check: for every contestant the profit over every bet equals balance minus starting cash');
  return lines;
}
