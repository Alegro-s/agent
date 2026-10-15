'use strict';
const fs = require('fs'); const path = require('path');
const BASE = process.argv[2] || 'http://localhost:8787';
const api = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(p + ': ' + j.error); return j; };
const wait = async id => { for (;;) { const j = await api('GET', '/api/jobs/' + id); if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 500)); } };
const ANSWERS_Q4 = { program_kind: 'Повышение квалификации', hours: '72 часа', audience: 'Студенты 3 курса специальности «Информационные системы и программирование», знают основы сетей и Linux', form: 'Очная, занятия на базе колледжа', final_attestation: 'Экзамен с практическим заданием на стенде' };
(async () => {
  const presets = await api('GET', '/api/presets');
  const only = process.argv[3] ? process.argv[3].split(',') : null;
  for (const p of presets) {
    if (only && !only.includes(p.id)) continue;
    const t0 = Date.now();
    const files = p.id === 'Q5' ? [{ name: 'Стажировка БСА 248ч.docx', data: fs.readFileSync(path.join(__dirname, 'ref-internship-248.docx')).toString('base64') }]
      : p.id === 'Q3' ? [{ name: 'Прошлая программа.docx', data: fs.readFileSync(path.join(__dirname, 'ref-dop-24.docx')).toString('base64') }] : [];
    let { id, job } = await api('POST', '/api/requests', { text: p.text, files });
    let j = await wait(job);
    let r = await api('GET', '/api/requests/' + id);
    if (r.status === 'clarifying') {
      console.log(`${p.id}: вопросы (${r.questions.length}):`, r.questions.map(x => x.param_key).join(', '));
      const answers = Object.fromEntries(r.questions.map(x => [x.ord, ANSWERS_Q4[x.param_key] || 'на ваше усмотрение']));
      j = await wait((await api('POST', `/api/requests/${id}/answers`, { answers })).job);
      r = await api('GET', '/api/requests/' + id);
    }
    if (!r.version_id) { console.log(p.id, 'FAIL', j.error, j.log.slice(-3)); continue; }
    const tSk = Date.now() - t0;
    const a = await api('POST', `/api/versions/${r.version_id}/approve`);
    j = await wait(a.job);
    const b = await api('GET', '/api/versions/' + r.version_id);
    const files2 = await api('GET', `/api/versions/${r.version_id}/files`);
    const iss = b.check_report.issues;
    console.log(`${p.id}: ${b.program.kind} ${b.plan.grand_total}/${b.program.hours} ч · ЛК ${b.plan.totals.lk} ПР ${b.plan.totals.pr} СРС ${b.plan.totals.srs} ИА ${b.final_attestation.hours} · недель ${Math.max(...b.plan.calendar.map(c => c.week))} · модулей ${b.plan.modules.length} · каркас ${Math.round(tSk / 1000)}с, всего ${Math.round((Date.now() - t0) / 1000)}с · job ${j.status}`);
    console.log('   ошибки:', iss.filter(i => i.severity === 'error').map(i => `${i.rule} ${i.message}`));
    console.log('   прочее:', iss.filter(i => i.severity !== 'error').map(i => `${i.rule}`).join(' '), '· файлы:', files2.map(f => f.format).join(','));
    for (const i of iss.filter(i => ['V15', 'V18'].includes(i.rule))) console.log('   ', i.rule, i.message);
  }
})().catch(e => { console.error(e); process.exit(1); });
