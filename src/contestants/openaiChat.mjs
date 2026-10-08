// Kind "openai-chat": any service that speaks the OpenAI chat-completions API (OpenRouter and the like).
// Settings: baseUrl, model, keyName (the name of the key in the env file). One call per round.
import {parseAnswers, SYSTEM_LINE} from '../prompt.mjs';

export function openaiChat(def, ctx) {
  const doFetch = ctx.fetchImpl || fetch;
  return async function ask({prompt, ids, deadlineMs}) {
    const key = ctx.env[def.keyName];
    if (!def.baseUrl || !def.model || !def.keyName) return {status: 'error', error: 'an openai-chat contestant needs baseUrl, model and keyName'};
    if (!key) return {status: 'error', error: `${def.keyName} is missing from the env file`};
    let res, text;
    try {
      res = await doFetch(`${def.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${key}`, 'content-type': 'application/json'},
        body: JSON.stringify({
          model: def.model,
          messages: [{role: 'system', content: SYSTEM_LINE}, {role: 'user', content: prompt}],
          ...(def.jsonMode === false ? {} : {response_format: {type: 'json_object'}}),
          ...(def.temperature === undefined ? {} : {temperature: def.temperature}),
          ...(def.maxTokens ? {max_tokens: def.maxTokens} : {}),
        }),
        signal: AbortSignal.timeout(deadlineMs),
      });
      text = await res.text();
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') return {status: 'late', problems: [`no answer within ${Math.round(deadlineMs / 1000)} s`]};
      return {status: 'error', error: `could not reach ${def.baseUrl} (${String(error.message).slice(0, 120)})`};
    }
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || !body) return {status: 'error', error: `HTTP ${res.status}: ${String(body?.error?.message || text).slice(0, 200)}`};
    const content = body.choices?.[0]?.message?.content;
    const parsed = parseAnswers(typeof content === 'string' ? content : '', ids);
    const u = body.usage || {};
    return {
      status: parsed.ok ? 'ok' : 'invalid', answers: parsed.answers, problems: parsed.problems, model: body.model || def.model,
      usage: {inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null, costUsd: typeof u.cost === 'number' ? u.cost : null},
      raw: String(content || '').slice(0, 6000),
    };
  };
}
