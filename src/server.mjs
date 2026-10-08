// The dashboard: one local page that reads the run folder. It only ever reads, so it can be opened on a live run
// or on a finished one, and stopping it never affects the run.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {iso, readJson} from './util.mjs';
import {UPGRADE_URL} from './predictefy.mjs';

const PAGE = fileURLToPath(new URL('./dashboard/index.html', import.meta.url));

function trimRound(record) {
  if (!record) return null;
  const {prompt, ...rest} = record;
  const answers = Object.fromEntries(Object.entries(record.answers || {}).map(([name, a]) => { const {raw, ...keep} = a; return [name, keep]; }));
  return {...rest, promptChars: prompt?.length ?? 0, answers};
}

export function buildView(store, {rounds = 8} = {}) {
  const state = store.load();
  const numbers = store.roundNumbers();
  return {
    now: iso(), state, heartbeat: readJson(store.paths.heartbeat), upgradeUrl: UPGRADE_URL,
    roundNumbers: numbers, rounds: numbers.slice(-rounds).map(n => trimRound(store.loadRound(n))),
  };
}

export function startServer({store, port, log = () => {}}) {
  const send = (res, status, type, body) => { res.writeHead(status, {'content-type': type, 'cache-control': 'no-store'}); res.end(body); };
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/state') return send(res, 200, 'application/json', JSON.stringify(buildView(store)));
      if (url.pathname === '/api/round') {
        const record = store.loadRound(Number(url.searchParams.get('n')));
        return record ? send(res, 200, 'application/json', JSON.stringify(record)) : send(res, 404, 'application/json', '{"error":"no such round"}');
      }
      if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, 'text/html; charset=utf-8', readFileSync(PAGE));
      return send(res, 404, 'text/plain', 'not found');
    } catch (error) {
      return send(res, 500, 'text/plain', String(error.message));
    }
  });
  server.on('error', error => log(`dashboard not started on port ${port}: ${error.message}`));
  server.listen(port, '127.0.0.1', () => log(`dashboard: http://127.0.0.1:${port}/`));
  return server;
}
