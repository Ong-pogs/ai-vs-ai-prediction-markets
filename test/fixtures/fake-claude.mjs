// Stands in for `claude -p` in tests: reads the prompt on stdin and prints the same JSON envelope the real tool prints.
const mode = process.env.FAKE_MODE || 'ok';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const ids = [...prompt.matchAll(/^(g\d+)$/gm)].map(m => m[1]);
if (mode === 'slow') await new Promise(r => setTimeout(r, 20000));
if (mode === 'fail') { console.error('Credit balance is too low'); process.exit(1); }
const answers = ids.map((id, i) => ({id, call: i === 0 ? 'BUY_YES' : 'SKIP', p_yes: 0.6, lean: i % 2 ? 'NO' : 'YES', strength: 90 - i * 10, reason: 'fake'}));
const fence = '`'.repeat(3);
const result = mode === 'garbage' ? 'I would rather not say.' : (mode === 'fenced' ? `${fence}json\n${JSON.stringify({answers})}\n${fence}` : JSON.stringify({answers}));
console.log(JSON.stringify({
  type: 'result', is_error: false, result, duration_ms: 12, total_cost_usd: 0.0123,
  usage: {input_tokens: 2, cache_creation_input_tokens: 1300, cache_read_input_tokens: 0, output_tokens: 120},
  modelUsage: {'claude-opus-5-5': {}},
  sawFlags: process.argv.slice(2),
  sawSessionVars: Object.keys(process.env).filter(k => /^CLAUDE_CODE_|^CLAUDECODE$/.test(k)),
  sawSecrets: Object.keys(process.env).filter(k => /^PREDICTEFY_|^TYPESAFE_/.test(k)),
}));
