import { db } from './db.js';
import { isMaster, isExternal } from './access.js';
import { userModules } from './modules.js';
import { readableDocument } from './files.js';
import { askSaifsys, dubaiDate } from './saifsys/client.js';
import { sendPush } from './push.js';

// Renewal cases (Document Renewals): one document being renewed or cancelled, from the
// decision to the papers coming back. A contract (a type the master ticked "opens a case")
// opens one by itself 60 days before it ends; any other document when the admin taps Renew
// or Cancel. People decide: nothing here renews, terminates or cancels anything by itself.
// Every step is an event with who took it. The master and Document Renewals holders work
// the cases, on documents they can read.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const DAY = 86400000;
const shift = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const now = () => Math.floor(Date.now() / 1000);

export const STATUSES = ['open', 'renew_review', 'cancel_review', 'needs_review', 'awaiting_approval', 'with_pro',
  'approved', 'checking_documents', 'writing_back', 'paused', 'closed'];
const DECIDING = ['open', 'renew_review', 'cancel_review', 'needs_review'];
const AFTER = { renew: 'renew_review', cancel: 'cancel_review', needs_review: 'needs_review' };

export async function caseSettings() {
  return (await db.prepare('SELECT open_days, approver_ids, pro_ids FROM doc_renewal_case_settings WHERE id = 1').get())
    || { open_days: 60, approver_ids: [], pro_ids: [] };
}

export const event = (caseId, userId, kind, detail = {}) =>
  db.prepare('INSERT INTO doc_renewal_case_events (case_id, user_id, kind, detail) VALUES (?, ?, ?, ?)').run(caseId, userId, kind, JSON.stringify(detail));

/** May this person work cases at all? The master, and Document Renewals holders who are not external. */
async function worker(user) {
  if (isMaster(user)) return true;
  return !isExternal(user) && (await userModules(user)).includes('document_renewals');
}

/** A case this person may see: they work cases and can read its document. */
export async function getCase(user, id) {
  const c = await db.prepare('SELECT * FROM doc_renewal_cases WHERE id = ?').get(Number(id) || 0);
  if (!c || !(await worker(user)) || !(await readableDocument(user, c.document_id))) throw bad('Not found', 404);
  return c;
}

export async function listCases(user, { closed = false } = {}) {
  if (!(await worker(user))) return [];
  const rows = await db.prepare(`SELECT c.*, t.label AS type FROM doc_renewal_cases c
    JOIN documents d ON d.id = c.document_id LEFT JOIN document_types t ON t.id = d.type_id
    WHERE (c.closed_at IS NULL) <> ? ORDER BY c.ends_on ASC NULLS LAST, c.id`).all(closed);
  const out = [];
  for (const c of rows) if (await readableDocument(user, c.document_id)) out.push(c);
  return out;
}

async function openCase(doc, { userId = null, status = 'open', kind = null } = {}) {
  const { id } = await db.prepare(`INSERT INTO doc_renewal_cases (document_id, employee_code, employee_name, subject, ends_on, kind, status, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .run(doc.id, doc.employee_code, doc.employee_name, doc.subject, doc.expires_on, kind, status, userId);
  await event(id, userId, 'opened', userId ? {} : { by: 'the daily check', ends_on: doc.expires_on });
  return id;
}

/** The admin's Renew or Cancel on a document. */
export async function startCase(user, docId, kind) {
  if (!(await worker(user))) throw bad('You do not have Document Renewals', 403);
  if (!['renew', 'cancel'].includes(kind)) throw bad('Renew or cancel?');
  const doc = await readableDocument(user, docId);
  if (!doc) throw bad('Not found', 404);
  if (!doc.category_id) throw bad('Give this file its kind of document first (passport, visa, licence...)');
  let id;
  try {
    id = await openCase(doc, { userId: user.id, status: AFTER[kind], kind });
  } catch (e) {
    if (e.code === '23505') throw bad('This document already has an open case', 409);
    throw e;
  }
  await event(id, user.id, 'decision', { choice: kind });
  return getCase(user, id);
}

/** Renew, cancel (for a contract: start a termination review) or needs review. Only before approval. */
export async function decide(user, id, { choice, note } = {}) {
  const c = await getCase(user, id);
  if (!AFTER[choice]) throw bad('Choose renew, cancel or needs review');
  if (!DECIDING.includes(c.status)) throw bad('This case is past its decision');
  const kind = choice === 'needs_review' ? c.kind : choice;
  await db.prepare(`UPDATE doc_renewal_cases SET status = ?, kind = ?, owner_id = COALESCE(owner_id, ?), updated_at = ${'extract(epoch from now())::bigint'} WHERE id = ?`)
    .run(AFTER[choice], kind, user.id, c.id);
  await event(c.id, user.id, 'decision', { choice, note: String(note || '').trim().slice(0, 500) || null });
  return getCase(user, c.id);
}

export async function pause(user, id, { reason } = {}) {
  const c = await getCase(user, id);
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw bad('Say why it is paused');
  if (c.closed_at || c.status === 'paused') throw bad('This case cannot be paused now');
  await db.prepare('UPDATE doc_renewal_cases SET status = ?, paused_from = ?, paused_reason = ?, updated_at = ? WHERE id = ?').run('paused', c.status, why, now(), c.id);
  await event(c.id, user.id, 'paused', { reason: why });
}

export async function resume(user, id) {
  const c = await getCase(user, id);
  if (c.status !== 'paused') throw bad('This case is not paused');
  await db.prepare('UPDATE doc_renewal_cases SET status = ?, paused_from = NULL, paused_reason = NULL, updated_at = ? WHERE id = ?').run(c.paused_from || 'open', now(), c.id);
  await event(c.id, user.id, 'resumed');
}

export async function closeCase(caseId, userId, note) {
  await db.prepare("UPDATE doc_renewal_cases SET status = 'closed', closed_at = ?, closed_note = ?, updated_at = ? WHERE id = ?").run(now(), note, now(), caseId);
  await event(caseId, userId, 'closed', { note });
}

/** Not a case for us (a contractor, a mistake): closed with the reason, and not reopened. */
export async function outOfScope(user, id, { reason } = {}) {
  const c = await getCase(user, id);
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw bad('Say why it is out of scope');
  if (c.closed_at) throw bad('This case is already closed');
  await closeCase(c.id, user.id, `Out of scope: ${why}`);
}

/**
 * The daily check: a confirmed contract within open_days of its end opens a case; an open
 * case follows its contract to the newer one that replaced it; one whose employee has left
 * in saifsys closes. Nothing is opened or closed when saifsys cannot say who is still here.
 */
export async function scanCases({ today = dubaiDate(), ask = askSaifsys } = {}) {
  const out = { opened: 0, moved: 0, closed: 0 };
  const { open_days } = await caseSettings();
  const staff = new Map(); // code -> saifsys employee, or an Error
  const employee = async (code) => {
    if (!staff.has(code)) {
      staff.set(code, await ask('hr', 'employee', { q: code }).then((r) => (r.employee && String(r.employee.code) === code ? r.employee : null), (e) => e));
    }
    return staff.get(code);
  };

  // An open case whose document was replaced follows it to the newest one.
  for (const c of await db.prepare(`SELECT c.id, c.document_id FROM doc_renewal_cases c JOIN documents d ON d.id = c.document_id
      WHERE c.closed_at IS NULL AND d.superseded_by IS NOT NULL`).all()) {
    let to = c.document_id;
    for (let i = 0; i < 20; i++) {
      const next = (await db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(to))?.superseded_by;
      if (!next) break;
      to = next;
    }
    const d = await db.prepare('SELECT * FROM documents WHERE id = ?').get(to);
    await db.prepare('UPDATE doc_renewal_cases SET document_id = ?, ends_on = ?, updated_at = ? WHERE id = ?').run(d.id, d.expires_on, now(), c.id);
    await event(c.id, null, 'moved', { from: c.document_id, to: d.id, ends_on: d.expires_on });
    out.moved++;
  }

  // An open case for someone who has left closes.
  for (const c of await db.prepare('SELECT id, employee_code FROM doc_renewal_cases WHERE closed_at IS NULL AND employee_code IS NOT NULL').all()) {
    const e = await employee(c.employee_code);
    if (e && !(e instanceof Error) && e.left) {
      await closeCase(c.id, null, `Left in saifsys on ${e.exit_date || 'an unknown date'}`);
      out.closed++;
    }
  }

  // A confirmed contract near its end, for someone still here, opens a case once.
  const due = await db.prepare(`SELECT d.* FROM documents d
      JOIN document_types t ON t.id = d.type_id AND t.opens_case
      JOIN document_categories c ON c.id = d.category_id AND c.links_to = 'employee'
    WHERE d.employee_code IS NOT NULL AND d.expires_on IS NOT NULL AND d.expires_on <= ?
      AND d.expiry_confirmed_at IS NOT NULL AND d.link_confirmed_at IS NOT NULL
      AND d.superseded_by IS NULL AND d.not_renewing_at IS NULL AND d.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM doc_renewal_cases r WHERE r.document_id = d.id)
    ORDER BY d.expires_on, d.id`).all(shift(today, open_days));
  for (const d of due) {
    const e = await employee(d.employee_code);
    if (!e || e instanceof Error || e.left) continue;
    try {
      await openCase(d);
      out.opened++;
    } catch (err) {
      if (err.code !== '23505') throw err; // another run opened it a moment ago
    }
  }
  return out;
}

// ---------- proposal and approval ----------

const MONEY = ['basic', 'allowance', 'bonus'];
const TEXT = ['position', 'location', 'hours', 'benefits'];
const DATES = ['new_start', 'new_end', 'effective_date', 'expected_expiry', 'last_working_day', 'notice_given_on'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Is this case's document a contract (its type opens cases)? */
async function isContract(c) {
  return !!(await db.prepare(`SELECT t.opens_case FROM documents d JOIN document_types t ON t.id = d.type_id WHERE d.id = ?`).get(c.document_id))?.opens_case;
}

// Only the fields a proposal has, cleaned: numbers as numbers, dates as dates, short texts.
function cleanTerms(t = {}) {
  const out = {};
  for (const k of MONEY) if (t[k] !== undefined && t[k] !== '' && t[k] !== null) {
    const n = Number(t[k]);
    if (!Number.isFinite(n) || n < 0) throw bad(`${k} must be an amount`);
    out[k] = n;
  }
  for (const k of TEXT) if (t[k]) out[k] = String(t[k]).trim().slice(0, 300);
  for (const k of DATES) if (t[k]) {
    if (!isDate(t[k])) throw bad(`${k.replace(/_/g, ' ')} must be a date`);
    out[k] = t[k];
  }
  for (const k of ['reason', 'notice_days']) if (t[k]) out[k] = k === 'notice_days' ? Number(t[k]) || 0 : String(t[k]).trim().slice(0, 500);
  return out;
}

/**
 * HR's proposal. A contract renewal keeps the terms (copied from saifsys), updates them (a new
 * end and effective date required), or resolves a discrepancy first (the case pauses). Any other
 * document proposes its expected new expiry; a cancellation its reason.
 */
export async function propose(user, id, { mode, terms, note } = {}, { ask = askSaifsys } = {}) {
  const c = await getCase(user, id);
  if (!['renew_review', 'cancel_review', 'needs_review'].includes(c.status)) throw bad('Decide renew or cancel first, before the proposal');
  const contract = await isContract(c);
  const why = String(note || '').trim().slice(0, 1000) || null;
  let t;
  if (c.kind === 'cancel') {
    if (mode !== 'cancel') throw bad('This case is a cancellation');
    t = cleanTerms(terms);
    if (!t.reason) throw bad('Say why it is being cancelled');
    if (contract && !t.last_working_day) throw bad('Give the last working day');
  } else if (!contract) {
    if (mode !== 'renew_document') throw bad('Keep and update terms are for contracts; give the expected new expiry');
    t = cleanTerms(terms);
    if (!t.expected_expiry) throw bad('Give the expected new expiry date');
  } else if (mode === 'resolve_first') {
    await pause(user, c.id, { reason: `Resolve before proceeding${why ? `: ${why}` : ''}` });
    return getCase(user, c.id);
  } else if (mode === 'keep') {
    const e = c.employee_code ? (await ask('hr', 'employee', { q: c.employee_code })).employee : null;
    if (!e) throw bad('saifsys has no record of this employee to copy the terms from', 502);
    t = cleanTerms({ ...e.salary, position: e.position, location: e.location, ...terms });
  } else if (mode === 'update') {
    t = cleanTerms(terms);
    if (!t.new_end) throw bad('Give the new end date');
    if (!t.effective_date) throw bad('Give the date the new terms start');
  } else {
    throw bad('Choose keep terms, update terms or resolve first');
  }
  const proposal = { mode, terms: t, note: why, by: user.id, at: now() };
  await db.prepare('UPDATE doc_renewal_cases SET proposal = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(proposal), now(), c.id);
  await event(c.id, user.id, 'proposal', proposal);
  return getCase(user, c.id);
}

/** Who approves: the people the master named, or else the master. */
async function approvers() {
  const { approver_ids } = await caseSettings();
  if (approver_ids?.length) return approver_ids;
  return (await db.prepare("SELECT id FROM users WHERE role = 'master' AND NOT external ORDER BY id").all()).map((r) => r.id);
}

export async function submit(user, id, { push = sendPush } = {}) {
  const c = await getCase(user, id);
  if (!['renew_review', 'cancel_review', 'needs_review'].includes(c.status)) throw bad('This case is not being prepared');
  if (!c.proposal) throw bad('Write the proposal first');
  await db.prepare("UPDATE doc_renewal_cases SET status = 'awaiting_approval', updated_at = ? WHERE id = ?").run(now(), c.id);
  await event(c.id, user.id, 'submitted');
  // Who and what, never the terms: the approver reads those on the case page.
  const who = c.employee_name || c.subject || 'a document';
  await push((await approvers()).filter((uid) => uid !== user.id || isMaster(user)), {
    title: `Approval needed: ${c.kind === 'cancel' ? 'cancellation' : 'renewal'} for ${who}`,
    body: 'Open the case to read the proposal and approve or reject it',
    url: `/?docrenewals=case-${c.id}`,
    tag: `renewal-case-${c.id}`,
  });
}

async function mayApprove(user, c) {
  const list = await approvers();
  if (!isMaster(user) && !list.includes(user.id)) throw bad('Only the approvers or the master approve', 403);
  if (c.proposal?.by === user.id && !isMaster(user)) throw bad('Someone else has to approve your own proposal', 403);
}

export async function approve(user, id) {
  const c = await getCase(user, id);
  if (c.status !== 'awaiting_approval') throw bad('Nothing is waiting for approval');
  await mayApprove(user, c);
  await db.prepare("UPDATE doc_renewal_cases SET status = 'approved', updated_at = ? WHERE id = ?").run(now(), c.id);
  await event(c.id, user.id, 'approved');
}

export async function reject(user, id, { note } = {}) {
  const c = await getCase(user, id);
  if (c.status !== 'awaiting_approval') throw bad('Nothing is waiting for approval');
  await mayApprove(user, c);
  const why = String(note || '').trim().slice(0, 1000);
  if (!why) throw bad('Say why it is rejected');
  await db.prepare('UPDATE doc_renewal_cases SET status = ?, updated_at = ? WHERE id = ?').run(c.kind === 'cancel' ? 'cancel_review' : 'renew_review', now(), c.id);
  await event(c.id, user.id, 'rejected', { note: why });
}
