'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h1 = n => (n == null ? '—' : String(Math.round(n * 10) / 10).replace('.', ','));
const num = n => Number(n || 0).toLocaleString('ru-RU');
const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, k = m % 10; return m > 10 && m < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c; };
const api = async (method, path, body) => {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const toast = (t, err) => { const d = document.createElement('div'); d.className = 'toast' + (err ? ' err' : ''); d.textContent = t; document.body.append(d); setTimeout(() => d.remove(), 3500); };
const view = () => $('#view');
const timers = new Set();
const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
const clearTimers = () => { timers.forEach(clearTimeout); timers.clear(); };

const short = (s, n = 64) => { s = String(s || '').replace(/^(Сделайте|Нужна|Нужен|Нужно|Сделай|Создайте)\s+/i, ''); s = s[0] ? s[0].toUpperCase() + s.slice(1) : s; return s.length > n ? s.slice(0, s.lastIndexOf(' ', n) > 20 ? s.lastIndexOf(' ', n) : n) + '…' : s; };
const KIND = { pk: 'Повышение квалификации', pk_internship: 'Стажировка', dop: 'Общеразвивающая' };
const FORM = { ochno: 'Очно', ochno_zaochno: 'Очно-заочно', zaochno: 'Заочно / дистанционно' };

const TASKS = {
  analyse: [['S1', 'Понимаю запрос', 'тип, объём, слушатели, формат'], ['S2', 'Выбираю шаблон', 'и ищу, чего не хватает'], ['S3', 'Строю каркас', 'модули, компетенции; часы считает код']],
  content: [['S4', 'Пишу темы и задания', 'содержание и практика по каждой теме'], ['S5', 'Составляю тесты и аттестацию', 'вопросы с ключами, критерии оценки'], ['S6', 'Готовлю лекции и слайды', 'план лекции и презентация'], ['S7', 'Заполняю разделы программы', 'по шаблону АЦР, нормативка и литература'], ['S8', 'Проверяю себя', 'часы, покрытие результатов, источники'], ['S10', 'Собираю файлы', 'Word, PowerPoint, тесты для LMS']],
  patch: [['S9', 'Дорабатываю тему', 'только то, что вы попросили'], ['S8', 'Перепроверяю программу', 'часы и связи не должны сломаться'], ['S10', 'Обновляю файлы', '']],
};

async function refreshSide() {
  try {
    const [list, st] = await Promise.all([api('GET', '/api/requests'), api('GET', '/api/status')]);
    const cur = (location.hash.match(/^#\/p\/(\d+)/) || [])[1];
    $('#plist').innerHTML = list.length ? list.map(r => {
      const s = sideStatus(r);
      return `<a class="pitem ${String(r.id) === cur ? 'on' : ''}" href="#/p/${r.id}"><div class="pt">${esc(short(r.title, 40))}</div>
        <div class="pm"><span class="sdot ${s[1]}"></span>${s[0]}${r.hours ? ' · ' + h1(r.hours) + ' ч' : ''}</div></a>`;
    }).join('') : '<div class="muted small" style="padding:8px">Здесь появятся ваши программы</div>';
    const o = st.ollama;
    $('#ai').innerHTML = `<div class="row1"><span class="sdot ${o.ok ? 'ok' : 'err'}"></span>${o.ok ? 'ИИ работает на этом ноутбуке' : 'Ollama не запущена'}</div>
      <div class="muted" style="margin-top:4px">${o.ok ? 'Данные не уходят в интернет' : esc(o.error || '')}</div>
      ${o.ok && o.models.length ? `<select id="model" title="Модель">${o.models.map(m => `<option ${m === st.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>` : ''}`;
    const sel = $('#model');
    if (sel) sel.onchange = async () => { await api('POST', '/api/settings', { model: sel.value }); toast('Модель: ' + sel.value); };
    if (list.some(r => r.job && r.job.status === 'running')) later(refreshSide, 4000);
  } catch { $('#ai').innerHTML = '<div class="row1"><span class="sdot err"></span>Сервер не отвечает</div>'; }
}
function sideStatus(r) {
  if (r.job && r.job.status === 'running') return ['Собирается…', 'run'];
  if (r.status === 'clarifying') return ['Ждёт ваших ответов', 'wait'];
  if (r.version_status === 'skeleton') return ['Каркас на проверке', 'wait'];
  if (r.status === 'failed') return ['Не удалось', 'err'];
  if (r.status === 'done') return [r.issues && r.issues.e ? 'Готово, есть замечания' : 'Готово', 'ok'];
  return ['Черновик', ''];
}

function route() {
  clearTimers();
  refreshSide();
  $('#main').scrollTop = 0;
  const h = location.hash.slice(1) || '/';
  let m;
  if (h === '/new') return viewNew();
  if (h === '/how') return viewHow();
  if ((m = h.match(/^\/p\/(\d+)(?:\/(\w+))?$/))) return viewProgram(+m[1], m[2]);
  return viewHome();
}
window.addEventListener('hashchange', route);

function journey(r, q) {
  const asked = (q || []).length > 0;
  const answered = asked && q.every(x => x.answer);
  const s = [];
  s.push(['done', 'Запрос', 'принят']);
  if (!asked) s.push([r.version_id || r.status !== 'new' ? 'skip done' : 'todo', 'Уточнения', r.version_id ? 'не понадобились' : '']);
  else s.push([answered ? 'done' : 'now', 'Уточнения', answered ? 'ответы получены' : `${q.length} ${plural(q.length, 'вопрос', 'вопроса', 'вопросов')}`]);
  const running = r.job && r.job.status === 'running';
  const sk = r.version_status === 'skeleton' || (running && r.job.kind === 'analyse' && (answered || !asked));
  const built = r.version_id && r.version_status !== 'skeleton';
  s.push([built ? 'done' : sk ? 'now' : 'todo', 'Каркас', built ? 'утверждён' : sk ? (running ? 'строится' : 'ждёт утверждения') : '']);
  s.push([r.status === 'done' && !running ? 'done' : built ? 'now' : 'todo', 'Комплект', r.status === 'done' && !running ? 'готов' : built ? 'собирается' : '']);
  return `<div class="journey">${s.map(([c, t, d], i) => `<div class="jstep ${c}"><span class="n">${c.includes('done') ? '✓' : i + 1}</span><span>${t}<small>${esc(d)}</small></span></div>`).join('')}</div>`;
}
function header(r, extra = '') {
  const p = r.params || {};
  const facts = [KIND[r.kind || p.program_kind], r.hours ? h1(r.hours) + ' ч' : null, FORM[p.form], p.audience].filter(Boolean);
  return `<div class="head"><div style="flex:1;min-width:280px"><h1>${esc(short(r.title))}</h1><div class="facts">${facts.map(f => `<span class="fact">${esc(f)}</span>`).join('')}</div></div>${extra}</div>`;
}

async function viewHome() {
  const [list, presets] = await Promise.all([api('GET', '/api/requests'), api('GET', '/api/presets')]);
  view().innerHTML = `
    <div class="hero">
      <h1>Опишите программу словами — агент соберёт полный комплект</h1>
      <p>Программа по шаблону АЦР, учебный план с проверенными часами, карта компетенций, тесты с ключами, задания с критериями, лекции и слайды. Вы утверждаете каркас и правите детали.</p>
      <a class="btn lime lg" href="#/new">+ Новая программа</a>
    </div>
    ${list.length ? `<div class="flex mb"><h2 style="margin:0">Последние программы</h2></div>
      <div class="plcards mb">${list.slice(0, 6).map(r => { const s = sideStatus(r); return `<a class="plc" href="#/p/${r.id}"><span class="flex small"><span class="sdot ${s[1]}"></span>${s[0]}</span><div class="t">${esc(short(r.title))}</div><div class="muted small">${esc(KIND[r.kind] || '')}${r.hours ? ' · ' + h1(r.hours) + ' ч' : ''}</div></a>`; }).join('')}</div>` : ''}
    <h2 class="mt2">Как это работает</h2>
    ${howCards()}
    <h2 class="mt2">Попробуйте на примерах из кейса</h2>
    <div class="examples">${presets.map(p => `<button class="ex" data-p="${p.id}"><b>${esc(p.title.split('·')[0])}</b><span>${esc(p.title.split('·')[1] || 'неполный запрос — агент задаст вопросы')}</span></button>`).join('')}</div>`;
  $$('.ex').forEach(b => b.onclick = () => { sessionStorage.setItem('preset', b.dataset.p); location.hash = '/new'; });
}
const howCards = () => `<div class="how">
  <div class="card"><div class="num">1</div><h3>Опишите задачу</h3><div class="muted small">Свободным текстом. Можно приложить прошлую программу — возьмём структуру.</div></div>
  <div class="card"><div class="num">2</div><h3>Ответьте на вопросы</h3><div class="muted small">Если чего-то не хватает, агент спросит, а не будет додумывать.</div></div>
  <div class="card"><div class="num">3</div><h3>Утвердите каркас</h3><div class="muted small">Модули, часы, компетенции. Часы всегда сходятся — их считает код.</div></div>
  <div class="card"><div class="num">4</div><h3>Получите комплект</h3><div class="muted small">Word, слайды, тесты для LMS. Любую тему можно доработать отдельно.</div></div></div>`;

const CHECK = [
  ['Тип', t => /общеразвива/i.test(t) ? 'Общеразвивающая' : /стажировк/i.test(t) ? 'Стажировка' : /повышени[а-яё]*\s+квалификац/i.test(t) ? 'Повышение квалификации' : ''],
  ['Объём', t => { const m = t.match(/(\d{1,3})\s*(?:академ[а-яё]*\s*)?час/i); return m ? m[1] + ' ч' : ''; }],
  ['Слушатели', t => { const m = t.match(/для\s+([^.,;]{4,50})/i); return m ? m[1] : ''; }],
  ['Формат', t => /очно-заочн/i.test(t) ? 'Очно-заочно' : /дистанц|онлайн|заочн/i.test(t) ? 'Дистанционно' : /(^|[^а-яё-])очн/i.test(t) ? 'Очно' : /стажировк/i.test(t) ? 'На предприятии' : ''],
  ['Аттестация', t => { const m = t.match(/(зач[её]т[а-яё]*|экзамен[а-яё]*|защит[а-яё]*\s+[а-яё]+|защищает[^.]{0,30})/i); return m ? m[1] : ''; }],
];
async function viewNew() {
  const presets = await api('GET', '/api/presets');
  const files = [];
  view().innerHTML = `
    <div class="head"><div><h1>Новая программа</h1><div class="facts"><span class="fact">Шаг 1 из 4 · запрос</span></div></div></div>
    <div class="composer">
      <textarea id="text" placeholder="Например: программа повышения квалификации на 72 часа «Анализ данных на Python» для сотрудников банков, которые работают в Excel. Очно-заочно, 4 недели. Итоговая аттестация — защита проекта."></textarea>
      <div class="bar">
        <label class="attach" id="drop">📎 Приложить прошлую программу (.docx)<input type="file" id="file" accept=".docx,.txt,.md,.pdf" multiple hidden></label>
        <span id="flist" class="flex"></span><span class="sp"></span>
        <button class="btn lime" id="go" disabled>Собрать программу →</button>
      </div>
    </div>
    <div class="checklist" id="ck"></div>
    <p class="muted small" style="margin:10px 4px 0">Не всё указано? Ничего страшного — агент спросит недостающее. Из приложенной программы берётся только структура, текст будет новым.</p>
    <h3 class="mt2">Или начните с примера из кейса</h3>
    <div class="examples">${presets.map(p => `<button class="ex" data-p="${p.id}"><b>${esc(p.title.split('·')[0])}</b><span>${esc(p.title.split('·')[1] || 'неполный — будут вопросы')}</span></button>`).join('')}</div>`;
  const ta = $('#text');
  const update = () => {
    const t = ta.value;
    $('#ck').innerHTML = CHECK.map(([k, f]) => { const v = f(t); return `<div class="ck ${v ? 'ok' : ''}"><b>${k}</b>${v ? `<span class="v">${esc(v)}</span>` : 'не указан'}</div>`; }).join('');
    $('#go').disabled = t.trim().length < 15;
  };
  ta.oninput = update;
  const showFiles = () => { $('#flist').innerHTML = files.map((f, i) => `<span class="fchip">${esc(f.name)}<button data-rm="${i}" title="Убрать">×</button></span>`).join(''); $$('[data-rm]').forEach(b => b.onclick = e => { e.preventDefault(); files.splice(+b.dataset.rm, 1); showFiles(); }); };
  const addFiles = async list => { for (const f of list) { const u = new Uint8Array(await f.arrayBuffer()); let bin = ''; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); files.push({ name: f.name, data: btoa(bin) }); } showFiles(); };
  $('#file').onchange = e => addFiles(e.target.files);
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
  const usePreset = id => { ta.value = presets.find(p => p.id === id).text; update(); ta.focus(); };
  $$('.ex').forEach(b => b.onclick = () => usePreset(b.dataset.p));
  const pre = sessionStorage.getItem('preset'); if (pre) { sessionStorage.removeItem('preset'); usePreset(pre); }
  update();
  $('#go').onclick = async () => {
    $('#go').disabled = true; $('#go').innerHTML = '<span class="spin"></span> Отправляю…';
    try { const r = await api('POST', '/api/requests', { text: ta.value, files }); location.hash = '/p/' + r.id; }
    catch (e) { toast(e.message, true); $('#go').disabled = false; $('#go').textContent = 'Собрать программу →'; }
  };
}

async function viewProgram(id, section) {
  const r = await api('GET', '/api/requests/' + id);
  const job = r.job ? await api('GET', '/api/jobs/' + r.job.id) : null;
  if (job && job.status === 'running') return viewWorking(r, job);
  if (r.status === 'clarifying') return viewQuestions(r);
  if (!r.version_id) return viewFailed(r, job);
  if (r.version_status === 'skeleton') return viewSkeleton(r);
  return viewKit(r, section || 'summary', job);
}

function viewFailed(r, job) {
  view().innerHTML = `${header(r)}${journey(r, r.questions)}
    <div class="card"><h2>Не получилось собрать программу</h2><p class="lead">${esc(job?.error || 'Неизвестная ошибка')}</p>
    <p class="small muted">Частые причины: не запущена Ollama, модель не скачана, в запросе нет объёма в часах.</p>
    <div class="flex mt"><a class="btn lime" href="#/new">Создать запрос заново</a></div></div>`;
}

function viewWorking(r, job) {
  const kind = job.kind;
  const list = TASKS[kind] || TASKS.content;
  const started = new Date(job.started_at.replace(' ', 'T')).getTime() || Date.now();
  view().innerHTML = `${header(r)}${journey(r, r.questions)}
    <div class="progress">
      <div class="card"><h2>${kind === 'analyse' ? 'Разбираю запрос и строю каркас' : kind === 'patch' ? 'Дорабатываю тему' : 'Собираю комплект'}</h2>
        <p class="lead">${kind === 'analyse' ? 'Обычно до пары минут. Потом вы проверите каркас.' : 'Можно уйти со страницы — работа продолжится, программа появится слева.'}</p>
        <div class="tasks" id="tasks"></div></div>
      <div class="card lime"><div class="small" style="font-weight:700">Прошло времени</div><div class="timer" id="timer">0:00</div>
        <div class="small">Модель работает на этом ноутбуке. Часы раскладывает код — они всегда сойдутся.</div>
        <div class="feed" id="feed"></div></div>
    </div>`;
  const paint = j => {
    const seen = j.log.map(l => l.step);
    const curIdx = list.findIndex(([s]) => s === j.step);
    $('#tasks').innerHTML = list.map(([s, t, d], i) => {
      const last = [...j.log].reverse().find(l => l.step === s);
      const state = j.status === 'running' && i === curIdx ? 'now' : (i < curIdx || seen.includes(s) ? 'done' : 'todo');
      return `<div class="task ${state}"><span class="ic">${state === 'done' ? '✓' : state === 'now' ? '<span class="spin"></span>' : i + 1}</span><div><div class="tt">${t}</div><div class="td">${esc(last && state !== 'todo' ? last.text : d)}</div></div><span></span></div>`;
    }).join('');
    $('#feed').innerHTML = [...j.log].reverse().slice(0, 30).map(l => `<div>${esc(l.t)} — ${esc(l.text)}</div>`).join('');
  };
  paint(job);
  const tick = async () => {
    if (!$('#timer')) return;
    const s = Math.max(0, Math.round((Date.now() - started) / 1000));
    $('#timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const j = await api('GET', '/api/jobs/' + job.id).catch(() => null);
    if (!j) return later(tick, 2000);
    if (j.status !== 'running') { refreshSide(); return viewProgram(r.id); }
    paint(j);
    later(tick, 1000);
  };
  later(tick, 500);
}

const QMETA = {
  program_kind: ['Какой это будет документ?', 'От этого зависит шаблон и что получат слушатели: удостоверение или сертификат.', ['Повышение квалификации', 'Стажировка (повышение квалификации)', 'Общеразвивающая программа']],
  hours: ['Сколько всего часов?', '«Примерно месяц» можно наполнить и 36, и 144 часами.', ['16 часов', '36 часов', '72 часа', '144 часа']],
  audience: ['Кто будет учиться и что уже умеет?', 'Чтобы подобрать стартовый уровень, язык и примеры.', []],
  form: ['Как будут проходить занятия?', 'Влияет на долю аудиторной и самостоятельной работы.', ['Очно', 'Очно-заочно', 'Дистанционно']],
  final_attestation: ['Как проверим результат в конце?', 'Под форму аттестации агент подготовит задания и критерии.', ['Зачёт', 'Экзамен с практическим заданием', 'Защита проекта']],
};
function viewQuestions(r) {
  view().innerHTML = `${header(r)}${journey(r, r.questions)}
    <div class="bubble"><div class="who me">Вы</div><div class="msg">${esc(r.raw_text)}</div></div>
    <div class="bubble"><div class="who">ИИ</div><div class="msg">Чтобы не додумывать за вас, уточню ${r.questions.length} ${plural(r.questions.length, 'момент', 'момента', 'моментов')}. Выберите вариант или напишите свой — на пропущенные вопросы решу сам.</div></div>
    <div style="margin-left:50px">
      ${r.questions.map(q => { const m = QMETA[q.param_key] || [q.question, '', []]; return `<div class="qcard" data-q="${q.ord}"><div class="q">${q.ord}. ${esc(m[0])}</div><div class="why">${esc(m[1])}</div>
        ${m[2].length ? `<div class="opts">${m[2].map(o => `<button class="opt">${esc(o)}</button>`).join('')}</div>` : ''}
        <input class="inp" placeholder="${esc(q.hint || 'Ваш ответ')}"></div>`; }).join('')}
      <div class="flex mt"><span class="muted small" id="left"></span><span class="sp"></span><button class="btn lime lg" id="send">Продолжить →</button></div>
    </div>`;
  const upd = () => { const n = $$('.qcard').filter(c => $('.inp', c).value.trim()).length; $$('.qcard').forEach(c => c.classList.toggle('ok', !!$('.inp', c).value.trim())); $('#left').textContent = n === r.questions.length ? 'Все ответы есть' : `Отвечено ${n} из ${r.questions.length}`; };
  $$('.qcard').forEach(c => {
    $$('.opt', c).forEach(o => o.onclick = () => { $$('.opt', c).forEach(x => x.classList.remove('on')); o.classList.add('on'); $('.inp', c).value = o.textContent; upd(); });
    $('.inp', c).oninput = () => { $$('.opt', c).forEach(x => x.classList.toggle('on', x.textContent === $('.inp', c).value)); upd(); };
  });
  upd();
  $('#send').onclick = async () => {
    const answers = {}; $$('.qcard').forEach(c => { answers[c.dataset.q] = $('.inp', c).value; });
    $('#send').disabled = true;
    try { await api('POST', `/api/requests/${r.id}/answers`, { answers }); viewProgram(r.id); } catch (e) { toast(e.message, true); $('#send').disabled = false; }
  };
}

async function viewSkeleton(r) {
  const open = new Set();
  let b = await api('GET', '/api/versions/' + r.version_id);
  const paint = () => {
    const sum = b.plan.grand_total, need = b.program.hours, ok = Math.abs(sum - need) < 1e-6;
    const refIssues = (r.files || []).flatMap(f => (f.structure?.issues || []).map(i => [f.filename, i]));
    const step = b.program.duration.lesson_hours ? 1 : 0.5;
    view().innerHTML = `${header(r)}${journey(r, r.questions)}
      <div class="card white mb"><h2>Проверьте каркас перед сборкой</h2>
        <p class="lead" style="margin:0">Это последняя точка, где вы решаете. Поменяйте часы модулей кнопками − / + — темы, виды занятий и календарь пересчитаются сами. Тексты тем, тесты и слайды агент напишет после утверждения.</p></div>
      ${refIssues.length ? `<div class="card mb" style="border-color:var(--light)"><h3>В приложенном образце нашлась ошибка</h3>${refIssues.map(([f, i]) => `<div class="issue info"><span class="mk"></span><span>«${esc(f)}»: ${esc(i)} В новой программе её не будет — итоги считаются из строк.</span></div>`).join('')}</div>` : ''}
      <div class="grid g2" style="grid-template-columns:1.5fr 1fr;align-items:start">
        <div><div class="flex mb"><h2 style="margin:0">Модули и часы</h2><span class="sp"></span><span class="muted small">нажмите на модуль, чтобы увидеть темы</span></div>
          <div class="mods">${b.plan.modules.map(m => `<div class="mod ${open.has(m.id) ? 'open' : ''}" data-m="${m.id}">
            <div class="mh"><span class="code">${esc(m.code)}</span><div><div class="title">${esc(m.title)}</div><div class="split">${m.topics.length} ${plural(m.topics.length, 'тема', 'темы', 'тем')} · лекции ${h1(m.hours.lk)} · практика ${h1(m.hours.pr + m.hours.lb)} · самост. ${h1(m.hours.srs)}</div></div>
              <span class="stepper" data-stop><button data-d="-${step}" title="Меньше">−</button><input type="number" step="${step}" min="${step}" value="${m.planned_hours}"><button data-d="${step}" title="Больше">+</button></span><span class="chev">›</span></div>
            <div class="tl" ${open.has(m.id) ? '' : 'hidden'}>${m.topics.map(t => `<div><i>${esc(t.code)}</i><span>${esc(t.title)}</span><i>${h1(t.hours.total)} ч</i></div>`).join('')}</div></div>`).join('')}
            <div class="mod"><div class="mh" style="cursor:default"><span class="code" style="background:var(--lime)">ИА</span><div><div class="title">Итоговая аттестация</div><div class="split">${esc(b.final_attestation.form)}</div></div><b>${h1(b.final_attestation.hours)} ч</b><span></span></div></div>
          </div></div>
        <div>
          <div class="card mb"><h3>Цель программы</h3><p class="muted" style="margin:0">${esc(b.program.goal)}</p></div>
          <div class="card mb"><h3>Чему научатся</h3>${b.competencies.map(c => `<div style="margin-top:12px"><b>${esc(c.title)}</b>${c.standard ? `<div class="small muted">Профстандарт ${esc(c.standard.code)}${c.standard.function_code ? ', ТФ ' + esc(c.standard.function_code) : ''} ${c.standard.verified ? '<span class="tag l">подтверждён</span>' : '<span class="tag">проверить код</span>'}</div>` : ''}
            <ul style="margin:6px 0 0;padding-left:18px" class="small">${c.outcomes.map(o => `<li>${esc(o.text)}</li>`).join('')}</ul></div>`).join('')}</div>
          <div class="card"><h3>График</h3><div class="stat"><div class="v">${Math.max(...b.plan.calendar.map(c => c.week))}<small>${plural(Math.max(...b.plan.calendar.map(c => c.week)), 'неделя', 'недели', 'недель')}</small></div></div>
            <div class="muted small">${new Set(b.plan.calendar.map(c => c.day)).size} учебных дней${b.program.duration.max_hours_per_day ? `, не больше ${h1(b.program.duration.max_hours_per_day)} ч в день` : ''}${b.program.duration.lesson_hours ? `, занятия по ${h1(b.program.duration.lesson_hours)} ч ${b.program.duration.lessons_per_week} раза в неделю` : ''}</div></div>
        </div>
      </div>
      <div class="sumbar"><div class="sum">Итого ${h1(sum)} из ${h1(need)} ч <span class="badge ${ok ? 'ok' : 'bad'}">${ok ? '✓ сходится' : `${sum > need ? 'лишние' : 'не хватает'} ${h1(Math.abs(sum - need))} ч`}</span></div>
        <div class="hbar" style="flex:1;min-width:200px;margin:0">${['lk', 'pr', 'srs'].map((k, i) => `<i style="width:${(100 * (k === 'pr' ? b.plan.totals.pr + b.plan.totals.lb : b.plan.totals[k])) / need}%;background:${['#F0F0F0', '#88EF1B', '#00B000'][i]}"></i>`).join('')}<i style="width:${(100 * b.final_attestation.hours) / need}%;background:#777"></i></div>
        <button class="btn lime lg" id="approve" ${ok ? '' : 'disabled'}>Утвердить и собрать комплект →</button></div>`;
    $$('.mod[data-m]').forEach(el => {
      const id = +el.dataset.m;
      $('.mh', el).onclick = e => { if (e.target.closest('[data-stop]')) return; open.has(id) ? open.delete(id) : open.add(id); paint(); };
      const inp = $('input', el);
      const set = async v => { try { b = await api('POST', `/api/versions/${r.version_id}/modules/${id}`, { hours: v }); paint(); } catch (e) { toast(e.message, true); } };
      $$('[data-d]', el).forEach(btn => btn.onclick = () => set(Math.max(step, +inp.value + +btn.dataset.d)));
      inp.onchange = () => set(+inp.value);
    });
    $('#approve').onclick = async () => { $('#approve').disabled = true; try { await api('POST', `/api/versions/${r.version_id}/approve`); refreshSide(); viewProgram(r.id); } catch (e) { toast(e.message, true); $('#approve').disabled = false; } };
  };
  paint();
}

const SECTIONS = [['summary', 'Сводка'], ['plan', 'Учебный план'], ['map', 'Чему научатся'], ['assess', 'Оценивание'], ['slides', 'Лекции и слайды'], ['sources', 'Литература'], ['files', 'Файлы']];
const TOOL = { test: 'тест', seminar_task: 'задание', interview: 'собеседование', final_attestation: 'аттестация' };
const SEV = { error: ['Нужно исправить', 'Без этого программу нельзя утверждать'], warn: ['Стоит проверить', 'Агент не уверен — посмотрите сами'], info: ['К сведению', 'Полезные наблюдения'] };

async function viewKit(r, section, job) {
  const [b, files] = await Promise.all([api('GET', '/api/versions/' + r.version_id), api('GET', `/api/versions/${r.version_id}/files`)]);
  const iss = b.check_report.issues;
  const errs = iss.filter(i => i.severity === 'error').length;
  const lectures = b.plan.modules.flatMap(m => m.topics.filter(t => t.lecture));
  const docx = files.find(f => f.format === 'docx');
  const nq = b.assessment.tests.reduce((a, t) => a + t.questions.length, 0) + b.plan.modules.reduce((a, m) => a + m.interview_questions.length, 0);
  const counts = { plan: b.plan.modules.reduce((a, m) => a + m.topics.length, 0), map: b.competencies.reduce((a, c) => a + c.outcomes.length, 0), assess: nq, slides: lectures.length, sources: b.sources.length, files: files.length };
  view().innerHTML = `${header(r, docx ? `<a class="btn lime" href="/api/files/${encodeURIComponent(docx.name)}">⬇ Скачать программу (.docx)</a>` : '')}${journey(r, r.questions)}
    <div class="ws"><nav class="toc">${SECTIONS.map(([k, t]) => `<button data-s="${k}" class="${k === section ? 'on' : ''}">${t}${k === 'summary' && errs ? `<span class="cnt red">${errs}</span>` : counts[k] != null ? `<span class="cnt">${counts[k]}</span>` : ''}</button>`).join('')}</nav><div id="sec"></div></div>`;
  $$('.toc button').forEach(btn => btn.onclick = () => { location.hash = `/p/${r.id}/${btn.dataset.s}`; });
  const S = $('#sec');
  const T = b.plan.totals, total = b.program.hours;

  if (section === 'summary') {
    const outs = b.competencies.flatMap(c => c.outcomes);
    const covered = outs.filter(o => o.topics.length && o.assessed_by.length >= 2).length;
    const groups = ['error', 'warn', 'info'].map(s => [s, iss.filter(i => i.severity === s)]).filter(g => g[1].length);
    S.innerHTML = `
      <div class="status ${errs ? 'bad' : 'ok'}"><span class="big">${errs ? '!' : '✓'}</span><div><b>${errs ? `${errs} ${plural(errs, 'замечание нужно', 'замечания нужно', 'замечаний нужно')} исправить` : 'Комплект собран, самопроверка пройдена'}</b><div class="small">${errs ? 'Ниже — что именно и где.' : 'Часы сходятся, каждый результат обучения раскрыт в теме и проверяется минимум двумя способами.'}</div></div></div>
      <div class="grid g4 mb">
        <div class="card white stat"><div class="k">Объём</div><div class="v">${h1(b.plan.grand_total)}<small>ч</small></div></div>
        <div class="card stat"><div class="k">Тем</div><div class="v">${counts.plan}</div></div>
        <div class="card stat"><div class="k">Вопросов и заданий</div><div class="v">${nq + b.plan.modules.reduce((a, m) => a + m.topics.reduce((x, t) => x + t.seminar_tasks.length, 0), 0)}</div></div>
        <div class="card stat"><div class="k">Результаты проверяются</div><div class="v">${outs.length ? Math.round((100 * covered) / outs.length) : 0}<small>%</small></div></div>
      </div>
      <div class="grid g2" style="grid-template-columns:1.4fr 1fr;align-items:start">
        <div class="card">${groups.length ? groups.map(([s, list]) => `<div class="igroup mb"><h3><span class="sdot ${s === 'error' ? 'err' : s === 'warn' ? 'wait' : 'ok'}"></span>${SEV[s][0]} · ${list.length}</h3><div class="small muted">${SEV[s][1]}</div>${list.map(i => `<div class="issue ${s}"><span class="mk"></span><span>${esc(i.message)}<small>${esc(i.rule)}</small></span></div>`).join('')}</div>`).join('') : '<div class="empty">Замечаний нет</div>'}</div>
        <div>
          <div class="card mb"><h3>Как распределены часы</h3>
            <div class="hbar">${[[T.lk, '#F0F0F0'], [T.pr + T.lb, '#88EF1B'], [T.srs, '#00B000'], [b.final_attestation.hours, '#777']].map(([v, c]) => v > 0 ? `<i style="width:${(100 * v) / total}%;background:${c}"></i>` : '').join('')}</div>
            <div class="legend"><span style="--c:#F0F0F0">Лекции ${h1(T.lk)}</span><span style="--c:#88EF1B">Практика ${h1(T.pr + T.lb)}</span><span style="--c:#00B000">Самостоятельно ${h1(T.srs)}</span><span style="--c:#777">Аттестация ${h1(b.final_attestation.hours)}</span></div></div>
          <div class="card lime mb"><h3>Что дальше</h3><ol style="margin:0;padding-left:18px">
            <li>Скачайте программу и слайды в разделе «Файлы».</li>
            <li>Посмотрите пункты «стоит проверить» — например, коды профстандартов.</li>
            <li>Не нравится тема? Откройте «Учебный план» и нажмите «Доработать» — агент перепишет только её.</li></ol></div>
          <div class="card small muted">Собрано моделью ${esc(b.meta.models.join(', '))} за ${Math.max(1, Math.round(b.meta.llm_ms / 60000))} мин · ${num(b.meta.tokens)} токенов · ${b.meta.llm_calls} обращений. Реквизиты приказа, ФИО и подписи оставлены пустыми.</div>
          ${b.changes.length ? `<div class="card mt"><h3>Ваши правки</h3>${b.changes.map(c => `<div class="issue info"><span class="mk"></span><span>${esc(c.instruction)}<small>${esc(c.created_at)}</small></span></div>`).join('')}</div>` : ''}
        </div></div>`;
  }

  if (section === 'plan') {
    S.innerHTML = `<div class="flex mb"><p class="muted" style="margin:0">Наведите на тему и нажмите «Доработать», чтобы попросить изменения. Остальная программа не изменится.</p></div>
      ${b.plan.modules.map(m => `<div class="card mb"><div class="flex"><span class="tag w">${m.kind === 'intro' ? 'Вводный' : 'Модуль ' + esc(m.code)}</span><h2 style="margin:0;flex:1">${esc(m.title)}</h2><b>${h1(m.hours.total)} ч</b></div>
        <div class="small muted" style="margin:4px 0 8px">Контроль: ${esc(m.control_form)}</div>
        ${m.topics.map(t => `<div class="topic"><div class="th"><span class="tag">${esc(t.code)}</span><b>${esc(t.title)}</b>
          <span class="small muted">${[t.hours.lk && `лекция ${h1(t.hours.lk)}`, (t.hours.pr + t.hours.lb) && `практика ${h1(t.hours.pr + t.hours.lb)}`, t.hours.srs && `самост. ${h1(t.hours.srs)}`].filter(Boolean).join(' · ')} ч</span>
          <button class="btn sm dark edit" data-fix="${t.id}" data-name="${esc(t.code + ' ' + t.title)}">✎ Доработать</button></div>
          <p>${esc(t.content)}</p>
          ${t.seminar_tasks.map(s => `<div class="tk"><b>Задание:</b> ${esc(s.title.replace(/^Задание:\s*/i, ''))}${s.situation ? ` — ${esc(s.situation)}` : ''}<br>${esc(s.instructions)}${s.deliverable ? `<br><b>Результат:</b> ${esc(s.deliverable)}` : ''}<br><b>Критерии:</b> ${s.criteria.map(esc).join('; ')}</div>`).join('')}</div>`).join('')}</div>`).join('')}
      <div class="card white"><div class="flex"><span class="tag" style="background:#0A0A0A;color:#F0F0F0">ИА</span><h2 style="margin:0;flex:1">Итоговая аттестация: ${esc(b.final_attestation.form)}</h2><b>${h1(b.final_attestation.hours)} ч</b></div></div>`;
    $$('[data-fix]').forEach(btn => btn.onclick = () => fixDrawer(r, btn.dataset.fix, btn.dataset.name));
  }

  if (section === 'map') {
    S.innerHTML = `<p class="muted" style="margin-top:0">Каждый результат обучения должен раскрываться хотя бы в одной теме и проверяться минимум двумя способами — так агент проверяет себя.</p>
      ${b.competencies.map(c => `<div class="card mb"><h2>${esc(c.title)}</h2>
        <div class="small muted mb">${c.standard ? `Профстандарт ${esc(c.standard.code)} «${esc(c.standard.title || '')}»${c.standard.function_code ? `, трудовая функция ${esc(c.standard.function_code)} ${esc(c.standard.function_title || '')}` : ', код трудовой функции нужно выбрать'} ${c.standard.verified ? '<span class="tag l">подтверждён</span>' : '<span class="tag">проверить</span>'}` : 'Общеразвивающая программа — без привязки к профстандарту'}</div>
        ${c.outcomes.map(o => { const n = o.assessed_by.length; const ok = o.topics.length && n >= 2; return `<div class="out"><span class="tag w">${{ knowledge: 'знать', skill: 'уметь', ability: 'владеть', experience: 'опыт' }[o.kind]}</span>
          <div>${esc(o.text)}<div class="small" style="margin-top:4px">${o.topics.map(t => `<span class="tag">тема ${esc(t)}</span>`).join('')}${Object.entries(o.assessed_by.reduce((m, a) => { const k = TOOL[a.split(':')[0]]; m[k] = (m[k] || 0) + 1; return m; }, {})).map(([k, c]) => `<span class="tag l">${k}${c > 1 ? ' ×' + c : ''}</span>`).join('')}</div></div>
          <div style="text-align:right"><div class="cov">${[0, 1].map(i => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div><div class="small ${ok ? '' : 'muted'}" style="margin-top:4px;color:${ok ? 'var(--lime)' : 'var(--red)'}">${ok ? 'проверяется' : 'мало проверок'}</div></div></div>`; }).join('')}</div>`).join('')}`;
  }

  if (section === 'assess') {
    const fa = b.final_attestation;
    const iqs = b.plan.modules.filter(m => m.interview_questions.length);
    S.innerHTML = `<div class="card lime mb"><h2>Итоговая аттестация: ${esc(fa.form)}</h2><p style="margin:4px 0 0">${esc(fa.description)}</p></div>
      <div class="grid g2 mb" style="align-items:start">
        <div class="card"><h3>Требования</h3><p class="muted small">${esc(fa.requirements)}</p><h3>Как проходит</h3><p class="muted small">${esc(fa.procedure)}</p><h3>Пример задания</h3><p class="muted small" style="margin-bottom:0">${esc(fa.example_task)}</p></div>
        <div class="card"><h3>Критерии оценки</h3>${fa.criteria.map(c => `<div class="issue"><b>${c.max_points ?? ''}</b><span>${esc(c.text)}</span></div>`).join('')}<p class="small muted">${esc(fa.pass_rule)}</p></div></div>
      ${b.assessment.tests.map(t => `<div class="card mb"><div class="flex"><h2 style="margin:0;flex:1">${esc(t.title)}</h2><span class="muted small">правильный ответ подсвечен</span></div>
        ${t.questions.map((x, i) => `<div class="qq"><b>${i + 1}. ${esc(x.text)}</b>${x.options.map((o, k) => `<div class="o ${o.correct ? 'ok' : ''}">${'абвгд'[k]}) ${esc(o.text)}${o.correct ? ' ✓' : ''}</div>`).join('')}</div>`).join('')}</div>`).join('')}
      ${iqs.length ? `<div class="card"><h2>Вопросы для собеседования с руководителем стажировки</h2>${iqs.map(m => `<h3 class="mt">${esc(m.code)}. ${esc(m.title)}</h3>${m.interview_questions.map((x, i) => `<div class="qq">${i + 1}. ${esc(x.text)}</div>`).join('')}`).join('')}</div>` : ''}`;
  }

  if (section === 'slides') {
    S.innerHTML = lectures.length ? lectures.map(t => `<div class="card mb"><div class="flex mb"><span class="tag">${esc(t.code)}</span><h2 style="margin:0;flex:1">${esc(t.title)}</h2><span class="muted small">${t.lecture.slides.length} слайдов</span></div>
      <p class="muted small" style="margin-top:0"><b>Цель:</b> ${esc(t.lecture.goal)}<br><b>План:</b> ${t.lecture.outline.map(esc).join(' → ')}</p>
      <div class="slides">${t.lecture.slides.map((s, i) => `<div class="slide ${i === 0 ? 'first' : ''}"><div class="st">${esc(s.title)}</div><ul>${s.bullets.map(x => `<li>${esc(x)}</li>`).join('')}</ul><div class="foot"></div></div>`).join('')}</div></div>`).join('')
      : '<div class="card empty">Для этой программы слайды не запрашивались</div>';
  }

  if (section === 'sources') {
    const G = { normative: 'Нормативные документы', main: 'Основная литература', web: 'Интернет-ресурсы' };
    S.innerHTML = `<div class="card mb small" style="padding:16px 20px"><span class="tag l">✓ из справочника</span> — проверенный источник. <span class="tag">проверить</span> — предложил ИИ, в документе помечен, перед утверждением сверьте.</div>
      ${Object.entries(G).map(([k, title]) => { const l = b.sources.filter(s => s.section === k); return l.length ? `<div class="card mb"><h3>${title}</h3>${l.map(s => `<div class="issue"><span>${s.verified ? '<span class="tag l">✓</span>' : '<span class="tag">проверить</span>'}</span><span>${esc(s.text)}</span></div>`).join('')}</div>` : ''; }).join('')}
      ${b.tools.length ? `<div class="card"><h3>Сервисы и инструменты в тексте программы</h3>${b.tools.map(t => `<span class="tag ${t.available_ru === 0 || t.deprecated ? 'r' : 'l'}">${esc(t.name)}</span>`).join('')}<p class="small muted">Красным — недоступные в России или устаревшие.</p></div>` : ''}`;
  }

  if (section === 'files') {
    const L = { docx: ['DOCX', 'Программа по шаблону АЦР', 'Откройте в Word: все разделы, планы, оценочные материалы'], pptx: ['PPTX', 'Слайды к лекциям', 'Презентация в цветах дизайн-системы'], gift: ['GIFT', 'Тесты для Moodle', 'Формат GIFT'], moodle_xml: ['XML', 'Тесты Moodle XML', 'Импорт в банк вопросов'], csv: ['CSV', 'Тесты таблицей', 'Для Excel и других LMS'], json: ['JSON', 'Все данные комплекта', 'Для интеграций'] };
    const main = files.find(f => f.format === 'docx');
    S.innerHTML = `<div class="files">${main ? `<a class="file main" href="/api/files/${encodeURIComponent(main.name)}"><span class="ext">DOCX</span><span>Программа по шаблону АЦР<small>${L.docx[2]} · ${Math.round(main.size / 1024)} КБ</small></span></a>` : ''}
      ${files.filter(f => f !== main).map(f => `<a class="file" href="/api/files/${encodeURIComponent(f.name)}"><span class="ext">${(L[f.format] || [f.format])[0]}</span><span>${(L[f.format] || [, f.name])[1]}<small>${(L[f.format] || [, , ''])[2]}</small></span></a>`).join('')}</div>
      <div class="flex mt"><span class="muted small">Реквизиты приказа, ФИО преподавателей и подписи оставлены пустыми — их заполняет методист.</span><span class="sp"></span><button class="btn sm dark" id="reexp">Пересобрать файлы</button></div>`;
    $('#reexp').onclick = async () => { await api('POST', `/api/versions/${r.version_id}/export`); toast('Файлы пересобраны'); viewProgram(r.id, 'files'); };
  }
  void job;
}

function fixDrawer(r, topicId, name) {
  const bg = document.createElement('div'); bg.className = 'drawer-bg';
  const ideas = ['Объясни проще, для новичков', 'Добавь больше практики', 'Добавь пример из реальной работы слушателей', 'Сделай задание сложнее', 'Сократи теорию'];
  bg.innerHTML = `<div class="drawer"><div class="flex"><h2 style="margin:0;flex:1">Доработать тему</h2><button class="btn sm ghost" id="x">Закрыть</button></div>
    <p class="muted">${esc(name)}</p><p class="small muted">Агент перепишет только эту тему: содержание, задание и слайды. Часы и остальные темы останутся как есть, после правки программа перепроверится.</p>
    <div class="opts mt">${ideas.map(i => `<button class="opt">${esc(i)}</button>`).join('')}</div>
    <textarea id="instr" placeholder="Что поменять? Своими словами"></textarea>
    <div class="flex mt"><span class="sp"></span><button class="btn lime" id="ok">Доработать</button></div></div>`;
  document.body.append(bg);
  const close = () => bg.remove();
  bg.onclick = e => { if (e.target === bg) close(); };
  $('#x', bg).onclick = close;
  $$('.opt', bg).forEach(o => o.onclick = () => { $('#instr', bg).value = o.textContent; $('#instr', bg).focus(); });
  $('#ok', bg).onclick = async () => {
    const v = $('#instr', bg).value.trim(); if (!v) return toast('Напишите, что поменять', true);
    try { await api('POST', `/api/versions/${r.version_id}/topics/${topicId}/regenerate`, { instruction: v }); close(); viewProgram(r.id); } catch (e) { toast(e.message, true); }
  };
}

function viewHow() {
  view().innerHTML = `<div class="hero"><h1>Часы считает код, тексты пишет ИИ, решения принимаете вы</h1><p>Модель работает на этом ноутбуке через Ollama, данные не уходят наружу. Каждый шаг агента — отдельный навык с инструкцией, как на платформе GigaCowork.</p></div>
    ${howCards()}
    <h2 class="mt2">Что агент проверяет сам</h2>
    <div class="grid g3">
      <div class="card"><h3>Часы</h3><div class="muted small">Темы = модуль, модули + аттестация = объём, нагрузка в день, срок, доля практики, нули в стажировке.</div></div>
      <div class="card"><h3>Карта компетенций</h3><div class="muted small">Каждый результат раскрыт в теме и проверяется минимум двумя способами, у вопросов есть ключи.</div></div>
      <div class="card"><h3>Шаблон и нормативка</h3><div class="muted small">Все разделы заполнены, реквизиты пустые, профстандарты и литература помечены, если не подтверждены.</div></div>
      <div class="card"><h3>Образец</h3><div class="muted small">Ошибки в приложенной программе находятся и не переносятся. Текст образца не копируется.</div></div>
      <div class="card"><h3>Сервисы</h3><div class="muted small">Недоступные в России и устаревшие инструменты не попадают в программу.</div></div>
      <div class="card"><h3>Ожидания</h3><div class="muted small">Если заказчик ждёт больше, чем реально за эти часы, агент скажет об этом.</div></div>
    </div>`;
}

route();
