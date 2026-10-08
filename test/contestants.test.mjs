import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContestant, KINDS} from '../src/contestants/index.mjs';
import {claudeArgs} from '../src/contestants/claudeCli.mjs';
import {codexArgs, readCodexReport} from '../src/contestants/codexCli.mjs';
import {cleanEnv} from '../src/contestants/proc.mjs';
import {buildPrompt} from '../src/prompt.mjs';

const dir = mkdtempSync(join(tmpdir(), 'arena-test-'));
const fake = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const facts = [
  {id: 'g1', game: 'A v B', when: 'Starts in 1 hour.', yes_means: 'A to win', no_means: 'B to win', prices: 'p', fair_price: 'f'},
  {id: 'g2', game: 'C v D', when: 'Starts in 1 hour.', yes_means: 'C to win', no_means: 'D to win', prices: 'p', fair_price: 'f'},
];
const round = (deadlineMs = 15000) => ({facts, prompt: buildPrompt(facts, {startingCash: 100, stakeUsd: 5, betsPerRound: {min: 2, max: 2}}), ids: ['g1', 'g2'], deadlineMs, roundNumber: 7});
const ctx = (extra = {}) => ({env: {}, agentDir: dir, tmpDir: dir, ...extra});
const withMode = async (mode, run) => { process.env.FAKE_MODE = mode; try { return await run(); } finally { delete process.env.FAKE_MODE; } };

test('the contestant kinds a config can name', () => {
  assert.deepEqual(Object.keys(KINDS).sort(), ['claude-cli', 'codex-cli', 'jev', 'openai-chat', 'random']);
  assert.throws(() => createContestant({name: 'x', kind: 'telepathy'}, ctx()), /Unknown contestant kind/);
});

test('the environment handed to a command-line AI has no agent-session variables and none of the keys', () => {
  const env = cleanEnv({CODEX_HOME: 'h'}, {PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_EFFORT: 'max', CLAUDE_PID: '1', PREDICTEFY_API_KEY: 'k', TYPESAFE_API_KEY: 'k', KALSHI_API_KEY_ID: 'k', USERPROFILE: 'u'});
  assert.deepEqual(env, {PATH: 'p', USERPROFILE: 'u', CODEX_HOME: 'h'});
});

test('claude is called with no tools, no settings, its model and its effort', () => {
  const args = claudeArgs({model: 'sonnet', effort: 'high'});
  assert.deepEqual(args.slice(0, 5), ['-p', '--model', 'sonnet', '--effort', 'high']);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence') && args.includes('--disable-slash-commands'));
  assert.ok(!claudeArgs({model: 'opus'}).includes('--effort'));
});

test('kind claude-cli: a good answer carries the model, the tokens and the cost the tool reported', async () => {
  const c = createContestant({name: 'claude', kind: 'claude-cli', bin: process.execPath, binArgs: [fake('fake-claude.mjs')], model: 'opus', effort: 'medium'}, ctx());
  const r = await c.ask(round());
  assert.equal(r.status, 'ok');
  assert.equal(r.model, 'claude-opus-5-5');
  assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.costUsd], [1302, 120, 0.0123]);
  assert.equal(r.answers.g1.call, 'BUY_YES');
  assert.equal(r.answers.g2.lean, 'NO');
  assert.ok(r.latencyMs > 0);
});

test('kind claude-cli: a fenced answer still parses, nonsense is invalid, a failure is an error', async () => {
  const c = createContestant({name: 'claude', kind: 'claude-cli', bin: process.execPath, binArgs: [fake('fake-claude.mjs')]}, ctx());
  assert.equal((await withMode('fenced', () => c.ask(round()))).status, 'ok');
  assert.equal((await withMode('garbage', () => c.ask(round()))).status, 'invalid');
  const failed = await withMode('fail', () => c.ask(round()));
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /Credit balance is too low/);
  const missing = await createContestant({name: 'claude', kind: 'claude-cli', bin: join(dir, 'no-such-program')}, ctx()).ask(round());
  assert.equal(missing.status, 'error');
});

test('an answer that arrives after the deadline is late, and the process is stopped', async () => {
  const c = createContestant({name: 'claude', kind: 'claude-cli', bin: process.execPath, binArgs: [fake('fake-claude.mjs')]}, ctx());
  const started = Date.now();
  const r = await withMode('slow', () => c.ask(round(1200)));
  assert.equal(r.status, 'late');
  assert.deepEqual(r.answers, {});
  assert.ok(Date.now() - started < 9000, 'it did not wait for the slow answer');
});

test('kind codex-cli: the model and tokens are read from the header Codex prints', async () => {
  const c = createContestant({name: 'gpt6', kind: 'codex-cli', bin: process.execPath, binArgs: [fake('fake-codex.mjs')], model: 'gpt-6.1-sol', effort: 'medium'}, ctx());
  const r = await c.ask(round());
  assert.equal(r.status, 'ok');
  assert.equal(r.model, 'gpt-6.1-sol');
  assert.equal(r.usage.totalTokens, 20770);
  assert.equal(r.answers.g2.strength, 51);
  assert.deepEqual(readCodexReport('model: gpt-6.1-sol\nreasoning effort: medium\ntokens used\n1,234\n'), {model: 'gpt-6.1-sol', effort: 'medium', totalTokens: 1234});
  const args = codexArgs({model: 'm', effort: 'low'}, {agentDir: 'A', schemaFile: 'S', outFile: 'O'});
  assert.ok(args.includes('read-only') && args.includes('--ephemeral') && args.includes('--skip-git-repo-check') && args.at(-1) === '-');
  assert.equal(args[args.indexOf('--output-schema') + 1], 'S');
});

test('kind codex-cli: an expired sign-in is reported in plain words', async () => {
  const c = createContestant({name: 'gpt6', kind: 'codex-cli', bin: process.execPath, binArgs: [fake('fake-codex.mjs')], model: 'gpt-6.1-sol', codexHome: 'X'}, ctx());
  const r = await withMode('unauthorized', () => c.ask(round()));
  assert.equal(r.status, 'error');
  assert.match(r.error, /not signed in/);
});

test('kind openai-chat against a fake server: good, unparsable, failing and slow answers', async () => {
  let mode = 'ok', seen = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      seen = {url: req.url, auth: req.headers.authorization, body: JSON.parse(body)};
      if (mode === 'slow') return setTimeout(() => res.end('{}'), 5000);
      if (mode === 'down') { res.writeHead(500); return res.end('{"error":{"message":"upstream exploded"}}'); }
      const content = mode === 'text' ? 'no thanks' : JSON.stringify({answers: [{id: 'g1', call: 'BUY_NO', p_yes: 0.3, lean: 'NO', strength: 77, reason: 'r'}, {id: 'g2', call: 'SKIP', p_yes: 0.5, lean: 'YES', strength: 5, reason: ''}]});
      res.end(JSON.stringify({model: 'vendor/model-x', choices: [{message: {content}}], usage: {prompt_tokens: 900, completion_tokens: 80, cost: 0.0004}}));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const def = {name: 'kimi', kind: 'openai-chat', baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, model: 'vendor/model-x', keyName: 'FAKE_ROUTER_KEY'};
  const c = createContestant(def, ctx({env: {FAKE_ROUTER_KEY: 'test-key'}}));
  try {
    const ok = await c.ask(round());
    assert.equal(ok.status, 'ok');
    assert.deepEqual([seen.url, seen.auth, seen.body.model, seen.body.messages.length, seen.body.response_format.type], ['/v1/chat/completions', 'Bearer test-key', 'vendor/model-x', 2, 'json_object']);
    assert.deepEqual([ok.model, ok.usage.inputTokens, ok.usage.outputTokens, ok.usage.costUsd], ['vendor/model-x', 900, 80, 0.0004]);
    assert.equal(ok.answers.g1.call, 'BUY_NO');
    mode = 'text';
    assert.equal((await c.ask(round())).status, 'invalid');
    mode = 'down';
    const down = await c.ask(round());
    assert.equal(down.status, 'error');
    assert.match(down.error, /HTTP 500: upstream exploded/);
    mode = 'slow';
    assert.equal((await c.ask(round(700))).status, 'late');
    const noKey = await createContestant(def, ctx()).ask(round());
    assert.equal(noKey.status, 'error');
    assert.match(noKey.error, /FAKE_ROUTER_KEY is missing/);
  } finally { server.closeAllConnections(); server.close(); }
});

test('kind jev: one request per game, the pinned model, and a failed game becomes a skip', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({url, auth: init.headers.Authorization, body});
    if (body.state.game === 'C v D') return {ok: false, status: 422, text: async () => '{"detail":"bad"}'};
    return {ok: true, status: 200, text: async () => JSON.stringify({model: 'jev-1.13.0', answers: {call: {type: 'choice', choice: 'BUY_YES', confidence: 0.6, probabilities: {BUY_YES: 0.7, BUY_NO: 0.05, SKIP: 0.25}}, yes_wins: {type: 'noul', noul: 0.66}, lean: {type: 'choice', choice: 'YES', probabilities: {YES: 0.9, NO: 0.1}}}, usage: {input_tokens: 800, output_tokens: 70}})};
  };
  const c = createContestant({name: 'jev', kind: 'jev', model: 'jev-1.13.0'}, ctx({env: {TYPESAFE_API_KEY: 'ts-key'}, fetchImpl}));
  const r = await c.ask(round());
  assert.equal(r.status, 'ok');
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[0].url, sent[0].auth, sent[0].body.model], ['https://api.typesafe.ai/v1/systemone', 'Bearer ts-key', 'jev-1.13.0']);
  assert.equal(sent[0].body.state.id, undefined);
  assert.deepEqual(Object.keys(sent[0].body.questions), ['call', 'yes_wins', 'lean']);
  assert.deepEqual([r.answers.g1.call, r.answers.g1.pYes, r.answers.g1.lean, r.answers.g1.strength], ['BUY_YES', 0.66, 'YES', 75]);
  assert.match(r.answers.g2.problem, /HTTP 422/);
  assert.deepEqual([r.model, r.usage.inputTokens, r.usage.costUsd, r.usage.requests], ['jev-1.13.0', 800, 0.000034, 2]);
  const noKey = await createContestant({name: 'jev', kind: 'jev'}, ctx()).ask(round());
  assert.equal(noKey.status, 'error');
});

test('kind random: the same seed and round always give the same picks, and it never calls a buy its own', async () => {
  const make = seed => createContestant({name: 'random', kind: 'random', seed}, ctx());
  const a = await make(20261008).ask(round()), b = await make(20261008).ask(round()), c = await make(7).ask(round());
  assert.deepEqual(a.answers, b.answers);
  assert.notDeepEqual(a.answers, c.answers);
  assert.ok(Object.values(a.answers).every(x => x.call === 'SKIP' && ['YES', 'NO'].includes(x.lean) && x.strength >= 0 && x.strength <= 100));
  const next = await make(20261008).ask({...round(), roundNumber: 8});
  assert.notDeepEqual(a.answers, next.answers);
});
