// Stands in for `codex exec` in tests: prints the header the real tool prints on stderr and writes the answer to the -o file.
import {writeFileSync} from 'node:fs';

const args = process.argv.slice(2), mode = process.env.FAKE_MODE || 'ok';
const out = args[args.indexOf('-o') + 1], model = args[args.indexOf('-m') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (mode === 'unauthorized') {
  console.error('ERROR codex_login::auth::manager: Failed to refresh token: Your refresh token has been invalidated. Please try signing in again.');
  process.exit(1);
}
const ids = [...prompt.matchAll(/^(g\d+)$/gm)].map(m => m[1]);
console.error(['OpenAI Codex v0.160.1', '--------', `model: ${model}`, 'provider: openai', 'reasoning effort: medium', `codex home: ${process.env.CODEX_HOME || 'default'}`, '--------'].join('\n'));
writeFileSync(out, JSON.stringify({answers: ids.map((id, i) => ({id, call: 'SKIP', p_yes: 0.4, lean: 'NO', strength: 50 + i, reason: 'fake'}))}));
console.error('tokens used\n20,770');
