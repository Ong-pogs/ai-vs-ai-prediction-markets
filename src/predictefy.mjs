// A small Predictefy REST client: one place for the key, retries, and a running count of credits by endpoint.
// Docs: https://docs.predictefy.com . Paper trading (/v1/paper/*) costs 0 credits and fills against real order books.
import {sleep} from './util.mjs';

export const UPGRADE_URL = 'https://predictefy.com/en/prediction-market-api?utm_source=youtube&utm_medium=video&utm_campaign=ai-vs-ai-paper-trading&utm_content=app';

export function makePredictefy({apiKey, base = 'https://data.predictefy.com', fetchImpl = fetch, timeoutMs = 20000, pause = sleep}) {
  const usage = {calls: 0, credits: 0, byEndpoint: {}, planNotice: null};
  async function request(method, path, {body, headers = {}, label, attempts = 3} = {}) {
    const name = label || path.split('?')[0].replace(/\/[0-9a-f-]{20,}/g, '/{id}');
    let last = {status: 0, ok: false, json: null, error: {code: 'NETWORK', message: 'no attempt made'}};
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const started = Date.now();
      try {
        const res = await fetchImpl(base + path, {
          method,
          headers: {Authorization: `Bearer ${apiKey}`, ...(body ? {'content-type': 'application/json'} : {}), ...headers},
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        const credits = Number(res.headers.get('x-credits-charged') || 0);
        usage.calls++;
        usage.credits += credits;
        const row = usage.byEndpoint[name] ||= {calls: 0, credits: 0};
        row.calls++;
        row.credits += credits;
        last = {
          status: res.status, ok: res.ok && json?.success !== false, json, data: json?.data,
          error: json?.error || (res.ok ? null : {code: `HTTP_${res.status}`, message: text.slice(0, 200)}),
          credits, replay: res.headers.get('idempotency-replay') === 'true', ms: Date.now() - started,
        };
        if (res.status === 402 || json?.error?.code === 'PLAN_REQUIRED') {
          usage.planNotice = {code: json?.error?.code || 'INSUFFICIENT_CREDITS', at: new Date().toISOString(), endpoint: name};
        }
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === attempts) return last;
        await pause(Math.min(10, Number(res.headers.get('retry-after')) || attempt * 1.5) * 1000);
      } catch (error) {
        last = {status: 0, ok: false, json: null, error: {code: 'NETWORK', message: String(error.message || error).slice(0, 200)}, ms: Date.now() - started};
        if (attempt === attempts) return last;
        await pause(attempt * 1500);
      }
    }
    return last;
  }
  return {
    usage,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, {...options, body: body ?? {}}),
  };
}
