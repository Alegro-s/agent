// Хранилище MVP: SQLite (встроен в Node 22+/24, без установки).
// Схема повторяет KB/04_БД (PostgreSQL), упрощения описаны в README.
'use strict';
const path = require('path');
const fs = require('fs');
process.removeAllListeners('warning'); // глушим ExperimentalWarning node:sqlite
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, process.env.EDU_DB || (process.env.EDU_LLM === 'mock' ? 'demo.sqlite' : 'edu.sqlite')));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS template (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
  legal_basis TEXT NOT NULL, document_issued TEXT NOT NULL, requires_standard INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS template_section (
  id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES template(id),
  code TEXT NOT NULL, title TEXT NOT NULL, ord INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1, is_blank_field INTEGER NOT NULL DEFAULT 0,
  UNIQUE (template_id, code));

CREATE TABLE IF NOT EXISTS request (
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  raw_text TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', missing_params TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',
  model TEXT);
CREATE TABLE IF NOT EXISTS request_file (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES request(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'reference',
  extracted_text TEXT, structure TEXT);
CREATE TABLE IF NOT EXISTS clarifying_question (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES request(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 5), param_key TEXT NOT NULL,
  question TEXT NOT NULL, hint TEXT, answer TEXT, UNIQUE (request_id, ord));

CREATE TABLE IF NOT EXISTS program (
  id INTEGER PRIMARY KEY, request_id INTEGER REFERENCES request(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES template(id), kind TEXT NOT NULL CHECK (kind IN ('pk','pk_internship','dop')),
  title TEXT NOT NULL, direction TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS program_version (
  id INTEGER PRIMARY KEY, program_id INTEGER NOT NULL REFERENCES program(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'skeleton',
  hours_requested REAL NOT NULL CHECK (hours_requested > 0),
  form TEXT NOT NULL, uses_dot INTEGER NOT NULL DEFAULT 0,
  duration_weeks REAL, duration_approx INTEGER NOT NULL DEFAULT 0, days_per_week INTEGER,
  max_hours_per_day REAL, lesson_hours REAL, lessons_per_week INTEGER, min_practice_share REAL,
  audience TEXT, entry_requirements TEXT, goal TEXT, tasks TEXT NOT NULL DEFAULT '[]',
  standard_id INTEGER REFERENCES standard(id),
  approved_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS section_content (
  version_id INTEGER NOT NULL REFERENCES program_version(id) ON DELETE CASCADE,
  section_code TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'llm',
  PRIMARY KEY (version_id, section_code));
CREATE TABLE IF NOT EXISTS module (
  id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES program_version(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, code TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'regular',
  title TEXT NOT NULL, planned_hours REAL NOT NULL CHECK (planned_hours >= 0), weight REAL NOT NULL DEFAULT 1,
  control_form TEXT, needs_slides INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft');
CREATE TABLE IF NOT EXISTS topic (
  id INTEGER PRIMARY KEY, module_id INTEGER NOT NULL REFERENCES module(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, content TEXT,
  ttype TEXT NOT NULL DEFAULT 'mixed', weight REAL NOT NULL DEFAULT 1,
  lk REAL NOT NULL DEFAULT 0 CHECK (lk >= 0), pr REAL NOT NULL DEFAULT 0 CHECK (pr >= 0),
  lb REAL NOT NULL DEFAULT 0 CHECK (lb >= 0), srs REAL NOT NULL DEFAULT 0 CHECK (srs >= 0),
  total REAL GENERATED ALWAYS AS (lk + pr + lb + srs) STORED,
  delivery TEXT, status TEXT NOT NULL DEFAULT 'draft');
CREATE TABLE IF NOT EXISTS final_attestation (
  version_id INTEGER PRIMARY KEY REFERENCES program_version(id) ON DELETE CASCADE,
  form TEXT NOT NULL, hours REAL NOT NULL, description TEXT, requirements TEXT,
  procedure TEXT, example_task TEXT, pass_rule TEXT);
CREATE TABLE IF NOT EXISTS attestation_criterion (
  id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES final_attestation(version_id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, text TEXT NOT NULL, max_points INTEGER);
CREATE TABLE IF NOT EXISTS calendar_slot (
  id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES program_version(id) ON DELETE CASCADE,
  day_no INTEGER NOT NULL, week_no INTEGER NOT NULL, topic_id INTEGER REFERENCES topic(id) ON DELETE CASCADE,
  activity TEXT NOT NULL, hours REAL NOT NULL CHECK (hours > 0));

CREATE TABLE IF NOT EXISTS standard (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL, order_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unverified', keywords TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS standard_function (
  id INTEGER PRIMARY KEY, standard_id INTEGER NOT NULL REFERENCES standard(id),
  code TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unverified', UNIQUE (standard_id, code));
CREATE TABLE IF NOT EXISTS competency (
  id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES program_version(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, activity_type TEXT,
  standard_function_id INTEGER REFERENCES standard_function(id));
CREATE TABLE IF NOT EXISTS learning_outcome (
  id INTEGER PRIMARY KEY, competency_id INTEGER NOT NULL REFERENCES competency(id) ON DELETE CASCADE,
  code TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('knowledge','skill','ability','experience')), text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outcome_topic (
  outcome_id INTEGER REFERENCES learning_outcome(id) ON DELETE CASCADE,
  topic_id INTEGER REFERENCES topic(id) ON DELETE CASCADE, PRIMARY KEY (outcome_id, topic_id));

CREATE TABLE IF NOT EXISTS test (
  id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES program_version(id) ON DELETE CASCADE,
  module_id INTEGER REFERENCES module(id) ON DELETE CASCADE, purpose TEXT NOT NULL, title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS test_question (
  id INTEGER PRIMARY KEY, test_id INTEGER NOT NULL REFERENCES test(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, qtype TEXT NOT NULL DEFAULT 'single', text TEXT NOT NULL, explanation TEXT);
CREATE TABLE IF NOT EXISTS question_option (
  id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES test_question(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, text TEXT NOT NULL, is_correct INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS question_outcome (
  question_id INTEGER REFERENCES test_question(id) ON DELETE CASCADE,
  outcome_id INTEGER REFERENCES learning_outcome(id) ON DELETE CASCADE, PRIMARY KEY (question_id, outcome_id));
CREATE TABLE IF NOT EXISTS seminar_task (
  id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
  title TEXT NOT NULL, situation TEXT, instructions TEXT NOT NULL, deliverable TEXT);
CREATE TABLE IF NOT EXISTS task_criterion (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES seminar_task(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_outcome (
  task_id INTEGER REFERENCES seminar_task(id) ON DELETE CASCADE,
  outcome_id INTEGER REFERENCES learning_outcome(id) ON DELETE CASCADE, PRIMARY KEY (task_id, outcome_id));
CREATE TABLE IF NOT EXISTS interview_question (
  id INTEGER PRIMARY KEY, module_id INTEGER NOT NULL REFERENCES module(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS interview_outcome (
  question_id INTEGER REFERENCES interview_question(id) ON DELETE CASCADE,
  outcome_id INTEGER REFERENCES learning_outcome(id) ON DELETE CASCADE, PRIMARY KEY (question_id, outcome_id));
CREATE TABLE IF NOT EXISTS attestation_outcome (
  criterion_id INTEGER REFERENCES attestation_criterion(id) ON DELETE CASCADE,
  outcome_id INTEGER REFERENCES learning_outcome(id) ON DELETE CASCADE, PRIMARY KEY (criterion_id, outcome_id));

CREATE TABLE IF NOT EXISTS lecture_plan (
  id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL UNIQUE REFERENCES topic(id) ON DELETE CASCADE,
  goal TEXT NOT NULL, outline TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft');
CREATE TABLE IF NOT EXISTS slide (
  id INTEGER PRIMARY KEY, lecture_plan_id INTEGER NOT NULL REFERENCES lecture_plan(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, title TEXT NOT NULL, bullets TEXT NOT NULL DEFAULT '[]', notes TEXT);

CREATE TABLE IF NOT EXISTS source (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, bibl_text TEXT NOT NULL UNIQUE, url TEXT,
  status TEXT NOT NULL DEFAULT 'unverified', keywords TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS program_source (
  version_id INTEGER REFERENCES program_version(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES source(id), section TEXT NOT NULL, ord INTEGER NOT NULL,
  PRIMARY KEY (version_id, source_id));
CREATE TABLE IF NOT EXISTS tool_registry (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, pattern TEXT NOT NULL, category TEXT NOT NULL,
  available_ru INTEGER, deprecated INTEGER NOT NULL DEFAULT 0, note TEXT);
CREATE TABLE IF NOT EXISTS program_tool (
  version_id INTEGER REFERENCES program_version(id) ON DELETE CASCADE,
  tool_id INTEGER REFERENCES tool_registry(id), PRIMARY KEY (version_id, tool_id));

CREATE TABLE IF NOT EXISTS check_run (
  id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES program_version(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), passed INTEGER);
CREATE TABLE IF NOT EXISTS check_issue (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES check_run(id) ON DELETE CASCADE,
  rule_code TEXT NOT NULL, severity TEXT NOT NULL, entity_type TEXT, entity_id INTEGER, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS change_request (
  id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES program_version(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL, target_id INTEGER NOT NULL, instruction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS export_artifact (
  id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES program_version(id) ON DELETE CASCADE,
  format TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS generation_run (
  id INTEGER PRIMARY KEY, request_id INTEGER REFERENCES request(id) ON DELETE CASCADE,
  skill_code TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  duration_ms INTEGER, ok INTEGER NOT NULL DEFAULT 1, error TEXT);
CREATE TABLE IF NOT EXISTS job (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES request(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', step TEXT, log TEXT NOT NULL DEFAULT '[]',
  error TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), finished_at TEXT);

CREATE VIEW IF NOT EXISTS v_module_hours AS
SELECT m.id AS module_id, m.version_id, m.code, m.kind, m.planned_hours,
  COALESCE(SUM(t.lk),0) lk, COALESCE(SUM(t.pr),0) pr, COALESCE(SUM(t.lb),0) lb,
  COALESCE(SUM(t.srs),0) srs, COALESCE(SUM(t.total),0) total
FROM module m LEFT JOIN topic t ON t.module_id = m.id GROUP BY m.id;

CREATE VIEW IF NOT EXISTS v_version_hours AS
SELECT v.id AS version_id, v.hours_requested,
  (SELECT COALESCE(SUM(lk),0) FROM v_module_hours WHERE version_id=v.id) lk,
  (SELECT COALESCE(SUM(pr),0) FROM v_module_hours WHERE version_id=v.id) pr,
  (SELECT COALESCE(SUM(lb),0) FROM v_module_hours WHERE version_id=v.id) lb,
  (SELECT COALESCE(SUM(srs),0) FROM v_module_hours WHERE version_id=v.id) srs,
  (SELECT COALESCE(SUM(total),0) FROM v_module_hours WHERE version_id=v.id) modules_total,
  COALESCE(fa.hours,0) attestation_hours,
  (SELECT COALESCE(SUM(total),0) FROM v_module_hours WHERE version_id=v.id) + COALESCE(fa.hours,0) grand_total
FROM program_version v LEFT JOIN final_attestation fa ON fa.version_id = v.id;

CREATE VIEW IF NOT EXISTS v_outcome_assessment AS
SELECT qo.outcome_id, 'test' tool_kind, q.test_id tool_id
  FROM question_outcome qo JOIN test_question q ON q.id = qo.question_id
UNION SELECT outcome_id, 'seminar_task', task_id FROM task_outcome
UNION SELECT io.outcome_id, 'interview', iq.module_id
  FROM interview_outcome io JOIN interview_question iq ON iq.id = io.question_id
UNION SELECT ao.outcome_id, 'final_attestation', ac.version_id
  FROM attestation_outcome ao JOIN attestation_criterion ac ON ac.id = ao.criterion_id;

CREATE VIEW IF NOT EXISTS v_outcome_coverage AS
SELECT lo.id outcome_id, c.version_id, c.code competency, lo.code, lo.text,
  (SELECT COUNT(*) FROM outcome_topic ot WHERE ot.outcome_id = lo.id) topics,
  (SELECT COUNT(*) FROM v_outcome_assessment a WHERE a.outcome_id = lo.id) tools
FROM learning_outcome lo JOIN competency c ON c.id = lo.competency_id;
`;
db.exec(SCHEMA);

// ---------- Справочники ----------
function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM template').get().n > 0) return;
  const ins = (sql, rows) => { const st = db.prepare(sql); rows.forEach(r => st.run(...r)); };
  ins('INSERT INTO template (id, code, title, legal_basis, document_issued, requires_standard) VALUES (?,?,?,?,?,?)', [
    [1, 'dpp_pk', 'Дополнительная профессиональная программа повышения квалификации',
      'Федеральный закон от 29.12.2012 № 273-ФЗ «Об образовании в Российской Федерации»; приказ Минобрнауки России от 01.07.2013 № 499',
      'Удостоверение о повышении квалификации установленного образца', 1],
    [2, 'dop', 'Дополнительная общеобразовательная общеразвивающая программа',
      'Приказ Минпросвещения России от 27.07.2022 № 629',
      'Сертификат об освоении программы', 0],
  ]);
  const pk = [
    ['0.1', 'Реквизиты приказа об утверждении', 1], ['1.1', 'Аннотация программы', 0], ['1.2', 'Цель реализации программы', 0],
    ['1.3', 'Планируемые результаты обучения', 0], ['1.4', 'Программа разработана на основе', 0],
    ['1.5', 'Перечень профессиональных компетенций', 0], ['1.6', 'Требования к слушателям', 0],
    ['1.7', 'Форма обучения', 0], ['1.8', 'Объём программы', 0], ['1.9', 'Выдаваемый документ', 0],
    ['2.1', 'Учебный план', 0], ['2.2', 'Учебно-тематический план', 0], ['2.3', 'Календарный учебный график', 0],
    ['2.4', 'Рабочая программа', 0], ['2.5', 'Оценка качества освоения программы', 0],
    ['3.1', 'Материально-техническое обеспечение', 0], ['3.2', 'Учебно-методическое и информационное обеспечение', 0],
    ['3.3', 'Организация образовательного процесса', 0], ['3.4', 'Кадровое обеспечение', 1],
  ];
  const dop = [
    ['0.1', 'Реквизиты приказа об утверждении', 1], ['1', 'Пояснительная записка', 0], ['1.1', 'Актуальность программы', 0],
    ['1.2', 'Категории обучающихся', 0], ['1.3', 'Цель и задачи программы', 0], ['1.4', 'Сроки реализации', 0],
    ['1.5', 'Планируемые результаты обучения', 0], ['1.6', 'Календарный учебный график', 0],
    ['2.1', 'Учебный план', 0], ['2.2', 'Учебно-тематический план', 0], ['2.3', 'Оценочные материалы', 0],
    ['2.4', 'Методические материалы', 0], ['3.1', 'Материально-технические условия', 0],
    ['3.2', 'Учебно-методическое и информационное обеспечение', 0], ['3.3', 'Литература', 0], ['3.4', 'Кадровое обеспечение', 1],
  ];
  ins('INSERT INTO template_section (template_id, code, title, ord, is_blank_field) VALUES (?,?,?,?,?)',
    [...pk.map((s, i) => [1, s[0], s[1], i + 1, s[2]]), ...dop.map((s, i) => [2, s[0], s[1], i + 1, s[2]])]);

  ins('INSERT INTO standard (id, code, title, order_ref, status, keywords) VALUES (?,?,?,?,?,?)', [
    [1, '01.001', 'Педагог (педагогическая деятельность в сфере дошкольного, начального общего, основного общего, среднего общего образования) (воспитатель, учитель)', 'Приказ Минтруда России от 18.10.2013 № 544н', 'verified', 'учител педагог школ урок'],
    [2, '06.015', 'Специалист по информационным системам', 'Приказ Минтруда России от 13.07.2023 № 586н', 'unverified', 'информационн систем аналит требован бизнес-анализ'],
    [3, '06.026', 'Системный администратор информационно-коммуникационных систем', 'Приказ Минтруда России от 29.09.2020 № 680н', 'unverified', 'devops linux администр инфраструкт сет docker ci/cd kubernetes'],
    [4, '06.032', 'Специалист по безопасности компьютерных систем и сетей', 'Приказ Минтруда России от 14.09.2022 № 533н', 'unverified', 'безопасн кибер защит уязвим инцидент'],
    [5, '06.042', 'Специалист по большим данным', 'реквизиты приказа требуют проверки', 'unverified', 'данн анализ pandas статист sql аналитик big data'],
    [6, '06.001', 'Программист', 'реквизиты приказа требуют проверки', 'unverified', 'программ разработ python код'],
  ]);
  ins('INSERT INTO standard_function (standard_id, code, title, status) VALUES (?,?,?,?)', [
    [1, 'A/01.6', 'Общепедагогическая функция. Обучение', 'verified'],
    [1, 'A/02.6', 'Воспитательная деятельность', 'verified'],
    [1, 'A/03.6', 'Развивающая деятельность', 'verified'],
    [2, 'C/14.6', 'Разработка архитектуры ИС', 'unverified'],
  ]);
  ins('INSERT INTO source (kind, bibl_text, url, status, keywords) VALUES (?,?,?,?,?)', [
    ['law', 'Федеральный закон от 29.12.2012 № 273-ФЗ «Об образовании в Российской Федерации».', null, 'verified', '*'],
    ['order', 'Приказ Минобрнауки России от 01.07.2013 № 499 «Об утверждении Порядка организации и осуществления образовательной деятельности по дополнительным профессиональным программам».', null, 'verified', 'pk'],
    ['order', 'Приказ Минпросвещения России от 27.07.2022 № 629 «Об утверждении Порядка организации и осуществления образовательной деятельности по дополнительным общеобразовательным программам».', null, 'verified', 'dop'],
    ['law', 'Федеральный закон от 27.07.2006 № 152-ФЗ «О персональных данных».', null, 'verified', 'персональн данн учени банк обезлич'],
    ['web', 'Документация Python 3. — URL: https://docs.python.org/3/', 'https://docs.python.org/3/', 'verified', 'python'],
    ['web', 'Документация pandas. — URL: https://pandas.pydata.org/docs/', 'https://pandas.pydata.org/docs/', 'verified', 'pandas данн'],
    ['web', 'Документация Matplotlib. — URL: https://matplotlib.org/stable/', 'https://matplotlib.org/stable/', 'verified', 'визуал matplotlib'],
    ['web', 'Документация PostgreSQL. — URL: https://www.postgresql.org/docs/', 'https://www.postgresql.org/docs/', 'verified', 'sql postgres'],
    ['web', 'Документация Docker. — URL: https://docs.docker.com/', 'https://docs.docker.com/', 'verified', 'docker devops контейнер'],
    ['web', 'Документация Kubernetes. — URL: https://kubernetes.io/ru/docs/', 'https://kubernetes.io/ru/docs/', 'verified', 'kubernetes devops'],
    ['web', 'Документация GitLab CI/CD. — URL: https://docs.gitlab.com/ee/ci/', 'https://docs.gitlab.com/ee/ci/', 'verified', 'ci/cd devops gitlab'],
    ['web', 'Документация GigaChat API. — URL: https://developers.sber.ru/docs/ru/gigachat/api/overview', 'https://developers.sber.ru/docs/ru/gigachat/api/overview', 'verified', 'ии нейросет gigachat учител'],
    ['web', 'Документация YandexGPT (Yandex Cloud Foundation Models). — URL: https://yandex.cloud/ru/docs/foundation-models/', 'https://yandex.cloud/ru/docs/foundation-models/', 'verified', 'ии нейросет yandexgpt учител'],
    ['web', 'Банк данных угроз безопасности информации ФСТЭК России. — URL: https://bdu.fstec.ru/', 'https://bdu.fstec.ru/', 'verified', 'безопасн кибер угроз'],
  ]);
  ins('INSERT INTO tool_registry (name, pattern, category, available_ru, deprecated, note) VALUES (?,?,?,?,?,?)', [
    ['GigaChat', 'gigachat|гигачат', 'ai_service', 1, 0, 'Сбер'],
    ['YandexGPT', 'yandexgpt|yandex gpt|алиса', 'ai_service', 1, 0, 'Яндекс'],
    ['Шедеврум', 'шедеврум', 'ai_service', 1, 0, 'Яндекс'],
    ['Kandinsky', 'kandinsky|кандинск', 'ai_service', 1, 0, 'Сбер'],
    ['DeepSeek', 'deepseek', 'ai_service', 1, 0, ''],
    ['Qwen', 'qwen', 'ai_service', 1, 0, ''],
    ['ChatGPT', 'chatgpt|chat gpt|openai|gpt-4|gpt-3', 'ai_service', 0, 0, 'OpenAI: недоступен из России напрямую'],
    ['Claude', '\\bclaude\\b|anthropic', 'ai_service', 0, 0, 'Anthropic: недоступен из России напрямую'],
    ['Gemini', 'gemini|google bard', 'ai_service', 0, 0, 'Google: недоступен из России напрямую'],
    ['Midjourney', 'midjourney', 'ai_service', 0, 0, 'недоступен из России напрямую'],
    ['Copilot', 'copilot', 'ai_service', 0, 0, 'Microsoft: недоступен из России напрямую'],
    ['Python 2', 'python 2\\b|python2', 'software', null, 1, 'не поддерживается с 2020 года'],
    ['Theano', 'theano', 'library', null, 1, 'развитие прекращено'],
    ['pandas.append', 'dataframe\\.append|df\\.append', 'library', null, 1, 'удалён в pandas 2.0, используйте pd.concat'],
  ]);
}
seed();

const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
  id: (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid),
  tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
};

module.exports = { db, q, DATA_DIR };
