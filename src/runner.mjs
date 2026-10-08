// The run itself: a fixed schedule of rounds. Each round settles what has resolved, builds one slate of markets,
// asks every contestant the same question about it, turns the answers into bets by one fixed rule, and writes
// everything down. All state is on disk after every step, so the same command resumes a run after a restart.
import {writeJsonAtomic, iso, sleep, round2, round4} from './util.mjs';
import {findGames} from './markets/sportsScreen.mjs';
import {buildFacts} from './facts.mjs';
import {buildPrompt, rulesText} from './prompt.mjs';
import {chooseBets, wantedCounts} from './rules.mjs';
import {paperBuy} from './execution/paper.mjs';
import {readResolution, describeResolution} from './settle.mjs';
import {newAccount, openPosition, settlePosition, openPositions, equity, summary} from './ledger.mjs';

const pad = n => String(n).padStart(3, '0');
export const roundTime = (state, k) => Date.parse(state.startAt) + k * state.intervalSec * 1000;

export function newRunId(config, nowMs = Date.now()) {
  const d = new Date(nowMs), two = n => String(n).padStart(2, '0');
  return `${config.name}-${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}z`;
}

export function describeRules(config) {
  const {min, max} = config.betsPerRound;
  const every = config.intervalMinutes >= 1 ? `${config.intervalMinutes} minutes` : `${config.intervalSec} seconds`;
  const bets = min > 0 ? `each contestant must place its ${max === 1 ? 'best bet' : `${max} best bets`}` : `each contestant may place up to ${max} bet${max === 1 ? '' : 's'}`;
  return `Every ${every} ${bets}, $${config.stakeUsd} each, from the same list of games. Every contestant starts with $${config.startingCash} of paper money and every bet is held until the game settles.`;
}

/** `startMs` is when round 1 runs. It may lie a little in the future, so a run can start on a round clock time. */
export function createState(config, runId, startMs = Date.now()) {
  const nowMs = startMs;
  const rules = {
    startingCash: config.startingCash, stakeUsd: config.stakeUsd, betsPerRound: config.betsPerRound,
    answerDeadlineSec: config.answerDeadlineSec, execution: config.execution, text: describeRules(config), promptRule: rulesText(config),
  };
  const {envFile, ...publicConfig} = config;
  return {
    version: 1, runId, name: config.name, title: config.title, createdAt: iso(), startAt: iso(nowMs),
    endAt: iso(nowMs + config.rounds * config.intervalSec * 1000), intervalSec: config.intervalSec, rounds: config.rounds,
    settleGraceHours: config.settleGraceHours, status: 'running', stage: 'trading', rules, config: publicConfig,
    nextRound: 0, roundsDone: 0, missedRounds: [], asked: {}, pending: {}, equity: [], lastError: null, finished: null,
    contestants: Object.fromEntries(config.contestants.map(c => [c.name, {
      name: c.name, label: c.label || c.name, kind: c.kind, baseline: Boolean(c.baseline), color: c.color || null,
      configuredModel: c.model || null, configuredEffort: c.effort || null, seed: c.seed ?? null, reportedModel: null,
      account: newAccount(config.startingCash),
      usage: {calls: 0, ok: 0, late: 0, invalid: 0, errors: 0, latencyMsTotal: 0, latencyMsMax: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0},
      wanted: {buy: 0, skip: 0, asked: 0},
      bets: {picked: 0, filled: 0, partial: 0, noFill: 0, noCash: 0, noLiveBook: 0, errors: 0},
    }])),
    predictefy: {calls: 0, credits: 0, byEndpoint: {}, planNotice: null},
  };
}

// ---- bookkeeping ----
function syncUsage(ctx) {
  const {state, client, usageBase} = ctx;
  const merged = structuredClone(usageBase);
  merged.calls += client.usage.calls;
  merged.credits += client.usage.credits;
  for (const [endpoint, row] of Object.entries(client.usage.byEndpoint)) {
    const into = merged.byEndpoint[endpoint] ||= {calls: 0, credits: 0};
    into.calls += row.calls;
    into.credits += row.credits;
  }
  merged.planNotice = client.usage.planNotice || usageBase.planNotice;
  state.predictefy = merged;
}

function recordAnswer(entry, result) {
  const u = entry.usage;
  u.calls++;
  u[{ok: 'ok', late: 'late', invalid: 'invalid', error: 'errors'}[result.status] || 'errors']++;
  u.latencyMsTotal += result.latencyMs || 0;
  u.latencyMsMax = Math.max(u.latencyMsMax, result.latencyMs || 0);
  u.inputTokens += result.usage?.inputTokens || 0;
  u.outputTokens += result.usage?.outputTokens || 0;
  u.totalTokens += result.usage?.totalTokens ?? ((result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0));
  u.costUsd = round4(u.costUsd + (result.usage?.costUsd || 0));
  if (result.model) entry.reportedModel = result.model;
}

function pushEquity(state, round) {
  state.equity.push({round, at: iso(), values: Object.fromEntries(Object.values(state.contestants).map(c => [c.name, round2(equity(c.account))]))});
}

function applyOutcome(ctx, intent, outcome) {
  const {state, store} = ctx;
  const entry = state.contestants[intent.name];
  const row = {gid: intent.gid, gameId: intent.gameId, title: intent.title, side: intent.side, sideName: intent.sideName, strength: intent.strength, status: outcome.status, attempts: outcome.attempts};
  if (outcome.shares > 0) {
    openPosition(entry.account, {
      id: outcome.key, round: intent.round, gameId: intent.gameId, title: intent.title, competition: intent.competition, kickoffAt: intent.kickoffAt,
      side: intent.side, sideName: intent.sideName, venue: outcome.venue, marketId: outcome.marketId, outcomeId: outcome.outcomeId,
      shares: outcome.shares, avgPrice: outcome.avgPrice, fees: outcome.fees, cost: outcome.cost, quotedAsk: outcome.quotedAsk, limit: outcome.limit, fairAtEntry: intent.fair ?? null,
      orderId: outcome.orderId, key: outcome.key, openedAt: iso(), late: Boolean(intent.recovered),
    });
    entry.bets[outcome.status === 'partial' ? 'partial' : 'filled']++;
    Object.assign(row, {venue: outcome.venue, shares: outcome.shares, avgPrice: outcome.avgPrice, fees: outcome.fees, cost: outcome.cost, orderId: outcome.orderId, key: outcome.key});
    store.event('fill', {name: intent.name, round: intent.round, ...row, fills: outcome.fills});
  } else {
    const counter = {'no-cash': 'noCash', 'no-live-book': 'noLiveBook', 'no-fill': 'noFill'}[outcome.status] || 'errors';
    entry.bets[counter]++;
    if (outcome.status === 'no-cash') {
      const open = openPositions(entry.account);
      row.why = `Not enough free cash: $${entry.account.cash.toFixed(2)} free, $${open.reduce((s, p) => s + p.cost, 0).toFixed(2)} tied up in ${open.length} open bet${open.length === 1 ? '' : 's'}.`;
    }
    if (outcome.status === 'no-live-book') row.why = 'The paper engine had no live order book for this outcome.';
    if (outcome.status === 'no-fill') row.why = 'The order did not fill before it was cancelled.';
    if (outcome.status === 'error') row.why = `The paper engine refused the order (${outcome.code}).`;
    if (outcome.status === 'unknown') row.why = 'The order could not be confirmed; it is checked again next round.';
    store.event('no_bet', {name: intent.name, round: intent.round, ...row});
  }
  return row;
}

// ---- settlement and marks ----
export async function settlePass(ctx, tag) {
  const {state, store, client} = ctx;
  const groups = new Map();
  for (const c of Object.values(state.contestants)) {
    for (const position of openPositions(c.account)) {
      const key = `${position.venue}|${position.marketId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({contestant: c, position});
    }
  }
  const settlements = [];
  for (const [key, rows] of groups) {
    const [venue, marketId] = key.split('|');
    const res = await client.get(`/api/${venue}/fetchMarket?marketId=${encodeURIComponent(marketId)}`, {label: '/api/{venue}/fetchMarket'});
    if (!res.ok || !res.data) { store.event('settle_read_failed', {venue, marketId, error: res.error}); continue; }
    for (const {contestant, position} of rows) {
      try {
      const reading = readResolution(res.data, position.outcomeId);
      position.lastStatus = reading.status;
      position.lastReadAt = iso();
      if (reading.state === 'won' || reading.state === 'lost') {
        settlePosition(position, contestant.account, {won: reading.state === 'won', how: describeResolution(venue, marketId, reading), at: iso()});
        const row = {name: contestant.name, title: position.title, side: position.side, sideName: position.sideName, venue, marketId, result: position.state, shares: position.shares, cost: position.cost, payout: position.payout, pnl: position.pnl, how: position.how};
        settlements.push(row);
        store.event('settle', {round: tag, ...row});
      } else {
        if (typeof reading.price === 'number') { position.mark = reading.price; position.markAsOf = reading.asOf; position.markSource = `Predictefy catalogue price (${reading.priceBasis || 'price'})`; }
        position.note = reading.state === 'unclear' ? 'Predictefy lists the market as resolved, but the price it carries does not name a winner yet.' : undefined;
      }
      } catch (error) { store.event('settle_error', {venue, marketId, message: String(error?.message || error).slice(0, 300)}); }
    }
  }
  syncUsage(ctx);
  return settlements;
}

// ---- orders that were in flight when the harness last stopped ----
export async function recoverPending(ctx) {
  const {state, store, client} = ctx;
  for (const [key, intent] of Object.entries(state.pending)) {
    const outcome = await paperBuy({client, key, cells: intent.cells, stakeUsd: state.rules.stakeUsd, cash: state.contestants[intent.name].account.cash, cfg: {...state.rules.execution, fillWaitSec: 0}});
    if (outcome.status === 'unknown') continue;
    applyOutcome(ctx, {...intent, recovered: true}, outcome);
    store.event('pending_recovered', {key, status: outcome.status});
    delete state.pending[key];
    store.save(state);
  }
}

// ---- one round ----
export async function runRound(ctx, k) {
  const {state, store, client, contestants, config, log} = ctx;
  const n = k + 1, nowMs = Date.now();
  const record = {round: n, scheduledFor: iso(roundTime(state, k)), startedAt: iso(nowMs), slate: [], answers: {}, bets: {}, settlements: [], notes: []};
  store.event('round_start', {round: n});
  log(`round ${n} of ${state.rounds}`);

  record.settlements = await settlePass(ctx, n);
  if (record.settlements.length) log(`  settled ${record.settlements.length} bet${record.settlements.length === 1 ? '' : 's'}`);

  const held = new Set(Object.values(state.contestants).flatMap(c => c.account.positions.map(p => p.gameId)));
  const found = await findGames({client, source: {...config.markets[0], stakeUsd: config.stakeUsd}, nowMs, asked: new Set(Object.keys(state.asked)), held, max: config.maxMarketsPerRound, minGames: config.minMarketsPerRound});
  record.screen = found.stats;
  const slate = found.games.map((game, i) => ({gid: `g${i + 1}`, ...game, facts: buildFacts(game, `g${i + 1}`, nowMs, config.facts)}));
  record.slate = slate;
  for (const game of slate) state.asked[game.id] ??= n;

  if (!slate.length) {
    record.notes.push(found.stats.error ? `No games this round: the sports screen answered ${found.stats.error.code}.` : `No tradable games this round (${found.stats.fixtures} fixtures in the window, none with a live price on both sides).`);
    log(`  ${record.notes.at(-1)}`);
  } else {
    const factsList = slate.map(game => game.facts), ids = slate.map(game => game.gid);
    record.prompt = buildPrompt(factsList, state.rules);
    store.event('slate', {round: n, games: slate.map(g => ({gid: g.gid, id: g.id, title: g.title})), prompt: record.prompt});
    store.saveRound(n, record);
    log(`  ${slate.length} games: ${slate.map(g => g.title).join(' | ').slice(0, 300)}`);

    await Promise.all(contestants.map(async contestant => {
      const name = contestant.def.name, entry = state.contestants[name];
      try {
      const result = await contestant.ask({facts: factsList, prompt: record.prompt, ids, deadlineMs: state.rules.answerDeadlineSec * 1000, roundNumber: n});
      record.answers[name] = result;
      record.bets[name] = [];
      recordAnswer(entry, result);
      store.event('answer', {round: n, name, status: result.status, latencyMs: result.latencyMs, model: result.model, usage: result.usage, answers: result.answers, problems: result.problems, error: result.error, raw: result.raw});
      log(`  ${name}: ${result.status} in ${(result.latencyMs / 1000).toFixed(1)} s${result.error ? ` (${result.error})` : ''}`);
      if (result.status !== 'ok') { store.save(state); return; }
      const wanted = wantedCounts(result.answers);
      entry.wanted.buy += wanted.buy;
      entry.wanted.skip += wanted.skip;
      entry.wanted.asked += ids.length;
      let filled = 0;
      for (const pick of chooseBets(result.answers, slate, state.rules)) {
        if (filled >= state.rules.betsPerRound.max) break;
        const game = slate.find(g => g.gid === pick.gid), side = pick.side === 'YES' ? game.yes : game.no;
        const key = `ai-vs-ai-${state.runId}-${name}-r${pad(n)}-${game.id}-${pick.side.toLowerCase()}`;
        const intent = {key, name, round: n, gid: pick.gid, gameId: game.id, title: game.title, competition: game.competition, kickoffAt: game.kickoffAt, side: pick.side, sideName: side.name, strength: pick.strength, fair: side.fair, cells: side.cells, at: iso()};
        entry.bets.picked++;
        state.pending[key] = intent;
        store.save(state);
        store.event('order_intent', {round: n, name, key, gid: pick.gid, side: pick.side, cells: side.cells});
        const outcome = await paperBuy({client, key, cells: side.cells, stakeUsd: state.rules.stakeUsd, cash: entry.account.cash, cfg: state.rules.execution});
        store.event('order_result', {round: n, name, key, status: outcome.status, attempts: outcome.attempts});
        const row = applyOutcome(ctx, intent, outcome);
        record.bets[name].push(row);
        if (outcome.shares > 0) filled++;
        if (outcome.status === 'no-cash') { delete state.pending[key]; store.save(state); break; }
        if (outcome.status !== 'unknown') delete state.pending[key];
        store.save(state);
        log(`    ${name} ${pick.side} ${game.title.slice(0, 50)}: ${outcome.status}${outcome.shares ? ` ${outcome.shares} at ${outcome.avgPrice} on ${outcome.venue}` : ''}`);
      }
      } catch (error) {
        // one contestant's trouble must never take the round, or the other contestants, down with it
        record.notes.push(`${name}: stopped by an unexpected error this round (${String(error?.message || error).slice(0, 160)}).`);
        store.event('contestant_error', {round: n, name, message: String(error?.stack || error).slice(0, 800)});
        log(`  ${name}: unexpected error: ${error?.message || error}`);
      }
    }));
  }

  syncUsage(ctx);
  pushEquity(state, n);
  state.nextRound = k + 1;
  state.roundsDone++;
  state.lastRoundAt = iso();
  record.finishedAt = iso();
  record.equity = state.equity.at(-1).values;
  store.saveRound(n, record);
  store.save(state);
  store.event('round_end', {round: n, equity: record.equity});
  return record;
}

// ---- the result file ----
export function finishedSummary(state, stage) {
  const rows = Object.values(state.contestants).map(c => {
    const s = summary(c.account), u = c.usage;
    return {
      name: c.name, label: c.label, kind: c.kind, baseline: c.baseline, model: c.reportedModel || c.configuredModel,
      equity: round2(s.equity), pnl: round2(s.pnl), cash: round2(s.cash), unsettledValue: round2(s.openValue), realized: round2(s.realized), feesPaid: round2(s.feesPaid),
      bets: s.bets, settled: s.settled, won: s.won, lost: s.lost, unsettled: s.open,
      wanted: {...c.wanted, skipShare: c.wanted.asked ? Number((c.wanted.skip / c.wanted.asked).toFixed(3)) : null},
      betOutcomes: c.bets,
      answers: {calls: u.calls, ok: u.ok, late: u.late, invalid: u.invalid, errors: u.errors, averageSeconds: u.calls ? Number((u.latencyMsTotal / u.calls / 1000).toFixed(2)) : null, slowestSeconds: Number((u.latencyMsMax / 1000).toFixed(2)), inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens, costUsd: u.costUsd},
    };
  }).sort((a, b) => b.equity - a.equity);
  const unsettled = Object.values(state.contestants).flatMap(c => openPositions(c.account).map(p => ({name: c.name, title: p.title, side: p.side, sideName: p.sideName, venue: p.venue, marketId: p.marketId, shares: p.shares, cost: p.cost, markedAt: p.mark, markAsOf: p.markAsOf, markSource: p.markSource, note: p.note || null})));
  return {
    runId: state.runId, title: state.title, stage, startAt: state.startAt, endAt: state.endAt, writtenAt: iso(), rule: state.rules.text,
    rounds: {planned: state.rounds, done: state.roundsDone, missed: state.missedRounds.length},
    contestants: rows, unsettled,
    notes: [
      'Paper trading: every bet is an order on Predictefy\'s paper engine, filled against the real order book. Paper results are not real results.',
      'Settled bets were settled from each market\'s real resolution read through Predictefy. Unsettled bets are valued at Predictefy\'s last catalogue price and labelled unsettled.',
    ],
    predictefy: state.predictefy,
  };
}

function writeFinished(ctx, stage) {
  const {state, store, config} = ctx;
  const result = finishedSummary(state, stage);
  state.finished = {stage, writtenAt: result.writtenAt};
  writeJsonAtomic(store.paths.finished, result);
  if (config.finishedFile) {
    try { writeJsonAtomic(config.finishedFile, result); } catch (error) { ctx.log(`could not write ${config.finishedFile}: ${error.message}`); }
  }
  store.event('finished_file', {stage});
}

// ---- the schedule ----
async function waitUntil(ctx, timeMs, what) {
  const {state, store} = ctx;
  for (;;) {
    if (store.stopRequested()) { state.status = 'stopped'; store.save(state); store.event('stopped'); ctx.log('stop requested; state saved'); return true; }
    const left = timeMs - Date.now();
    store.heartbeat({status: state.status, stage: state.stage, waitingFor: what, until: iso(timeMs), nextRound: state.nextRound + 1});
    if (left <= 0) return false;
    await (ctx.pause || sleep)(Math.min(left, 15000));
  }
}

export async function runLoop(ctx) {
  const {state, store, log} = ctx;
  state.status = 'running';
  store.save(state);
  await recoverPending(ctx);
  while (state.nextRound < state.rounds) {
    const k = state.nextRound, due = roundTime(state, k);
    if (await waitUntil(ctx, due, `round ${k + 1}`)) return 'stopped';
    if (Date.now() - due > state.intervalSec * 500) {
      state.missedRounds.push({round: k + 1, scheduledFor: iso(due), reason: 'the harness was not running at the scheduled time'});
      state.nextRound = k + 1;
      store.save(state);
      store.event('round_missed', {round: k + 1});
      log(`round ${k + 1} was missed (the harness was not running)`);
      continue;
    }
    try { await runRound(ctx, k); }
    catch (error) {
      state.lastError = {at: iso(), round: k + 1, message: String(error?.stack || error).slice(0, 600)};
      state.nextRound = Math.max(state.nextRound, k + 1);
      store.save(state);
      store.event('round_error', state.lastError);
      log(`round ${k + 1} failed: ${error?.message || error}`);
    }
  }
  const endMs = Date.parse(state.endAt);
  if (await waitUntil(ctx, endMs, 'the end of the run')) return 'stopped';
  state.stage = 'settling';
  await settlePass(ctx, 'close');
  pushEquity(state, 'close');
  writeFinished(ctx, 'closed');
  store.save(state);
  log('trading is over; result file written; late settlements are still folded in');
  const graceEnd = endMs + state.settleGraceHours * 3600000;
  const anyOpen = () => Object.values(state.contestants).some(c => openPositions(c.account).length);
  while (anyOpen() && Date.now() < graceEnd) {
    if (await waitUntil(ctx, Math.min(graceEnd, Date.now() + 10 * 60000), 'late settlements')) return 'stopped';
    const settled = await settlePass(ctx, 'after-close');
    if (settled.length) { pushEquity(state, 'after-close'); writeFinished(ctx, 'closed'); log(`settled ${settled.length} more`); }
    store.save(state);
  }
  await settlePass(ctx, 'final');
  pushEquity(state, 'final');
  state.status = 'finished';
  state.stage = 'final';
  writeFinished(ctx, 'final');
  store.save(state);
  store.event('run_finished');
  log('run finished');
  return 'finished';
}
