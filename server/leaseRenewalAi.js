import { claude } from './ai.js';
import { CAREFUL_MODEL, FAST_MODEL } from './config.js';

// What Reem reads for Lease renewals (server/leaseRenewals.js): a tenant's email, and the
// signed agreement and cheque photos. Each answer is JSON in a fixed shape, and anything
// Claude is not sure of comes back as unsure, never as a guess.
//
// Reem only reads and suggests here. What is sent, by a person's tap or by Reem itself on
// an automatic renewal, is decided in leaseRenewals.js from these answers.

const MODEL = CAREFUL_MODEL; // reading cheques and agreements: the careful model, not the fast one

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

// Room enough for a long dispute email: answers cut off half-way can't be read (2026-11-02, PARK PLACE 203).
// Claude fills in a form (a tool it must call) rather than writing JSON in its text: a long
// dispute email once came back as prose and could not be read at all (2026-11-03, PARK PLACE 203).
async function askJson(system, content, schema, maxTokens = 4000, model = MODEL) {
  const res = await claude.messages.create({
    model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }],
    tools: [{ name: 'answer', description: 'Give your answer here, in this shape.', input_schema: schema }],
    tool_choice: { type: 'tool', name: 'answer' },
  });
  if (res.stop_reason === 'max_tokens') throw new Error('Reem could not read that: the answer was too long and got cut off.');
  const used = res.content.find((b) => b.type === 'tool_use' && b.name === 'answer');
  if (used?.input && typeof used.input === 'object') return used.input;
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return parseJson(text);
  } catch (e) {
    // What came back, in the log only (it can hold the tenant's words), so the cause can be found.
    console.warn(`[renewal ai] unreadable answer (stop: ${res.stop_reason}):`, text.slice(0, 300));
    throw new Error(`${e.message.replace(/\.$/, '')}${res.stop_reason === 'refusal' ? ': the AI declined to answer' : ''}.`);
  }
}

// The forms' shapes. Nullable fields are a type pair, so "not sure" stays null, never a guess.
const S = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });
const str = { type: 'string' };
const strOrNull = { type: ['string', 'null'] };
const numOrNull = { type: ['number', 'null'] };

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// ---------- the tenant's email ----------

const REPLY = `You read a tenant's email in a lease renewal conversation for a Dubai landlord and say what it means. The email may be in any language.
Answer by filling in the answer tool:
{"intent": "accept"|"counter"|"reject"|"question"|"documents"|"unclear", "amount": number|null, "summary": string,
 "asks_less": boolean, "dispute": boolean, "dispute_note": string|null, "suggested_reply": string|null}
- accept: they agree to the rent last offered to them.
- counter: they propose a different annual rent. amount = that annual rent in AED. A monthly figure is multiplied by 12.
  A discount asked for without a figure ("can you reduce it?") is unclear, not counter.
- reject: they will not renew / are moving out.
- question: they ask something before deciding.
- documents: they are only sending documents, cheques or the signed agreement.
- unclear: anything else, or you are not sure. Never guess a figure.
- asks_less: true when they ask for a lower rent or a discount, with or without a figure.
- summary: one short line in plain English of what they said, e.g. "Asks for AED 58,000 instead" or "Will move out at the end".
- dispute: true when they contest the increase or the renewal: say it is not legal, cite RERA, the Rental Index, Decree 43,
  the Rental Dispute Settlement Centre (RDC), a lawyer or a complaint, or refuse to pay or to leave.
  dispute_note: one line on what they are claiming. null when dispute is false.
- suggested_reply: a short, polite reply in English that a person could send, using ONLY the facts given (no promises,
  no new figures, no legal threats). For a question, answer it if the facts do; otherwise null.`;

/** What a tenant's email means, given the renewal's facts and the conversation so far. */
export async function readReply({ facts, history, text }) {
  const out = await askJson(REPLY, [{ type: 'text', text:
    `Facts of this renewal:\n${facts}\n\nThe conversation so far, oldest first:\n${history || '(none)'}\n\nThe tenant's new email:\n"""\n${String(text || '').slice(0, 6000)}\n"""` }], S({
    intent: { type: 'string', enum: ['accept', 'counter', 'reject', 'question', 'documents', 'unclear'] }, amount: numOrNull, summary: str,
    asks_less: { type: 'boolean' }, dispute: { type: 'boolean' }, dispute_note: strOrNull, suggested_reply: strOrNull,
  }));
  const intents = ['accept', 'counter', 'reject', 'question', 'documents', 'unclear'];
  const intent = intents.includes(out.intent) ? out.intent : 'unclear';
  const amount = num(out.amount);
  return {
    intent: intent === 'counter' && !(amount > 0) ? 'unclear' : intent,
    amount: intent === 'counter' ? amount : null,
    summary: String(out.summary || '').slice(0, 300),
    asksLess: !!out.asks_less || (intent === 'counter' && amount > 0),
    dispute: !!out.dispute,
    disputeNote: out.dispute && out.dispute_note ? String(out.dispute_note).slice(0, 300) : null,
    suggestedReply: out.suggested_reply ? String(out.suggested_reply).slice(0, 2000) : null,
  };
}

// ---------- the signed agreement and the cheques ----------

const DOCS = `You check the papers a tenant sent back to renew a lease: photos or scans of the signed renewal agreement (the tenancy contract) and of cheques.
Answer by filling in the answer tool:
{"agreement": "signed"|"unsigned"|"none", "cheques": [{"amount": number|null, "date": "YYYY-MM-DD"|null, "payee": string|null, "signed": boolean|null, "file": string}],
 "unreadable": [string], "note": string}
- agreement: "signed" only if a page of the renewal agreement or tenancy contract shows the tenant's signature; "unsigned" if the agreement is there without it; "none" if it was not sent.
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
  const out = await askJson(DOCS, content, S({
    agreement: { type: 'string', enum: ['signed', 'unsigned', 'none'] },
    cheques: { type: 'array', items: S({ amount: numOrNull, date: strOrNull, payee: strOrNull, signed: { type: ['boolean', 'null'] }, file: str }) },
    unreadable: { type: 'array', items: str }, note: str,
  }));
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

// ---------- the advisors ----------

// The person asks something ("help me negotiate the chiller fee") and picks who answers; each
// answer comes with an email to the tenant to use (the user, 2026-11-03). They are given the
// lease file from saifsys, so they never send the team off to pull the contract.
const ADVISE = `You are advising the landlord's team on a lease renewal in Dubai. Read the renewal's facts, the current contract from
saifsys and every email in full, then answer what the team asks you, from your own expertise.
Answer by filling in the answer tool: {"view": string, "reply": string}
- view: your answer to what the team asked, for the landlord's team. Plain text only: no markdown, no ** or #; short lines, a dash
  for each point. Check what the tenant claims against the contract you were given and say whether it matches.
  Options you suggest (e.g. a figure to offer) are clearly your suggestion for the team to decide.
- You already have the contract, its charges, Ejari and saifsys's legal cases: never tell the team to pull or check them. If
  something you need is not in what you were given, name exactly what is missing, once.
- What the tenant already said in the emails is known: use it. Never ask the tenant again for something they already told us,
  and never ask them for the contract, the Ejari or a figure on them: we are the landlord and hold those. Anything the team
  still has to check goes in the view, never in the email.
- Earlier questions from the team and the advisors' answers are given: build on them, don't repeat them. When the team asks
  you to suggest a figure, give one, with why.
- reply: ALWAYS write it, never leave it empty: the email to the tenant that carries out your advice, ready to send (when you
  suggest a figure, it offers that figure). The team decides whether to send it, so never tell them to hold the email.
  In English, polite, using only the facts given and your suggestion. Only the body: no greeting ("Dear ...") and no sign-off,
  as both are added.
- Only the emails listed went to the tenant. Replies the advisors suggested before are drafts that were NOT sent.
Rules you never break:
- Never say whether the rent increase is legal or allowed. If the tenant raises it, say the team should check the unit on DLD's Rental Index calculator and offer what it allows.
- Never file, or tell the team to file, a case. Never threaten the tenant with one.
- Never present a figure, date or promise as already agreed when it is not in the facts.`;

/** One advisor's answer to what a person asked about a renewal, in its own persona. agent: { name, persona }. */
export async function advise({ agent, facts, thread, dispute, ask, earlier }) {
  const out = await askJson(`${agent.persona || `You are ${agent.name}.`}\n\n${ADVISE}`, [{ type: 'text', text:
    `Facts of this renewal:\n${facts}\n\n${dispute ? `The tenant disputes it: ${dispute}\n\n` : ''}The emails, oldest first:\n${thread || '(none yet)'}\n\n` +
    `${earlier ? `What the team asked the advisors before, and their answers, oldest first:\n${earlier}\n\n` : ''}` +
    `The team asks you:\n"""\n${String(ask || 'Give your view: what is going on and what should we do next?').slice(0, 2000)}\n"""` }], S({ view: str, reply: str }));
  return {
    view: String(out.view || '').trim().slice(0, 4000),
    reply: out.reply ? String(out.reply).trim().slice(0, 4000) : null,
  };
}

const NEXT_ASK = `You help the landlord's team on a lease renewal in Dubai. From the facts, the emails and what the team already asked
its advisors, write what the team most likely wants to ask its advisors now, so they don't have to type it.
Answer by filling in the answer tool: {"ask": string}
- ask: one or two short sentences in the team's voice, e.g. "The tenant accepts the rent but disputes the chiller fee (AED 7,000 vs
  his AED 3,500). Suggest a chiller fee we can offer and write the reply."
- Be specific to the tenant's latest email: name the figures and the point in question. Always end by asking for the reply to send.
- Build on what was already asked; don't repeat a question that was answered unless the tenant wrote again since.`;

/** The question the team most likely wants to put to its advisors next: the Ask box, filled in. Fast model: it only drafts a question. */
export async function nextAsk({ facts, thread, earlier }) {
  const out = await askJson(NEXT_ASK, [{ type: 'text', text:
    `Facts of this renewal:\n${facts}\n\nThe emails, oldest first:\n${thread || '(none yet)'}\n\n` +
    `What the team asked the advisors before, oldest first:\n${earlier || '(nothing yet)'}` }], S({ ask: str }), 600, FAST_MODEL);
  return String(out.ask || '').trim().slice(0, 600);
}

const STORY = `You write the "what happened" part of a case pack a Dubai landlord will upload to the Rental Dispute Settlement Centre themselves.
The reader is an RDC officer who knows nothing about this lease: they must understand the dispute in under a minute.
Answer by filling in the answer tool: {"summary": string}
- summary: plain English, short sentences, in this shape:
  1. One sentence: what the two sides disagree about, with both figures (e.g. "The tenant accepts the rent of AED 46,200 but
     disputes the chiller fee: the landlord asks AED 6,500 a year, the tenant says it should stay at AED 3,500.").
  2. A blank line, then one short paragraph per email, oldest first, starting with its date: who wrote and what they said or
     offered, with the figures. Say what each side's position was, not only that an email was sent.
  3. A blank line, then one sentence on where it stands now.
- Write amounts as "AED 7,000 + VAT AED 350". Call the sides "the landlord" and "the tenant" (name the tenant once).
- Facts only, from the emails given. No opinions, no legal argument, never whether the rent or a fee is legal.
- Never mention Reem, software, systems, drafts, advisors or anything the landlord's team did internally: only what the two
  sides wrote to each other. An email with no text: say only that it was received on that date.`;

/** The renewal's story in a few neutral paragraphs, for the RDC case pack. */
export async function caseSummary({ facts, story }) {
  const out = await askJson(STORY, [{ type: 'text', text: `Facts of this renewal:\n${facts}\n\nWhat happened, oldest first:\n${story}` }], S({ summary: str }));
  return String(out.summary || '').trim().slice(0, 4000);
}

const REWRITE = `You are the building management team of a Dubai landlord, writing to a tenant about the renewal of their lease.
Rewrite the draft reply you are given into a clear, professional, courteous email from the building management team.
Answer by filling in the answer tool: {"reply": string}
- reply: only the body: no greeting ("Dear ...") and no sign-off, as both are added.
- Keep what the draft is trying to say. Answer what the tenant last asked, using ONLY the facts given.
- Professional and warm, never cold or pushy; short paragraphs; plain English; no slang, no emojis.
- No new figures, dates, discounts or promises that are not in the facts or the draft.
- Never say whether a rent increase is legal or allowed, and never threaten the tenant with a case.`;

/** The person's draft reply, written again by Reem as the building management team. */
export async function rewriteReply({ facts, thread, draft }) {
  const out = await askJson(REWRITE, [{ type: 'text', text:
    `Facts of this renewal:\n${facts}\n\nThe emails, oldest first:\n${thread || '(none yet)'}\n\nThe draft reply to rewrite:\n"""\n${String(draft || '').slice(0, 6000)}\n"""` }], S({ reply: str }));
  const reply = String(out.reply || '').trim();
  if (!reply) throw new Error('Reem could not rewrite that. Try again.');
  return reply.slice(0, 4000);
}
