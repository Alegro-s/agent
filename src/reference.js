'use strict';
const { mammoth } = require('../vendor/libs.cjs');

const decode = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const ITOGO = /^итого(\s|\(|:|$)/i;
const num = s => { const m = String(s).replace(',', '.').match(/^-?\d+(\.\d+)?$/); return m ? parseFloat(m[0]) : null; };

function tablesFromHtml(html) {
  const tables = [];
  for (const t of html.match(/<table[\s\S]*?<\/table>/g) || []) {
    const rows = (t.match(/<tr[\s\S]*?<\/tr>/g) || []).map(r => (r.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(decode));
    tables.push(rows);
  }
  return tables;
}

function analysePlans(tables) {
  const issues = [];
  const plans = [];
  const label = { total: 'всего', lk: 'ЛК', pr: 'ПР', lb: 'ЛБ', srs: 'СРС' };
  const fmtRow = o => Object.keys(label).filter(k => o[k] != null).map(k => `${label[k]} ${o[k]}`).join(', ');
  let planNo = 0;
  for (const rows of tables) {
    const hi = rows.findIndex(r => r.some(c => /^(ЛК|Лекции)/i.test(c)) && r.some(c => /^(ПР|Практ)/i.test(c)) && r.some(c => /СРС|Самостоят/i.test(c)));
    if (hi < 0) continue;
    const header = rows[hi];
    const col = {};
    header.forEach((c, i) => {
      if (/трудо[её]мкость|^всего$/i.test(c) && col.total == null) col.total = i;
      if (/^ЛК|^Лекции/i.test(c)) col.lk = i;
      if (/^ПР|^Практ/i.test(c)) col.pr = i;
      if (/^ЛБ|^Лаб/i.test(c)) col.lb = i;
      if (/СРС|Самостоят/i.test(c)) col.srs = i;
    });
    const val = (r, k) => { if (col[k] == null) return null; const shift = header.length - r.length; const v = num(r[col[k] - Math.max(0, shift)] ?? ''); return v; };
    const rowObj = r => Object.fromEntries(Object.keys(label).map(k => [k, val(r, k)]));
    const body = rows.slice(hi + 1);
    const totalRow = body.find(r => ITOGO.test(r[0] || ''));
    const name = ++planNo === 1 ? 'учебном плане' : 'учебно-тематическом плане';
    const top = body.filter(r => /^\d+\.?$/.test((r[0] || '').trim()) || /аттестац/i.test(r[0] || ''));
    const sum = (rs, k) => rs.reduce((a, r) => a + (val(r, k) || 0), 0);
    if (totalRow) {
      const t = rowObj(totalRow);
      const bad = Object.keys(label).filter(k => t[k] != null && Math.abs(t[k] - sum(top, k)) > 0.01);
      if (bad.length) issues.push(`в ${name} итоговая строка (${fmtRow(t)}) не сходится со строками разделов (${bad.map(k => `${label[k]} ${sum(top, k)}`).join(', ')}).`);
      plans.push({ header, total: t });
    }
    // раздел = сумма его тем
    for (const parent of body.filter(r => /^\d+\.?$/.test((r[0] || '').trim()))) {
      const n = (parent[0] || '').replace('.', '').trim();
      const kids = body.filter(r => new RegExp('^' + n + '\\.\\d+\\.?$').test((r[0] || '').trim()));
      if (!kids.length) continue;
      const p = rowObj(parent);
      const bad = Object.keys(label).filter(k => p[k] != null && Math.abs(p[k] - sum(kids, k)) > 0.01);
      if (bad.length) issues.push(`в ${name} раздел ${n} (${fmtRow(p)}) не равен сумме своих тем (${bad.map(k => `${label[k]} ${sum(kids, k)}`).join(', ')}).`);
    }
  }
  return { plans, issues: [...new Set(issues)] };
}

function headings(text) {
  return text.split('\n').map(s => s.trim()).filter(s => /^(\d+(\.\d+)*\.?)\s+[А-ЯA-Z]/.test(s) && s.length < 140).slice(0, 60);
}

async function parseFile(filename, buffer) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.docx')) {
    const [{ value: html }, { value: text }] = await Promise.all([mammoth.convertToHtml({ buffer }), mammoth.extractRawText({ buffer })]);
    const tables = tablesFromHtml(html);
    const { plans, issues } = analysePlans(tables);
    return { text, structure: { headings: headings(text), plans, issues, tables: tables.length } };
  }
  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    const text = buffer.toString('utf8');
    return { text, structure: { headings: headings(text), plans: [], issues: [] } };
  }
  if (lower.endsWith('.pdf')) {
    return { text: '', structure: { headings: [], plans: [], issues: [], note: 'PDF сохранён, извлечение текста в MVP не поддерживается — приложите .docx' } };
  }
  throw new Error('Поддерживаются .docx, .txt, .md, .pdf');
}

module.exports = { parseFile, analysePlans, tablesFromHtml };
