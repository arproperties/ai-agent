import { db } from './db.js';
import { MODELS } from './config.js';
import { docHistory } from './properties.js';
import { cleanAddresses } from './drafts.js';

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
    ch.status AS chaser_status
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

/** A renewal as the screen and Riley see it: the document, who is on it and where each stands, the offers, and what was made of them. */
export async function getRenewal(id) {
  await settle();
  const r = await rawRenewal(id);
  const { file_path, ...document } = await documentOf(r.document_id);
  return { id: r.id, status: r.status, opened_by: r.opened_by, created_at: Number(r.created_at), chosen_quote_id: r.chosen_quote_id, document,
    suppliers: (await requestsOf(r.id)).map(({ draft_owner, message_id, seen, ...q }) => q),
    quotes: await quotesOf(r.id), compared: r.compared ? JSON.parse(r.compared) : null, closing: JSON.parse(r.closing || '[]') };
}

/** The renewals still under way, newest first, each with how far it has got. */
export async function listRenewals() {
  await settle();
  const rows = await db.prepare("SELECT id FROM prop_renewals WHERE status IN ('open', 'decided') ORDER BY id DESC").all();
  const out = [];
  for (const { id } of rows) {
    const r = await getRenewal(id);
    out.push({ id: r.id, status: r.status, title: r.document.title, where: r.document.where, expiry_date: r.document.expiry_date,
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
