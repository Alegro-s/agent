'use strict';

function distribute(total, weights, step = 0.5, minEach = 0) {
  const n = weights.length;
  if (!n) return [];
  const units = Math.round(total / step);
  const minU = Math.round(minEach / step);
  const w = weights.map(x => (x > 0 ? x : 1));
  const sw = w.reduce((a, b) => a + b, 0);
  const free = Math.max(0, units - minU * n);
  const raw = w.map(x => (x / sw) * free);
  const base = raw.map(Math.floor);
  let rest = free - base.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - base[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < rest; k++) base[order[k % n][1]] += 1;
  return base.map(b => (b + (units >= minU * n ? minU : 0)) * step);
}

const r05 = x => Math.round(x * 2) / 2;


function splitTopic(total, { kind, ttype, srsShare, practiceShare }) {
  if (kind === 'pk_internship') return { lk: 0, pr: 0, lb: 0, srs: total };
  let srs = ttype === 'project' && srsShare > 0 ? r05(total * Math.max(srsShare, 0.5)) : r05(total * srsShare);
  if (srs > total) srs = total;
  const contact = total - srs;
  let ps = practiceShare;
  if (ttype === 'theory') ps = Math.min(ps, 0.3);
  if (ttype === 'practice' || ttype === 'project') ps = 1;
  let pr = r05(contact * ps);
  if (pr > contact) pr = contact;
  const lk = contact - pr;
  return { lk, pr, lb: 0, srs };
}

function srsShareFor(form, usesDot) {
  if (form === 'zaochno') return 0.6;
  if (form === 'ochno_zaochno') return 0.35;
  return usesDot ? 0.2 : 0;
}

function enforcePracticeMin(topics, minHours) {
  let cur = topics.reduce((a, t) => a + t.pr + t.lb, 0);
  let guard = 0;
  while (cur < minHours && guard++ < 10000) {
    const t = topics.filter(x => x.lk >= 1).sort((a, b) => b.lk - a.lk)[0]
      || topics.filter(x => x.lk >= 0.5).sort((a, b) => b.lk - a.lk)[0];
    if (!t) break;
    t.lk -= 0.5; t.pr += 0.5; cur += 0.5;
  }
  return cur;
}

function buildCalendar(topics, faHours, o) {
  const slots = [];
  const queue = [];
  topics.forEach((t, i) => {
    for (const a of ['lk', 'pr', 'lb', 'srs']) if (t[a] > 0) queue.push({ i, a, h: t[a] });
  });
  const lessonMode = o.lessonHours && o.lessonsPerWeek;
  const cap = lessonMode ? o.lessonHours : (o.maxPerDay || 4);
  const perWeek = lessonMode ? o.lessonsPerWeek : (o.daysPerWeek || 5);
  let day = 1, used = 0;
  const push = (i, a, h) => {
    const last = slots[slots.length - 1];
    if (last && last.day === day && last.topicIndex === i && last.activity === a) last.hours += h;
    else slots.push({ day, week: Math.ceil(day / perWeek), topicIndex: i, activity: a, hours: h });
  };
  for (const item of queue) {
    let h = item.h;
    while (h > 1e-9) {
      if (used >= cap - 1e-9) { day++; used = 0; }
      const take = Math.min(h, cap - used);
      push(item.i, item.a, r05(take) || take);
      used += take; h -= take;
    }
  }
  if (faHours > 0) {
    let h = faHours;
    while (h > 1e-9) {
      if (used >= cap - 1e-9) { day++; used = 0; }
      const take = Math.min(h, cap - used);
      slots.push({ day, week: Math.ceil(day / perWeek), topicIndex: null, activity: 'attestation', hours: take });
      used += take; h -= take;
    }
  }
  return slots;
}

function daysPerWeekFor(totalHours, maxPerDay, weeks) {
  const days = Math.ceil(totalHours / (maxPerDay || 4));
  if (!weeks) return 5;
  return Math.min(7, Math.max(1, Math.ceil(days / weeks)));
}

module.exports = { distribute, splitTopic, srsShareFor, enforcePracticeMin, buildCalendar, daysPerWeekFor, r05 };
