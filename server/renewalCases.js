import { db } from './db.js';
import { isMaster, isExternal } from './access.js';
import { userModules } from './modules.js';
import { readableDocument } from './files.js';
import { askSaifsys, dubaiDate } from './saifsys/client.js';

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
  'checking_documents', 'writing_back', 'paused', 'closed'];
const DECIDING = ['open', 'renew_review', 'cancel_review', 'needs_review'];
const AFTER = { renew: 'renew_review', cancel: 'cancel_review', needs_review: 'needs_review' };

export async function caseSettings() {
  return (await db.prepare('SELECT open_days, approver_ids, pro_ids FROM renewal_case_settings WHERE id = 1').get())
    || { open_days: 60, approver_ids: [], pro_ids: [] };
}

export const event = (caseId, userId, kind, detail = {}) =>
  db.prepare('INSERT INTO renewal_case_events (case_id, user_id, kind, detail) VALUES (?, ?, ?, ?)').run(caseId, userId, kind, JSON.stringify(detail));

/** May this person work cases at all? The master, and Document Renewals holders who are not external. */
async function worker(user) {
  if (isMaster(user)) return true;
  return !isExternal(user) && (await userModules(user)).includes('document_renewals');
}

/** A case this person may see: they work cases and can read its document. */
export async function getCase(user, id) {
  const c = await db.prepare('SELECT * FROM renewal_cases WHERE id = ?').get(Number(id) || 0);
  if (!c || !(await worker(user)) || !(await readableDocument(user, c.document_id))) throw bad('Not found', 404);
  return c;
}

export async function listCases(user, { closed = false } = {}) {
  if (!(await worker(user))) return [];
  const rows = await db.prepare(`SELECT c.*, t.label AS type FROM renewal_cases c
    JOIN documents d ON d.id = c.document_id LEFT JOIN document_types t ON t.id = d.type_id
    WHERE (c.closed_at IS NULL) <> ? ORDER BY c.ends_on ASC NULLS LAST, c.id`).all(closed);
  const out = [];
  for (const c of rows) if (await readableDocument(user, c.document_id)) out.push(c);
  return out;
}

async function openCase(doc, { userId = null, status = 'open', kind = null } = {}) {
  const { id } = await db.prepare(`INSERT INTO renewal_cases (document_id, employee_code, employee_name, subject, ends_on, kind, status, owner_id)
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
  await db.prepare(`UPDATE renewal_cases SET status = ?, kind = ?, owner_id = COALESCE(owner_id, ?), updated_at = ${'extract(epoch from now())::bigint'} WHERE id = ?`)
    .run(AFTER[choice], kind, user.id, c.id);
  await event(c.id, user.id, 'decision', { choice, note: String(note || '').trim().slice(0, 500) || null });
  return getCase(user, c.id);
}

export async function pause(user, id, { reason } = {}) {
  const c = await getCase(user, id);
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw bad('Say why it is paused');
  if (c.closed_at || c.status === 'paused') throw bad('This case cannot be paused now');
  await db.prepare('UPDATE renewal_cases SET status = ?, paused_from = ?, paused_reason = ?, updated_at = ? WHERE id = ?').run('paused', c.status, why, now(), c.id);
  await event(c.id, user.id, 'paused', { reason: why });
}

export async function resume(user, id) {
  const c = await getCase(user, id);
  if (c.status !== 'paused') throw bad('This case is not paused');
  await db.prepare('UPDATE renewal_cases SET status = ?, paused_from = NULL, paused_reason = NULL, updated_at = ? WHERE id = ?').run(c.paused_from || 'open', now(), c.id);
  await event(c.id, user.id, 'resumed');
}

export async function closeCase(caseId, userId, note) {
  await db.prepare("UPDATE renewal_cases SET status = 'closed', closed_at = ?, closed_note = ?, updated_at = ? WHERE id = ?").run(now(), note, now(), caseId);
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
  for (const c of await db.prepare(`SELECT c.id, c.document_id FROM renewal_cases c JOIN documents d ON d.id = c.document_id
      WHERE c.closed_at IS NULL AND d.superseded_by IS NOT NULL`).all()) {
    let to = c.document_id;
    for (let i = 0; i < 20; i++) {
      const next = (await db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(to))?.superseded_by;
      if (!next) break;
      to = next;
    }
    const d = await db.prepare('SELECT * FROM documents WHERE id = ?').get(to);
    await db.prepare('UPDATE renewal_cases SET document_id = ?, ends_on = ?, updated_at = ? WHERE id = ?').run(d.id, d.expires_on, now(), c.id);
    await event(c.id, null, 'moved', { from: c.document_id, to: d.id, ends_on: d.expires_on });
    out.moved++;
  }

  // An open case for someone who has left closes.
  for (const c of await db.prepare('SELECT id, employee_code FROM renewal_cases WHERE closed_at IS NULL AND employee_code IS NOT NULL').all()) {
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
      AND NOT EXISTS (SELECT 1 FROM renewal_cases r WHERE r.document_id = d.id)
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
