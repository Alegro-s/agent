'use strict';
const { q } = require('./db');
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const hours = r => ({ total: r.total, lk: r.lk, pr: r.pr, lb: r.lb, srs: r.srs });

function bundle(vid) {
  const v = q.get(`SELECT v.*, p.kind, p.title, p.direction, p.request_id, t.code tcode, t.document_issued, t.title ttitle, t.legal_basis
    FROM program_version v JOIN program p ON p.id=v.program_id JOIN template t ON t.id=p.template_id WHERE v.id=?`, vid);
  if (!v) return null;
  const outcomes = q.all('SELECT lo.*, c.code ccode FROM learning_outcome lo JOIN competency c ON c.id=lo.competency_id WHERE c.version_id=? ORDER BY c.ord, lo.id', vid);
  const oc = new Map(outcomes.map(o => [o.id, o.code]));
  const std = v.standard_id ? q.get('SELECT * FROM standard WHERE id=?', v.standard_id) : null;
  const competencies = q.all(`SELECT c.*, sf.code fcode, sf.title ftitle, sf.status fstatus FROM competency c
     LEFT JOIN standard_function sf ON sf.id=c.standard_function_id WHERE c.version_id=? ORDER BY c.ord`, vid).map(c => ({
    code: c.code, title: c.title, activity_type: c.activity_type || '',
    standard: std && v.kind !== 'dop' ? { code: std.code, title: std.title, function_code: c.fcode || null, function_title: c.ftitle || '', verified: std.status === 'verified' && c.fstatus === 'verified' } : null,
    outcomes: outcomes.filter(o => o.competency_id === c.id).map(o => ({
      id: o.code, kind: o.kind, text: o.text,
      topics: q.all('SELECT t.code FROM outcome_topic ot JOIN topic t ON t.id=ot.topic_id WHERE ot.outcome_id=?', o.id).map(x => x.code),
      assessed_by: q.all('SELECT tool_kind, tool_id FROM v_outcome_assessment WHERE outcome_id=?', o.id).map(x => `${x.tool_kind}:${x.tool_id}`),
    })),
  }));
  const modules = q.all('SELECT m.*, h.lk, h.pr, h.lb, h.srs, h.total FROM module m JOIN v_module_hours h ON h.module_id=m.id WHERE m.version_id=? ORDER BY m.ord', vid).map(m => ({
    id: m.id, code: m.code, kind: m.kind, title: m.title, planned_hours: m.planned_hours, needs_slides: !!m.needs_slides, control_form: m.control_form || '', hours: hours(m),
    interview_questions: q.all('SELECT * FROM interview_question WHERE module_id=? ORDER BY ord', m.id).map(x => ({ text: x.text, outcomes: q.all('SELECT outcome_id FROM interview_outcome WHERE question_id=?', x.id).map(r => oc.get(r.outcome_id)) })),
    topics: q.all('SELECT * FROM topic WHERE module_id=? ORDER BY ord', m.id).map(t => {
      const lp = q.get('SELECT * FROM lecture_plan WHERE topic_id=?', t.id);
      return {
        id: t.id, code: t.code, title: t.title, content: t.content || '', type: t.ttype, delivery: t.delivery, status: t.status, hours: hours(t),
        outcomes: q.all('SELECT outcome_id FROM outcome_topic WHERE topic_id=?', t.id).map(r => oc.get(r.outcome_id)),
        ...(lp ? { lecture: { goal: lp.goal, status: lp.status, outline: J(lp.outline) || [], slides: q.all('SELECT * FROM slide WHERE lecture_plan_id=? ORDER BY ord', lp.id).map(s => ({ title: s.title, bullets: J(s.bullets) || [], notes: s.notes || '' })) } } : {}),
        seminar_tasks: q.all('SELECT * FROM seminar_task WHERE topic_id=?', t.id).map(st => ({
          id: st.id, title: st.title, situation: st.situation || '', instructions: st.instructions, deliverable: st.deliverable || '',
          criteria: q.all('SELECT text FROM task_criterion WHERE task_id=? ORDER BY ord', st.id).map(x => x.text),
          outcomes: q.all('SELECT outcome_id FROM task_outcome WHERE task_id=?', st.id).map(r => oc.get(r.outcome_id)),
        })),
      };
    }),
  }));
  const vh = q.get('SELECT * FROM v_version_hours WHERE version_id=?', vid);
  const fa = q.get('SELECT * FROM final_attestation WHERE version_id=?', vid) || {};
  const tests = q.all('SELECT t.*, m.code mcode FROM test t LEFT JOIN module m ON m.id=t.module_id WHERE t.version_id=? ORDER BY t.id', vid).map(t => ({
    id: String(t.id), purpose: t.purpose, module: t.mcode || null, title: t.title,
    questions: q.all('SELECT * FROM test_question WHERE test_id=? ORDER BY ord', t.id).map(x => ({
      text: x.text, type: x.qtype, explanation: x.explanation || '',
      options: q.all('SELECT text, is_correct FROM question_option WHERE question_id=? ORDER BY ord', x.id).map(o => ({ text: o.text, correct: !!o.is_correct })),
      outcomes: q.all('SELECT outcome_id FROM question_outcome WHERE question_id=?', x.id).map(r => oc.get(r.outcome_id)),
    })),
  }));
  const run = q.get('SELECT * FROM check_run WHERE version_id=? ORDER BY id DESC LIMIT 1', vid);
  const issues = run ? q.all('SELECT rule_code rule, severity, entity_type entity, message FROM check_issue WHERE run_id=? ORDER BY id', run.id) : [];
  const tokens = q.get('SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) t, COALESCE(SUM(duration_ms),0) ms, COUNT(*) n, GROUP_CONCAT(DISTINCT model) models FROM generation_run WHERE request_id=?', v.request_id);
  const sections = Object.fromEntries(q.all('SELECT section_code, body FROM section_content WHERE version_id=?', vid).map(s => [s.section_code, s.body]));
  const templateSections = q.all('SELECT code, title, is_blank_field FROM template_section WHERE template_id=(SELECT template_id FROM program WHERE id=?) ORDER BY ord', v.program_id);
  return {
    meta: { schema_version: '1.0', generated_at: new Date().toISOString(), template: v.tcode, version_no: v.version_no, revision: v.revision, status: v.status, version_id: v.id, request_id: v.request_id,
      models: (tokens.models || '').split(',').filter(Boolean), tokens: tokens.t, llm_ms: tokens.ms, llm_calls: tokens.n },
    program: {
      kind: v.kind, title: v.title, direction: v.direction || '', hours: v.hours_requested, form: v.form, uses_dot: !!v.uses_dot,
      duration: Object.fromEntries(Object.entries({ weeks: v.duration_weeks, approx: !!v.duration_approx, max_hours_per_day: v.max_hours_per_day, lesson_hours: v.lesson_hours, lessons_per_week: v.lessons_per_week, days_per_week: v.days_per_week }).filter(([, x]) => x != null)),
      min_practice_share: v.min_practice_share, audience: v.audience || '', entry_requirements: v.entry_requirements || '', goal: v.goal || '', tasks: J(v.tasks) || [],
      document_issued: v.document_issued, template_title: v.ttitle, legal_basis: v.legal_basis,
      approval: { order_no: '', order_date: '', signatory: '' }, approved_at: v.approved_at,
      sections, template_sections: templateSections,
    },
    competencies,
    plan: {
      modules, totals: { total: vh.modules_total, lk: vh.lk, pr: vh.pr, lb: vh.lb, srs: vh.srs }, grand_total: vh.grand_total,
      calendar: q.all('SELECT cs.*, t.code tcode FROM calendar_slot cs LEFT JOIN topic t ON t.id=cs.topic_id WHERE cs.version_id=? ORDER BY day_no, cs.id', vid)
        .map(s => ({ day: s.day_no, week: s.week_no, topic: s.tcode || null, activity: s.activity, hours: s.hours })),
    },
    final_attestation: { form: fa.form || '', hours: fa.hours || 0, description: fa.description || '', requirements: fa.requirements || '', procedure: fa.procedure || '', example_task: fa.example_task || '', pass_rule: fa.pass_rule || '',
      criteria: q.all('SELECT * FROM attestation_criterion WHERE version_id=? ORDER BY ord', vid).map(c => ({ text: c.text, max_points: c.max_points, outcomes: q.all('SELECT outcome_id FROM attestation_outcome WHERE criterion_id=?', c.id).map(r => oc.get(r.outcome_id)) })) },
    assessment: { tests },
    sources: q.all('SELECT s.*, ps.section FROM program_source ps JOIN source s ON s.id=ps.source_id WHERE ps.version_id=? ORDER BY ps.ord', vid).map(s => ({ section: s.section, text: s.bibl_text, url: s.url || '', verified: s.status === 'verified' })),
    tools: q.all('SELECT tr.* FROM program_tool pt JOIN tool_registry tr ON tr.id=pt.tool_id WHERE pt.version_id=?', vid).map(t => ({ name: t.name, available_ru: t.available_ru, deprecated: !!t.deprecated, note: t.note })),
    teachers: modules.map(m => ({ module: m.code, full_name: '', degree: '', position: '' })),
    check_report: { passed: run ? !!run.passed : false, run_at: run ? run.started_at : null, issues },
    changes: q.all('SELECT * FROM change_request WHERE version_id=? ORDER BY id DESC', vid),
  };
}

module.exports = { bundle };
