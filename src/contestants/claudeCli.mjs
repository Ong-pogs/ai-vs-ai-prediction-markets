// Kind "claude-cli": Claude through the Claude Code command line (claude -p), one call per round.
// No tools, no settings, no plugins, no session file, and the default system prompt is replaced by one line,
// so the model sees the prompt and nothing else of the user's.
import {runProcess, cleanEnv, firstLine} from './proc.mjs';
import {parseAnswers, SYSTEM_LINE} from '../prompt.mjs';

export function claudeArgs(def) {
  return [
    ...(def.binArgs || []), '-p', '--model', def.model || 'opus', ...(def.effort ? ['--effort', def.effort] : []),
    '--output-format', 'json', '--tools', '', '--no-session-persistence', '--disable-slash-commands',
    '--strict-mcp-config', '--setting-sources', '', '--system-prompt', SYSTEM_LINE,
  ];
}

export function claudeCli(def, ctx) {
  return async function ask({prompt, ids, deadlineMs}) {
    const run = await runProcess(def.bin || 'claude', claudeArgs(def), {input: prompt, cwd: ctx.agentDir, env: cleanEnv(), timeoutMs: deadlineMs});
    if (run.timedOut) return {status: 'late', problems: [`no answer within ${Math.round(deadlineMs / 1000)} s`]};
    let body = null;
    try { body = JSON.parse(run.stdout); } catch { /* not JSON */ }
    if (run.code !== 0 || !body || body.is_error) {
      return {status: 'error', error: firstLine(run.stderr) || String(body?.result || '').slice(0, 300) || `claude exited with ${run.code}`};
    }
    const u = body.usage || {};
    const usage = {
      inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      outputTokens: u.output_tokens || 0,
      costUsd: typeof body.total_cost_usd === 'number' ? body.total_cost_usd : null,
      toolReportedMs: body.duration_ms ?? null,
    };
    const parsed = parseAnswers(body.result, ids);
    return {
      status: parsed.ok ? 'ok' : 'invalid', answers: parsed.answers, problems: parsed.problems,
      model: Object.keys(body.modelUsage || {}).join(', ') || null, usage, raw: String(body.result || '').slice(0, 6000),
    };
  };
}
