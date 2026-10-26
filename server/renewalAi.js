import { claude } from './ai.js';
import { CAREFUL_MODEL } from './config.js';
import { parseJson } from './leaseRenewalAi.js';

// What Reem reads of the papers a PRO brings back for a renewal case (a new visa, a signed
// contract), and its check of them against what was approved. Reem reads and flags; it never
// verifies. HR ticks Verified on the case page, even when nothing is flagged, and anything Reem
// is not sure of is held for HR rather than guessed.

const block = ({ mime, data }) => (mime === 'application/pdf'
  ? { type: 'document', source: { type: 'base64', media_type: mime, data } }
  : { type: 'image', source: { type: 'base64', media_type: mime, data } });

async function claudeJson(system, content) {
  const res = await claude.messages.create({ model: CAREFUL_MODEL, max_tokens: 800, system, messages: [{ role: 'user', content }] });
  return parseJson(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

const READ = `You read one UAE employment or immigration paper (a residence visa, Emirates ID, passport, labour card, or a labour contract) for HR.
Answer with JSON only:
{"name": string|null, "employee_code": string|null, "passport_no": string|null, "start": "YYYY-MM-DD"|null, "end": "YYYY-MM-DD"|null,
 "basic": number|null, "allowance": number|null, "total": number|null,
 "position": string|null, "location": string|null, "hours": string|null, "benefits": string|null,
 "signed": true|false|null, "confidence": "high"|"low"}
- name: the person it is for, as written. employee_code only if a company staff code (like E00056) is printed.
- start / end: the paper's start or issue date and its end or expiry date. UAE papers write dates as DD/MM/YYYY.
- basic / allowance / total: monthly AED amounts, only on a contract. allowance is all allowances together (housing, transport, other).
- position / location / hours / benefits, only on a contract: the job title, the work location, the working hours, and the
  other benefits (air ticket, leave, medical, accommodation...) in a few words, all in English as the contract states them.
- signed: on a contract, true only when both sides' signatures are visible; false when the signature lines are empty; null if you cannot tell or it is not a contract.
- confidence: "low" when the paper is blurred, cut off, in a language you cannot read, or any field above is a guess.
Never guess: null when a value is not clearly there.`;

const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const text = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** What the paper says, in one fixed shape. `ask` replaces Claude in tests. */
export async function readReturnedDoc({ mime, data }, { ask = claudeJson } = {}) {
  const r = await ask(READ, [block({ mime, data }), { type: 'text', text: 'Read this paper.' }]);
  return {
    name: text(r.name), employee_code: text(r.employee_code), passport_no: text(r.passport_no),
    start: date(r.start), end: date(r.end),
    basic: num(r.basic), allowance: num(r.allowance), total: num(r.total),
    position: text(r.position), location: text(r.location), hours: text(r.hours), benefits: text(r.benefits, 300),
    signed: typeof r.signed === 'boolean' ? r.signed : null,
    confidence: r.confidence === 'high' ? 'high' : 'low',
  };
}

const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
// One name written shorter or longer than the other ("Abdul Karim Khan" / "Abdul Karim Jan Khan") is the same person.
function sameName(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return true; // nothing to compare: not a mismatch, the code and HR decide
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 ? short.every((w) => long.includes(w)) : long.includes(short[0]);
}

/** What does not match the approved case. ok only when nothing is flagged and Reem is sure. */
export function checkAgainstCase(read, c, { contract }) {
  const problems = [];
  const t = c.proposal?.terms || {};
  if (read.confidence !== 'high') problems.push('Reem is not sure of what it read: check the paper yourself');
  if (read.name && c.employee_name && !sameName(read.name, c.employee_name)) {
    problems.push(`The paper is for ${read.name}, not ${c.employee_name}`);
  }
  if (read.employee_code && c.employee_code && read.employee_code.toLowerCase() !== c.employee_code.toLowerCase()) {
    problems.push(`The paper has staff code ${read.employee_code}, not ${c.employee_code}`);
  }
  if (c.kind === 'renew') {
    const want = contract ? t.new_end : t.expected_expiry;
    if (!read.end) problems.push('No end or expiry date could be read');
    else if (want && read.end !== want) problems.push(`It runs to ${read.end}, but ${want} was approved`);
    if (contract) {
      if (read.signed === false) problems.push('The contract is not signed');
      else if (read.signed !== true) problems.push('Reem cannot tell whether the contract is signed');
      for (const k of ['basic', 'allowance']) {
        if (read[k] !== null && t[k] !== undefined && read[k] !== t[k]) problems.push(`${k} ${read[k]} on the paper, ${t[k]} approved`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
