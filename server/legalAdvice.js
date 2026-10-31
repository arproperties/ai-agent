import { claude } from './ai.js';
import { CAREFUL_MODEL } from './config.js';
import { parseJson } from './leaseRenewalAi.js';

// "Ask Reem" on a legal case (server/legalLease.js): Reem reads the case, its timeline,
// the lease file from saifsys and the checks, and helps the lawyer decide. It never
// decides: the settlement and case-status decisions stay with the people the flow names.
// Law and money are involved, so it is the careful model, figures come only from the
// facts, and any point of UAE law is put as something for the lawyer to confirm.

const MODEL = CAREFUL_MODEL;

const ADVISE = `You help the in-house legal team of a Dubai landlord (Saif Holding) decide what to do on one legal case about a tenancy.
You get the case (type, stage, what each stage recorded, its documents and timeline), the lease file from the company system saifsys
(rent, what is owed and overdue, cheques, payments, deposit, Ejari, violations, notices, saifsys's own legal desk), and checks the system already found.
Answer with JSON only:
{"summary": string, "position": "strong"|"fair"|"weak"|"unclear", "position_why": string,
 "wrong": [string], "next": [{"step": string, "who": string|null, "by": "YYYY-MM-DD"|null, "why": string}],
 "options": [{"option": string, "for": string, "against": string}], "missing": [string], "questions": [string]}
- summary: 2 to 4 short lines in plain English: who, what is owed or breached, where the case stands today.
- position: how strong the landlord's position looks ON THESE FACTS; position_why one line why.
- wrong: what is wrong, inconsistent or risky in the case or the lease file (a mismatch, a missing paper, a missed date,
  a renewal still running, an action taken out of order). Most serious first. Empty if nothing.
- next: the next 1 to 5 concrete steps, in order, for the stage the case is in. who: a role (lawyer, accounts, leasing, property manager) or null.
  by: a date only when it follows from a date in the facts (e.g. a cooling period's end), else null.
- options: 2 or 3 real choices for the decision ahead (e.g. settle with a payment plan, apply the deposit, file at the Rental Dispute Centre,
  wait for the lease to end), each with the main point for and against, using the figures given.
- missing: documents or facts the lawyer should get before the next step (e.g. the bank's return memo for a bounced cheque,
  the Ejari certificate, proof the notice was delivered).
- questions: up to 3 questions only the lawyer or management can answer.
Rules you never break:
- Figures, dates, names and references come ONLY from the facts. Never invent or round them. If a figure is not there, say it is not known.
- On points of UAE law (notice periods, what a filing requires, fees, criminal vs civil routes for cheques), say what is usual and add
  "(confirm with the lawyer)". Never cite an article number or a fee as certain.
- Never tell anyone to threaten the tenant, and never draft anything to send. Plain words, short lines, no legal jargon without a short explanation.`;

const list = (v, n, max = 400) => (Array.isArray(v) ? v : []).map((x) => String(x || '').trim().slice(0, max)).filter(Boolean).slice(0, n);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reem's view of a case, from the facts as text. */
export async function adviseCase({ facts }) {
  const res = await claude.messages.create({ model: MODEL, max_tokens: 2500, system: ADVISE, messages: [{ role: 'user', content: facts }] });
  const out = parseJson(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  return {
    summary: String(out.summary || '').trim().slice(0, 1500),
    position: ['strong', 'fair', 'weak', 'unclear'].includes(out.position) ? out.position : 'unclear',
    positionWhy: String(out.position_why || '').trim().slice(0, 400),
    wrong: list(out.wrong, 8),
    next: (Array.isArray(out.next) ? out.next : []).slice(0, 5).map((s) => ({
      step: String(s?.step || '').trim().slice(0, 400), who: s?.who ? String(s.who).slice(0, 60) : null,
      by: DATE.test(String(s?.by || '')) ? s.by : null, why: String(s?.why || '').trim().slice(0, 400),
    })).filter((s) => s.step),
    options: (Array.isArray(out.options) ? out.options : []).slice(0, 3).map((o) => ({
      option: String(o?.option || '').trim().slice(0, 300), for: String(o?.for || '').trim().slice(0, 400), against: String(o?.against || '').trim().slice(0, 400),
    })).filter((o) => o.option),
    missing: list(out.missing, 8),
    questions: list(out.questions, 3),
    model: MODEL,
  };
}
