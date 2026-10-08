// Keys are read from an env file and handed to the code that needs them. They are never copied into process.env,
// so nothing the harness starts (the AI command lines) can see them, and they are never logged.
import {existsSync, readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';

export function readEnvFile(file) {
  if (!file || !existsSync(file)) return {};
  return parseEnv(readFileSync(file, 'utf8'));
}
export function requireKey(env, name, hint) {
  const value = env[name];
  if (!value || /your_.*_here|^pk_live_your/i.test(value)) throw new Error(`${name} is missing from the env file. ${hint || ''}`.trim());
  return value;
}
