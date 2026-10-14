import { claude } from './ai.js';
import { MODELS } from './config.js';

// What Reem reads for Lease renewals (server/renewals.js): the DLD screenshot, a tenant's
// email, and the signed agreement and cheque photos. Each answer is JSON in a fixed shape,
// and anything Claude is not sure of comes back as unsure, never as a guess - renewals.js
// sends those to the boss.
//
// Reem never writes the letters here. The emails are fixed texts in renewals.js; the only
// words of Claude's that reach a tenant are an answer to a question, from the case's facts.

const MODEL = MODELS[0].id; // reading cheques and screenshots: the careful model, not the fast one

const block = ({ mime, data }) => (mime === 'application/pdf'
  ? { type: 'document', source: { type: 'base64', media_type: mime, data } }
  : { type: 'image', source: { type: 'base64', media_type: mime, data } });

/** The first JSON object in Claude's answer. */
export function parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Reem could not read that (no answer in the expected shape).');
  return JSON.parse(s.slice(start, end + 1));
}

async function askJson(system, content, maxTokens = 1500) {
  const res = await claude.messages.create({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] });
  return parseJson(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// ---------- the DLD screenshot ----------

const DLD = `You read a screenshot of the Dubai Land Department (DLD) Rental Index calculator for a landlord.
Answer with JSON only: {"pct": number|null, "average": number|null, "confident": boolean, "note": string}.
- pct: the maximum rent increase the result allows, in percent (0, 5, 10, 15 or 20). 0 when it says no increase is allowed.
- average: the average annual rent the result shows for similar units, in AED, or null when it does not show one.
- confident: true only if the picture is clearly a DLD rental index RESULT and you read pct off it without doubt.
- note: one short line on what the screenshot shows, e.g. "Al Barsha, 1 bedroom, current rent 36,000: increase up to 5%".
Never guess. If it is not a DLD result, or the figure is cut off or unclear, set confident false and pct null.`;

/** What the DLD screenshot says. image: { mime, data (base64) }. */
export async function readDld(image, lease) {
  const out = await askJson(DLD, [
    block(image),
    { type: 'text', text: `The lease being renewed: ${lease.building}, unit ${lease.unit} (${lease.unit_type || 'unit'}), current annual rent AED ${lease.annual_rent}.` },
  ], 400);
  const pct = num(out.pct);
  return {
    pct: pct !== null && pct >= 0 && pct <= 20 ? pct : null,
    average: num(out.average),
    confident: !!out.confident && pct !== null,
    note: String(out.note || '').slice(0, 300),
  };
}

// ---------- the tenant's email ----------

const REPLY = `You read a tenant's email in a lease renewal conversation and say what it means. The email may be in any language.
Answer with JSON only:
{"intent": "accept"|"counter"|"reject"|"question"|"documents"|"unclear", "amount": number|null, "question": string|null,
 "answer": string|null, "can_answer": boolean, "summary": string}
- accept: they agree to the rent last offered to them.
- counter: they propose a different annual rent. amount = that annual rent in AED. A monthly figure is multiplied by 12.
  A discount asked for without a figure ("can you reduce it?") is unclear, not counter.
- reject: they will not renew / are moving out.
- question: they ask something before deciding. question = the question, short.
  answer = a short, polite answer in English using ONLY the facts given; can_answer = false when the facts do not answer it.
- documents: they are only sending documents, cheques or the signed agreement.
- unclear: anything else, or you are not sure. Never guess a figure.
- summary: one line in English of what they said.`;

/** What a tenant's email means, given the case's facts and the conversation so far. */
export async function readReply({ facts, history, text }) {
  const out = await askJson(REPLY, [{ type: 'text', text:
    `Facts of this renewal:\n${facts}\n\nThe conversation so far, oldest first:\n${history || '(none)'}\n\nThe tenant's new email:\n"""\n${String(text || '').slice(0, 6000)}\n"""` }], 800);
  const intents = ['accept', 'counter', 'reject', 'question', 'documents', 'unclear'];
  const intent = intents.includes(out.intent) ? out.intent : 'unclear';
  const amount = num(out.amount);
  return {
    intent: intent === 'counter' && !(amount > 0) ? 'unclear' : intent,
    amount: intent === 'counter' ? amount : null,
    question: out.question ? String(out.question).slice(0, 500) : null,
    answer: out.can_answer && out.answer ? String(out.answer).slice(0, 2000) : null,
    summary: String(out.summary || '').slice(0, 300),
  };
}

// ---------- the signed agreement and the cheques ----------

const DOCS = `You check the papers a tenant sent back to renew a lease: photos or scans of the signed renewal agreement and of cheques.
Answer with JSON only:
{"agreement": "signed"|"unsigned"|"none", "cheques": [{"amount": number|null, "date": "YYYY-MM-DD"|null, "payee": string|null, "signed": boolean|null, "file": string}],
 "unreadable": [string], "note": string}
- agreement: "signed" only if a page of the renewal agreement shows the tenant's signature; "unsigned" if the agreement is there without it; "none" if it was not sent.
- cheques: every cheque you can see, one entry each, with the amount in figures (AED), the date written on it, who it is payable to, and whether it is signed. file = the file name it is in.
- unreadable: names of files you could not read.
- Never guess a figure or a date: use null.`;

/** What is in the files a tenant sent. files: [{ name, mime, data (base64) }]. */
export async function readDocs(files) {
  const content = [];
  for (const f of files) {
    content.push({ type: 'text', text: `File: ${f.name}` });
    content.push(block(f));
  }
  content.push({ type: 'text', text: 'Read these files.' });
  const out = await askJson(DOCS, content, 2000);
  return {
    agreement: ['signed', 'unsigned', 'none'].includes(out.agreement) ? out.agreement : 'none',
    cheques: (Array.isArray(out.cheques) ? out.cheques : []).map((c) => ({
      amount: num(c.amount), date: /^\d{4}-\d{2}-\d{2}$/.test(String(c.date || '')) ? c.date : null,
      payee: c.payee ? String(c.payee).slice(0, 200) : null, signed: c.signed === null || c.signed === undefined ? null : !!c.signed,
      file: String(c.file || ''),
    })),
    unreadable: (Array.isArray(out.unreadable) ? out.unreadable : []).map(String),
    note: String(out.note || '').slice(0, 300),
  };
}
