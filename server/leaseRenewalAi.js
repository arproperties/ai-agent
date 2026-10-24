import { claude } from './ai.js';
import { CAREFUL_MODEL } from './config.js';

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

async function askJson(system, content, maxTokens = 1500) {
  const res = await claude.messages.create({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] });
  return parseJson(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// ---------- the tenant's email ----------

const REPLY = `You read a tenant's email in a lease renewal conversation for a Dubai landlord and say what it means. The email may be in any language.
Answer with JSON only:
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
    `Facts of this renewal:\n${facts}\n\nThe conversation so far, oldest first:\n${history || '(none)'}\n\nThe tenant's new email:\n"""\n${String(text || '').slice(0, 6000)}\n"""` }], 1000);
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
Answer with JSON only:
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

// ---------- the advisors ----------

const ADVISE = `You are advising the landlord's team on a lease renewal in Dubai. Read the renewal's facts and the emails, then give your view from your own expertise.
Answer with JSON only: {"view": string, "reply": string|null}
- view: 3 to 6 short lines in plain English for the landlord's team: what is going on, what the risk is, and what to do next.
- reply: a short, polite email to the tenant the team could send, in English, using ONLY the facts given. Only the body: no greeting
  ("Dear ...") and no sign-off, as both are added. null if no email should go now.
Rules you never break:
- Never say whether the rent increase is legal or allowed. If the tenant raises it, say the team should check the unit on DLD's Rental Index calculator and offer what it allows.
- Never file, or tell the team to file, a case. Never threaten the tenant with one.
- No new figures, dates or promises that are not in the facts.`;

/** One advisor's view of a renewal, in its own persona. agent: { name, persona }. */
export async function advise({ agent, facts, thread, dispute }) {
  const out = await askJson(`${agent.persona || `You are ${agent.name}.`}\n\n${ADVISE}`, [{ type: 'text', text:
    `Facts of this renewal:\n${facts}\n\n${dispute ? `The tenant disputes it: ${dispute}\n\n` : ''}The emails, oldest first:\n${thread || '(none yet)'}` }], 1200);
  return {
    view: String(out.view || '').trim().slice(0, 2000),
    reply: out.reply ? String(out.reply).trim().slice(0, 3000) : null,
  };
}

const STORY = `You write the "what happened" part of a case pack a Dubai landlord will upload to the Rental Dispute Settlement Centre themselves.
Answer with JSON only: {"summary": string}
- summary: one to three short paragraphs in plain English, in the order things happened, with the dates and figures given.
- Facts only: who wrote what and when. No opinions, no legal argument, and never whether the rent increase is legal.`;

/** The renewal's story in a few neutral paragraphs, for the RDC case pack. */
export async function caseSummary({ facts, story }) {
  const out = await askJson(STORY, [{ type: 'text', text: `Facts of this renewal:\n${facts}\n\nWhat happened, oldest first:\n${story}` }], 1200);
  return String(out.summary || '').trim().slice(0, 4000);
}

const REWRITE = `You are the building management team of a Dubai landlord, writing to a tenant about the renewal of their lease.
Rewrite the draft reply you are given into a clear, professional, courteous email from the building management team.
Answer with JSON only: {"reply": string}
- reply: only the body: no greeting ("Dear ...") and no sign-off, as both are added.
- Keep what the draft is trying to say. Answer what the tenant last asked, using ONLY the facts given.
- Professional and warm, never cold or pushy; short paragraphs; plain English; no slang, no emojis.
- No new figures, dates, discounts or promises that are not in the facts or the draft.
- Never say whether a rent increase is legal or allowed, and never threaten the tenant with a case.`;

/** The person's draft reply, written again by Reem as the building management team. */
export async function rewriteReply({ facts, thread, draft }) {
  const out = await askJson(REWRITE, [{ type: 'text', text:
    `Facts of this renewal:\n${facts}\n\nThe emails, oldest first:\n${thread || '(none yet)'}\n\nThe draft reply to rewrite:\n"""\n${String(draft || '').slice(0, 6000)}\n"""` }], 1200);
  const reply = String(out.reply || '').trim();
  if (!reply) throw new Error('Reem could not rewrite that. Try again.');
  return reply.slice(0, 4000);
}
