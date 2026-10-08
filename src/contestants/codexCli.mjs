// Kind "codex-cli": an OpenAI model through the Codex command line (codex exec), one call per round.
// Read-only sandbox, no shell tool, no web search, nothing saved to disk, and the answer shape is enforced with
// --output-schema. Codex prints the model it used and the tokens it spent on stderr, which is where they are read from.
import {existsSync, readFileSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {runProcess, cleanEnv, firstLine} from './proc.mjs';
import {parseAnswers, ANSWER_SCHEMA} from '../prompt.mjs';

export function codexArgs(def, {agentDir, schemaFile, outFile}) {
  return [
    ...(def.binArgs || []), 'exec', ...(def.model ? ['-m', def.model] : []),
    ...(def.effort ? ['-c', `model_reasoning_effort="${def.effort}"`] : []), '-c', 'web_search="disabled"',
    '--disable', 'shell_tool', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    '-C', agentDir, '--output-schema', schemaFile, '-o', outFile, '-',
  ];
}

/** Reads "model: ...", "reasoning effort: ..." and "tokens used\n20,770" from Codex's stderr. */
export function readCodexReport(stderr) {
  const text = String(stderr || '');
  const tokens = /tokens used\s*\r?\n\s*([\d,]+)/i.exec(text);
  return {
    model: /^model:\s*(.+)$/im.exec(text)?.[1].trim() || null,
    effort: /^reasoning effort:\s*(.+)$/im.exec(text)?.[1].trim() || null,
    totalTokens: tokens ? Number(tokens[1].replace(/,/g, '')) : null,
  };
}

export function codexCli(def, ctx) {
  mkdirSync(ctx.tmpDir, {recursive: true});
  const schemaFile = join(ctx.tmpDir, 'answer.schema.json');
  writeFileSync(schemaFile, JSON.stringify(ANSWER_SCHEMA));
  return async function ask({prompt, ids, deadlineMs, roundNumber}) {
    const outFile = join(ctx.tmpDir, `${def.name}-r${roundNumber}.json`);
    rmSync(outFile, {force: true});
    const env = cleanEnv(def.codexHome ? {CODEX_HOME: def.codexHome} : {});
    const run = await runProcess(def.bin || 'codex', codexArgs(def, {agentDir: ctx.agentDir, schemaFile, outFile}), {input: prompt, cwd: ctx.agentDir, env, timeoutMs: deadlineMs});
    if (run.timedOut) return {status: 'late', problems: [`no answer within ${Math.round(deadlineMs / 1000)} s`]};
    const report = readCodexReport(run.stderr);
    const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    rmSync(outFile, {force: true});
    if (run.code !== 0 || !text.trim()) {
      const reason = /refresh token|sign(ing)? in again|unauthorized|401/i.test(run.stderr) ? 'Codex is not signed in (its login has expired)' : firstLine(run.stderr.split(/\r?\n/).filter(line => /error/i.test(line)).join('\n')) || `codex exited with ${run.code} and no answer`;
      return {status: 'error', error: reason, model: report.model};
    }
    const parsed = parseAnswers(text, ids);
    return {
      status: parsed.ok ? 'ok' : 'invalid', answers: parsed.answers, problems: parsed.problems,
      model: report.model, usage: {totalTokens: report.totalTokens, effort: report.effort, note: 'tokens as Codex prints them on stderr'}, raw: text.slice(0, 6000),
    };
  };
}
