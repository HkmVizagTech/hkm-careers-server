/**
 * Screening questions set per job (e.g. "Can you work on weekends?") and the applicant's answers.
 * A question can have "required answers" (knock-out): answers that don't match are flagged for HR,
 * never auto-rejected.
 */
const TYPES = ['text', 'paragraph', 'yesno', 'choice', 'number'];
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Tidy the questions an admin saved on a job. */
function normalizeQuestions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((q) => {
      const type = TYPES.includes(q?.type) ? q.type : 'text';
      const label = clean(q?.label, 200);
      if (!label) return null;
      const out = { label, type, required: q?.required !== false };
      if (q?._id && /^[0-9a-f]{24}$/i.test(String(q._id))) out._id = q._id;
      if (type === 'choice') {
        const seen = new Set();
        out.options = (Array.isArray(q.options) ? q.options : [])
          .map((o) => clean(o, 100))
          .filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()))
          .slice(0, 12);
        if (out.options.length < 2) return null;
        out.accept = (Array.isArray(q.accept) ? q.accept : []).filter((a) => out.options.includes(a));
        if (out.accept.length === out.options.length) out.accept = []; // everything acceptable = no knock-out
      } else if (type === 'yesno') {
        out.accept = ['yes', 'no'].includes(q?.accept?.[0]) ? [q.accept[0]] : [];
      } else if (type === 'number') {
        const min = q?.min === '' || q?.min == null ? null : Number(q.min);
        const max = q?.max === '' || q?.max == null ? null : Number(q.max);
        if (Number.isFinite(min)) out.min = min;
        if (Number.isFinite(max)) out.max = max;
      }
      return out;
    })
    .filter(Boolean)
    .slice(0, 15);
}

/** Does an answer meet the job's requirement? undefined when the question has no requirement. */
function meetsRequirement(q, value) {
  if (q.type === 'yesno' || q.type === 'choice') {
    if (!q.accept?.length) return undefined;
    return q.accept.includes(value);
  }
  if (q.type === 'number' && (q.min != null || q.max != null)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    return (q.min == null || n >= q.min) && (q.max == null || n <= q.max);
  }
  return undefined;
}

/**
 * Check the applicant's answers against the job's questions.
 * @returns {{ error?: string, answers: object[], flags: string[] }}
 */
function gradeAnswers(questions, raw) {
  let given = raw;
  if (typeof raw === 'string') {
    try {
      given = JSON.parse(raw || '{}');
    } catch {
      given = {};
    }
  }
  given = given && typeof given === 'object' ? given : {};
  const answers = [];
  const flags = [];
  for (const q of questions || []) {
    const id = String(q._id);
    let value = given[id];
    value = value == null ? '' : String(value).trim().slice(0, q.type === 'paragraph' ? 3000 : 300);
    if (q.type === 'yesno' && value) value = value.toLowerCase() === 'yes' ? 'yes' : value.toLowerCase() === 'no' ? 'no' : '';
    if (q.type === 'choice' && value && !(q.options || []).includes(value)) value = '';
    if (q.type === 'number' && value && !Number.isFinite(Number(value))) value = '';
    if (!value) {
      if (q.required) return { error: `Please answer: ${q.label}`, answers: [], flags: [] };
      continue;
    }
    const meets = meetsRequirement(q, value);
    if (meets === false) flags.push(q.label);
    answers.push({ question: q._id, label: q.label, type: q.type, value, meets });
  }
  return { answers, flags };
}

module.exports = { normalizeQuestions, gradeAnswers, meetsRequirement, TYPES };
