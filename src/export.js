'use strict';
const fs = require('fs');
const path = require('path');
const { docx, PptxGenJS } = require('../vendor/libs.cjs');
const { q, DATA_DIR } = require('./db');
const { bundle } = require('./repo');

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, BorderStyle, PageBreak, ShadingType,
} = docx;

const ORG = process.env.EDU_ORG || 'Автономная некоммерческая организация дополнительного профессионального образования «Академия цифрового развития»';
const CITY = process.env.EDU_CITY || 'Магас';
const fmt = n => (n == null ? '' : String(Math.round(n * 10) / 10).replace('.', ','));
const KIND_RU = { pk: 'ДОПОЛНИТЕЛЬНАЯ ПРОФЕССИОНАЛЬНАЯ ПРОГРАММА\nПОВЫШЕНИЯ КВАЛИФИКАЦИИ', pk_internship: 'ДОПОЛНИТЕЛЬНАЯ ПРОФЕССИОНАЛЬНАЯ ПРОГРАММА\nПОВЫШЕНИЯ КВАЛИФИКАЦИИ В ФОРМЕ СТАЖИРОВКИ', dop: 'ДОПОЛНИТЕЛЬНАЯ ОБЩЕОБРАЗОВАТЕЛЬНАЯ\nОБЩЕРАЗВИВАЮЩАЯ ПРОГРАММА' };
const ACT = { lk: 'лекция', pr: 'практика', lb: 'лаб. работа', srs: 'СРС', attestation: 'итоговая аттестация' };

const P = (text, o = {}) => new Paragraph({
  alignment: o.align, spacing: { after: o.after ?? 120, line: 300 }, heading: o.heading, indent: o.indent ? { firstLine: 567 } : undefined,
  children: String(text ?? '').split('\n').flatMap((line, i) => [...(i ? [new TextRun({ break: 1 })] : []), new TextRun({ text: line, bold: o.bold, size: o.size || 24, font: 'Times New Roman', italics: o.italic, color: o.color })]),
});
const H1 = t => P(t, { bold: true, size: 26, after: 160, heading: HeadingLevel.HEADING_1 });
const H2 = t => P(t, { bold: true, size: 24, after: 120, heading: HeadingLevel.HEADING_2 });
const border = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const cell = (t, o = {}) => new TableCell({
  columnSpan: o.span, width: o.w ? { size: o.w, type: WidthType.PERCENTAGE } : undefined,
  shading: o.head ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E8F5E1' } : undefined,
  borders: { top: border, bottom: border, left: border, right: border },
  children: [new Paragraph({ alignment: o.center ? AlignmentType.CENTER : AlignmentType.LEFT, children: [new TextRun({ text: String(t ?? ''), bold: o.bold || o.head, size: o.size || 20, font: 'Times New Roman' })] })],
});
const table = (rows, widths) => new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: rows.map((r, ri) => new TableRow({ tableHeader: ri === 0, children: r.map((c, ci) => (c instanceof TableCell ? c : cell(c, { head: ri === 0, w: widths?.[ci], center: ci > 1 && ri > 0 }))) })) });

function planTable(b, withTopics) {
  const dop = b.meta.template === 'dop';
  const head = dop ? ['№', 'Наименование модулей и тем', 'Всего', 'Аудиторных', 'Лекции', 'Практика', 'СРС', 'Форма контроля']
    : ['№', 'Наименование разделов' + (withTopics ? ', тем' : ''), 'Всего, ч', 'ЛК', 'ПР', 'ЛБ', 'СРС', 'Форма аттестации'];
  const row = (code, name, h, form, bold) => {
    const vals = dop ? [code, name, fmt(h.total), fmt(h.lk + h.pr + h.lb), fmt(h.lk), fmt(h.pr + h.lb), fmt(h.srs), form || '']
      : [code, name, fmt(h.total), fmt(h.lk), fmt(h.pr), fmt(h.lb), fmt(h.srs), form || ''];
    return vals.map((v, i) => cell(v, { bold, center: i > 1 && i < 7 }));
  };
  const rows = [head];
  for (const m of b.plan.modules) {
    rows.push(row(m.code, (m.kind === 'intro' ? 'Вводный модуль. ' : 'Модуль ' + m.code + '. ') + m.title.replace(/^Вводный модуль[:.]?\s*/i, ''), m.hours, m.control_form, true));
    if (withTopics) for (const t of m.topics) rows.push(row(t.code, 'Тема ' + t.code + '. ' + t.title, t.hours, ''));
  }
  const fa = b.final_attestation;
  const z = { total: fa.hours, lk: 0, pr: 0, lb: 0, srs: 0 };
  rows.push(row('', 'Итоговая аттестация', z, fa.form, true));
  const T = b.plan.totals;
  rows.push(row('', 'Итого', { total: b.plan.grand_total, lk: T.lk, pr: T.pr, lb: T.lb, srs: T.srs }, '', true));
  return table(rows, [6, 40, 9, 9, 8, 8, 8, 12]);
}

function calendarTable(b) {
  const weeks = new Map();
  for (const s of b.plan.calendar) {
    const w = weeks.get(s.week) || { days: new Set(), hours: 0, topics: new Set(), acts: {} };
    w.days.add(s.day); w.hours += s.hours; if (s.topic) w.topics.add(s.topic); else w.topics.add('ИА');
    w.acts[s.activity] = (w.acts[s.activity] || 0) + s.hours; weeks.set(s.week, w);
  }
  const rows = [['Неделя', 'Дней/занятий', 'Часов', 'Виды работ', 'Темы']];
  for (const [w, x] of [...weeks.entries()].sort((a, b) => a[0] - b[0]))
    rows.push([String(w), String(x.days.size), fmt(x.hours), Object.entries(x.acts).map(([a, h]) => `${ACT[a]} ${fmt(h)}`).join(', '), [...x.topics].join(', ')]);
  return table(rows, [10, 14, 10, 30, 36]);
}

function resultsTable(b) {
  const rows = [['Компетенция', 'Трудовая функция', 'Знания', 'Умения', 'Навыки / опыт']];
  for (const c of b.competencies) {
    const by = k => c.outcomes.filter(o => (Array.isArray(k) ? k.includes(o.kind) : o.kind === k)).map(o => `${o.id} ${o.text}`).join('\n');
    rows.push([`${c.code}. ${c.title}`, c.standard ? `${c.standard.function_code || 'код ТФ уточнить'} ${c.standard.function_title || ''}${c.standard.verified ? '' : ' [требует проверки]'}` : '—', by('knowledge'), by('skill'), by(['ability', 'experience'])]);
  }
  return table(rows, [22, 18, 20, 20, 20]);
}

async function toDocx(vid) {
  const b = bundle(vid);
  const dop = b.meta.template === 'dop';
  const s = b.program.sections;
  const ch = [];
  ch.push(P(ORG, { align: AlignmentType.CENTER, bold: true }));
  ch.push(P('', { after: 400 }));
  ch.push(P('УТВЕРЖДЕНО\nПриказом № ________ от «____» ______________ 20___ г.', { align: AlignmentType.RIGHT, after: 1600 }));
  ch.push(P(KIND_RU[b.program.kind], { align: AlignmentType.CENTER, bold: true, size: 28 }));
  ch.push(P(`«${b.program.title}»`, { align: AlignmentType.CENTER, bold: true, size: 32, after: 400 }));
  ch.push(P(`Объём: ${fmt(b.program.hours)} академических часов`, { align: AlignmentType.CENTER }));
  ch.push(P(`${CITY} ${new Date().getFullYear()}`, { align: AlignmentType.CENTER }));
  ch.push(new Paragraph({ children: [new PageBreak()] }));

  const sec = (code, title, extra) => { ch.push(H2(`${code} ${title}`)); if (s[code]) ch.push(P(s[code], { indent: true })); if (extra) [].concat(extra).forEach(x => ch.push(x)); };
  if (dop) {
    ch.push(H1('1. Пояснительная записка'));
    ch.push(P(s['1'] || '', { indent: true }));
    sec('1.1', 'Актуальность программы'); sec('1.2', 'Категории обучающихся'); sec('1.3', 'Цель и задачи программы'); sec('1.4', 'Сроки реализации');
    ch.push(H2('1.5 Планируемые результаты обучения')); ch.push(resultsTable(b));
    sec('1.6', 'Календарный учебный график', [calendarTable(b)]);
    ch.push(H1('2. Содержание программы'));
    ch.push(H2('2.1 Учебный план')); ch.push(planTable(b, false));
  } else {
    ch.push(H1('1. Общая характеристика программы'));
    sec('1.1', 'Аннотация программы'); sec('1.2', 'Цель реализации программы');
    ch.push(H2('1.3 Планируемые результаты обучения')); ch.push(resultsTable(b));
    sec('1.4', 'Программа разработана на основе'); sec('1.5', 'Перечень профессиональных компетенций'); sec('1.6', 'Требования к слушателям');
    sec('1.7', 'Форма обучения'); sec('1.8', 'Объём программы'); sec('1.9', 'Выдаваемый документ');
    ch.push(H1('2. Содержание программы'));
    ch.push(H2('2.1 Учебный план')); ch.push(planTable(b, false));
  }
  ch.push(H2('2.2 Учебно-тематический план')); ch.push(planTable(b, true));
  ch.push(P('', { after: 120 }));
  for (const m of b.plan.modules) {
    ch.push(P(`${m.kind === 'intro' ? 'Вводный модуль' : 'Модуль ' + m.code}. ${m.title}`, { bold: true }));
    for (const t of m.topics) {
      ch.push(P(`Тема ${t.code}. ${t.title} (${[t.hours.lk && `лекции ${fmt(t.hours.lk)} ч`, t.hours.pr && `практика ${fmt(t.hours.pr)} ч`, t.hours.lb && `лаб. ${fmt(t.hours.lb)} ч`, t.hours.srs && `СРС ${fmt(t.hours.srs)} ч`].filter(Boolean).join(', ')})`, { bold: true, size: 22 }));
      ch.push(P(t.content, { indent: true, size: 22 }));
      for (const st of t.seminar_tasks) ch.push(P(`Практическое задание «${st.title}». ${st.situation ? st.situation + ' ' : ''}${st.instructions}${st.deliverable ? ' Результат: ' + st.deliverable + '.' : ''}\nКритерии оценки: ${st.criteria.join('; ')}.`, { size: 22, italic: true }));
    }
  }
  if (!dop) { ch.push(H2('2.3 Календарный учебный график')); ch.push(calendarTable(b)); sec('2.4', 'Рабочая программа'); }
  const fa = b.final_attestation;
  ch.push(H2(dop ? '2.3 Оценочные материалы' : '2.5 Оценка качества освоения программы'));
  ch.push(P(dop ? s['2.3'] : s['2.5'], { indent: true }));
  ch.push(P('Итоговая аттестация', { bold: true }));
  ch.push(P([`Форма: ${fa.form} (${fmt(fa.hours)} ч).`, fa.description, fa.requirements && 'Требования: ' + fa.requirements, fa.procedure && 'Процедура: ' + fa.procedure, fa.example_task && 'Пример задания: ' + fa.example_task, fa.pass_rule].filter(Boolean).join('\n'), { indent: true }));
  if (fa.criteria.length) ch.push(table([['Критерий', 'Баллы', 'Результаты обучения'], ...fa.criteria.map(c => [c.text, c.max_points ?? '', (c.outcomes || []).join(', ')])], [60, 12, 28]));
  if (dop) { ch.push(H2('2.4 Методические материалы')); ch.push(P(s['2.4'] || '', { indent: true })); }

  ch.push(H1('3. Организационно-педагогические условия реализации программы'));
  ch.push(H2(dop ? '3.1 Материально-технические условия' : '3.1 Материально-техническое обеспечение')); ch.push(P(s['3.1'] || '', { indent: true }));
  ch.push(H2('3.2 Учебно-методическое и информационное обеспечение'));
  const groups = { normative: 'Нормативные документы', main: 'Основная литература', web: 'Интернет-ресурсы' };
  for (const [k, title] of Object.entries(groups)) {
    const list = b.sources.filter(x => x.section === k);
    if (!list.length) continue;
    ch.push(P(title, { bold: true }));
    list.forEach((x, i) => ch.push(P(`${i + 1}. ${x.text}${x.verified ? '' : ' [источник не подтверждён — проверьте]'}`, { size: 22 })));
  }
  if (!dop) { ch.push(H2('3.3 Организация образовательного процесса')); ch.push(P(s['3.3'] || '', { indent: true })); }
  ch.push(H2('3.4 Кадровое обеспечение'));
  ch.push(table([['№', 'Модуль', 'ФИО преподавателя', 'Уч. степень / звание', 'Должность'], ...b.plan.modules.map((m, i) => [String(i + 1), `${m.code}. ${m.title}`, '', '', ''])], [6, 40, 22, 16, 16]));

  ch.push(new Paragraph({ children: [new PageBreak()] }));
  ch.push(H1('Приложение 1. Оценочные материалы текущего контроля'));
  for (const m of b.plan.modules) if (m.interview_questions.length) {
    ch.push(P(`Вопросы для собеседования — ${m.code}. ${m.title}`, { bold: true }));
    m.interview_questions.forEach((x, i) => ch.push(P(`${i + 1}. ${x.text} [${x.outcomes.join(', ')}]`, { size: 22 })));
  }
  for (const t of b.assessment.tests) {
    ch.push(P(t.title, { bold: true }));
    t.questions.forEach((x, i) => {
      ch.push(P(`${i + 1}. ${x.text} [${x.outcomes.join(', ')}]`, { size: 22 }));
      x.options.forEach((o, k) => ch.push(P(`   ${'абвгд'[k]}) ${o.text}`, { size: 22 })));
    });
    ch.push(P('Ключи: ' + t.questions.map((x, i) => `${i + 1}–${'абвгд'[x.options.findIndex(o => o.correct)]}`).join(', '), { size: 22, italic: true }));
  }

  const doc = new Document({ creator: 'ИИ-методист «Точка сборки»', title: b.program.title, styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } }, sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1701, right: 850 } } }, children: ch }] });
  return Packer.toBuffer(doc);
}

const C = { bg: '0A0A0A', card: '131313', lime: '88EF1B', green: '00B000', white: 'F0F0F0', gray: '777777', light: 'BFEBBF' };
async function toPptx(vid) {
  const b = bundle(vid);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = b.program.title;
  const lectures = b.plan.modules.flatMap(m => m.topics.filter(t => t.lecture).map(t => ({ m, t })));
  const cover = pptx.addSlide();
  cover.background = { color: C.bg };
  cover.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 0.5, w: 12.3, h: 6.5, fill: { color: C.card }, rectRadius: 0.4, line: { color: '222222' } });
  cover.addShape(pptx.ShapeType.roundRect, { x: 0.9, y: 0.9, w: 2.6, h: 0.5, fill: { color: C.lime }, rectRadius: 0.25 });
  cover.addText(`${fmt(b.program.hours)} ч · ${lectures.length} лекц.`, { x: 0.9, y: 0.9, w: 2.6, h: 0.5, fontSize: 14, bold: true, color: '0A0A0A', align: 'center', fontFace: 'Arial' });
  cover.addText(b.program.title, { x: 0.9, y: 2.2, w: 11.4, h: 2, fontSize: 44, bold: true, color: C.white, fontFace: 'Arial' });
  cover.addText('Презентации к лекциям', { x: 0.9, y: 4.3, w: 11, h: 0.6, fontSize: 20, color: C.light, fontFace: 'Arial' });
  for (const { m, t } of lectures) {
    t.lecture.slides.forEach((s, i) => {
      const sl = pptx.addSlide();
      sl.background = { color: C.bg };
      sl.addShape(pptx.ShapeType.rect, { x: 0, y: 7.3, w: 13.33, h: 0.2, fill: { type: 'solid', color: C.green } });
      sl.addText(`Тема ${t.code} · ${m.title}`, { x: 0.6, y: 0.3, w: 9, h: 0.4, fontSize: 12, color: C.gray, fontFace: 'Arial' });
      sl.addText(`${i + 1}/${t.lecture.slides.length}`, { x: 11.5, y: 0.3, w: 1.2, h: 0.4, fontSize: 12, color: C.gray, align: 'right', fontFace: 'Arial' });
      if (i === 0) {
        sl.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 1.4, w: 12.1, h: 4.8, fill: { color: C.lime }, rectRadius: 0.4 });
        sl.addText(s.title, { x: 1.0, y: 1.8, w: 11.3, h: 2.2, fontSize: 40, bold: true, color: '0A0A0A', fontFace: 'Arial', valign: 'top' });
        sl.addText(s.bullets.join(' · '), { x: 1.0, y: 4.4, w: 11.3, h: 1.4, fontSize: 18, color: '131313', fontFace: 'Arial', valign: 'top' });
      } else {
        sl.addText(s.title, { x: 0.6, y: 0.9, w: 12, h: 1, fontSize: 32, bold: true, color: C.white, fontFace: 'Arial' });
        sl.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 2.1, w: 12.1, h: 4.8, fill: { color: C.card }, rectRadius: 0.3, line: { color: '262626' } });
        sl.addText(s.bullets.map(x => ({ text: x, options: { bullet: { code: '25CF' }, color: C.white, breakLine: true } })), { x: 1.0, y: 2.4, w: 11.3, h: 4.2, fontSize: 22, fontFace: 'Arial', valign: 'top', paraSpaceAfter: 10 });
      }
      if (s.notes) sl.addNotes(s.notes);
    });
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

const giftEsc = s => String(s).replace(/([~=#{}:\\])/g, '\\$1');
function toGift(vid) {
  const b = bundle(vid);
  return b.assessment.tests.map(t => `// ${t.title}\n$CATEGORY: ${giftEsc(b.program.title)}/${giftEsc(t.title)}\n\n` + t.questions.map((x, i) =>
    `::${t.id}-${i + 1} [${x.outcomes.join(',')}]::${giftEsc(x.text)} {\n${x.options.map(o => `  ${o.correct ? '=' : '~'}${giftEsc(o.text)}`).join('\n')}\n${x.explanation ? `  ####${giftEsc(x.explanation)}\n` : ''}}\n`).join('\n')).join('\n');
}
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function toMoodleXml(vid) {
  const b = bundle(vid);
  const items = b.assessment.tests.flatMap(t => t.questions.map((x, i) => `  <question type="multichoice">
    <name><text>${xmlEsc(`${t.id}-${i + 1} ${x.outcomes.join(',')}`)}</text></name>
    <questiontext format="html"><text><![CDATA[${x.text}]]></text></questiontext>
    <generalfeedback><text><![CDATA[${x.explanation || ''}]]></text></generalfeedback>
    <single>true</single><shuffleanswers>true</shuffleanswers>
${x.options.map(o => `    <answer fraction="${o.correct ? 100 : 0}"><text><![CDATA[${o.text}]]></text></answer>`).join('\n')}
  </question>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<quiz>\n${items.join('\n')}\n</quiz>\n`;
}
function toCsv(vid) {
  const b = bundle(vid);
  const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['test', 'n', 'question', 'option_1', 'option_2', 'option_3', 'option_4', 'correct', 'outcomes', 'explanation']];
  for (const t of b.assessment.tests) t.questions.forEach((x, i) => rows.push([t.title, i + 1, x.text, ...[0, 1, 2, 3].map(k => x.options[k]?.text || ''), x.options.findIndex(o => o.correct) + 1, x.outcomes.join(','), x.explanation]));
  return '﻿' + rows.map(r => r.map(esc).join(';')).join('\r\n');
}

async function exportAll(vid, formats = ['docx', 'pptx', 'json', 'gift', 'xml', 'csv']) {
  const b = bundle(vid);
  const slug = `${process.env.EDU_LLM === 'mock' ? 'demo-' : ''}program-${b.meta.request_id}-v${vid}r${b.meta.revision}-${Date.now().toString(36)}`;
  const dir = path.join(DATA_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  const save = (fmtName, ext, data) => { const p = path.join(dir, `${slug}.${ext}`); fs.writeFileSync(p, data); q.run('INSERT INTO export_artifact (version_id, format, path) VALUES (?,?,?)', vid, fmtName, p); out[fmtName] = path.basename(p); };
  if (formats.includes('docx')) save('docx', 'docx', await toDocx(vid));
  if (formats.includes('pptx') && b.plan.modules.some(m => m.topics.some(t => t.lecture))) save('pptx', 'pptx', await toPptx(vid));
  if (formats.includes('json')) save('json', 'json', JSON.stringify(b, null, 2));
  if (b.assessment.tests.length) {
    if (formats.includes('gift')) save('gift', 'gift.txt', toGift(vid));
    if (formats.includes('xml')) save('moodle_xml', 'moodle.xml', toMoodleXml(vid));
    if (formats.includes('csv')) save('csv', 'tests.csv', toCsv(vid));
  }
  q.run("UPDATE program_version SET status='exported' WHERE id=? AND status='checked'", vid);
  return out;
}

module.exports = { exportAll, toDocx, toPptx, toGift, toCsv, toMoodleXml };
