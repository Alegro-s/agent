'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { q, DATA_DIR } = require('./src/db');
const llm = require('./src/llm');
const P = require('./src/pipeline');
const { parseFile } = require('./src/reference');
const { bundle } = require('./src/repo');
const { runChecks } = require('./src/checks');
const { exportAll } = require('./src/export');
const presets = require('./src/presets');

const PORT = +(process.env.PORT || 8787);
const PUB = path.join(__dirname, 'public');
const EXP = path.join(DATA_DIR, 'exports');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };

q.run("UPDATE job SET status='failed', error='Сервер был перезапущен' WHERE status='running'");

function startJob(requestId, kind, fn) {
  const id = q.id('INSERT INTO job (request_id, kind) VALUES (?,?)', requestId, kind);
  const log = (step, text) => {
    const j = q.get('SELECT log FROM job WHERE id=?', id);
    const arr = JSON.parse(j.log); arr.push({ t: new Date().toLocaleTimeString('ru-RU'), step, text });
    q.run('UPDATE job SET log=?, step=? WHERE id=?', JSON.stringify(arr), step, id);
    console.log(`[job ${id}] ${step}: ${text}`);
  };
  Promise.resolve().then(() => fn(log)).then(
    () => q.run("UPDATE job SET status='done', finished_at=datetime('now','localtime') WHERE id=?", id),
    e => { console.error(e); log('ERR', e.message); q.run("UPDATE job SET status='failed', error=?, finished_at=datetime('now','localtime') WHERE id=?", e.message, id); q.run("UPDATE request SET status='failed' WHERE id=? AND status NOT IN ('done')", requestId); });
  return id;
}

async function analyse(requestId, log) {
  const r = q.get('SELECT * FROM request WHERE id=?', requestId);
  const answers = q.all('SELECT * FROM clarifying_question WHERE request_id=? AND answer IS NOT NULL ORDER BY ord', requestId);
  const LABEL = { program_kind: 'Тип программы', hours: 'Объём', audience: 'Слушатели', form: 'Форма обучения', final_attestation: 'Итоговая аттестация в форме' };
  const text = r.raw_text + (answers.length ? '\n\nУточнения методиста:\n' + answers.map(a => `${LABEL[a.param_key] || a.param_key}: ${a.answer}.`).join('\n') : '');
  log('S1', 'Разбираю запрос' + (answers.length ? ' с ответами методиста' : ''));
  const params = await P.extractParams(requestId, text);
  const missing = answers.length ? P.findMissing(params).filter(k => !answers.some(a => a.param_key === k)) : P.findMissing(params);
  q.run('UPDATE request SET params=?, missing_params=? WHERE id=?', JSON.stringify(params), JSON.stringify(missing), requestId);
  log('S2', `Шаблон: ${params.program_kind === 'dop' ? 'общеразвивающая программа' : params.program_kind ? 'повышение квалификации' + (params.program_kind === 'pk_internship' ? ' (стажировка)' : '') : 'не определён'}; объём: ${params.hours || '?'} ч`);
  if (missing.length && !answers.length) {
    q.run('DELETE FROM clarifying_question WHERE request_id=?', requestId);
    missing.forEach((k, i) => q.run('INSERT INTO clarifying_question (request_id, ord, param_key, question, hint) VALUES (?,?,?,?,?)', requestId, i + 1, k, P.QUESTIONS[k][0], P.QUESTIONS[k][1]));
    q.run("UPDATE request SET status='clarifying' WHERE id=?", requestId);
    log('Q', `Не хватает данных — задаю ${missing.length} вопрос(а) методисту`);
    return;
  }
  if (!params.program_kind || !params.hours) throw new Error('Не удалось определить тип программы или объём в часах — уточните запрос.');
  log('S3', 'Строю каркас: цель, компетенции, модули; часы раскладывает код');
  const vid = P.buildSkeleton(requestId);
  const v = await vid;
  log('S3', `Каркас готов (версия ${v}). Ждёт утверждения методистом`);
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); };
const readBody = req => new Promise((ok, fail) => { const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => { try { ok(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { fail(e); } }); });

function requestSummary(r) {
  const prog = q.get('SELECT p.*, v.id vid, v.status vstatus, v.hours_requested FROM program p LEFT JOIN program_version v ON v.program_id=p.id WHERE p.request_id=? ORDER BY v.id DESC LIMIT 1', r.id);
  const job = q.get('SELECT * FROM job WHERE request_id=? ORDER BY id DESC LIMIT 1', r.id);
  const run = prog ? q.get('SELECT * FROM check_run WHERE version_id=? ORDER BY id DESC LIMIT 1', prog.vid) : null;
  const issues = run ? q.get("SELECT SUM(severity='error') e, SUM(severity='warn') w, SUM(severity='info') i FROM check_issue WHERE run_id=?", run.id) : null;
  const tok = q.get('SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) t, COALESCE(SUM(duration_ms),0) ms FROM generation_run WHERE request_id=?', r.id);
  const params = JSON.parse(r.params);
  return { id: r.id, created_at: r.created_at, status: r.status, raw_text: r.raw_text, title: prog?.title || params.title || r.raw_text.slice(0, 70), kind: prog?.kind || params.program_kind, hours: prog?.hours_requested || params.hours,
    version_id: prog?.vid || null, version_status: prog?.vstatus || null, job: job ? { id: job.id, status: job.status, step: job.step, kind: job.kind } : null, issues, tokens: tok.t, llm_ms: tok.ms };
}

const routes = [
  ['GET', /^\/api\/status$/, async () => ({ ollama: await llm.ollamaStatus(), model: llm.settings.model, mock: llm.settings.mock })],
  ['POST', /^\/api\/settings$/, async (b) => { if (b.model) llm.settings.model = b.model; return { model: llm.settings.model }; }],
  ['GET', /^\/api\/presets$/, async () => presets],
  ['GET', /^\/api\/stats$/, async () => {
    const t = q.get('SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) tokens, COALESCE(SUM(duration_ms),0) ms, COUNT(*) calls FROM generation_run');
    const p = q.get("SELECT COUNT(*) n, COALESCE(SUM(hours_requested),0) h FROM program_version");
    const done = q.get("SELECT COUNT(*) n FROM program_version WHERE status IN ('checked','exported','content_ready')");
    const issues = q.get("SELECT COUNT(*) n FROM check_issue ci JOIN check_run cr ON cr.id=ci.run_id WHERE ci.severity='error' AND cr.id IN (SELECT MAX(id) FROM check_run GROUP BY version_id)");
    return { ...t, programs: p.n, hours: p.h, ready: done.n, open_errors: issues.n };
  }],
  ['GET', /^\/api\/requests$/, async () => q.all('SELECT * FROM request ORDER BY id DESC LIMIT 50').map(requestSummary)],
  ['POST', /^\/api\/requests$/, async (b) => {
    if (!b.text || b.text.trim().length < 10) throw Object.assign(new Error('Опишите задачу хотя бы одним предложением'), { code: 400 });
    const id = q.id('INSERT INTO request (raw_text, model) VALUES (?,?)', b.text.trim(), llm.settings.model);
    for (const f of b.files || []) {
      const parsed = await parseFile(f.name, Buffer.from(f.data, 'base64'));
      q.run('INSERT INTO request_file (request_id, filename, role, extracted_text, structure) VALUES (?,?,?,?,?)', id, f.name, f.role || 'reference', parsed.text, JSON.stringify(parsed.structure));
    }
    const job = startJob(id, 'analyse', log => analyse(id, log));
    return { id, job };
  }],
  ['GET', /^\/api\/requests\/(\d+)$/, async (_, [id]) => {
    const r = q.get('SELECT * FROM request WHERE id=?', +id);
    if (!r) throw Object.assign(new Error('Нет такого запроса'), { code: 404 });
    return { ...requestSummary(r), params: JSON.parse(r.params), missing: JSON.parse(r.missing_params),
      questions: q.all('SELECT * FROM clarifying_question WHERE request_id=? ORDER BY ord', r.id),
      files: q.all('SELECT id, filename, role, structure FROM request_file WHERE request_id=?', r.id).map(f => ({ ...f, structure: JSON.parse(f.structure || '{}') })) };
  }],
  ['POST', /^\/api\/requests\/(\d+)\/answers$/, async (b, [id]) => {
    for (const [ord, ans] of Object.entries(b.answers || {})) q.run('UPDATE clarifying_question SET answer=? WHERE request_id=? AND ord=?', String(ans || 'на ваше усмотрение').trim() || 'на ваше усмотрение', +id, +ord);
    q.run("UPDATE clarifying_question SET answer='на ваше усмотрение' WHERE request_id=? AND answer IS NULL", +id);
    return { job: startJob(+id, 'analyse', log => analyse(+id, log)) };
  }],
  ['GET', /^\/api\/jobs\/(\d+)$/, async (_, [id]) => { const j = q.get('SELECT * FROM job WHERE id=?', +id); return { ...j, log: JSON.parse(j.log) }; }],
  ['GET', /^\/api\/versions\/(\d+)$/, async (_, [id]) => bundle(+id)],
  ['GET', /^\/api\/versions\/(\d+)\/runs$/, async (_, [id]) => {
    const v = q.get('SELECT p.request_id FROM program_version v JOIN program p ON p.id=v.program_id WHERE v.id=?', +id);
    return q.all('SELECT skill_code, model, prompt_tokens, completion_tokens, duration_ms, ok, error, started_at FROM generation_run WHERE request_id=? ORDER BY id', v.request_id);
  }],
  ['POST', /^\/api\/versions\/(\d+)\/modules\/(\d+)$/, async (b, [vid, mid]) => {
    if (b.title) q.run('UPDATE module SET title=? WHERE id=? AND version_id=?', b.title, +mid, +vid);
    if (b.hours != null) P.setModuleHours(+vid, +mid, Math.max(0.5, Math.round(+b.hours * 2) / 2));
    return bundle(+vid);
  }],
  ['POST', /^\/api\/versions\/(\d+)\/topics\/(\d+)$/, async (b, [vid, tid]) => { if (b.title) q.run('UPDATE topic SET title=? WHERE id=?', b.title, +tid); return bundle(+vid); }],
  ['POST', /^\/api\/versions\/(\d+)\/approve$/, async (_, [vid]) => {
    const vh = q.get('SELECT * FROM v_version_hours WHERE version_id=?', +vid);
    if (Math.abs(vh.grand_total - vh.hours_requested) > 1e-6) throw Object.assign(new Error(`Часы не сходятся: ${vh.grand_total} из ${vh.hours_requested}. Поправьте модули.`), { code: 400 });
    q.run("UPDATE program_version SET status='skeleton_approved', approved_at=datetime('now','localtime') WHERE id=?", +vid);
    const rid = q.get('SELECT p.request_id FROM program_version v JOIN program p ON p.id=v.program_id WHERE v.id=?', +vid).request_id;
    q.run("UPDATE request SET status='skeleton_approved' WHERE id=?", rid);
    return { job: startJob(rid, 'content', async log => { await P.generateContent(+vid, log); log('S10', 'Выгрузка файлов'); const f = await exportAll(+vid); log('S10', 'Готово: ' + Object.keys(f).join(', ')); }) };
  }],
  ['POST', /^\/api\/versions\/(\d+)\/topics\/(\d+)\/regenerate$/, async (b, [vid, tid]) => {
    if (!b.instruction) throw Object.assign(new Error('Напишите, что поменять'), { code: 400 });
    const rid = q.get('SELECT p.request_id FROM program_version v JOIN program p ON p.id=v.program_id WHERE v.id=?', +vid).request_id;
    return { job: startJob(rid, 'patch', async log => { log('S9', `Точечная доработка темы: «${b.instruction}»`); const r = await P.regenerateTopic(+vid, +tid, b.instruction); log('S8', `Перепроверка: ${r.issues.filter(i => i.severity === 'error').length} ошибок`); await exportAll(+vid); log('S10', 'Файлы обновлены'); }) };
  }],
  ['POST', /^\/api\/versions\/(\d+)\/check$/, async (_, [vid]) => { P.repairCoverage(+vid); runChecks(+vid); return bundle(+vid); }],
  ['POST', /^\/api\/versions\/(\d+)\/export$/, async (_, [vid]) => exportAll(+vid)],
  ['GET', /^\/api\/versions\/(\d+)\/files$/, async (_, [vid]) => {
    const rows = q.all('SELECT format, path, MAX(id) id, created_at FROM export_artifact WHERE version_id=? GROUP BY format ORDER BY id', +vid);
    return rows.filter(r => fs.existsSync(r.path)).map(r => ({ format: r.format, name: path.basename(r.path), created_at: r.created_at, size: fs.statSync(r.path).size }));
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/files/')) {
      const name = path.basename(decodeURIComponent(url.pathname.slice(11)));
      const p = path.join(EXP, name);
      if (!fs.existsSync(p)) return send(res, 404, { error: 'Файл не найден' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"` });
      return fs.createReadStream(p).pipe(res);
    }
    if (url.pathname.startsWith('/api/')) {
      for (const [m, re, fn] of routes) {
        const mm = url.pathname.match(re);
        if (mm && req.method === m) return send(res, 200, await fn(m === 'POST' ? await readBody(req) : {}, mm.slice(1)));
      }
      return send(res, 404, { error: 'Нет такого метода' });
    }
    const file = path.join(PUB, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([\\/])+/, ''));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, e.code && Number.isInteger(e.code) ? e.code : 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  const st = await llm.ollamaStatus();
  console.log(`\n  ИИ-методист «Точка сборки» запущен:  http://localhost:${PORT}\n  Модель: ${llm.settings.model}${llm.settings.mock ? ' (mock)' : ''}  ·  Ollama: ${st.ok ? 'OK ' + st.version : 'НЕ ОТВЕЧАЕТ'}\n`);
});
