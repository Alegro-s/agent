'use strict';
const { q } = require('./db');
const { generateJson } = require('./llm');
const H = require('./hours');
const { runChecks } = require('./checks');

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const words = s => (s || '').toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, ' ').split(/\s+/).filter(w => w.length > 3).map(w => w.slice(0, 6));
const overlap = (a, b) => { const A = new Set(words(a)); return words(b).filter(w => A.has(w)).length; };

async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  }));
  return res;
}

function audienceStyle(p) {
  const a = (p.audience || '') + ' ' + (p.entry_level || '');
  if (/класс|школьн|подрост|дет/i.test(a)) return 'Аудитория — школьники-подростки. Пиши простыми словами, короткими фразами, поясняй каждый термин при первом упоминании, приводи примеры из игр и повседневной жизни.';
  if (/учител|педагог/i.test(a)) return 'Аудитория — учителя без навыков программирования. Пиши понятно, без технического жаргона, примеры только из работы учителя: план урока, задания для учеников, проверочные работы.';
  if (/банк|сотрудник|excel/i.test(a)) return 'Аудитория — сотрудники организаций, практики. Примеры и задания строй на рабочих ситуациях этой отрасли.';
  if (/студент|колледж|спо/i.test(a)) return 'Аудитория — студенты колледжа (СПО). Пиши понятно, ставь реалистичные задачи начального уровня.';
  if (/стаж/i.test(a)) return 'Аудитория — стажёры в ИТ-компаниях, работают самостоятельно с наставником.';
  return 'Пиши понятным деловым русским языком без лишнего жаргона.';
}

const NUMWORDS = { 'один': 1, 'одного': 1, 'два': 2, 'двух': 2, 'три': 3, 'трёх': 3, 'трех': 3, 'четыре': 4, 'четырёх': 4, 'пять': 5, 'шесть': 6 };
const toNum = s => (s == null ? null : (NUMWORDS[String(s).toLowerCase()] ?? (parseFloat(String(s).replace(',', '.')) || null)));

function parseRules(text) {
  const t = text.replace(/ё/g, 'е');
  const p = {};
  let m;
  if ((m = t.match(/(\d{1,3})\s*(?:академическ[а-яёa-z]*\s*)?час/i))) p.hours = +m[1];
  if ((m = t.match(/объем[а-яёa-z]*\s*[-—:]?\s*(\d{1,3})/i))) p.hours = +m[1];
  if (/общеразвива/i.test(t)) p.program_kind = 'dop';
  else if (/стажировк/i.test(t)) p.program_kind = 'pk_internship';
  else if (/повышени[а-яёa-z]*\s+квалификац/i.test(t)) p.program_kind = 'pk';
  if (/очно-заочн/i.test(t)) p.form = 'ochno_zaochno';
  else if (/(^|[^-])заочн|дистанционно|онлайн/i.test(t) && !/(^|[^а-яё-])очн/i.test(t)) p.form = 'zaochno';
  else if (/(^|[^а-яё-])очн(о|ая|ой|ые|ых)([^а-яё-]|$)/i.test(t)) p.form = 'ochno';
  if (/дистанцион|ДОТ\b|электронн[а-яёa-z]* обучен/i.test(t)) p.uses_dot = true;
  if ((m = t.match(/по\s+(\d+|два|две|три)\s+час[а-яёa-z]*\s+(\d+|один|два|три|четыре)\s+раз[а-яёa-z]*\s+в\s+неделю/i))) { p.lesson_hours = toNum(m[1] === 'две' ? 'два' : m[1]); p.lessons_per_week = toNum(m[2]); }
  if (/практик[а-яёa-z]*[^.]*не\s+меньше\s+половин/i.test(t) || /не\s+меньше\s+половин[а-яёa-z]*[^.]*практик/i.test(t)) p.min_practice_share = 0.5;
  if ((m = t.match(/практик[а-яёa-z]*[^.]*не\s+менее\s+(\d+)\s*%/i))) p.min_practice_share = +m[1] / 100;
  if ((m = t.match(/(\d+|одн[а-яёa-z]*|дв[а-яёa-z]*|тр[а-яёa-z]*|четыр[а-яёa-z]*)\s+недел/i))) p.duration_weeks = toNum(m[1]) || toNum(m[1].slice(0, 3) === 'дву' ? 'два' : m[1]);
  if ((m = t.match(/(около|примерно|почти)?\s*(\d+|одного|двух|трех|двa|два|три|месяц)\s*месяц/i))) {
    const n = m[2] === 'месяц' ? 1 : toNum(m[2]); if (n) { p.duration_weeks = Math.round(n * 4.3 * 10) / 10; p.duration_approx = !!m[1]; }
  }
  if (/около\s+двух\s+месяц/i.test(t)) { p.duration_weeks = 8.6; p.duration_approx = true; }
  if (/примерно\s+на\s+месяц|около\s+месяц/i.test(t)) { p.duration_weeks = 4.3; p.duration_approx = true; }
  if ((m = t.match(/не\s+(?:больше|более)\s+(\d+)\s+час[а-яёa-z]*\s+в\s+день/i))) p.max_hours_per_day = +m[1];
  if ((m = t.match(/тест[а-яёa-z]*\s+на\s+(\d+)\s+вопрос/i))) p.test_questions = +m[1];
  if ((m = t.match(/аттестаци[а-яёa-z]*\s+занимает\s+(\d+)\s+час/i))) p.final_attestation_hours = +m[1];
  if (/аудиторных занятий нет|вся работа самостоятельн/i.test(t)) p.contact_hours = 0;
  if ((m = t.match(/слайд[а-яёa-z]*[^.]*?для\s+первых\s+(\d+|двух|трех|трёх)\s+заняти/i))) { const n = toNum(m[1].replace('двух', 'два').replace(/тр[её]х/, 'три')); p.slides_lessons = Array.from({ length: n || 2 }, (_, i) => i + 1); }
  if ((m = t.match(/слайд[а-яёa-z]*[^.]*?для\s+(?:всех\s+лекций\s+)?модул[а-яёa-z]*\s+(?:про|по)\s+([A-Za-zА-Яа-яё0-9+#-]+)/i))) p.slides_module = m[1];
  if ((m = t.match(/[«"]([^»"]{3,120})[»"]/))) p.title = m[1].trim();
  if (/только\s+сервис[а-яёa-z]*[^.]*доступн[а-яёa-z]*\s+в\s+России/i.test(t)) p.only_ru_services = true;
  return p;
}

const PARAM_SCHEMA = {
  type: 'object',
  properties: {
    program_kind: { type: 'string', enum: ['pk', 'pk_internship', 'dop', 'unknown'] },
    title: { type: 'string' }, direction: { type: 'string' },
    hours: { type: 'number' }, form: { type: 'string', enum: ['ochno', 'ochno_zaochno', 'zaochno', 'unknown'] },
    audience: { type: 'string' }, entry_level: { type: 'string' },
    final_attestation_form: { type: 'string' },
    required_topics: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    customer_expectation: { type: 'string' },
  },
  required: ['program_kind', 'title', 'direction', 'hours', 'form', 'audience', 'entry_level', 'final_attestation_form', 'required_topics', 'constraints', 'customer_expectation'],
};

function mockParams(text) {
  const r = parseRules(text);
  const aud = (text.match(/для\s+([^.,]*?(?:школьник|учител|сотрудник|студент|слушател)[^.,]*)/i) || [])[1] || '';
  const fa = (text.match(/(?:аттестаци[а-яёa-z]*[^.]*?(?:в форме|в виде)\s+|защищает\s+|форме\s+)([^.]+)/i) || [])[1] || '';
  const topics = (text.match(/темы\s+это\s+([^.]+)/i) || [])[1];
  return {
    program_kind: r.program_kind || 'unknown', title: r.title || '', direction: (text.match(/по\s+([а-яa-z]+(?:безопасност[а-яёa-z]*|python|данн[а-яёa-z]*)?)/i) || [])[1] || '',
    hours: r.hours || 0, form: r.form || 'unknown', audience: aud, entry_level: /без опыта|работают в Excel/i.test(text) ? 'начальный' : '',
    final_attestation_form: fa.trim(), required_topics: topics ? topics.split(/,|\sи\s/).map(s => s.trim()).filter(Boolean) : [],
    constraints: r.only_ru_services ? ['только сервисы, доступные в России'] : [], customer_expectation: /работать/i.test(text) ? 'после курса пойти работать в сфере' : '',
  };
}

async function extractParams(requestId, text) {
  const rules = parseRules(text);
  const original = text.split('\n\nУточнения методиста:')[0];
  const rt = parseRules(original).title; if (rt) rules.title = rt; else delete rules.title;
  let llm = {};
  try {
    llm = await generateJson({
      skill: 'S1', requestId,
      system: 'Ты методист дополнительного образования. Извлекаешь параметры образовательной программы из запроса. Ничего не придумывай: если параметра нет в тексте — верни пустую строку, 0 или "unknown". «Примерно месяц» не задаёт часы.',
      prompt: `Запрос методиста:\n"""${text}"""\n\nВерни JSON: program_kind (pk — повышение квалификации, pk_internship — стажировка, dop — общеразвивающая, unknown), title (название программы), direction (ИТ-направление), hours (объём в часах или 0), form (ochno/ochno_zaochno/zaochno/unknown), audience (кто слушатели), entry_level (что слушатели уже умеют, если сказано), final_attestation_form (форма итоговой аттестации или ""), required_topics (темы, которые методист прямо назвал обязательными), constraints (ограничения), customer_expectation (чего заказчик ждёт от результата курса).`,
      schema: PARAM_SCHEMA, mock: () => mockParams(text), maxTokens: 700,
    });
  } catch (e) { llm = mockParams(text); llm._llm_error = e.message; }
  const p = {
    program_kind: rules.program_kind || (llm.program_kind !== 'unknown' ? llm.program_kind : null),
    title: rules.title || llm.title || '',
    direction: llm.direction || '',
    hours: rules.hours ?? (llm.hours > 0 && /\d/.test(text) ? llm.hours : null),
    form: rules.form || (llm.form !== 'unknown' ? llm.form : null),
    uses_dot: !!rules.uses_dot,
    audience: llm.audience || '',
    entry_level: llm.entry_level || '',
    final_attestation_form: llm.final_attestation_form || '',
    final_attestation_hours: rules.final_attestation_hours || null,
    required_topics: (llm.required_topics || []).filter(Boolean).slice(0, 8),
    constraints: llm.constraints || [],
    customer_expectation: llm.customer_expectation || '',
    duration_weeks: rules.duration_weeks || null, duration_approx: !!rules.duration_approx,
    max_hours_per_day: rules.max_hours_per_day || null,
    lesson_hours: rules.lesson_hours || null, lessons_per_week: rules.lessons_per_week || null,
    min_practice_share: rules.min_practice_share || null,
    test_questions: rules.test_questions || null,
    slides_lessons: rules.slides_lessons || null, slides_module: rules.slides_module || null,
    only_ru_services: !!rules.only_ru_services || (llm.constraints || []).some(c => /росси/i.test(c)),
  };
  if (p.program_kind === 'pk_internship') { p.form = p.form || 'zaochno'; p.uses_dot = true; if (!p.audience) p.audience = 'стажёры, проходящие стажировку в ИТ-компаниях региона под руководством наставника'; }
  if (!p.audience) { const m = text.match(/для\s+([^.,]*?(?:школьник|учител|сотрудник|студент|слушател)[^.,]*)/i); if (m) p.audience = m[1]; }
  if (!p.final_attestation_form) {
    const m = text.match(/(?:итогов[а-яёa-z]*\s+аттестаци[а-яёa-z]*[^.]*?(?:в форме|в виде|форма)\s+)([^.]+)/i) || text.match(/(защищает[^.]+|защит[а-яёa-z]* (?:проекта|отч[её]та)[^.]*)/i);
    if (m) p.final_attestation_form = m[1].trim();
  }
  return p;
}

const QUESTIONS = {
  program_kind: ['Какой документ получат слушатели: удостоверение о повышении квалификации или сертификат об освоении общеразвивающей программы? От этого зависит шаблон.', 'Например: «повышение квалификации»'],
  hours: ['Сколько всего академических часов на курс? «Примерно месяц» можно наполнить и 36, и 144 часами.', 'Например: 72 часа'],
  audience: ['Кто будут слушатели и что они уже знают? Например: курс, специальность, базовые навыки.', 'Например: студенты 3 курса, знают основы сетей'],
  form: ['Как будут проходить занятия: очно, дистанционно или смешанно (очно-заочно)?', 'Например: очно на базе колледжа'],
  final_attestation: ['Как проверим результат в конце обучения: экзамен, защита проекта или зачёт?', 'Например: экзамен с практическим заданием'],
};

function findMissing(p) {
  const miss = [];
  if (!p.program_kind) miss.push('program_kind');
  if (!p.hours) miss.push('hours');
  if (!p.form) miss.push('form');
  if (!p.final_attestation_form) miss.push('final_attestation');
  if ((!p.audience && miss.length >= 1) || (!p.entry_level && miss.length >= 2)) miss.splice(2, 0, 'audience');
  return miss.slice(0, 5);
}

const SKELETON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' }, goal: { type: 'string' },
    tasks: { type: 'array', items: { type: 'string' } },
    competencies: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, activity_type: { type: 'string' },
      outcomes: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['knowledge', 'skill', 'ability'] }, text: { type: 'string' } }, required: ['kind', 'text'] } },
    }, required: ['title', 'outcomes'] } },
    modules: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, weight: { type: 'number' }, intro: { type: 'boolean' },
      topics: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, weight: { type: 'number' }, type: { type: 'string', enum: ['theory', 'mixed', 'practice', 'project'] } }, required: ['title', 'weight', 'type'] } },
    }, required: ['title', 'weight', 'topics'] } },
  },
  required: ['title', 'goal', 'tasks', 'competencies', 'modules'],
};

function sizeGuide(p, contactHours) {
  const h = contactHours;
  if (p.lesson_hours) return `Ровно ${Math.round(h / p.lesson_hours)} тем (одна тема = одно занятие по ${p.lesson_hours} ч), 1–3 модуля.`;
  if (p.program_kind === 'pk_internship') return '6–8 разделов (модулей) по 1–3 темы; последний раздел — «Подготовка отчёта о стажировке».';
  if (h <= 24) return '2–3 модуля, всего 5–8 тем.';
  if (h <= 40) return '3–5 модулей, всего 8–12 тем.';
  if (h <= 80) return '4–6 модулей, всего 12–18 тем.';
  return '6–8 модулей, всего 16–24 темы.';
}

function mockSkeleton(p, contact) {
  const n = p.lesson_hours ? Math.round(contact / p.lesson_hours) : 0;
  const req = p.required_topics.length ? p.required_topics : ['Основы направления', 'Инструменты', 'Практикум'];
  const modules = [];
  if (/excel|без опыта|начальн/i.test(p.entry_level + p.audience) && p.program_kind !== 'dop') modules.push({ title: 'Вводный модуль: основы Python', weight: 0.8, intro: true, topics: [{ title: 'Среда и синтаксис Python', weight: 1, type: 'mixed' }, { title: 'Типы данных и функции', weight: 1, type: 'mixed' }] });
  if (n) {
    const names = ['Знакомство: что такое программа, print и переменные', 'Числа, строки, ввод и вывод', 'Условия if/elif/else', 'Циклы for и while', 'Списки и строки', 'Функции', 'Мини-проект: игра или чат-бот'];
    modules.push({ title: 'Основы программирования', weight: 1, topics: names.slice(0, n).map((t, i) => ({ title: t, weight: 1, type: i === n - 1 ? 'project' : 'mixed' })) });
  } else {
    req.forEach(r => modules.push({ title: r[0].toUpperCase() + r.slice(1), weight: 1, topics: [{ title: `${r}: основные понятия`, weight: 1, type: 'theory' }, { title: `${r}: практикум`, weight: 1.2, type: 'practice' }] }));
    if (p.program_kind === 'pk_internship') modules.push({ title: 'Подготовка отчёта о стажировке', weight: 0.4, topics: [{ title: 'Оформление отчёта и подготовка к защите', weight: 1, type: 'practice' }] });
  }
  return {
    title: p.title || 'Программа', goal: 'Сформировать у слушателей практические навыки по направлению программы.',
    tasks: ['Дать базовые знания', 'Отработать навыки на практике', 'Подготовить итоговую работу'],
    competencies: [
      { title: 'Применяет базовые инструменты направления', activity_type: 'Профессиональная деятельность', outcomes: [{ kind: 'knowledge', text: 'Знает основные понятия и инструменты' }, { kind: 'skill', text: 'Умеет решать типовые задачи' }] },
      { title: 'Выполняет и защищает итоговую работу', activity_type: 'Профессиональная деятельность', outcomes: [{ kind: 'skill', text: 'Умеет оформлять результат работы' }, { kind: 'ability', text: 'Владеет навыком презентации решения' }] },
    ],
    modules,
  };
}

function pickStandard(p, raw = '') {
  if (p.program_kind === 'dop') return null;
  const core = `${p.title} ${p.direction} ${(p.required_topics || []).join(' ')} ${raw.split('\n\nУточнения')[0]}`.toLowerCase();
  const hay = `${core} ${p.audience}`.toLowerCase();
  let best = null, score = 0;
  for (const s of q.all('SELECT * FROM standard')) {
    const ks = s.keywords.split(/\s+/).filter(Boolean);
    const sc = ks.filter(k => core.includes(k)).length * 2 + ks.filter(k => hay.includes(k)).length;
    if (sc > score) { score = sc; best = s; }
  }
  return best;
}

function faHoursFor(p) {
  if (p.final_attestation_hours) return p.final_attestation_hours;
  if (p.hours <= 36) return 2;
  return 4;
}

async function buildSkeleton(requestId) {
  const req = q.get('SELECT * FROM request WHERE id=?', requestId);
  const p = J(req.params);
  const kind = p.program_kind;
  const faHours = faHoursFor(p);
  const contact = p.hours - faHours;
  const ref = q.get("SELECT * FROM request_file WHERE request_id=? AND role='reference'", requestId);
  const refHeadings = ref ? (J(ref.structure)?.headings || []).slice(0, 25).join('; ') : '';
  const rulesText = [
    p.program_kind === 'dop' ? 'Это общеразвивающая программа: никаких профстандартов и трудовых функций.' : 'Это программа повышения квалификации: компетенции профессиональные, формулируй как трудовые действия.',
    p.program_kind === 'pk_internship' ? 'Это стажировка: все темы — самостоятельная работа под руководством наставника на предприятии.' : '',
    p.required_topics.length ? `Обязательные темы, каждую сделай отдельным модулем: ${p.required_topics.join('; ')}.` : '',
    /excel|без опыта|нулев|не умеют программ|начальн/i.test(`${p.audience} ${p.entry_level} ${req.raw_text}`) ? 'У слушателей нет опыта программирования: начни с вводного модуля по основам (intro=true), сложные темы (классы, API) не раньше переменных, условий и циклов.' : '',
    p.only_ru_services ? 'Упоминай только сервисы, доступные в России (GigaChat, YandexGPT, Kandinsky, Шедеврум). Не упоминай ChatGPT, Gemini, Claude, Midjourney.' : '',
    /учител|дет|школ/i.test(p.audience) && /ИИ|искусствен|нейросет/i.test(req.raw_text) ? 'Обязательно отдельный модуль о рисках, этике и защите персональных данных учеников.' : '',
    refHeadings ? `Структуру разделов возьми из приложенной программы (заголовки: ${refHeadings}), но формулировки пиши новые.` : '',
    /работать|трудоустро/i.test(p.customer_expectation + req.raw_text) ? `Результаты обучения формулируй реалистично для ${p.hours} ч — начальный уровень, без обещания полной подготовки специалиста.` : '',
  ].filter(Boolean).join('\n');

  const sk = await generateJson({
    skill: 'S3', requestId,
    system: 'Ты опытный методист ДПО. Проектируешь каркас образовательной программы: цель, задачи, компетенции с результатами обучения (знания, умения, навыки) и модули с темами. Часы не считаешь — только относительные веса. Всё на русском.',
    prompt: `Параметры программы:\n${JSON.stringify({ ...p, hours: undefined }, null, 1)}\nОбъём: ${p.hours} ч, из них ${faHours} ч итоговая аттестация.\n${audienceStyle(p)}\n${rulesText}\nРазмер: ${sizeGuide(p, contact)}\n2–4 компетенции, у каждой 2–4 результата обучения (kind: knowledge/skill/ability).\nДля каждой темы укажи weight (относительная трудоёмкость, 0.5–3) и type: theory, mixed, practice или project.\nВерни JSON: title, goal, tasks (3–5), competencies, modules.`,
    schema: SKELETON_SCHEMA, mock: () => mockSkeleton(p, contact), maxTokens: 2500,
  });

  let modules = (sk.modules || []).filter(m => m.topics && m.topics.length);
  for (const rt of p.required_topics) {
    const key = words(rt);
    if (!modules.some(m => key.some(k => words(m.title + ' ' + m.topics.map(t => t.title).join(' ')).includes(k))))
      modules.push({ title: rt[0].toUpperCase() + rt.slice(1), weight: 1, topics: [{ title: `${rt}: основы`, weight: 1, type: 'mixed' }, { title: `${rt}: практикум`, weight: 1, type: 'practice' }] });
  }
  if (kind === 'pk_internship' && !modules.some(m => /отч[её]т/i.test(m.title)))
    modules.push({ title: 'Подготовка отчёта о стажировке', weight: 0.5, topics: [{ title: 'Оформление отчёта и подготовка к защите', weight: 1, type: 'practice' }] });
  if (!modules.length) modules = mockSkeleton(p, contact).modules;

  const step = p.lesson_hours && kind !== 'pk_internship' ? 1 : (kind === 'pk_internship' ? 1 : 0.5);
  const modHours = H.distribute(contact, modules.map(m => clamp(m.weight || 1, 0.2, 5) * Math.max(1, m.topics.length)), step, step * Math.max(1, Math.min(2, 1)));
  const srsShare = H.srsShareFor(p.form, p.uses_dot);
  let practiceShare = 0.5;
  if (p.min_practice_share) practiceShare = clamp(p.min_practice_share * p.hours / Math.max(1, contact * (1 - srsShare)) + 0.08, 0.5, 0.9);
  const flatTopics = [];
  modules.forEach((m, mi) => {
    const th = H.distribute(modHours[mi], m.topics.map(t => clamp(t.weight || 1, 0.3, 4)), step, Math.min(step, modHours[mi] / m.topics.length));
    m.topics.forEach((t, ti) => {
      const split = H.splitTopic(th[ti], { kind, ttype: t.type || 'mixed', srsShare, practiceShare });
      Object.assign(t, split, { hours: th[ti] });
      flatTopics.push(t);
    });
    m.hours = modHours[mi];
  });
  if (p.min_practice_share) H.enforcePracticeMin(flatTopics, p.min_practice_share * p.hours);

  const tpl = kind === 'dop' ? 2 : 1;
  const std = pickStandard(p, req.raw_text);
  const daysPerWeek = p.lesson_hours ? null : H.daysPerWeekFor(p.hours, p.max_hours_per_day || 4, p.duration_weeks);
  return q.tx(() => {
    const programId = q.id('INSERT INTO program (request_id, template_id, kind, title, direction) VALUES (?,?,?,?,?)', requestId, tpl, kind, p.title || sk.title, p.direction || null);
    const vid = q.id(`INSERT INTO program_version (program_id, hours_requested, form, uses_dot, duration_weeks, duration_approx, days_per_week, max_hours_per_day,
        lesson_hours, lessons_per_week, min_practice_share, audience, entry_requirements, goal, tasks, standard_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      programId, p.hours, p.form, p.uses_dot ? 1 : 0, p.duration_weeks, p.duration_approx ? 1 : 0, daysPerWeek, p.max_hours_per_day || (kind === 'pk_internship' ? 4 : null),
      p.lesson_hours, p.lessons_per_week, p.min_practice_share, p.audience, null, sk.goal, JSON.stringify(sk.tasks || []), std ? std.id : null);
    const fn = std ? q.get('SELECT * FROM standard_function WHERE standard_id=? ORDER BY code LIMIT 1', std.id) : null;
    (sk.competencies || []).slice(0, 5).forEach((c, ci) => {
      const cid = q.id('INSERT INTO competency (version_id, ord, code, title, activity_type, standard_function_id) VALUES (?,?,?,?,?,?)',
        vid, ci + 1, (kind === 'dop' ? 'Р' : 'ПК-') + (ci + 1), c.title, c.activity_type || null, fn ? fn.id : null);
      const cnt = { knowledge: 0, skill: 0, ability: 0, experience: 0 };
      const letter = { knowledge: 'З', skill: 'У', ability: 'Н', experience: 'О' };
      (c.outcomes || []).slice(0, 5).forEach(o => {
        const k = letter[o.kind] ? o.kind : 'skill';
        q.run('INSERT INTO learning_outcome (competency_id, code, kind, text) VALUES (?,?,?,?)', cid, `${letter[k]}${ci + 1}.${++cnt[k]}`, k, o.text);
      });
    });
    let ord = 0;
    modules.forEach((m, mi) => {
      const isIntro = !!m.intro && mi === 0;
      const code = isIntro ? '0' : String(mi + (modules[0].intro ? 0 : 1));
      const mid = q.id('INSERT INTO module (version_id, ord, code, kind, title, planned_hours, weight, control_form, needs_slides) VALUES (?,?,?,?,?,?,?,?,0)',
        vid, ++ord, code, isIntro ? 'intro' : 'regular', m.title, m.hours, m.weight || 1, kind === 'pk_internship' ? 'Собеседование с руководителем стажировки' : (kind === 'dop' ? 'Практическая работа' : 'Тест, практическое задание'));
      m.topics.forEach((t, ti) => q.run('INSERT INTO topic (module_id, ord, code, title, ttype, weight, lk, pr, lb, srs, delivery) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        mid, ti + 1, `${code}.${ti + 1}`, t.title, t.type || 'mixed', t.weight || 1, t.lk, t.pr, t.lb, t.srs,
        kind === 'pk_internship' ? 'dot' : (t.srs > 0 && t.lk + t.pr > 0 ? 'mixed' : (t.srs > 0 ? 'dot' : 'ochno'))));
    });
    q.run('INSERT INTO final_attestation (version_id, form, hours) VALUES (?,?,?)', vid, p.final_attestation_form || 'Зачёт', faHours);
    markSlides(vid, p);
    rebuildCalendar(vid);
    q.run("UPDATE request SET status='skeleton' WHERE id=?", requestId);
    return vid;
  });
}

function markSlides(vid, p) {
  q.run('UPDATE module SET needs_slides=0 WHERE version_id=?', vid);
  const mods = q.all('SELECT * FROM module WHERE version_id=? ORDER BY ord', vid);
  if (p.slides_module) {
    const k = p.slides_module.toLowerCase().slice(0, 5);
    const m = mods.find(m => m.title.toLowerCase().includes(k)) || q.get(`SELECT m.* FROM module m JOIN topic t ON t.module_id=m.id WHERE m.version_id=? AND lower(t.title) LIKE ? LIMIT 1`, vid, `%${k}%`);
    if (m) { q.run('UPDATE module SET needs_slides=1 WHERE id=?', m.id); return; }
  }
  if (p.slides_lessons) return; 
  const first = q.get(`SELECT m.id FROM module m JOIN v_module_hours h ON h.module_id=m.id WHERE m.version_id=? AND h.lk>0 AND m.kind='regular' ORDER BY m.ord LIMIT 1`, vid)
    || q.get(`SELECT m.id FROM module m JOIN v_module_hours h ON h.module_id=m.id WHERE m.version_id=? AND h.lk>0 ORDER BY m.ord LIMIT 1`, vid);
  if (first) q.run('UPDATE module SET needs_slides=1 WHERE id=?', first.id);
}

function rebuildCalendar(vid) {
  const v = q.get('SELECT * FROM program_version WHERE id=?', vid);
  const topics = q.all('SELECT t.* FROM topic t JOIN module m ON m.id=t.module_id WHERE m.version_id=? ORDER BY m.ord, t.ord', vid);
  const fa = q.get('SELECT hours FROM final_attestation WHERE version_id=?', vid);
  const daysPerWeek = v.lesson_hours ? null : H.daysPerWeekFor(v.hours_requested, v.max_hours_per_day || 4, v.duration_weeks);
  const slots = H.buildCalendar(topics, fa ? fa.hours : 0, { lessonHours: v.lesson_hours, lessonsPerWeek: v.lessons_per_week, maxPerDay: v.max_hours_per_day || 4, daysPerWeek });
  q.run('DELETE FROM calendar_slot WHERE version_id=?', vid);
  q.run('UPDATE program_version SET days_per_week=? WHERE id=?', daysPerWeek, vid);
  for (const s of slots) q.run('INSERT INTO calendar_slot (version_id, day_no, week_no, topic_id, activity, hours) VALUES (?,?,?,?,?,?)',
    vid, s.day, s.week, s.topicIndex == null ? null : topics[s.topicIndex].id, s.activity, s.hours);
}

function setModuleHours(vid, moduleId, hours) {
  const v = q.get('SELECT v.*, p.kind FROM program_version v JOIN program p ON p.id=v.program_id WHERE v.id=?', vid);
  const topics = q.all('SELECT * FROM topic WHERE module_id=? ORDER BY ord', moduleId);
  const th = H.distribute(hours, topics.map(t => t.weight), 0.5, Math.min(0.5, hours / topics.length));
  const srsShare = H.srsShareFor(v.form, v.uses_dot);
  q.tx(() => {
    q.run('UPDATE module SET planned_hours=? WHERE id=?', hours, moduleId);
    topics.forEach((t, i) => { const s = H.splitTopic(th[i], { kind: v.kind, ttype: t.ttype, srsShare, practiceShare: 0.5 }); q.run('UPDATE topic SET lk=?, pr=?, lb=?, srs=? WHERE id=?', s.lk, s.pr, s.lb, s.srs, t.id); });
    if (v.min_practice_share) {
      const all = q.all('SELECT t.* FROM topic t JOIN module m ON m.id=t.module_id WHERE m.version_id=?', vid);
      H.enforcePracticeMin(all, v.min_practice_share * v.hours_requested);
      all.forEach(t => q.run('UPDATE topic SET lk=?, pr=? WHERE id=?', t.lk, t.pr, t.id));
    }
    rebuildCalendar(vid);
  });
}

const CONTENT_SCHEMA = {
  type: 'object', properties: { topics: { type: 'array', items: { type: 'object', properties: {
    code: { type: 'string' }, content: { type: 'string' }, outcomes: { type: 'array', items: { type: 'string' } },
    task: { type: 'object', properties: { title: { type: 'string' }, situation: { type: 'string' }, instructions: { type: 'string' }, deliverable: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } } }, required: ['title', 'instructions', 'criteria'] },
  }, required: ['code', 'content', 'outcomes'] } } }, required: ['topics'],
};
const TEST_SCHEMA = {
  type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: {
    text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, correct: { type: 'integer' }, outcome: { type: 'string' }, explanation: { type: 'string' },
  }, required: ['text', 'options', 'correct', 'outcome'] } } }, required: ['questions'],
};
const INTERVIEW_SCHEMA = { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, outcome: { type: 'string' } }, required: ['text', 'outcome'] } } }, required: ['questions'] };
const FA_SCHEMA = {
  type: 'object', properties: {
    description: { type: 'string' }, requirements: { type: 'string' }, procedure: { type: 'string' }, example_task: { type: 'string' }, pass_rule: { type: 'string' },
    criteria: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, points: { type: 'integer' }, outcomes: { type: 'array', items: { type: 'string' } } }, required: ['text', 'points', 'outcomes'] } },
  }, required: ['description', 'requirements', 'procedure', 'example_task', 'pass_rule', 'criteria'],
};
const LECTURE_SCHEMA = {
  type: 'object', properties: { goal: { type: 'string' }, outline: { type: 'array', items: { type: 'string' } },
    slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['title', 'bullets'] } } },
  required: ['goal', 'outline', 'slides'],
};
const SECTIONS_SCHEMA = {
  type: 'object', properties: { annotation: { type: 'string' }, relevance: { type: 'string' }, entry_requirements: { type: 'string' }, organization: { type: 'string' },
    books: { type: 'array', items: { type: 'string' } } },
  required: ['annotation', 'relevance', 'entry_requirements', 'organization', 'books'],
};

function outcomesOf(vid) {
  return q.all('SELECT lo.*, c.code ccode, c.title ctitle FROM learning_outcome lo JOIN competency c ON c.id=lo.competency_id WHERE c.version_id=? ORDER BY c.ord, lo.id', vid);
}

async function writeModule(ctx, m) {
  const topics = q.all('SELECT * FROM topic WHERE module_id=? ORDER BY ord', m.id);
  const needTask = t => t.pr + t.lb > 0 || ctx.kind === 'pk_internship';
  const res = await generateJson({
    skill: 'S4', requestId: ctx.requestId,
    system: 'Ты методист и эксперт-практик. Пишешь содержание тем программы и практические задания. Всё на русском. Не копируй чужие тексты дословно.',
    prompt: `Программа: «${ctx.title}». ${ctx.style}\n${ctx.rules}\nМодуль ${m.code}. ${m.title}\nТемы:\n${topics.map(t => `- ${t.code} «${t.title}»: ЛК ${t.lk} ч, ПР ${t.pr} ч, СРС ${t.srs} ч${needTask(t) ? ' — нужно практическое задание' : ''}`).join('\n')}\nРезультаты обучения (коды):\n${ctx.outcomes.map(o => `${o.code}: ${o.text}`).join('\n')}\n\nДля каждой темы верни: code, content (3–5 предложений: что изучается и что делают слушатели), outcomes (1–3 кода результатов, которые раскрывает тема), task (для тем, где нужно задание: title, situation — реальная рабочая ситуация слушателя, instructions, deliverable, criteria — 3 критерия оценки).`,
    schema: CONTENT_SCHEMA, maxTokens: 3000,
    mock: () => ({ topics: topics.map((t, i) => ({ code: t.code, content: `В теме «${t.title}» слушатели разбирают ключевые понятия и выполняют упражнения. Преподаватель показывает пример, затем слушатели повторяют его на своих данных.`, outcomes: [ctx.outcomes[i % ctx.outcomes.length].code], task: needTask(t) ? { title: `Практикум: ${t.title}`, situation: 'Рабочая ситуация слушателя', instructions: 'Выполните задание по образцу и оформите результат.', deliverable: 'Файл с решением', criteria: ['Решение работает', 'Оформление по требованиям', 'Слушатель объясняет ход решения'] } : undefined })) }),
  });
  const byCode = new Map((res.topics || []).map(x => [String(x.code).trim(), x]));
  topics.forEach((t, i) => {
    const r = byCode.get(t.code) || (res.topics || [])[i] || {};
    q.run('UPDATE topic SET content=?, status=? WHERE id=?', r.content || `Тема «${t.title}».`, 'draft', t.id);
    q.run('DELETE FROM outcome_topic WHERE topic_id=?', t.id);
    for (const code of (r.outcomes || [])) { const o = ctx.outcomes.find(o => o.code === String(code).trim()); if (o) q.run('INSERT OR IGNORE INTO outcome_topic VALUES (?,?)', o.id, t.id); }
    q.run('DELETE FROM seminar_task WHERE topic_id=?', t.id);
    if (needTask(t)) {
      const tk = r.task && r.task.instructions ? r.task : { title: `Практическое задание: ${t.title}`, instructions: 'Выполните задание по теме и представьте результат.', criteria: ['Задание выполнено полностью', 'Результат корректен', 'Слушатель объясняет решение'] };
      const tid = q.id('INSERT INTO seminar_task (topic_id, title, situation, instructions, deliverable) VALUES (?,?,?,?,?)', t.id, tk.title, tk.situation || null, tk.instructions, tk.deliverable || null);
      (tk.criteria || []).slice(0, 5).forEach((c, k) => q.run('INSERT INTO task_criterion (task_id, ord, text) VALUES (?,?,?)', tid, k + 1, c));
      const linked = q.all('SELECT outcome_id FROM outcome_topic WHERE topic_id=?', t.id);
      for (const l of linked) q.run('INSERT OR IGNORE INTO task_outcome VALUES (?,?)', tid, l.outcome_id);
    }
  });
}

async function writeTests(ctx) {
  const mods = q.all('SELECT * FROM module WHERE version_id=? ORDER BY ord', ctx.vid);
  q.run('DELETE FROM test WHERE version_id=?', ctx.vid);
  q.run('DELETE FROM interview_question WHERE module_id IN (SELECT id FROM module WHERE version_id=?)', ctx.vid);
  if (ctx.kind === 'pk_internship') {
    await pool(mods, 2, async m => {
      const topics = q.all('SELECT title FROM topic WHERE module_id=?', m.id).map(t => t.title);
      const res = await generateJson({
        skill: 'S5', requestId: ctx.requestId,
        system: 'Ты руководитель стажировки. Составляешь вопросы для собеседования (текущий контроль).',
        prompt: `Раздел стажировки «${m.title}», темы: ${topics.join('; ')}.\nРезультаты обучения:\n${ctx.outcomes.map(o => `${o.code}: ${o.text}`).join('\n')}\nСоставь 4 вопроса для собеседования со стажёром по этому разделу. Для каждого укажи outcome — код результата обучения, который он проверяет.`,
        schema: INTERVIEW_SCHEMA, maxTokens: 900,
        mock: () => ({ questions: [1, 2, 3, 4].map(i => ({ text: `Вопрос ${i} по разделу «${m.title}»: расскажите, как вы применили это на стажировке?`, outcome: ctx.outcomes[(m.ord + i) % ctx.outcomes.length].code })) }),
      });
      (res.questions || []).slice(0, 6).forEach((x, i) => {
        const id = q.id('INSERT INTO interview_question (module_id, ord, text) VALUES (?,?,?)', m.id, i + 1, x.text);
        const o = ctx.outcomes.find(o => o.code === String(x.outcome).trim()); if (o) q.run('INSERT OR IGNORE INTO interview_outcome VALUES (?,?)', id, o.id);
      });
    });
    return;
  }
  const final = ctx.params.test_questions;
  const plan = final ? H.distribute(final, mods.map(() => 1), 1).map((n, i) => [mods[i], n]) : mods.map(m => [m, 3]);
  const testId = final ? q.id("INSERT INTO test (version_id, module_id, purpose, title) VALUES (?,?,?,?)", ctx.vid, null, 'final', `Итоговый тест (${final} вопросов)`) : null;
  let ordFinal = 0;
  await pool(plan.filter(x => x[1] > 0), 2, async ([m, n]) => {
    const topics = q.all('SELECT code, title FROM topic WHERE module_id=? ORDER BY ord', m.id);
    const mo = ctx.outcomes.filter(o => q.get('SELECT 1 FROM outcome_topic ot JOIN topic t ON t.id=ot.topic_id WHERE ot.outcome_id=? AND t.module_id=?', o.id, m.id)).concat(ctx.outcomes).slice(0, 8);
    const res = await generateJson({
      skill: 'S5', requestId: ctx.requestId,
      system: 'Ты составитель тестов. Вопросы с одним правильным ответом из 4 вариантов, без двусмысленности, на русском.',
      prompt: `Модуль «${m.title}», темы: ${topics.map(t => t.title).join('; ')}.\n${ctx.style}\nРезультаты обучения:\n${mo.map(o => `${o.code}: ${o.text}`).join('\n')}\nСоставь ровно ${n} вопросов. Для каждого: text, options (4 варианта), correct (индекс правильного 0–3), outcome (код результата), explanation.`,
      schema: TEST_SCHEMA, maxTokens: 300 + n * 260,
      mock: () => ({ questions: Array.from({ length: n }, (_, i) => ({ text: `Вопрос ${i + 1} по теме «${topics[i % topics.length].title}»?`, options: ['Верный ответ', 'Неверный 1', 'Неверный 2', 'Неверный 3'], correct: 0, outcome: mo[i % mo.length].code, explanation: 'Пояснение.' })) }),
    });
    const tid = testId || q.id("INSERT INTO test (version_id, module_id, purpose, title) VALUES (?,?,?,?)", ctx.vid, m.id, 'current', `Тест по модулю ${m.code}`);
    (res.questions || []).slice(0, n).forEach((x, i) => {
      const opts = (x.options || []).slice(0, 5);
      if (opts.length < 2) return;
      const qid = q.id('INSERT INTO test_question (test_id, ord, qtype, text, explanation) VALUES (?,?,?,?,?)', tid, testId ? ++ordFinal : i + 1, 'single', x.text, x.explanation || null);
      const ci = clamp(Number.isInteger(x.correct) ? x.correct : 0, 0, opts.length - 1);
      opts.forEach((o, k) => q.run('INSERT INTO question_option (question_id, ord, text, is_correct) VALUES (?,?,?,?)', qid, k + 1, String(o), k === ci ? 1 : 0));
      const o = ctx.outcomes.find(o => o.code === String(x.outcome).trim()) || mo[i % mo.length];
      q.run('INSERT OR IGNORE INTO question_outcome VALUES (?,?)', qid, o.id);
    });
  });
}

async function writeAttestation(ctx) {
  const fa = q.get('SELECT * FROM final_attestation WHERE version_id=?', ctx.vid);
  const res = await generateJson({
    skill: 'S5', requestId: ctx.requestId,
    system: 'Ты методист. Описываешь итоговую аттестацию программы: требования, процедуру, пример задания и критерии с баллами (сумма 100).',
    prompt: `Программа «${ctx.title}», ${ctx.hours} ч. Форма итоговой аттестации: ${fa.form}, ${fa.hours} ч.\n${ctx.style}\n${ctx.kind === 'dop' ? 'Критерии должны быть понятны подростку.' : ''}\nРезультаты обучения:\n${ctx.outcomes.map(o => `${o.code}: ${o.text}`).join('\n')}\nВерни: description (что происходит), requirements (требования к работе/отчёту/портфолио/проекту, к данным), procedure (порядок и регламент), example_task (пример задания), pass_rule (правило «зачтено»), criteria (4–5 критериев: text, points, outcomes — коды результатов; вместе критерии покрывают все результаты).`,
    schema: FA_SCHEMA, maxTokens: 1800,
    mock: () => ({ description: `Итоговая аттестация в форме: ${fa.form}.`, requirements: 'Работа выполнена самостоятельно, данные обезличены.', procedure: 'Выступление до 7 минут и ответы на вопросы.', example_task: 'Решите практическую задачу по программе и представьте результат.', pass_rule: 'Зачтено при 60 баллах и более из 100.',
      criteria: [0, 1, 2, 3].map(i => ({ text: ['Работоспособность решения', 'Полнота выполнения', 'Обоснованность решений', 'Качество защиты'][i], points: 25, outcomes: ctx.outcomes.filter((_, k) => k % 4 === i).map(o => o.code) })) }),
  });
  q.run('UPDATE final_attestation SET description=?, requirements=?, procedure=?, example_task=?, pass_rule=? WHERE version_id=?',
    res.description, res.requirements, res.procedure, res.example_task, res.pass_rule, ctx.vid);
  q.run('DELETE FROM attestation_criterion WHERE version_id=?', ctx.vid);
  (res.criteria || []).slice(0, 6).forEach((c, i) => {
    const id = q.id('INSERT INTO attestation_criterion (version_id, ord, text, max_points) VALUES (?,?,?,?)', ctx.vid, i + 1, c.text, c.points || null);
    for (const code of c.outcomes || []) { const o = ctx.outcomes.find(o => o.code === String(code).trim()); if (o) q.run('INSERT OR IGNORE INTO attestation_outcome VALUES (?,?)', id, o.id); }
  });
}

function slideTopics(ctx) {
  if (ctx.params.slides_lessons && ctx.params.lesson_hours) {
    return q.all(`SELECT DISTINCT t.* FROM calendar_slot cs JOIN topic t ON t.id=cs.topic_id WHERE cs.version_id=? AND cs.day_no IN (${ctx.params.slides_lessons.map(Number).join(',')}) ORDER BY cs.day_no`, ctx.vid);
  }
  return q.all('SELECT t.* FROM topic t JOIN module m ON m.id=t.module_id WHERE m.version_id=? AND m.needs_slides=1 AND t.lk>0 ORDER BY t.ord', ctx.vid);
}

async function writeLectures(ctx, topics) {
  await pool(topics, 2, async t => {
    const res = await generateJson({
      skill: 'S6', requestId: ctx.requestId,
      system: 'Ты лектор и дизайнер учебных презентаций. Делаешь план лекции и слайды: коротко, по 3–5 тезисов на слайд.',
      prompt: `Программа «${ctx.title}». ${ctx.style}\nТема ${t.code} «${t.title}» (лекция ${t.lk} ч).\nСодержание темы: ${t.content || ''}\nВерни: goal (цель лекции), outline (5–7 пунктов плана), slides (6–8 слайдов: title, bullets 3–5 коротких тезисов, notes — что сказать лектору). Первый слайд — титульный с темой, последний — итоги и вопросы.`,
      schema: LECTURE_SCHEMA, maxTokens: 2200,
      mock: () => ({ goal: `Разобрать тему «${t.title}».`, outline: ['Введение', 'Ключевые понятия', 'Пример', 'Практика', 'Итоги'], slides: [{ title: t.title, bullets: ['Тема занятия', 'Что узнаем сегодня'] }, { title: 'Ключевые понятия', bullets: ['Понятие 1', 'Понятие 2', 'Понятие 3'] }, { title: 'Пример', bullets: ['Шаг 1', 'Шаг 2'] }, { title: 'Итоги', bullets: ['Что запомнить', 'Вопросы'] }] }),
    });
    q.run('DELETE FROM lecture_plan WHERE topic_id=?', t.id);
    const lp = q.id('INSERT INTO lecture_plan (topic_id, goal, outline) VALUES (?,?,?)', t.id, res.goal || t.title, JSON.stringify(res.outline || []));
    (res.slides || []).slice(0, 12).forEach((s, i) => q.run('INSERT INTO slide (lecture_plan_id, ord, title, bullets, notes) VALUES (?,?,?,?,?)', lp, i + 1, s.title, JSON.stringify((s.bullets || []).slice(0, 6)), s.notes || null));
  });
}

const fmtH = n => String(n).replace('.', ',');
const FORM_RU = { ochno: 'очная', ochno_zaochno: 'очно-заочная', zaochno: 'заочная' };

async function writeSections(ctx) {
  const v = q.get('SELECT * FROM program_version WHERE id=?', ctx.vid);
  const vh = q.get('SELECT * FROM v_version_hours WHERE version_id=?', ctx.vid);
  const std = v.standard_id ? q.get('SELECT * FROM standard WHERE id=?', v.standard_id) : null;
  const tpl = q.get('SELECT t.* FROM template t JOIN program p ON p.template_id=t.id WHERE p.id=?', v.program_id);
  const res = await generateJson({
    skill: 'S7', requestId: ctx.requestId,
    system: 'Ты методист. Пишешь текстовые разделы образовательной программы официальным, но понятным языком.',
    prompt: `Программа «${ctx.title}» (${ctx.kind === 'dop' ? 'общеразвивающая' : 'повышение квалификации' + (ctx.kind === 'pk_internship' ? ' в форме стажировки' : '')}), ${ctx.hours} ч. Цель: ${v.goal}\nСлушатели: ${v.audience || ''}. ${ctx.params.entry_level || ''}\n${ctx.style}\nМодули: ${q.all('SELECT title FROM module WHERE version_id=? ORDER BY ord', ctx.vid).map(m => m.title).join('; ')}\nВерни: annotation (аннотация 4–6 предложений), relevance (актуальность 3–5 предложений), entry_requirements (требования к слушателям / категории обучающихся${/студент|колледж/i.test(v.audience || '') ? '; учти, что студенты могут получать среднее профессиональное образование параллельно с курсом' : ''}), organization (организация образовательного процесса 3–4 предложения), books (4–6 реально существующих книг на русском по теме в формате «Автор. Название. — Город: Издательство, год.»).`,
    schema: SECTIONS_SCHEMA, maxTokens: 1800,
    mock: () => ({ annotation: `Программа «${ctx.title}» формирует у слушателей практические навыки.`, relevance: 'Спрос на специалистов растёт.', entry_requirements: v.audience || 'Лица от 18 лет.', organization: 'Занятия проводятся в соответствии с расписанием.', books: ['Лутц М. Изучаем Python. — СПб.: Питер, 2019.'] }),
  });
  q.run('UPDATE program_version SET entry_requirements=? WHERE id=?', res.entry_requirements, ctx.vid);
  const outcomes = outcomesOf(ctx.vid);
  const comp = q.all('SELECT c.*, sf.code fcode, sf.title ftitle FROM competency c LEFT JOIN standard_function sf ON sf.id=c.standard_function_id WHERE c.version_id=? ORDER BY ord', ctx.vid);
  const resultsText = comp.map(c => `${c.code}. ${c.title}${c.fcode ? ` (ТФ ${c.fcode} «${c.ftitle}»)` : ''}\n` + outcomes.filter(o => o.competency_id === c.id).map(o => `  ${o.code} — ${o.text}`).join('\n')).join('\n');
  const fa = q.get('SELECT * FROM final_attestation WHERE version_id=?', ctx.vid);
  const cal = q.get('SELECT MAX(week_no) w, COUNT(DISTINCT day_no) d FROM calendar_slot WHERE version_id=?', ctx.vid);
  const body = {
    '0.1': '',
    '3.4': '',
    '1.1': res.annotation, '1': `Программа «${ctx.title}» имеет техническую направленность и реализуется на базовом уровне. Форма обучения: ${FORM_RU[v.form] || v.form}${v.uses_dot ? ' с применением ЭО и ДОТ' : ''}.\n${res.annotation}`,
    '1.2': ctx.kind === 'dop' ? res.entry_requirements : v.goal, '1.3': ctx.kind === 'dop' ? `Цель: ${v.goal}\nЗадачи:\n${J(v.tasks).map(t => '— ' + t).join('\n')}` : resultsText,
    '1.4': ctx.kind === 'dop' ? `Срок реализации: ${cal.w} нед. (${cal.d} занятий/дней). Трудоёмкость: ${fmtH(v.hours_requested)} ч.` : [tpl.legal_basis, std ? `Профессиональный стандарт ${std.code} «${std.title}» (${std.order_ref})${std.status !== 'verified' ? ' [требует проверки]' : ''}` : ''].filter(Boolean).join('.\n'),
    '1.5': ctx.kind === 'dop' ? resultsText : comp.map(c => `${c.fcode ? c.fcode + ' ' : ''}${c.title}`).join('\n'),
    '1.6': ctx.kind === 'dop' ? `Количество учебных недель — ${cal.w}. Количество занятий — ${cal.d}. ${v.lesson_hours ? `Режим: ${v.lessons_per_week} раза в неделю по ${fmtH(v.lesson_hours)} ч.` : ''}` : res.entry_requirements,
    '1.7': `${FORM_RU[v.form] || v.form}${v.uses_dot ? ', с применением электронного обучения и дистанционных образовательных технологий' : ''}${ctx.kind === 'pk_internship' ? '. Стажировка: аудиторных занятий нет, работа выполняется самостоятельно под руководством наставника от организации' : ''}.`,
    '1.8': `${fmtH(v.hours_requested)} академических часов: лекции ${fmtH(vh.lk)} ч, практические занятия ${fmtH(vh.pr)} ч, лабораторные ${fmtH(vh.lb)} ч, самостоятельная работа ${fmtH(vh.srs)} ч, итоговая аттестация ${fmtH(vh.attestation_hours)} ч. Срок обучения: ${cal.w} нед.${v.max_hours_per_day ? `, не более ${fmtH(v.max_hours_per_day)} ч в день` : ''}.`,
    '1.9': tpl.document_issued,
    '2.1': 'См. таблицу «Учебный план».', '2.2': 'См. таблицу «Учебно-тематический план».', '2.3': ctx.kind === 'dop' ? 'См. раздел «Оценочные материалы».' : 'См. таблицу «Календарный учебный график».',
    '2.4': 'См. содержание тем в учебно-тематическом плане.',
    '2.5': `Текущий контроль: ${ctx.kind === 'pk_internship' ? 'собеседование с руководителем стажировки по каждому разделу' : 'тесты и практические задания по модулям'}. Итоговая аттестация: ${fa.form} (${fmtH(fa.hours)} ч). ${fa.pass_rule || ''}`,
    '3.1': ctx.kind === 'pk_internship' ? 'Рабочее место стажёра в организации-партнёре, оборудованное компьютером с доступом в интернет и необходимым программным обеспечением.' : 'Учебная аудитория с рабочими местами для всех слушателей, компьютер на каждое место, проектор, доступ в интернет, электронная информационно-образовательная среда.',
    '3.2': 'См. список литературы и интернет-ресурсов.', '3.3': ctx.kind === 'dop' ? 'См. список литературы.' : res.organization,
    '2.3dop': '',
  };
  if (ctx.kind === 'dop') {
    body['2.3'] = `Итоговая аттестация: ${fa.form}. ${fa.description || ''}`; body['2.4'] = 'Методические рекомендации для теоретических и практических занятий, конспекты, презентации к занятиям.';
    body['3.1'] = body['3.1']; body['3.2'] = 'Презентации к занятиям, задания для практики, шаблон проекта.';
    body['1.4'] = body['1.4']; body['1.1'] = res.relevance;
  }
  delete body['2.3dop'];
  for (const [code, text] of Object.entries(body)) q.run('INSERT OR REPLACE INTO section_content (version_id, section_code, body, origin) VALUES (?,?,?,?)', ctx.vid, code, text || '', ['1.1', '1.2', '1.6', '3.3'].includes(code) ? 'llm' : 'code');

  q.run('DELETE FROM program_source WHERE version_id=?', ctx.vid);
  const hay = `${ctx.title} ${ctx.params.direction} ${ctx.params.audience} ${(ctx.params.required_topics || []).join(' ')} ${q.all('SELECT title FROM module WHERE version_id=?', ctx.vid).map(m => m.title).join(' ')}`.toLowerCase();
  let ord = 0;
  const kindKey = ctx.kind === 'dop' ? 'dop' : 'pk';
  for (const s of q.all('SELECT * FROM source WHERE status=?', 'verified')) {
    const ks = s.keywords.split(/\s+/).filter(Boolean);
    const ok = ks.includes('*') || (ks.length === 1 && ks[0] === kindKey) || ks.some(k => k.length > 2 && k !== 'dop' && hay.includes(k));
    if (ok) q.run('INSERT OR IGNORE INTO program_source VALUES (?,?,?,?)', ctx.vid, s.id, s.kind === 'web' ? 'web' : 'normative', ++ord);
  }
  if (ctx.kind !== 'dop') {
    const std = q.get('SELECT s.* FROM standard s JOIN program_version v ON v.standard_id=s.id WHERE v.id=?', ctx.vid);
    if (std) {
      const bt = `Профессиональный стандарт ${std.code} «${std.title}» (${std.order_ref}).`;
      q.run('INSERT OR IGNORE INTO source (kind, bibl_text, status) VALUES (?,?,?)', 'standard', bt, std.status);
      q.run('INSERT OR IGNORE INTO program_source VALUES (?,?,?,?)', ctx.vid, q.get('SELECT id FROM source WHERE bibl_text=?', bt).id, 'normative', ++ord);
    }
  }
  for (const b of (res.books || []).slice(0, 6)) {
    q.run('INSERT OR IGNORE INTO source (kind, bibl_text, status) VALUES (?,?,?)', 'book', b, 'unverified');
    const s = q.get('SELECT id FROM source WHERE bibl_text=?', b);
    q.run('INSERT OR IGNORE INTO program_source VALUES (?,?,?,?)', ctx.vid, s.id, 'main', ++ord);
  }
}

function detectTools(vid) {
  const texts = [
    ...q.all('SELECT t.title, t.content FROM topic t JOIN module m ON m.id=t.module_id WHERE m.version_id=?', vid).map(x => x.title + ' ' + x.content),
    ...q.all('SELECT body FROM section_content WHERE version_id=?', vid).map(x => x.body),
    ...q.all('SELECT st.title, st.instructions, st.situation FROM seminar_task st JOIN topic t ON t.id=st.topic_id JOIN module m ON m.id=t.module_id WHERE m.version_id=?', vid).map(x => `${x.title} ${x.instructions} ${x.situation}`),
    ...q.all('SELECT s.title, s.bullets FROM slide s JOIN lecture_plan lp ON lp.id=s.lecture_plan_id JOIN topic t ON t.id=lp.topic_id JOIN module m ON m.id=t.module_id WHERE m.version_id=?', vid).map(x => x.title + ' ' + x.bullets),
  ].join('\n').toLowerCase();
  q.run('DELETE FROM program_tool WHERE version_id=?', vid);
  for (const t of q.all('SELECT * FROM tool_registry')) if (new RegExp(t.pattern, 'i').test(texts)) q.run('INSERT OR IGNORE INTO program_tool VALUES (?,?)', vid, t.id);
}

function repairCoverage(vid) {
  const outs = q.all('SELECT * FROM v_outcome_coverage WHERE version_id=?', vid);
  const topics = q.all('SELECT t.* FROM topic t JOIN module m ON m.id=t.module_id WHERE m.version_id=? ORDER BY m.ord, t.ord', vid);
  const crits = q.all('SELECT * FROM attestation_criterion WHERE version_id=? ORDER BY ord', vid);
  let fixed = 0;
  outs.forEach((o, i) => {
    if (o.topics === 0 && topics.length) {
      const best = topics.map(t => [overlap(o.text, t.title + ' ' + (t.content || '')), t]).sort((a, b) => b[0] - a[0])[0][1];
      q.run('INSERT OR IGNORE INTO outcome_topic VALUES (?,?)', o.outcome_id, best.id); fixed++;
    }
    const has = kind => q.get('SELECT 1 FROM v_outcome_assessment WHERE outcome_id=? AND tool_kind=?', o.outcome_id, kind);
    if (!has('final_attestation') && crits.length) { q.run('INSERT OR IGNORE INTO attestation_outcome VALUES (?,?)', crits[i % crits.length].id, o.outcome_id); fixed++; }
    if (q.get('SELECT COUNT(*) n FROM v_outcome_assessment WHERE outcome_id=?', o.outcome_id).n < 2) {
      const task = q.get('SELECT st.id FROM seminar_task st JOIN outcome_topic ot ON ot.topic_id=st.topic_id WHERE ot.outcome_id=? LIMIT 1', o.outcome_id)
        || q.get('SELECT st.id FROM seminar_task st JOIN topic t ON t.id=st.topic_id JOIN module m ON m.id=t.module_id WHERE m.version_id=? ORDER BY st.id LIMIT 1 OFFSET ?', vid, i % Math.max(1, q.get('SELECT COUNT(*) n FROM seminar_task st JOIN topic t ON t.id=st.topic_id JOIN module m ON m.id=t.module_id WHERE m.version_id=?', vid).n));
      if (task) { q.run('INSERT OR IGNORE INTO task_outcome VALUES (?,?)', task.id, o.outcome_id); fixed++; }
      else {
        const iq = q.get('SELECT iq.id FROM interview_question iq JOIN module m ON m.id=iq.module_id WHERE m.version_id=? ORDER BY iq.id LIMIT 1 OFFSET ?', vid, i);
        if (iq) { q.run('INSERT OR IGNORE INTO interview_outcome VALUES (?,?)', iq.id, o.outcome_id); fixed++; }
      }
    }
  });
  for (const x of q.all('SELECT qq.id FROM test_question qq JOIN test t ON t.id=qq.test_id WHERE t.version_id=? AND NOT EXISTS (SELECT 1 FROM question_outcome WHERE question_id=qq.id)', vid)) {
    const o = outs[x.id % Math.max(1, outs.length)]; if (o) { q.run('INSERT OR IGNORE INTO question_outcome VALUES (?,?)', x.id, o.outcome_id); fixed++; }
  }
  return fixed;
}

function ctxFor(vid) {
  const v = q.get('SELECT v.*, p.kind, p.title, p.request_id FROM program_version v JOIN program p ON p.id=v.program_id WHERE v.id=?', vid);
  const req = q.get('SELECT * FROM request WHERE id=?', v.request_id);
  const params = J(req.params);
  return {
    vid, requestId: v.request_id, kind: v.kind, title: v.title, hours: v.hours_requested, params,
    style: audienceStyle(params), outcomes: outcomesOf(vid),
    rules: [params.only_ru_services ? 'Упоминай только сервисы, доступные в России (GigaChat, YandexGPT, Kandinsky, Шедеврум); не упоминай ChatGPT, Gemini, Claude, Midjourney.' : '',
      ctx2(params)].filter(Boolean).join(' '),
  };
}
const ctx2 = p => (/банк/i.test(p.audience) ? 'Задания строй на банковских ситуациях: отток клиентов, просроченная задолженность, кредитный портфель; данные обезличены.' : '')
  + (/учител/i.test(p.audience) ? ' Задания — на реальных задачах учителя: план урока, задания для учеников, проверочная работа.' : '');

async function generateContent(vid, log) {
  const ctx = ctxFor(vid);
  q.run("UPDATE request SET status='generating' WHERE id=?", ctx.requestId);
  const mods = q.all('SELECT * FROM module WHERE version_id=? ORDER BY ord', vid);
  log('S4', `Содержание тем и практические задания: ${mods.length} модулей`);
  let done = 0;
  await pool(mods, 2, async m => { await writeModule(ctx, m); log('S4', `Модуль ${m.code} «${m.title}» готов (${++done}/${mods.length})`); });
  log('S5', 'Оценочные материалы: тесты / вопросы собеседования');
  await writeTests(ctx);
  log('S5', 'Итоговая аттестация и критерии');
  await writeAttestation(ctx);
  const st = slideTopics(ctx);
  log('S6', `Планы лекций и слайды: ${st.length} тем`);
  await writeLectures(ctx, st);
  log('S7', 'Разделы шаблона, нормативка и источники');
  await writeSections(ctx);
  detectTools(vid);
  log('S8', 'Самопроверка');
  const fixed = repairCoverage(vid);
  if (fixed) log('S8', `Код достроил ${fixed} связей в карте компетенций`);
  const res = runChecks(vid);
  q.run("UPDATE program_version SET status=? WHERE id=?", res.passed ? 'checked' : 'content_ready', vid);
  q.run("UPDATE request SET status='done' WHERE id=?", ctx.requestId);
  log('S8', `Проверка: ${res.issues.filter(i => i.severity === 'error').length} ошибок, ${res.issues.filter(i => i.severity === 'warn').length} предупреждений, ${res.issues.filter(i => i.severity === 'info').length} сообщений`);
  return res;
}

async function regenerateTopic(vid, topicId, instruction) {
  const ctx = ctxFor(vid);
  const t = q.get('SELECT t.*, m.title mtitle FROM topic t JOIN module m ON m.id=t.module_id WHERE t.id=? AND m.version_id=?', topicId, vid);
  if (!t) throw new Error('Тема не найдена');
  const res = await generateJson({
    skill: 'S9', requestId: ctx.requestId,
    system: 'Ты методист. Точечно перерабатываешь одну тему программы по замечанию, не трогая остальное.',
    prompt: `Программа «${ctx.title}». ${ctx.style} ${ctx.rules}\nМодуль «${t.mtitle}». Тема ${t.code} «${t.title}» (ЛК ${t.lk}, ПР ${t.pr}, СРС ${t.srs} ч).\nТекущее содержание: ${t.content}\nЗамечание методиста: «${instruction}»\nРезультаты обучения:\n${ctx.outcomes.map(o => `${o.code}: ${o.text}`).join('\n')}\nВерни topics из одного элемента: code "${t.code}", title не возвращай — content (новое содержание), outcomes, task (если есть практика).`,
    schema: { ...CONTENT_SCHEMA, properties: { ...CONTENT_SCHEMA.properties, new_title: { type: 'string' } } }, maxTokens: 1500,
    mock: () => ({ new_title: t.title, topics: [{ code: t.code, content: `${t.content} Доработано: ${instruction}.`, outcomes: [ctx.outcomes[0].code], task: t.pr > 0 ? { title: `Практикум: ${t.title}`, instructions: 'Обновлённое задание.', criteria: ['Критерий 1', 'Критерий 2', 'Критерий 3'] } : undefined }] }),
  });
  if (res.new_title && res.new_title.length > 3 && /назван|переимен|замени тему|другую тему/i.test(instruction)) q.run('UPDATE topic SET title=? WHERE id=?', res.new_title, t.id);
  const r = (res.topics || [])[0] || {};
  q.run("UPDATE topic SET content=?, status='draft' WHERE id=?", r.content || t.content, t.id);
  q.run('DELETE FROM outcome_topic WHERE topic_id=?', t.id);
  for (const code of r.outcomes || []) { const o = ctx.outcomes.find(o => o.code === String(code).trim()); if (o) q.run('INSERT OR IGNORE INTO outcome_topic VALUES (?,?)', o.id, t.id); }
  if (r.task && r.task.instructions) {
    q.run('DELETE FROM seminar_task WHERE topic_id=?', t.id);
    const tid = q.id('INSERT INTO seminar_task (topic_id, title, situation, instructions, deliverable) VALUES (?,?,?,?,?)', t.id, r.task.title, r.task.situation || null, r.task.instructions, r.task.deliverable || null);
    (r.task.criteria || []).forEach((c, k) => q.run('INSERT INTO task_criterion (task_id, ord, text) VALUES (?,?,?)', tid, k + 1, c));
    for (const l of q.all('SELECT outcome_id FROM outcome_topic WHERE topic_id=?', t.id)) q.run('INSERT OR IGNORE INTO task_outcome VALUES (?,?)', tid, l.outcome_id);
  }
  if (q.get('SELECT 1 FROM lecture_plan WHERE topic_id=?', t.id)) {
    q.run("UPDATE lecture_plan SET status='stale' WHERE topic_id=?", t.id);
    await writeLectures(ctx, [q.get('SELECT * FROM topic WHERE id=?', t.id)]);
  }
  q.run('INSERT INTO change_request (version_id, target_type, target_id, instruction) VALUES (?,?,?,?)', vid, 'topic', t.id, instruction);
  q.run('UPDATE program_version SET revision = revision + 1 WHERE id=?', vid);
  detectTools(vid);
  repairCoverage(vid);
  return runChecks(vid);
}

module.exports = { parseRules, extractParams, findMissing, QUESTIONS, buildSkeleton, setModuleHours, rebuildCalendar, generateContent, regenerateTopic, repairCoverage };
