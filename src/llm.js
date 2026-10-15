'use strict';
const { q } = require('./db');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const settings = {
  model: process.env.EDU_MODEL || 'qwen2.5:7b',
  mock: process.env.EDU_LLM === 'mock',
  temperature: 0.3,
  numCtx: 8192,
};

async function ollamaStatus() {
  if (settings.mock) return { ok: true, version: 'mock', models: ['mock'], model: 'mock' };
  try {
    const [v, t] = await Promise.all([
      fetch(OLLAMA_URL + '/api/version', { signal: AbortSignal.timeout(3000) }).then(r => r.json()),
      fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(3000) }).then(r => r.json()),
    ]);
    const models = (t.models || []).map(m => m.name);
    return { ok: true, version: v.version, models, model: settings.model, modelInstalled: models.includes(settings.model) };
  } catch (e) {
    return { ok: false, error: 'Ollama не отвечает на ' + OLLAMA_URL + '. Запустите приложение Ollama.', models: [], model: settings.model };
  }
}

function extractJson(text) {
  try { return JSON.parse(text); } catch (_) { }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { } }
  throw new Error('Модель вернула невалидный JSON');
}

/**
 * @param {object} o {skill, requestId, system, prompt, schema, mock, temperature, maxTokens}
 */
async function generateJson(o) {
  const started = Date.now();
  if (settings.mock) {
    const out = typeof o.mock === 'function' ? o.mock() : o.mock;
    q.run('INSERT INTO generation_run (request_id, skill_code, model, prompt_tokens, completion_tokens, duration_ms) VALUES (?,?,?,?,?,?)',
      o.requestId ?? null, o.skill, 'mock', Math.round((o.system.length + o.prompt.length) / 3), Math.round(JSON.stringify(out).length / 3), 5);
    return out;
  }
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(OLLAMA_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10 * 60 * 1000),
        body: JSON.stringify({
          model: settings.model,
          stream: false,
          format: o.schema || 'json',
          keep_alive: '30m',
          options: { temperature: o.temperature ?? settings.temperature, num_ctx: settings.numCtx, num_predict: o.maxTokens || 2048 },
          messages: [
            { role: 'system', content: o.system },
            { role: 'user', content: o.prompt + (attempt > 1 ? '\n\nВерни строго валидный JSON по схеме, без пояснений.' : '') },
          ],
        }),
      });
      if (!res.ok) throw new Error('Ollama HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
      const data = await res.json();
      const parsed = extractJson(data.message?.content || '');
      q.run('INSERT INTO generation_run (request_id, skill_code, model, prompt_tokens, completion_tokens, duration_ms) VALUES (?,?,?,?,?,?)',
        o.requestId ?? null, o.skill, settings.model, data.prompt_eval_count || 0, data.eval_count || 0, Date.now() - started);
      return parsed;
    } catch (e) {
      lastErr = e;
    }
  }
  q.run('INSERT INTO generation_run (request_id, skill_code, model, duration_ms, ok, error) VALUES (?,?,?,?,0,?)',
    o.requestId ?? null, o.skill, settings.model, Date.now() - started, String(lastErr?.message || lastErr));
  throw lastErr;
}

module.exports = { generateJson, ollamaStatus, settings, OLLAMA_URL };
