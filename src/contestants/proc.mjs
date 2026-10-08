// Runs a command-line AI with the prompt on stdin, a hard deadline, and no window on screen.
import {spawn, spawnSync} from 'node:child_process';

const SESSION_VARS = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_EFFORT$|CLAUDE_JOB_DIR$|CLAUDE_PID$)/i;
const SECRET_VARS = /^(PREDICTEFY_|TYPESAFE_|ELEVENLABS_|KALSHI_)/i;

/** The environment handed to a contestant's process: no agent-session variables and none of the harness's keys. */
export function cleanEnv(extra = {}, base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !SESSION_VARS.test(key) && !SECRET_VARS.test(key)));
  return {...env, ...extra};
}

function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
  else child.kill('SIGKILL');
}

export function runProcess(bin, args, {input = '', cwd, env, timeoutMs}) {
  return new Promise(resolve => {
    const started = Date.now();
    let child, stdout = '', stderr = '', timedOut = false, done = false;
    const finish = code => { if (done) return; done = true; clearTimeout(timer); resolve({code, stdout, stderr, timedOut, ms: Date.now() - started}); };
    try { child = spawn(bin, args, {cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']}); }
    catch (error) { resolve({code: 'spawn-error', stdout, stderr: String(error.message), timedOut, ms: 0}); return; }
    const timer = setTimeout(() => { timedOut = true; killTree(child); setTimeout(() => finish('timeout'), 1500); }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < 2e6) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 2e6) stderr += chunk; });
    child.on('error', error => { stderr += String(error.message); finish('spawn-error'); });
    child.on('close', code => finish(timedOut ? 'timeout' : code));
    child.stdin.on('error', () => { /* the process went away before reading its prompt */ });
    child.stdin.end(input);
  });
}

export const firstLine = text => String(text || '').split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 300) || '';
