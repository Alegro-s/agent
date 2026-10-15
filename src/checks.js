'use strict';
const { q } = require('./db');

const fmt = n => String(Math.round(n * 10) / 10).replace('.', ',');

function sqlChecks(vid) {
  const out = [];
  const add = (rule, severity, entity_type, entity_id, message) => out.push({ rule, severity, entity_type, entity_id, message });
  const v = q.get(`SELECT v.*, p.kind, t.requires_standard FROM program_version v JOIN program p ON p.id=v.program_id
                   JOIN template t ON t.id=p.template_id WHERE v.id=?`, vid);

  for (const m of q.all('SELECT * FROM v_module_hours WHERE version_id=?', vid))
    if (Math.abs(m.total - m.planned_hours) > 1e-6)
      add('V01', 'error', 'module', m.module_id, `Модуль ${m.code}: по темам ${fmt(m.total)} ч, в утверждённом каркасе ${fmt(m.planned_hours)} ч.`);

  const vh = q.get('SELECT * FROM v_version_hours WHERE version_id=?', vid);
  if (Math.abs(vh.grand_total - vh.hours_requested) > 1e-6)
    add('V02', 'error', 'program_version', vid, `Итого ${fmt(vh.grand_total)} ч (модули ${fmt(vh.modules_total)} + аттестация ${fmt(vh.attestation_hours)}), а запрошено ${fmt(vh.hours_requested)} ч.`);

  if (v.kind === 'pk_internship')
    for (const t of q.all('SELECT t.* FROM topic t JOIN module m ON m.id=t.module_id WHERE m.version_id=? AND (t.lk+t.pr+t.lb)>0', vid))
      add('V03', 'error', 'topic', t.id, `Тема ${t.code}: в стажировке не может быть аудиторных часов (ЛК ${fmt(t.lk)}, ПР ${fmt(t.pr)}, ЛБ ${fmt(t.lb)}).`);

  if (v.max_hours_per_day)
    for (const d of q.all('SELECT day_no, SUM(hours) h FROM calendar_slot WHERE version_id=? GROUP BY day_no HAVING SUM(hours) > ?', vid, v.max_hours_per_day + 1e-9))
      add('V04', 'error', 'calendar_day', d.day_no, `День ${d.day_no}: ${fmt(d.h)} ч при лимите ${fmt(v.max_hours_per_day)} ч в день.`);
  const cal = q.get('SELECT COALESCE(SUM(hours),0) h, COALESCE(MAX(week_no),0) w, COUNT(DISTINCT day_no) d FROM calendar_slot WHERE version_id=?', vid);
  if (Math.abs(cal.h - v.hours_requested) > 1e-6)
    add('V04', 'error', 'program_version', vid, `В календарном графике ${fmt(cal.h)} ч, нужно ${fmt(v.hours_requested)} ч.`);
  if (v.duration_weeks) {
    const limit = v.duration_approx ? Math.ceil(v.duration_weeks * 1.15) : Math.ceil(v.duration_weeks);
    if (cal.w > limit) add('V04', 'error', 'program_version', vid, `График занимает ${cal.w} нед., а срок — ${v.duration_approx ? 'около ' : ''}${fmt(v.duration_weeks)} нед.`);
  }
  if (v.lesson_hours && v.lessons_per_week) {
    const bad = q.get('SELECT COUNT(*) n FROM (SELECT day_no, SUM(hours) h FROM calendar_slot WHERE version_id=? GROUP BY day_no) WHERE abs(h - ?) > 1e-6', vid, v.lesson_hours).n;
    if (bad) add('V04', 'warn', 'program_version', vid, `${bad} занят. не равны ${fmt(v.lesson_hours)} ч.`);
  }

  for (const c of q.all('SELECT c.* FROM competency c WHERE version_id=? AND NOT EXISTS (SELECT 1 FROM learning_outcome lo WHERE lo.competency_id=c.id)', vid))
    add('V05', 'error', 'competency', c.id, `Компетенция ${c.code} без результатов обучения.`);
  for (const o of q.all('SELECT * FROM v_outcome_coverage WHERE version_id=?', vid)) {
    if (o.topics === 0) add('V06', 'error', 'learning_outcome', o.outcome_id, `Результат ${o.competency}/${o.code} не раскрыт ни в одной теме.`);
    if (o.tools < 2) add('V07', 'error', 'learning_outcome', o.outcome_id, `Результат ${o.competency}/${o.code} проверяется ${o.tools} оценочным(и) средством(ами), нужно не меньше двух.`);
  }

  for (const x of q.all(`SELECT qq.id, qq.ord, t.title FROM test_question qq JOIN test t ON t.id=qq.test_id
       WHERE t.version_id=? AND qq.qtype IN ('single','multiple') AND NOT EXISTS (SELECT 1 FROM question_option o WHERE o.question_id=qq.id AND o.is_correct=1)`, vid))
    add('V08', 'error', 'test_question', x.id, `Вопрос ${x.ord} теста «${x.title}» без правильного ответа.`);
  for (const x of q.all(`SELECT qq.id, qq.ord, t.title FROM test_question qq JOIN test t ON t.id=qq.test_id
       WHERE t.version_id=? AND NOT EXISTS (SELECT 1 FROM question_outcome qo WHERE qo.question_id=qq.id)`, vid))
    add('V08', 'error', 'test_question', x.id, `Вопрос ${x.ord} теста «${x.title}» не привязан к результату обучения.`);

  const std = v.standard_id ? q.get('SELECT * FROM standard WHERE id=?', v.standard_id) : null;
  if (v.requires_standard) {
    if (!std) add('V09', 'error', 'program_version', vid, 'Программа повышения квалификации не связана с профессиональным стандартом.');
    else if (std.status !== 'verified') add('V09', 'warn', 'standard', std.id, `Профстандарт ${std.code} «${std.title}» не сверен с реестром Минтруда — проверьте код и реквизиты приказа (${std.order_ref}).`);
    for (const c of q.all(`SELECT c.*, sf.code fcode, sf.status fstatus FROM competency c LEFT JOIN standard_function sf ON sf.id=c.standard_function_id WHERE c.version_id=?`, vid)) {
      if (!c.standard_function_id) add('V09', 'warn', 'competency', c.id, `Компетенция ${c.code}: не указан код трудовой функции — выберите его из текста профстандарта${std ? ' ' + std.code : ''}.`);
      else if (c.fstatus !== 'verified') add('V09', 'warn', 'competency', c.id, `Компетенция ${c.code}: код ТФ ${c.fcode} не подтверждён по реестру.`);
    }
  } else {
    if (std || q.get('SELECT COUNT(*) n FROM competency WHERE version_id=? AND standard_function_id IS NOT NULL', vid).n)
      add('V09', 'error', 'program_version', vid, 'В общеразвивающей программе привязка к профстандарту не нужна.');
  }

  for (const s of q.all(`SELECT s.* FROM program_source ps JOIN source s ON s.id=ps.source_id WHERE ps.version_id=? AND s.status <> 'verified'`, vid))
    add('V10', 'warn', 'source', s.id, `Источник не подтверждён, в документе помечен: ${s.bibl_text.slice(0, 90)}`);

  for (const s of q.all(`SELECT ts.*, sc.body FROM template_section ts JOIN program p ON p.template_id=ts.template_id
       JOIN program_version v ON v.program_id=p.id LEFT JOIN section_content sc ON sc.version_id=v.id AND sc.section_code=ts.code
       WHERE v.id=?`, vid)) {
    const body = (s.body || '').trim();
    if (s.is_blank_field && body) add('V12', 'error', 'section', s.id, `Поле «${s.title}» должно остаться пустым для заполнения вручную.`);
    if (!s.is_blank_field && s.required && !body) add('V11', 'error', 'section', s.id, `Раздел ${s.code} «${s.title}» не заполнен.`);
  }

  for (const t of q.all(`SELECT t.* FROM topic t JOIN module m ON m.id=t.module_id
       WHERE m.version_id=? AND m.needs_slides=1 AND t.lk > 0
       AND NOT EXISTS (SELECT 1 FROM lecture_plan lp JOIN slide s ON s.lecture_plan_id=lp.id WHERE lp.topic_id=t.id)`, vid))
    add('V14', 'error', 'topic', t.id, `Тема ${t.code}: есть лекционные часы, но нет плана лекции и слайдов.`);

  if (v.min_practice_share) {
    const need = v.min_practice_share * v.hours_requested;
    if (vh.pr + vh.lb + 1e-9 < need)
      add('V16', 'error', 'program_version', vid, `Практика ${fmt(vh.pr + vh.lb)} ч, нужно не меньше ${fmt(need)} ч (${Math.round(v.min_practice_share * 100)}% объёма).`);
  }

  for (const t of q.all(`SELECT tr.* FROM program_tool pt JOIN tool_registry tr ON tr.id=pt.tool_id WHERE pt.version_id=? AND (tr.available_ru=0 OR tr.deprecated=1)`, vid))
    add('V17', 'error', 'tool', t.id, t.available_ru === 0 ? `${t.name} упомянут в программе, но ${t.note}.` : `${t.name}: ${t.note}.`);

  return out;
}

function shingles(text, n = 5) {
  const w = (text || '').toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, ' ').split(/\s+/).filter(Boolean);
  const s = new Set();
  for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' '));
  return s;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}
const norm = s => (s || '').toLowerCase().replace(/[«»"'.,:;()]/g, '').replace(/\s+/g, ' ').trim();

function codeChecks(vid) {
  const out = [];
  const add = (rule, severity, entity_type, entity_id, message) => out.push({ rule, severity, entity_type, entity_id, message });
  const v = q.get('SELECT v.*, p.request_id, p.kind FROM program_version v JOIN program p ON p.id=v.program_id WHERE v.id=?', vid);
  const req = q.get('SELECT * FROM request WHERE id=?', v.request_id);
  const params = JSON.parse(req?.params || '{}');
  const topics = q.all('SELECT t.*, m.title mtitle FROM topic t JOIN module m ON m.id=t.module_id WHERE m.version_id=? ORDER BY m.ord, t.ord', vid);

  for (const f of q.all("SELECT * FROM request_file WHERE request_id=? AND role='reference'", v.request_id)) {
    const ref = shingles(f.extracted_text);
    const texts = [...topics.map(t => [t.code, t.content]), ...q.all('SELECT section_code, body FROM section_content WHERE version_id=?', vid).map(s => [s.section_code, s.body])];
    for (const [code, txt] of texts) {
      const sim = jaccard(shingles(txt), ref);
      if (sim >= 0.3) add('V13', 'warn', 'text', null, `Фрагмент ${code} совпадает с приложенной программой на ${Math.round(sim * 100)}% — перепишите своими словами.`);
    }
    const st = JSON.parse(f.structure || '{}');
    for (const m of st.issues || []) add('V15', 'info', 'reference_file', f.id, `В приложенном образце «${f.filename}»: ${m} В новой программе ошибка не повторена: итоги считаются из строк.`);
  }

  const hay = norm(q.all('SELECT title FROM module WHERE version_id=?', vid).map(m => m.title).join(' | ') + ' | ' + topics.map(t => t.title).join(' | '));
  for (const rt of params.required_topics || []) {
    const key = norm(rt).split(' ').filter(w => w.length > 2).map(w => w.slice(0, Math.max(4, w.length - 2)));
    if (key.length && !key.some(k => hay.includes(k))) add('V19', 'error', 'program_version', vid, `Тема из запроса «${rt}» не найдена в учебном плане.`);
  }

  const seen = new Map();
  for (const t of topics) {
    const k = norm(t.title);
    if (seen.has(k)) add('V20', 'warn', 'topic', t.id, `Тема ${t.code} повторяет тему ${seen.get(k)}: «${t.title}».`);
    else seen.set(k, t.code);
  }

  const exp = (params.customer_expectation || '') + ' ' + (req?.raw_text || '');
  if (/работать|трудоустро|специалист[а-я]* с нуля|пойти работать|стать (специалист|инженер|разработчик)/i.test(exp) && v.hours_requested < 250)
    add('V18', 'info', 'program_version', vid, `Заказчик ожидает, что слушатели после курса смогут работать в профессии. За ${fmt(v.hours_requested)} ч реалистичен начальный уровень: результаты обучения сформулированы именно так. Для самостоятельной работы специалистом обычно нужна профессиональная переподготовка (от 250 ч) и практика — это стоит обсудить с заказчиком.`);
  return out;
}

const ORDER = { error: 0, warn: 1, info: 2 };
function runChecks(vid) {
  const issues = [...sqlChecks(vid), ...codeChecks(vid)].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.rule.localeCompare(b.rule));
  const passed = !issues.some(i => i.severity === 'error');
  const run = q.id('INSERT INTO check_run (version_id, passed) VALUES (?,?)', vid, passed ? 1 : 0);
  for (const i of issues) q.run('INSERT INTO check_issue (run_id, rule_code, severity, entity_type, entity_id, message) VALUES (?,?,?,?,?,?)', run, i.rule, i.severity, i.entity_type, i.entity_id ?? null, i.message);
  return { runId: run, passed, issues };
}

module.exports = { runChecks, sqlChecks, codeChecks, shingles, jaccard };
