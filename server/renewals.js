import { Router } from 'express';
import { readFileSync, rmSync } from 'node:fs';
import { db } from './db.js';
import { MODELS, DATA_DIR } from './config.js';
import { requireMaster } from './auth.js';
import { docHistory, saveFile, register, upload, sendDoc } from './properties.js';
import { fileBlock, isDate } from './documentReader.js';
import { cleanAddresses, createDraft, logAction } from './drafts.js';
import { store, discard } from './draftFiles.js';
import { replySubject } from './imap.js';
import { usDate } from './usFormat.js';
import { todayHere } from './leasingRegion.js';

// Renewals: getting a document that is due renewed, with Riley doing the legwork. A renewal
// is a case on one document. She lists who to ask (the insurer on the policy, others found
// on the web, the ones kept from before), writes the request to each, reads what comes
// back, lays the offers beside the current policy and says which she would take.
//
// She prepares; a person sends. Nothing in this file sends an email: the most it does is
// write a draft that waits for its owner's Approve (server/drafts.js, server/outbox.js).
// Reading the inbox is hers to do unasked, since it changes nothing.
//
// Everything that needs the model, the web or a mailbox takes it as `deps`, so each step
// can be run without any of them.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const NOW = 'extract(epoch from now())::bigint';
const MODEL = MODELS[0].id; // the balanced one: finding and weighing are worth more than the fastest model gives

/** One question to the model, answered in text. With `web`, it may search first (as server/chat.js lets an agent). */
async function model(content, { web = false, maxTokens = 2500 } = {}) {
  const { claude } = await import('./ai.js');
  const messages = [{ role: 'user', content }];
  let text = '';
  // A long search can pause the turn: it is picked up where it stopped, a few times at most.
  for (let turn = 0; turn < 4; turn++) {
    const res = await claude.messages.create({ model: MODEL, max_tokens: maxTokens, messages,
      ...(web ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }] } : {}) });
    text += res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  return text;
}

const real = {
  think: (content, opts) => model(content, opts),
  search: (prompt) => model(prompt, { web: true }),
  account: (userId) => import('./imap.js').then((m) => m.imapAccount(userId)),
  inbox: (userId, opts) => import('./imap.js').then((m) => m.recentInbox(userId, opts)),
  parts: (userId, id) => import('./imap.js').then((m) => m.emailParts(userId, id)),
  push: (userIds, note) => import('./push.js').then((m) => m.sendPush(userIds, note)),
};
const use = (deps) => ({ ...real, ...deps });

/** The JSON in a reply, whatever was said around it: an object, or with '[' a list. Null when there is none. */
function pull(reply, open = '{') {
  const m = String(reply ?? '').match(open === '[' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}
const line = (v, max = 300) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// ---------- the case ----------

const DOC = `SELECT d.id, d.title, d.number, d.details, d.notes, (d.file_path IS NOT NULL) AS has_file, d.file_path, d.file_name, d.file_mime,
    to_char(d.expiry_date, 'YYYY-MM-DD') AS expiry_date, d.unit_id, d.building_id, u.unit_no, bl.name AS building,
    coalesce(bl.address, c.address) AS address, coalesce(bl.city, c.city) AS city, coalesce(bl.emirate, c.state) AS state, c.name AS company
  FROM prop_documents d LEFT JOIN prop_units u ON u.id = d.unit_id
  LEFT JOIN prop_buildings bl ON bl.id = coalesce(d.building_id, u.building_id)
  JOIN prop_companies c ON c.id = coalesce(d.company_id, bl.company_id) WHERE d.id = ?`;

async function documentOf(id) {
  const d = await db.prepare(DOC).get(Number(id));
  if (!d) throw bad('Not found', 404);
  return { ...d, details: JSON.parse(d.details || '{}'), where: d.unit_id ? `Unit ${d.unit_no}, ${d.building}` : d.building_id ? d.building : d.company };
}

/** A renewal is over once a newer copy of its document is on file: that is what renewing it means. */
const settle = () => db.prepare(`UPDATE prop_renewals r SET status = 'renewed', closed_at = ${NOW}
  WHERE r.status IN ('open', 'decided') AND EXISTS (SELECT 1 FROM prop_documents d JOIN prop_documents n ON n.id <> d.id AND lower(n.title) = lower(d.title)
      AND n.company_id IS NOT DISTINCT FROM d.company_id AND n.building_id IS NOT DISTINCT FROM d.building_id AND n.unit_id IS NOT DISTINCT FROM d.unit_id
      AND ((n.expiry_date IS NOT NULL AND (d.expiry_date IS NULL OR n.expiry_date > d.expiry_date)) OR (n.expiry_date IS NOT DISTINCT FROM d.expiry_date AND n.id > d.id))
    WHERE d.id = r.document_id)`).run();

const REQUESTS = `SELECT q.id AS request_id, q.supplier_id, q.is_current, q.subject, q.body, q.manual_sent_at, q.chased_at, q.seen, q.reply_kind, q.reply_note, q.replied_at,
    q.draft_id, q.chaser_draft_id, s.name, s.email, s.email_confirmed, s.website, s.phone, s.kind, s.found_by, s.about,
    dr.status AS draft_status, dr.subject AS draft_subject, dr.body AS draft_body, dr.error AS draft_error, dr.sent_at AS draft_sent_at, dr.message_id, dr.user_id AS draft_owner,
    ch.status AS chaser_status, ch.body AS chaser_body, ch.user_id AS chaser_owner
  FROM prop_renewal_requests q JOIN prop_suppliers s ON s.id = q.supplier_id
  LEFT JOIN email_drafts dr ON dr.id = q.draft_id LEFT JOIN email_drafts ch ON ch.id = q.chaser_draft_id
  WHERE q.renewal_id = ? ORDER BY q.is_current DESC, lower(s.name)`;

/** Where a request stands, from its draft: listed → drafted → sending → sent → replied. A draft refused or gone leaves it listed. */
function stateOf(q) {
  if (q.replied_at) return 'replied';
  if (q.draft_status === 'sent' || q.manual_sent_at) return 'sent';
  if (q.draft_status === 'approved' || q.draft_status === 'sending') return 'sending';
  if (q.draft_status === 'pending') return 'drafted';
  return q.body ? 'written' : 'listed'; // written: the words are there to copy, with no mailbox to send them from
}

async function requestsOf(renewalId) {
  return (await db.prepare(REQUESTS).all(renewalId)).map((q) => {
    const live = ['pending', 'approved', 'sending', 'sent'].includes(q.draft_status);
    return { ...q, about: JSON.parse(q.about || '{}'), seen: JSON.parse(q.seen || '[]'), state: stateOf(q),
      subject: live ? q.draft_subject : q.subject, body: live ? q.draft_body : q.body,
      error: q.draft_status === 'failed' ? q.draft_error : null,
      sent_at: q.draft_status === 'sent' ? Number(q.draft_sent_at) : q.manual_sent_at ? Number(q.manual_sent_at) : null };
  });
}

const QUOTE_COLS = `q.id, q.supplier_id, s.name AS supplier, q.premium, q.sum_insured, q.deductible, q.cover, q.exclusions, to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until,
  q.note, q.source, q.email_id, (q.file_path IS NOT NULL) AS has_file, q.file_name, q.created_at`;
const quotesOf = (renewalId) => db.prepare(`SELECT ${QUOTE_COLS} FROM prop_renewal_quotes q JOIN prop_suppliers s ON s.id = q.supplier_id
  WHERE q.renewal_id = ? ORDER BY q.id`).all(renewalId);

const rawRenewal = async (id) => {
  const r = await db.prepare('SELECT * FROM prop_renewals WHERE id = ?').get(Number(id));
  if (!r) throw bad('Not found', 404);
  return r;
};

/** The letters written once an offer was chosen, each with where its draft stands (null when it is only words to copy). */
async function closingOf(r) {
  const out = [];
  for (const c of JSON.parse(r.closing || '[]')) {
    const dr = c.draft_id ? await db.prepare('SELECT status, subject, body, error FROM email_drafts WHERE id = ?').get(c.draft_id) : null;
    const live = dr && ['pending', 'approved', 'sending', 'sent'].includes(dr.status);
    out.push({ ...c, ...(live ? { subject: dr.subject, body: dr.body } : {}), status: dr?.status ?? null, error: dr?.status === 'failed' ? dr.error : null });
  }
  return out;
}

/** A renewal as the screen and Riley see it: the document, who is on it and where each stands, the offers, and what was made of them. */
export async function getRenewal(id) {
  await settle();
  const r = await rawRenewal(id);
  const { file_path, ...document } = await documentOf(r.document_id);
  return { id: r.id, status: r.status, opened_by: r.opened_by, created_at: Number(r.created_at), chosen_quote_id: r.chosen_quote_id, document,
    suppliers: (await requestsOf(r.id)).map(({ message_id, seen, ...q }) => q),
    quotes: await quotesOf(r.id), compared: r.compared ? JSON.parse(r.compared) : null, closing: await closingOf(r) };
}

/** The renewals still under way, newest first, each with how far it has got. */
export async function listRenewals() {
  await settle();
  const rows = await db.prepare("SELECT id FROM prop_renewals WHERE status IN ('open', 'decided') ORDER BY id DESC").all();
  const out = [];
  for (const { id } of rows) {
    const r = await getRenewal(id);
    out.push({ id: r.id, document_id: r.document.id, status: r.status, title: r.document.title, where: r.document.where, expiry_date: r.document.expiry_date,
      listed: r.suppliers.length, asked: r.suppliers.filter((s) => ['sent', 'replied'].includes(s.state)).length, quotes: r.quotes.length });
  }
  return out;
}

/** For the alerts: each document with a renewal under way → its id and how far it has got. */
export async function openByDocument() {
  await settle();
  const rows = await db.prepare(`SELECT r.id, r.document_id,
      (SELECT count(*)::int FROM prop_renewal_requests q LEFT JOIN email_drafts dr ON dr.id = q.draft_id WHERE q.renewal_id = r.id AND (dr.status = 'sent' OR q.manual_sent_at IS NOT NULL)) AS asked,
      (SELECT count(*)::int FROM prop_renewal_quotes x WHERE x.renewal_id = r.id) AS quotes
    FROM prop_renewals r WHERE r.status IN ('open', 'decided')`).all();
  return new Map(rows.map((r) => [r.document_id, r]));
}

/** For the alerts: the documents whose last renewal was closed as not renewing. They have stopped asking. */
export async function notRenewing() {
  const rows = await db.prepare(`SELECT r.document_id FROM prop_renewals r WHERE r.status = 'not_renewing'
    AND r.id = (SELECT max(x.id) FROM prop_renewals x WHERE x.document_id = r.document_id)`).all();
  return new Set(rows.map((r) => r.document_id));
}

// ---------- suppliers ----------

const SUPPLIER = 'id, name, email, phone, website, kind, found_by, email_confirmed, notes, about';
const supplierOut = (s) => s && { ...s, about: JSON.parse(s.about || '{}') };
export const listSuppliers = async () => (await db.prepare(`SELECT ${SUPPLIER} FROM prop_suppliers ORDER BY lower(name)`).all()).map(supplierOut);
const supplierByName = (name) => db.prepare(`SELECT ${SUPPLIER} FROM prop_suppliers WHERE lower(name) = lower(?)`).get(String(name).trim());

/** One address, as a person gave it: tidied, or refused. Empty is no address. */
function oneEmail(v) {
  if (!String(v ?? '').trim()) return null;
  const [email] = cleanAddresses([v], 'That');
  return email;
}

/** Keep a supplier, new or known by its name. An address that comes from a person is one they have confirmed. */
async function keepSupplier({ supplier_id, name, email, phone, website, kind, found_by }) {
  const known = supplier_id ? await db.prepare(`SELECT ${SUPPLIER} FROM prop_suppliers WHERE id = ?`).get(Number(supplier_id)) : await supplierByName(name || '');
  if (supplier_id && !known) throw bad('Not found', 404);
  const fields = { phone: line(phone, 60) || null, website: line(website) || null, kind: line(kind, 40) || null };
  const address = oneEmail(email);
  if (!known) {
    if (!line(name)) throw bad('A supplier needs a name.');
    const { id } = await db.prepare('INSERT INTO prop_suppliers (name, email, email_confirmed, phone, website, kind, found_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .run(line(name, 200), address, !!address, fields.phone, fields.website, fields.kind || 'insurer', line(found_by, 20) || 'person');
    return id;
  }
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
  if (address) Object.assign(set, { email: address, email_confirmed: true });
  const cols = Object.keys(set);
  if (cols.length) await db.prepare(`UPDATE prop_suppliers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), known.id);
  return known.id;
}

/** Change a kept supplier's details. A new address is, again, one a person has confirmed. */
export async function updateSupplier(id, body = {}) {
  const s = await db.prepare('SELECT id FROM prop_suppliers WHERE id = ?').get(Number(id));
  if (!s) throw bad('Not found', 404);
  const set = {};
  if ('name' in body) { if (!line(body.name)) throw bad('A supplier needs a name.'); set.name = line(body.name, 200); }
  for (const f of ['phone', 'website', 'kind', 'notes']) if (f in body) set[f] = line(body[f], f === 'notes' ? 1000 : 300) || (f === 'kind' ? 'insurer' : null);
  if ('email' in body) { set.email = oneEmail(body.email); set.email_confirmed = !!set.email; }
  const cols = Object.keys(set);
  try {
    if (cols.length) await db.prepare(`UPDATE prop_suppliers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), s.id);
  } catch (e) { if (e.code === '23505') throw bad('A supplier with that name already exists.', 409); throw e; }
  return supplierOut(await db.prepare(`SELECT ${SUPPLIER} FROM prop_suppliers WHERE id = ?`).get(s.id));
}

/** Take a supplier off the list for good. One with offers or requests on a renewal goes from those too. */
export async function removeSupplierForGood(id) {
  const r = await db.prepare('DELETE FROM prop_suppliers WHERE id = ?').run(Number(id));
  if (!r.changes) throw bad('Not found', 404);
  return { ok: true };
}

const listOn = (renewalId, supplierId, current = false) => db.prepare(`INSERT INTO prop_renewal_requests (renewal_id, supplier_id, is_current) VALUES (?, ?, ?)
  ON CONFLICT (renewal_id, supplier_id) DO NOTHING`).run(renewalId, supplierId, current);

/** Begin renewing a document, or give back the renewal already under way for it. The insurer on the policy is listed to start with. */
export async function startRenewal(documentId, by) {
  await settle();
  const copies = await docHistory(documentId); // every copy under this name and owner, the current one first
  const ids = copies.map((d) => d.id);
  const open = await db.prepare(`SELECT id FROM prop_renewals WHERE status IN ('open', 'decided') AND document_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id DESC`).get(...ids);
  if (open) return getRenewal(open.id);
  const current = copies[0];
  const { id } = await db.prepare('INSERT INTO prop_renewals (document_id, opened_by) VALUES (?, ?) RETURNING id').run(current.id, by ?? null);
  // It is shopped around for from here on, whatever it was filed as.
  await db.prepare("UPDATE prop_documents SET renew_by = 'quotes' WHERE id = ?").run(current.id);
  if (line(current.details?.insurer)) await listOn(id, await keepSupplier({ name: current.details.insurer, found_by: 'policy' }), true);
  return getRenewal(id);
}

const FIND = (d) => `A property company needs quotations to renew this: ${d.title}${d.details.cover ? ` (${d.details.cover})` : ''}, for ${d.where}`
  + `${[d.address, d.city, d.state].filter(Boolean).length ? `, ${[d.address, d.city, d.state].filter(Boolean).join(', ')}` : ''}. `
  + `Its current supplier is ${d.details.insurer || 'not known'}. Search the web for up to six other reputable insurers or brokers that provide this kind of cover for a property there and take enquiries from businesses. `
  + 'Reply with one JSON array and nothing else. Each item: "name" (the company), "website", "email" (an address for quotations or enquiries, only if you saw it on their own site; otherwise leave it out), '
  + '"phone" (only if seen), "kind" ("insurer" or "broker"), "why" (one short line on why it fits). Never invent an email address or a phone number.';

/**
 * Who else could be asked: the suppliers kept from before (`known`) and companies found on
 * the web (`found`), neither including anyone already on this renewal. Nothing is kept by
 * looking: a person adds the ones they want. `failed` when the search could not be made.
 */
export async function findSuppliers(id, deps) {
  const { search } = use(deps);
  const r = await rawRenewal(id);
  const d = await documentOf(r.document_id);
  const on = await requestsOf(r.id);
  const listed = (name) => on.some((q) => same(q.name, name));
  const known = (await listSuppliers()).filter((s) => !listed(s.name));
  let list;
  try { list = pull(await search(FIND(d)), '['); } catch (e) { console.error('[renewals] search:', e.message); }
  if (!Array.isArray(list)) return { known, found: [], failed: true };
  const found = [];
  for (const x of list) {
    const name = line(x?.name, 200);
    if (!name || listed(name) || known.some((s) => same(s.name, name)) || found.some((s) => same(s.name, name))) continue;
    let email = null;
    try { email = oneEmail(line(x.email)); } catch { /* not an address: left for the person to fill in */ }
    found.push({ name, email, website: line(x.website) || null, phone: line(x.phone, 60) || null, kind: x.kind === 'broker' ? 'broker' : 'insurer', why: line(x.why) || null });
  }
  return { known, found };
}

/** Put suppliers on a renewal: ones already kept (supplier_id) or new ones by name. */
export async function addSuppliers(id, list = []) {
  const r = await rawRenewal(id);
  if (!Array.isArray(list) || !list.length) throw bad('Choose at least one supplier.');
  // Checked before anything is kept, so one bad address does not leave half the list added.
  for (const s of list) oneEmail(s?.email);
  for (const s of list) await listOn(r.id, await keepSupplier(s || {}));
  return getRenewal(r.id);
}

/** Take a supplier off a renewal. One already written to stays: what was sent cannot be unsent. */
export async function removeSupplier(id, supplierId) {
  const r = await rawRenewal(id);
  const q = (await requestsOf(r.id)).find((x) => x.supplier_id === Number(supplierId));
  if (!q) throw bad('Not found', 404);
  if (!['listed', 'written'].includes(q.state)) throw bad(`${q.name} has already been written to.`, 409);
  await db.prepare('DELETE FROM prop_renewal_requests WHERE id = ?').run(q.request_id);
  return getRenewal(r.id);
}

/** Close a renewal without renewing: the document is let go (and stops asking), or the renewal was started by mistake. */
export async function closeRenewal(id, status) {
  const r = await rawRenewal(id);
  if (!['not_renewing', 'cancelled'].includes(status)) throw bad('A renewal is closed as not renewing or cancelled.');
  if (!['open', 'decided'].includes(r.status)) throw bad('This renewal is already closed.', 409);
  await db.prepare(`UPDATE prop_renewals SET status = ?, closed_at = ${NOW} WHERE id = ?`).run(status, r.id);
  return getRenewal(r.id);
}

// ---------- requests ----------

const CHASE_AFTER = 5; // days with no reply before a follow-up is written
const canSend = (acc) => !!(acc && acc.can_write && acc.smtp_host);
const fill = (text, supplier) => String(text || '').replace(/\{supplier\}/g, supplier);

/** The facts a request is written from. What is paid today is left out: it is not another insurer's to know. */
async function brief(d, by) {
  const user = await db.prepare('SELECT name FROM users WHERE id = ?').get(Number(by) || 0);
  const place = [d.where, d.address, d.city, d.state].filter(Boolean).join(', ');
  return { title: d.title, place, company: d.company, number: d.number, expiry: d.expiry_date ? usDate(d.expiry_date) : null, sender: user?.name || d.company,
    cover: d.details.cover, sum_insured: d.details.sum_insured, deductible: d.details.deductible, insurer: d.details.insurer };
}

/** The request in plain words, for when the model cannot write it: to a new supplier, and to the one who holds the policy now. */
function plainWording(b) {
  const facts = [b.cover && `Cover: ${b.cover}`, b.sum_insured && `Sum insured: ${b.sum_insured}`, b.deductible && `Deductible: ${b.deductible}`].filter(Boolean).join('\n');
  const ask = 'with the premium, the sum insured, the deductible, what is covered and any exclusions, and how long the offer stands';
  const sign = `Thank you,\n${b.sender}\n${b.company}`;
  return {
    new: { subject: `Quotation request: ${b.title}, ${b.place}`,
      body: `Dear {supplier} team,\n\n${b.company} would like a quotation for ${b.title} for ${b.place}.\n\n${facts ? `${facts}\n` : ''}${b.expiry ? `The present policy expires on ${b.expiry}.\n` : ''}\nPlease send your quotation ${ask}. The present policy schedule is attached where we have it.\n\n${sign}` },
    renewal: { subject: `Renewal terms: ${b.title}${b.number ? `, policy ${b.number}` : ''}`,
      body: `Dear {supplier} team,\n\nOur ${b.title}${b.number ? ` (policy ${b.number})` : ''} for ${b.place} ${b.expiry ? `expires on ${b.expiry}` : 'is coming up for renewal'}.\n\nPlease send your renewal terms ${ask}.\n\n${sign}` },
  };
}

const WORDING = (b) => `Write two short, courteous business emails for ${b.company}, a property company, signed by ${b.sender}. Use only these facts and invent nothing:\n${JSON.stringify(b)}\n`
  + '1. "new": to an insurer or broker we have not used, asking for a quotation for this cover. 2. "renewal": to the supplier that holds it now, asking for renewal terms. '
  + 'Each asks for the premium, the sum insured, the deductible, what is covered, any exclusions and how long the offer stands. Say the present policy schedule is attached. '
  + 'Never mention what we pay now. Write {supplier} wherever the name of the company written to belongs. Plain text, no markdown. '
  + 'Reply with one JSON object and nothing else: {"new": {"subject": "...", "body": "..."}, "renewal": {"subject": "...", "body": "..."}}.';

async function wordingFor(d, by, think) {
  const b = await brief(d, by);
  const plain = plainWording(b);
  try {
    const got = pull(await think(WORDING(b)));
    for (const k of ['new', 'renewal']) if (line(got?.[k]?.subject, 200) && line(got[k].body, 20000)) plain[k] = { subject: line(got[k].subject, 200), body: line(got[k].body, 20000) };
  } catch (e) { console.error('[renewals] wording:', e.message); }
  return plain;
}

/** The policy as a file to go with an email, or none when it has no file (or the file has gone). */
function policyFile(d) {
  if (!d.file_path) return [];
  try { return [{ name: d.file_name || 'policy', mimetype: d.file_mime, buffer: readFileSync(d.file_path) }]; } catch { return []; }
}

/**
 * Write the request to each supplier named (or to every one not yet written to): a draft
 * that waits for `by` to approve it, with the policy attached. Nothing is written to an
 * address nobody has confirmed. With no mailbox that can send, the words are kept on the
 * request instead, to be copied and sent by hand.
 */
export async function draftRequests(id, supplierIds, by, deps) {
  const { think, account } = use(deps);
  const r = await rawRenewal(id);
  if (r.status !== 'open') throw bad('This renewal is no longer open.', 409);
  const want = Array.isArray(supplierIds) && supplierIds.length ? supplierIds.map(Number) : null;
  const todo = (await requestsOf(r.id)).filter((q) => ['listed', 'written'].includes(q.state) && (!want || want.includes(q.supplier_id)));
  if (!todo.length) return getRenewal(r.id);
  const missing = todo.filter((q) => !q.email || !q.email_confirmed);
  if (missing.length) throw bad(`Confirm an email address first for: ${missing.map((q) => q.name).join(', ')}.`);

  const d = await documentOf(r.document_id);
  const words = await wordingFor(d, by, think);
  const acc = await account(by);
  for (const q of todo) {
    const w = words[q.is_current ? 'renewal' : 'new'];
    const [subject, body] = [fill(w.subject, q.name), fill(w.body, q.name)];
    if (!canSend(acc)) {
      await db.prepare('UPDATE prop_renewal_requests SET subject = ?, body = ?, draft_id = NULL WHERE id = ?').run(subject, body, q.request_id);
      continue;
    }
    const attachments = store(by, policyFile(d)); // each email its own copy: one is removed when its email goes
    let draft;
    try { draft = await createDraft(by, { to: [q.email], subject, body, from: acc.email, attachments }); } catch (e) { discard({ attachments: JSON.stringify(attachments) }); throw e; }
    await logAction(by, { action: 'draft', draftId: draft.id, recipients: draft.to_addrs });
    await db.prepare('UPDATE prop_renewal_requests SET draft_id = ?, subject = NULL, body = NULL WHERE id = ?').run(draft.id, q.request_id);
  }
  return getRenewal(r.id);
}

const requestOf = async (renewalId, requestId) => {
  const q = (await requestsOf(renewalId)).find((x) => x.request_id === Number(requestId));
  if (!q) throw bad('Not found', 404);
  return q;
};

/** Reword a request that has not gone: the draft while it waits (its own drafter only), or the words kept for copying. */
export async function editRequest(id, requestId, { subject, body } = {}, by) {
  const r = await rawRenewal(id);
  const q = await requestOf(r.id, requestId);
  const [s, b] = [line(subject, 200), String(body ?? '').trim().slice(0, 20000)];
  if (!s || !b) throw bad('An email needs a subject and some words.');
  if (q.state === 'drafted') {
    if (q.draft_owner !== by) throw bad('Only the person who drafted it can change it.', 403);
    const done = await db.prepare("UPDATE email_drafts SET subject = ?, body = ? WHERE id = ? AND status = 'pending'").run(s, b, q.draft_id);
    if (!done.changes) throw bad('This email has already been decided.', 409);
  } else if (q.state === 'written') {
    await db.prepare('UPDATE prop_renewal_requests SET subject = ?, body = ? WHERE id = ?').run(s, b, q.request_id);
  } else throw bad('This request can no longer be changed.', 409);
  return getRenewal(r.id);
}

/** A request copied out and sent by hand: say so, and it counts as asked. */
export async function markSent(id, requestId) {
  const r = await rawRenewal(id);
  const q = await requestOf(r.id, requestId);
  if (q.state !== 'written') throw bad(q.state === 'listed' ? 'There is nothing written to this supplier yet.' : 'This request has already gone.', 409);
  await db.prepare(`UPDATE prop_renewal_requests SET manual_sent_at = ${NOW} WHERE id = ?`).run(q.request_id);
  return getRenewal(r.id);
}

/**
 * A follow-up, drafted to each supplier whose request went five or more days ago and has
 * not been answered: once each, threaded onto the request, and waiting for approval like
 * any other. `now` is the moment, in seconds.
 */
export async function chase(id, by, deps, now = Math.floor(Date.now() / 1000)) {
  const { account } = use(deps);
  const r = await rawRenewal(id);
  const acc = await account(by);
  if (r.status !== 'open' || !canSend(acc)) return getRenewal(r.id);
  const d = await documentOf(r.document_id);
  const b = await brief(d, by);
  for (const q of await requestsOf(r.id)) {
    if (q.state !== 'sent' || q.chased_at || !q.draft_id || now - q.sent_at < CHASE_AFTER * 86400) continue;
    const body = `Dear ${q.name} team,\n\nWe wrote on ${usDate(new Date(q.sent_at * 1000).toISOString().slice(0, 10))} asking for ${q.is_current ? 'renewal terms' : 'a quotation'} for ${b.title} for ${b.place}`
      + `${b.expiry ? `, which expires on ${b.expiry}` : ''}. We would be glad to have it, or to know if you will not be quoting.\n\nThank you,\n${b.sender}\n${b.company}`;
    const draft = await createDraft(by, { to: [q.email], subject: replySubject(q.subject), body, from: acc.email, inReplyTo: q.message_id, refs: q.message_id });
    await logAction(by, { action: 'draft', draftId: draft.id, recipients: draft.to_addrs });
    await db.prepare('UPDATE prop_renewal_requests SET chaser_draft_id = ?, chased_at = ? WHERE id = ?').run(draft.id, now, q.request_id);
  }
  return getRenewal(r.id);
}

// ---------- replies and quotes ----------

const QUOTE_DIR = `${DATA_DIR}/properties/quotes`;
const QUOTE_FIELDS = ['premium', 'sum_insured', 'deductible', 'cover', 'exclusions'];
// Addresses anyone can have: mail from one of these is only that supplier's when it is the very address written to.
const FREE_MAIL = /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|aol|proton|protonmail)\./i;
const addressOf = (from) => (String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '')).trim().toLowerCase();

/** Whether mail from `from` is that supplier's: the address written to, or anybody else at the same company's own domain. */
function fromSupplier(from, email) {
  const [a, b] = [addressOf(from), String(email || '').toLowerCase()];
  if (!a || !b) return false;
  if (a === b) return true;
  const domain = (x) => x.split('@')[1];
  return !FREE_MAIL.test(b) && !!domain(a) && domain(a) === domain(b);
}

const READ = 'This is what a supplier sent back after we asked for a quotation to renew a policy or contract. Reply with one JSON object and nothing else. '
  + '"kind": "quote" if it gives a price or terms, "question" if it asks us for something before it can quote, "declined" if they will not quote, otherwise "other". '
  + '"note": one short sentence saying what it says. And, for a quote, only what is actually stated: "premium", "sum_insured" and "deductible" (each with its currency), '
  + '"cover" (what is covered, one line), "exclusions" (the notable ones, one line), "valid_until" (the date the offer stands until, YYYY-MM-DD). Never guess a figure or a date.';

/**
 * What a reply says: a quote (with its figures), a question, a refusal, or something else.
 * `files` are read as they are, PDFs and photos; the rest are only named. A file handed over
 * as a quote (`asQuote`) is taken as one whatever the model calls it.
 */
export async function readReply({ text = '', files = [] }, deps, asQuote = false) {
  const { think } = use(deps);
  const blocks = files.map(fileBlock).filter(Boolean).slice(0, 3);
  const unread = files.filter((f) => !fileBlock(f)).map((f) => f.name || f.originalname);
  const o = pull(await think([...blocks, { type: 'text', text: `${READ}\n\nThe email says:\n${String(text || '').slice(0, 8000) || '(nothing)'}`
    + `${unread.length ? `\n\nAlso attached, and not readable here: ${unread.join(', ')}` : ''}` }], { maxTokens: 800 })) || {};
  const kind = asQuote ? 'quote' : ['quote', 'question', 'declined'].includes(o.kind) ? o.kind : 'other';
  const out = { kind, note: line(o.note, 500) || null };
  if (kind === 'quote') {
    for (const f of QUOTE_FIELDS) out[f] = line(o[f], 500) || null;
    out.valid_until = isDate(o.valid_until) ? o.valid_until : null;
  }
  return out;
}

/** Keep an offer, with the file it came in. Whatever was made of the offers before is out of date now. */
async function keepQuote(renewalId, supplierId, offer, file, source, emailId = null) {
  const f = file ? saveFile({ buffer: file.buffer, originalname: file.originalname || file.name || 'quote', mimetype: file.mimetype || 'application/octet-stream' }, QUOTE_DIR) : {};
  await db.prepare(`INSERT INTO prop_renewal_quotes (renewal_id, supplier_id, premium, sum_insured, deductible, cover, exclusions, valid_until, note, source, email_id, file_path, file_name, file_mime, told)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(renewalId, supplierId, offer.premium ?? null, offer.sum_insured ?? null, offer.deductible ?? null, offer.cover ?? null,
    offer.exclusions ?? null, offer.valid_until ?? null, offer.note ?? null, source, emailId, f.file_path ?? null, f.file_name ?? null, f.file_mime ?? null, source !== 'email');
  await db.prepare('UPDATE prop_renewals SET compared = NULL WHERE id = ?').run(renewalId);
}

/**
 * Look in the mailbox each request went from for what has come back: mail from that
 * supplier since it was written to, not read before. A quote is kept with its file; a
 * question, a refusal or anything else is noted on the request. It only reads.
 * Gives the names of who quoted and who asked something this time, and the renewal.
 */
export async function checkReplies(id, deps) {
  const { inbox, parts } = use(deps);
  const r = await rawRenewal(id);
  const out = { quotes: [], questions: [] };
  if (r.status !== 'open') return { ...out, renewal: await getRenewal(r.id) };
  const ownerOf = (q) => q.draft_owner || r.opened_by;
  const waiting = (await requestsOf(r.id)).filter((q) => ['sent', 'replied'].includes(q.state) && q.email && q.sent_at && ownerOf(q));
  const boxes = new Map(); // whose mailbox → its mail since the first of their requests went
  for (const q of waiting) {
    const owner = ownerOf(q);
    if (!boxes.has(owner)) {
      const first = Math.min(...waiting.filter((x) => ownerOf(x) === owner).map((x) => x.sent_at));
      boxes.set(owner, await inbox(owner, { since: new Date(first * 1000), limit: 200 }));
    }
    let kind = q.reply_kind;
    for (const m of boxes.get(owner)) {
      const at = Math.floor(new Date(m.at).getTime() / 1000);
      if (q.seen.includes(m.id) || at < q.sent_at || !fromSupplier(m.from, q.email)) continue;
      let got;
      let p;
      try { p = await parts(owner, m.id); } catch { got = { kind: 'unread', note: 'This reply could not be read here: open it in your mailbox.' }; }
      if (p) {
        // The model not answering is not the reply's fault: it is left unread, and tried again next time.
        try { got = await readReply(p, deps); } catch (e) { console.error('[renewals] reading a reply:', e.message); continue; }
        if (got.kind === 'quote') await keepQuote(r.id, q.supplier_id, got, (p.files || []).find(fileBlock) || (p.files || [])[0], 'email', m.id);
      }
      q.seen.push(m.id);
      // Once it has quoted it has quoted: a thank-you afterwards does not undo that.
      kind = kind === 'quote' ? 'quote' : got.kind;
      await db.prepare('UPDATE prop_renewal_requests SET seen = ?, reply_kind = ?, reply_note = ?, replied_at = ? WHERE id = ?').run(JSON.stringify(q.seen), kind, got.note, at, q.request_id);
      if (got.kind === 'quote') out.quotes.push(q.name);
      else if (got.kind === 'question') out.questions.push(q.name);
    }
  }
  return { ...out, renewal: await getRenewal(r.id) };
}

/** A quote that came some other way (WhatsApp, paper, a call): the file is put in by a person and read like the rest. */
export async function addQuote(id, supplierId, file, deps) {
  const r = await rawRenewal(id);
  if (!file) throw bad('Choose the file with the quote.');
  const q = (await requestsOf(r.id)).find((x) => x.supplier_id === Number(supplierId));
  if (!q) throw bad('Not found', 404);
  let offer;
  try { offer = await readReply({ files: [file] }, deps, true); } catch (e) { console.error('[renewals] reading a quote:', e.message); }
  if (!offer || !QUOTE_FIELDS.some((f) => offer[f])) offer = { note: 'This could not be read: open the file to see the offer.' };
  await keepQuote(r.id, q.supplier_id, offer, file, 'upload');
  await db.prepare(`UPDATE prop_renewal_requests SET reply_kind = 'quote', reply_note = coalesce(?, reply_note), replied_at = coalesce(replied_at, ${NOW}) WHERE id = ?`).run(offer.note ?? null, q.request_id);
  return getRenewal(r.id);
}

const quoteFile = async (renewalId, quoteId) => {
  const q = await db.prepare('SELECT id, file_path, file_name, file_mime FROM prop_renewal_quotes WHERE id = ? AND renewal_id = ?').get(Number(quoteId), Number(renewalId));
  if (!q) throw bad('Not found', 404);
  return q;
};

export async function removeQuote(id, quoteId) {
  const r = await rawRenewal(id);
  const q = await quoteFile(r.id, quoteId);
  await db.prepare('DELETE FROM prop_renewal_quotes WHERE id = ?').run(q.id);
  await db.prepare('UPDATE prop_renewals SET compared = NULL, chosen_quote_id = CASE WHEN chosen_quote_id = ? THEN NULL ELSE chosen_quote_id END WHERE id = ?').run(q.id, r.id);
  if (q.file_path) rmSync(q.file_path, { force: true });
  return getRenewal(r.id);
}

/**
 * What Riley does unasked, for every renewal under way: look for replies, tell whoever
 * opened it (and the master) of a quote that has come, once, and write a follow-up to a
 * supplier gone quiet, saying so. It reads and it drafts; it sends nothing. `now` in seconds.
 */
export async function runRenewals(deps, now = Math.floor(Date.now() / 1000)) {
  const { push } = use(deps);
  await settle();
  const masters = (await db.prepare("SELECT id FROM users WHERE role = 'master'").all()).map((u) => u.id);
  const tell = (who, title, body) => Promise.resolve(push(who, { title, body, url: '/?leasing=alerts', tag: 'leasing-renewals' })).catch((e) => console.error('[renewals] push:', e.message));
  for (const r of await db.prepare("SELECT id, document_id, opened_by FROM prop_renewals WHERE status = 'open' ORDER BY id").all()) {
    try {
      const d = await documentOf(r.document_id);
      const who = [...new Set([r.opened_by, ...masters].filter(Boolean))];
      const what = `${d.title}, ${d.where}`;
      await checkReplies(r.id, deps);
      for (const q of await db.prepare(`SELECT q.id, q.premium, s.name FROM prop_renewal_quotes q JOIN prop_suppliers s ON s.id = q.supplier_id WHERE q.renewal_id = ? AND NOT q.told ORDER BY q.id`).all(r.id)) {
        // Written down before it is said, so a restart in between never says it twice.
        if ((await db.prepare('UPDATE prop_renewal_quotes SET told = true WHERE id = ? AND NOT told').run(q.id)).changes) await tell(who, `A quote from ${q.name}`, `${what}${q.premium ? ` · ${q.premium}` : ''}`);
      }
      if (!r.opened_by) continue;
      const before = new Set((await requestsOf(r.id)).filter((q) => q.chased_at).map((q) => q.request_id));
      await chase(r.id, r.opened_by, deps, now);
      for (const q of (await requestsOf(r.id)).filter((x) => x.chased_at && !before.has(x.request_id))) await tell(who, `No reply from ${q.name}`, `${what} · a follow-up is written and waiting for you`);
    } catch (e) { console.error(`[renewals] renewal ${r.id}:`, e.message); }
  }
}

let timer = null;
/** Every half hour. If it stops, nothing is lost: "Check for replies" on the renewal does the same by hand. */
export function startRenewals() {
  if (timer) return;
  const tick = () => runRenewals().catch((e) => console.error('[renewals]', e.message));
  timer = setInterval(tick, 30 * 60_000);
  timer.unref();
  setTimeout(tick, 60_000).unref();
}

// ---------- comparison and decision ----------

const ROWS = ['premium', 'sum_insured', 'deductible', 'cover', 'exclusions', 'valid_until'];
const VERDICTS = ['better', 'worse', 'same'];

const LOOK = (s) => `Search the web for what can be checked about "${s.name}"${s.website ? ` (${s.website})` : ''}, a company a property owner may buy insurance or a service contract from. `
  + 'Reply with one JSON object and nothing else, each value one short line, leaving out what you did not find: '
  + '"licensed" (whether and by whom it is licensed or registered to trade), "rating" (a published financial-strength or credit rating, with who gave it), '
  + '"since" (the year it began trading), "summary" (one sentence on who they are), "sources" (a list of {"title", "url"} for the pages these came from). '
  + 'Report only what a page says. Do not judge whether the company is trustworthy.';

/**
 * What can be checked about a supplier, with where it was found: its licence, its rating,
 * how long it has traded. Evidence for a person to weigh, never a verdict. Kept on the
 * supplier with the day it was looked up; a search that fails leaves what was there.
 */
export async function lookUp(supplierId, deps) {
  const { search } = use(deps);
  const s = await db.prepare(`SELECT ${SUPPLIER} FROM prop_suppliers WHERE id = ?`).get(Number(supplierId));
  if (!s) throw bad('Not found', 404);
  let o;
  try { o = pull(await search(LOOK(s))); } catch (e) { console.error('[renewals] looking up a supplier:', e.message); }
  if (o) {
    const about = Object.fromEntries(['licensed', 'rating', 'since', 'summary'].map((k) => [k, line(o[k], 400)]).filter(([, v]) => v));
    about.sources = (Array.isArray(o.sources) ? o.sources : []).filter((x) => /^https?:\/\//i.test(line(x?.url, 1000)))
      .slice(0, 5).map((x) => ({ title: line(x.title, 200) || line(x.url, 200), url: line(x.url, 1000) }));
    about.checked_on = todayHere();
    await db.prepare('UPDATE prop_suppliers SET about = ? WHERE id = ?').run(JSON.stringify(about), s.id);
  }
  return supplierOut(await db.prepare(`SELECT ${SUPPLIER} FROM prop_suppliers WHERE id = ?`).get(s.id));
}

const WEIGH = (d, current, offers) => 'A property company is renewing this and has these offers. Compare each offer with the current terms from the buyer\'s side, and say which you would take.\n'
  + `${JSON.stringify({ what: d.title, for: d.where, current, offers })}\n`
  + `Reply with one JSON object and nothing else: "verdicts": for each offer's quote_id, for each of ${ROWS.join(', ')} that can be compared, "better", "worse" or "same" than the current terms `
  + '(a lower premium or deductible is better; wider cover, a higher sum insured and fewer exclusions are better; leave out what cannot be compared); '
  + '"pick": the quote_id you would take, or null if none can be recommended; "why": two or three plain sentences giving the reasons; "unsure": one sentence on what a person should check before deciding. '
  + 'Use only the figures given. What is said about a supplier is background, not a reason to trust or distrust it.';

/**
 * The offers beside the current policy: each supplier's latest, figure by figure, marked
 * better, worse or the same, with which one Riley would take and why. Suppliers that have
 * quoted and were never looked up are looked up first. If the model cannot be asked, the
 * figures are still laid side by side, with no marks and nothing recommended.
 */
export async function compare(id, deps) {
  const { think } = use(deps);
  const r = await rawRenewal(id);
  const latest = new Map(); // each supplier's newest offer replaces its older ones
  for (const q of await quotesOf(r.id)) latest.set(q.supplier_id, q);
  if (!latest.size) throw bad('There are no quotes to compare yet.');
  const d = await documentOf(r.document_id);

  const suppliers = new Map((await listSuppliers()).map((s) => [s.id, s]));
  await Promise.all([...latest.keys()].filter((sid) => !suppliers.get(sid)?.about?.checked_on)
    .map((sid) => lookUp(sid, deps).then((s) => suppliers.set(sid, s)).catch(() => {})));

  const current = Object.fromEntries([['supplier', d.details.insurer], ...ROWS.map((k) => [k, d.details[k]])].filter(([, v]) => v));
  const offers = [...latest.values()].sort((a, b) => a.id - b.id).map((q) => ({ quote_id: q.id, supplier_id: q.supplier_id, supplier: q.supplier,
    ...Object.fromEntries(ROWS.map((k) => [k, q[k] ?? null])), verdicts: {} }));
  const out = { at: Math.floor(Date.now() / 1000), current, offers, pick: null, why: null, unsure: null, failed: false };
  try {
    const o = pull(await think(WEIGH(d, current, offers.map(({ verdicts, supplier_id, ...x }) => ({ ...x, about: suppliers.get(supplier_id)?.about?.summary })))));
    if (!o) throw new Error('no answer');
    for (const x of offers) {
      const v = o.verdicts?.[x.quote_id] || {};
      x.verdicts = Object.fromEntries(ROWS.filter((k) => VERDICTS.includes(v[k])).map((k) => [k, v[k]]));
    }
    out.pick = offers.some((x) => x.quote_id === Number(o.pick)) ? Number(o.pick) : null;
    out.why = line(o.why, 1500) || null;
    out.unsure = line(o.unsure, 600) || null;
  } catch (e) {
    console.error('[renewals] comparing:', e.message);
    out.failed = true;
  }
  await db.prepare('UPDATE prop_renewals SET compared = ? WHERE id = ?').run(JSON.stringify(out), r.id);
  return getRenewal(r.id);
}

/** The letter to the supplier chosen, and to each of the others that were asked. What one offered is never told to another. */
function closingWords(b, q, chosen) {
  const sign = `Thank you,\n${b.sender}\n${b.company}`;
  if (chosen) {
    return { kind: 'accept', subject: `Accepting your quotation: ${b.title}, ${b.place}`,
      body: `Dear ${q.name} team,\n\nThank you for your quotation for ${b.title} for ${b.place}${chosen.premium ? ` at ${chosen.premium}` : ''}. We would like to go ahead with it.\n\n`
        + `Please tell us what you need from us to put the cover in place${b.expiry ? ` from ${b.expiry}, when the present policy ends` : ''}, and send the policy documents once it is.\n\n${sign}` };
  }
  return { kind: 'thanks', subject: `Your quotation: ${b.title}, ${b.place}`,
    body: `Dear ${q.name} team,\n\nThank you for ${q.reply_kind === 'quote' ? 'your quotation' : 'your time'} on ${b.title} for ${b.place}. `
      + `We have decided to place this cover ${q.is_current ? 'elsewhere' : 'with another provider'} for the coming period.\n\nWe will keep your details for next time.\n\n${sign}` };
}

/**
 * Choose an offer. The acceptance to that supplier and a thank-you to each of the others
 * that were asked are written as drafts, waiting like any other (or as words to copy, with
 * no mailbox). Chosen again, the letters that have not gone are withdrawn and written anew.
 */
export async function decide(id, quoteId, by, deps) {
  const { account } = use(deps);
  await settle();
  const r = await rawRenewal(id);
  if (!['open', 'decided'].includes(r.status)) throw bad('This renewal is already closed.', 409);
  const chosen = (await quotesOf(r.id)).find((q) => q.id === Number(quoteId));
  if (!chosen) throw bad('Not found', 404);

  for (const c of JSON.parse(r.closing || '[]')) {
    if (!c.draft_id) continue;
    const d = await db.prepare("UPDATE email_drafts SET status = 'rejected', decided_at = extract(epoch from now())::bigint WHERE id = ? AND status = 'pending' RETURNING *").get(c.draft_id);
    if (d) discard(d);
  }
  const b = await brief(await documentOf(r.document_id), by);
  const acc = await account(by);
  const closing = [];
  const asked = (await requestsOf(r.id)).filter((q) => q.supplier_id === chosen.supplier_id || ['sent', 'replied'].includes(q.state));
  for (const q of asked.sort((x, y) => (y.supplier_id === chosen.supplier_id) - (x.supplier_id === chosen.supplier_id))) {
    const w = closingWords(b, q, q.supplier_id === chosen.supplier_id ? chosen : null);
    let draft = null;
    if (canSend(acc) && q.email && q.email_confirmed) {
      draft = await createDraft(by, { to: [q.email], subject: w.subject, body: w.body, from: acc.email });
      await logAction(by, { action: 'draft', draftId: draft.id, recipients: draft.to_addrs });
    }
    closing.push({ supplier_id: q.supplier_id, supplier: q.name, email: q.email, kind: w.kind, draft_id: draft?.id ?? null, draft_owner: draft ? by : null, subject: w.subject, body: w.body });
  }
  await db.prepare("UPDATE prop_renewals SET status = 'decided', chosen_quote_id = ?, closing = ? WHERE id = ?").run(chosen.id, JSON.stringify(closing), r.id);
  return getRenewal(r.id);
}

// ---------- Riley's hands ----------
//
// The same steps, asked for in the chat. She can say where renewals stand, start one, look
// for replies and compare the offers. Finding suppliers' addresses, approving the emails
// and choosing an offer stay on the screen, where a person sees what they are agreeing to.

const text = { type: 'string' };
const WHICH = { document: { ...text, description: 'The document, by its name or part of it (e.g. "fire insurance").' }, place: { ...text, description: 'The building, unit or company it belongs to, when more than one document has that name.' } };

export const RENEWAL_TOOLS = [
  { name: 'renewal_status',
    description: 'Which documents (insurance policies, licences, certificates, contracts) are due for renewal or expired, and for each whether a renewal is under way and how far it has got: suppliers listed, asked, quotes in. Read-only.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'renewal_start',
    description: 'Start renewing a document: opens its renewal and lists the supplier that holds it now. Only when the user asks. It writes to nobody. '
      + 'Afterwards tell the user to open the renewal on the Documents page to choose who else to ask and to approve the emails.',
    input_schema: { type: 'object', properties: WHICH, required: ['document'] } },
  { name: 'renewal_check_replies',
    description: 'Look in the mailbox for replies to the quote requests of a renewal, read them, and say who has quoted, who asked a question and who has not answered. It only reads the mailbox.',
    input_schema: { type: 'object', properties: WHICH, required: ['document'] } },
  { name: 'renewal_compare',
    description: 'Compare the quotes received for a renewal with the current policy and say which you would take and why. Give the user the figures and the reasons, and what to check before deciding. The user decides, on the renewal screen.',
    input_schema: { type: 'object', properties: WHICH, required: ['document'] } },
];
export const RENEWAL_STATUS = { renewal_status: 'Looking at what is due for renewal…', renewal_start: 'Starting the renewal…', renewal_check_replies: 'Looking for replies…', renewal_compare: 'Comparing the offers…' };

/** The tools above, for `user`. Reading where things stand is anyone's; the rest is the master's, as on the screens. */
export function renewalTools(user, deps) {
  const master = () => { if (user?.role !== 'master') throw new Error('Only the master can run a renewal. Tell the user to ask them.'); };
  const label = (d) => `${d.title}, ${d.where}`;
  /** The one document meant, from the register; says which there are when it is none or several. */
  const find = async ({ document, place }) => {
    const all = await register();
    const has = (hay, needle) => !needle || String(hay).toLowerCase().includes(String(needle).trim().toLowerCase());
    const hits = all.filter((d) => has(d.title, document) && has(`${d.where} ${d.company}`, place));
    if (hits.length === 1) return hits[0];
    throw new Error(`${hits.length ? 'More than one document matches' : 'No document matches'} "${[document, place].filter(Boolean).join(', ')}". There are: ${(hits.length ? hits : all).slice(0, 30).map(label).join('; ') || 'none yet'}.`);
  };
  const underWay = async (input) => {
    const d = await find(input);
    const r = (await openByDocument()).get(d.id);
    if (!r) throw new Error(`No renewal has been started for ${label(d)}. Offer to start one.`);
    return { d, r };
  };
  const who = (v) => v.suppliers.map((s) => `- ${s.name}: ${s.email ? (s.email_confirmed ? s.email : `${s.email} (not confirmed)`) : 'no address yet'}; ${s.state}`
    + `${s.reply_note ? ` — ${s.reply_note}` : ''}`).join('\n') || '- nobody listed yet';

  return {
    renewal_status: async () => {
      const [docs, open] = [await register(), await listRenewals()];
      const due = docs.filter((d) => ['due', 'expired'].includes(d.status) || open.some((r) => same(r.title, d.title) && r.where === d.where));
      if (!due.length) return 'Nothing is due for renewal.';
      const under = await openByDocument();
      return due.map((d) => {
        const r = open.find((x) => x.id === under.get(d.id)?.id);
        return `- ${label(d)}: ${d.expiry_date ? `${d.status === 'expired' ? 'expired' : 'expires'} ${usDate(d.expiry_date)}` : 'no expiry'}; `
          + (r ? `renewal under way: ${r.listed} listed, ${r.asked} asked, ${r.quotes} quote${r.quotes === 1 ? '' : 's'}${r.status === 'decided' ? ', an offer chosen' : ''}` : 'no renewal started');
      }).join('\n');
    },
    renewal_start: async (input) => {
      master();
      const d = await find(input);
      const v = await startRenewal(d.id, user.id);
      return `The renewal of ${label(d)} is open. On it so far:\n${who(v)}\nNobody has been written to. The user opens it on the Documents page to find more suppliers, confirm their addresses and approve the emails.`;
    },
    renewal_check_replies: async (input) => {
      master();
      const { d, r } = await underWay(input);
      const got = await checkReplies(r.id, deps);
      if (!got.renewal.suppliers.some((s) => ['sent', 'replied'].includes(s.state))) return `Nobody has been written to yet for ${label(d)}.\n${who(got.renewal)}`;
      return `${label(d)}: ${got.quotes.length ? `new quote from ${got.quotes.join(', ')}` : 'no new quote'}${got.questions.length ? `; a question from ${got.questions.join(', ')}` : ''}.\n${who(got.renewal)}`;
    },
    renewal_compare: async (input) => {
      master();
      const { d, r } = await underWay(input);
      const c = (await compare(r.id, deps)).compared;
      const fields = (o) => ROWS.filter((k) => o[k]).map((k) => `${k.replace(/_/g, ' ')} ${o[k]}${o.verdicts?.[k] ? ` (${o.verdicts[k]})` : ''}`).join('; ');
      return [`${label(d)}. Current: ${fields(c.current) || 'figures not on file'}${c.current.supplier ? `, with ${c.current.supplier}` : ''}.`,
        ...c.offers.map((o) => `- ${o.supplier}: ${fields(o) || 'the offer could not be read'}${o.quote_id === c.pick ? ' ← recommended' : ''}`),
        c.failed ? 'The offers could not be weighed just now; these are the figures only.' : `${c.why || 'No recommendation.'}${c.unsure ? ` To check: ${c.unsure}` : ''}`,
        'The user chooses on the renewal screen; nothing has been accepted.'].join('\n');
    },
  };
}

// ---------- routes ----------

export const renewalRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
renewalRoutes.use(requireMaster); // a renewal commits the company to a supplier: all of it is the master's
// With whether this person's own mailbox can send, so the screen knows to offer Approve or the words to copy.
const shown = async (req, v) => ({ ...v, can_send: canSend(await real.account(req.user.id)), me: req.user.id });

renewalRoutes.get('/', wrap(async (req, res) => res.json({ renewals: await listRenewals() })));
renewalRoutes.get('/suppliers', wrap(async (req, res) => res.json(await listSuppliers())));
renewalRoutes.put('/suppliers/:sid', wrap(async (req, res) => res.json(await updateSupplier(req.params.sid, req.body))));
renewalRoutes.delete('/suppliers/:sid', wrap(async (req, res) => res.json(await removeSupplierForGood(req.params.sid))));
renewalRoutes.post('/suppliers/:sid/lookup', wrap(async (req, res) => res.json(await lookUp(req.params.sid))));
renewalRoutes.post('/', wrap(async (req, res) => res.json(await shown(req, await startRenewal(req.body?.document_id, req.user.id)))));
renewalRoutes.get('/:id', wrap(async (req, res) => res.json(await shown(req, await getRenewal(req.params.id)))));
renewalRoutes.post('/:id/find', wrap(async (req, res) => res.json(await findSuppliers(req.params.id))));
renewalRoutes.post('/:id/suppliers', wrap(async (req, res) => res.json(await shown(req, await addSuppliers(req.params.id, req.body?.suppliers)))));
renewalRoutes.delete('/:id/suppliers/:sid', wrap(async (req, res) => res.json(await shown(req, await removeSupplier(req.params.id, req.params.sid)))));
renewalRoutes.post('/:id/requests', wrap(async (req, res) => res.json(await shown(req, await draftRequests(req.params.id, req.body?.supplier_ids, req.user.id)))));
renewalRoutes.put('/:id/requests/:rid', wrap(async (req, res) => res.json(await shown(req, await editRequest(req.params.id, req.params.rid, req.body, req.user.id)))));
renewalRoutes.post('/:id/requests/:rid/sent', wrap(async (req, res) => res.json(await shown(req, await markSent(req.params.id, req.params.rid)))));
renewalRoutes.post('/:id/check', wrap(async (req, res) => {
  const got = await checkReplies(req.params.id);
  res.json({ quotes: got.quotes, questions: got.questions, renewal: await shown(req, got.renewal) });
}));
renewalRoutes.post('/:id/chase', wrap(async (req, res) => res.json(await shown(req, await chase(req.params.id, req.user.id)))));
renewalRoutes.post('/:id/quotes', upload.single('file'), wrap(async (req, res) => res.json(await shown(req, await addQuote(req.params.id, req.body?.supplier_id, req.file)))));
renewalRoutes.delete('/:id/quotes/:qid', wrap(async (req, res) => res.json(await shown(req, await removeQuote(req.params.id, req.params.qid)))));
renewalRoutes.get('/:id/quotes/:qid/file', wrap(async (req, res) => sendDoc(req, res, await quoteFile(req.params.id, req.params.qid))));
renewalRoutes.post('/:id/compare', wrap(async (req, res) => res.json(await shown(req, await compare(req.params.id)))));
renewalRoutes.post('/:id/decide', wrap(async (req, res) => res.json(await shown(req, await decide(req.params.id, req.body?.quote_id, req.user.id)))));
renewalRoutes.post('/:id/close', wrap(async (req, res) => res.json(await shown(req, await closeRenewal(req.params.id, req.body?.status)))));
