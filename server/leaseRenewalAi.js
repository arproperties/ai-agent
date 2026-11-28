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

// Every email to the tenant that lists cheques follows saifsys's layout, given in the facts.
// Without this the AI split the VAT over every cheque and made up a "balance" line, so the
// email said one thing and the contract another.
// The AI got the sums wrong even with the layout given, so it writes no figures block at all:
// the cheques come from saifsys (Reem fills them in on a rewrite, the contract carries them).
const CHEQUES = `- Never list cheques, cheque amounts, a total or a breakdown of the charges and VAT: you may name the rent or a fee in a
  sentence, but every figures list comes from saifsys. Where the tenant needs the cheques, say they will be in the renewal
  contract (or, for the team, that "Tell Reem what to say" writes the email with saifsys's figures).`;

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
- suggested_reply: a short, polite reply in English that a person could send: only the body, no greeting ("Dear ...")
  and no sign-off, as both are added, using ONLY the facts given (no promises,
  no new figures, no legal threats). For a question, answer it if the facts do; otherwise null.
${CHEQUES}`;

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
- Never present a figure, date or promise as already agreed when it is not in the facts.
${CHEQUES}`;

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
Paragraphs were still too hard to follow (2026-11-07), so you give short labelled parts that are laid out as a list and a table.
Answer by filling in the answer tool: {"issue": string, "landlord": string, "tenant": string, "now": string, "steps": [{"date": string, "from": string, "said": string}]}
- issue: one short sentence, what they disagree about, e.g. "The chiller fee. The tenant accepts the rent of AED 46,200."
- landlord: the landlord's latest offer on that point, a few words, e.g. "AED 5,000 a year + VAT".
- tenant: the tenant's position on it, a few words, e.g. "AED 3,500 a year + VAT, as now".
- now: one short sentence on where it stands, e.g. "No agreement yet."
- steps: one per email, oldest first. date as given (YYYY-MM-DD); from "Landlord" or "Tenant"; said: what they offered or
  argued, at most 15 words, figures first, e.g. "Chiller fee lowered to AED 6,500 + VAT. Rent unchanged." Leave out what
  every offer repeats (the period, the cheques, the Ejari fee) unless it changed.
- Plain words a person reads in one go. Write "+ VAT", not the VAT amount. Call the sides "the landlord" and "the tenant".
- Facts only, from the emails given. No opinions, no legal argument, never whether the rent or a fee is legal.
- Never mention Reem, software, systems, drafts, advisors or anything the landlord's team did internally: only what the two
  sides wrote to each other. An email with no text: said "Email received."`;

/** The renewal's story as short labelled parts and one line per email, for the RDC case pack. */
export async function caseSummary({ facts, story }) {
  const out = await askJson(STORY, [{ type: 'text', text: `Facts of this renewal:\n${facts}\n\nWhat happened, oldest first:\n${story}` }],
    S({ issue: str, landlord: str, tenant: str, now: str, steps: { type: 'array', items: S({ date: str, from: str, said: str }) } }));
  const t = (x, n = 300) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    issue: t(out.issue), landlord: t(out.landlord), tenant: t(out.tenant), now: t(out.now),
    steps: (Array.isArray(out.steps) ? out.steps : []).slice(0, 40).map((s) => ({ date: t(s.date, 20), from: t(s.from, 20), said: t(s.said, 200) })).filter((s) => s.said),
  };
}

const REWRITE = `You are the building management team of a Dubai landlord, writing to a tenant about the renewal of their lease.
Rewrite the draft reply you are given into a clear, professional, courteous email from the building management team.
Answer by filling in the answer tool:
{"reply": string, "has_terms": boolean, "rent": number|null, "admin_fee": number|null, "chiller_fee": number|null}
- reply: only the body: no greeting ("Dear ...") and no sign-off, as both are added.
- Never write figures yourself: no cheques, no cheque amounts, no total, no list of the rent, charges, VAT or Ejari. When the
  email states the renewal terms (confirming what was agreed, or an offer), put the line {{FIGURES}} on its own where they belong,
  and set has_terms true. Reem puts there the rent, each charge with its VAT, the Ejari fee, the total and every cheque, exactly
  as saifsys works them out. Otherwise has_terms is false and there is no {{FIGURES}}.
- rent, admin_fee, chiller_fee: with has_terms, what this email agrees, in AED a year before VAT (a waived fee is 0). null for
  one that stays as in the facts. Take them from what the team asked and the tenant's emails; never guess a figure.
- Keep what the draft is trying to say. Answer what the tenant last asked, using ONLY the facts given.
- When the team says what they want the reply to say, that comes first: write the reply that says it, taking the
  details (figures, terms) from the tenant's emails and the facts. Keep it simple and short.
- Professional and warm, never cold or pushy; short paragraphs; plain English; no slang, no emojis.
- No new figures, dates, discounts or promises that are not in the facts or the draft.
- Never say whether a rent increase is legal or allowed, and never threaten the tenant with a case.`;

// One-tap instructions under "Tell Reem what to say", so the team does not have to think of
// the words: what they most likely want to answer to the tenant's last email.
const IDEAS = `You help the landlord's team answer a tenant in a Dubai lease renewal. From the facts and the emails, give the 2 or 3
instructions the team is most likely to give for the reply to the tenant's last email, so they can tap one instead of typing.
Answer by filling in the answer tool: {"ideas": [string]}
- Each one short (at most 12 words), in the team's voice, naming the figures that matter, e.g.
  "Accept her proposal: chiller AED 6,000 + VAT, admin fee waived", "Ask for two more days to review",
  "Decline politely and keep our offer of AED 59,400".
- Different choices (accept / ask for time / decline or counter), most likely first. Only from the facts and emails; no new figures.`;

/** The likely answers to the tenant's last email, as instructions to tap. Fast model: it only drafts a few words. */
export async function replyIdeas({ facts, thread }) {
  const out = await askJson(IDEAS, [{ type: 'text', text: `Facts of this renewal:\n${facts}\n\nThe emails, oldest first:\n${thread || '(none yet)'}` }],
    S({ ideas: { type: 'array', items: str } }), 400, FAST_MODEL);
  return (Array.isArray(out.ideas) ? out.ideas : []).map((x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean).slice(0, 3);
}

// An email to someone in the company about one renewal (accounts, legal, a colleague), never
// to the tenant. The reason says what the email asks for; the figures come from the renewal.
const TEAM = `You write a short internal email from a member of a Dubai landlord's property team to colleagues in the same company
(for example the accounts team or the legal team) about one tenant's lease renewal.
Answer by filling in the answer tool: {"subject": string, "body": string}
- subject: short; names the building and unit and what is needed, e.g. "Accounts review: PARK PLACE 610 lease renewal".
- body: a greeting to the recipient ("Dear Accounts Team," for accounts@, "Dear Legal Team," for legal@, "Hi <first name>," for a person),
  one line saying what you need from them, then the figures they need to do it as short "- label: value" lines, then one line
  saying what you need back and by when if the facts give a date, then "Thank you," and the sender's name on its own line.
- Use ONLY the facts given. Never invent a figure, date, name or balance. Leave out what the facts do not have.
- Plain professional English, short. No emojis, no markdown headings or bold.
- Never mention Reem, AI, drafts or advisors.`;

/** An internal email about the renewal, for the person to read and change before it goes. */
export async function teamEmail({ facts, thread, reason, note, to, sender }) {
  const out = await askJson(TEAM, [{ type: 'text', text: [
    `Facts of this renewal:\n${facts}`,
    `The emails with the tenant, oldest first:\n${thread || '(none yet)'}`,
    `Reason for this email: ${reason}`,
    note ? `What the sender wrote in the email box: either a few words of what they want, or an earlier draft with their own changes. ` +
      `Write the email from it, keeping every change, name, figure and wording they put in:\n"""\n${String(note).slice(0, 8000)}\n"""` : '',
    `To: ${to.join(', ') || '(not chosen yet)'}`,
    `Sender: ${sender}`,
  ].filter(Boolean).join('\n\n') }], S({ subject: str, body: str }), 2000);
  const subject = String(out.subject || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const body = String(out.body || '').trim().slice(0, 8000);
  if (!subject || !body) throw new Error('Reem could not write that email. Try again.');
  return { subject, body };
}

const NOTICE = `You write an email from the legal team of a Dubai landlord to a tenant whose lease will NOT be renewed.
Answer by filling in the answer tool: {"subject": string, "body": string}
- kind "notice": the first email. Say clearly and politely that the landlord does not intend to renew the tenancy when it ends,
  give the end date and the reason given, ask the tenant to confirm by reply that they will hand the unit back on that date,
  and say the team will arrange the move-out inspection and the return of the keys.
- kind "reply": answer the tenant's latest email in the thread, in the same calm, firm tone, keeping to what the legal team wants said.
- subject: for a notice, "Notice of non-renewal: <building>, Unit <unit>"; for a reply, "Re: " and the thread's subject if given.
- body: "Dear <tenant name>," then short paragraphs, then "Kind regards," and "Legal Department" on its own line.
- Use ONLY the facts given. Never invent a date, figure, law article or reason. Never threaten, never promise anything not in the facts.
- Never say the tenant must leave by law, and never cite a law, unless the legal team's own words say so.
- Plain professional English. No emojis, no markdown.
- Never mention Reem, AI or drafts.`;

/** The legal team's notice that the lease is not renewed, or its reply to the tenant: for a person to read and change. */
export async function noticeEmail({ facts, thread, kind, reason, note, subject }) {
  const out = await askJson(NOTICE, [{ type: 'text', text: [
    `Kind: ${kind === 'reply' ? 'reply' : 'notice'}`,
    `Facts of the lease:\n${facts}`,
    reason ? `Why the lease is not renewed (the team's words): ${reason}` : '',
    `The emails with the tenant, oldest first:\n${thread || '(none yet)'}`,
    subject ? `The thread's subject: ${subject}` : '',
    note ? `What the legal team wrote in the email box: either a few words of what they want said, or an earlier draft with their own changes. ` +
      `Write the email from it, keeping every change, name, date and wording they put in:\n"""\n${String(note).slice(0, 8000)}\n"""` : '',
  ].filter(Boolean).join('\n\n') }], S({ subject: str, body: str }), 2000);
  const subj = String(out.subject || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const body = String(out.body || '').trim().slice(0, 8000);
  if (!subj || !body) throw new Error('Reem could not write that email. Try again.');
  return { subject: subj, body };
}

/** The person's draft reply, written again by Reem as the building management team. */
export async function rewriteReply({ facts, thread, draft, ask }) {
  const out = await askJson(REWRITE, [{ type: 'text', text: [
    `Facts of this renewal:\n${facts}`,
    `The emails, oldest first:\n${thread || '(none yet)'}`,
    `The draft reply${ask ? ' so far' : ' to rewrite'}:\n"""\n${String(draft || '').slice(0, 6000) || '(empty)'}\n"""`,
    ask ? `What the team wants this reply to say:\n"""\n${String(ask).slice(0, 2000)}\n"""` : '',
  ].filter(Boolean).join('\n\n') }], S({ reply: str, has_terms: { type: 'boolean' }, rent: numOrNull, admin_fee: numOrNull, chiller_fee: numOrNull }));
  const reply = String(out.reply || '').trim();
  if (!reply) throw new Error('Reem could not rewrite that. Try again.');
  const terms = out.has_terms || reply.includes('{{FIGURES}}')
    ? { rent: num(out.rent), admin: num(out.admin_fee), chiller: num(out.chiller_fee) } : null;
  return { reply: reply.slice(0, 4000), terms };
}
