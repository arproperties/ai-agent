import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';
import { sendMail } from './mailer.js';
import { dubaiDate, dubaiHour } from './saifsys/client.js';

// Company post-dated cheques: a register of the cheques the company gives (issued) and the
// cheques it is given (received), each with its date, amount and status, so that nobody is
// surprised by one falling due or bouncing.
//
// These are the company's own cheques. A tenant's lease cheques are a different thing and
// stay in saifsys (Real Estate); nothing here reads or changes them.
//
// A cheque is typed once. Its status is changed by hand as things happen (deposited,
// cleared, on hold, bounced, replaced, cancelled, or a status with a name of its own), and
// every change is kept in its history. One copy of the cheque can be kept with it.
//
// Emails: a pending cheque is told as its date comes near (7, 3, 1 and 0 days before, by
// default), again each week once the date has passed, and a deposited cheque that has not
// cleared after 3, 7 and 14 days. A cheque set to Bounced is told at once, each time. Every
// one of these is the company's to change (the hour, the days, whether at all): the
// defaults are saifsys's Real Estate cheque reminders. They go to the person who added the
// cheque and to the addresses on the company's alert list. The daily check sends each person
// one email listing all their cheques.
//
// Each saifsys company has its own list (company_id is saifsys's). Reem keeps all of it; the
// saifsys screens (Loan Tracker → Post Dated Cheques) only show it, through the door in
// server/fromSaifsys.js. Who may open those screens is saifsys's role rule; signed in to Reem
// itself, the list is the master's.

const NOW = 'extract(epoch from now())::bigint';
const DIR = `${DATA_DIR}/company-pdc`;
const DAY = 86400000;
const LIST_DUE_DAYS = 7; // the list's "Due in the next 7 days" card and filter
// How the emails behave until a company changes it (Email alerts → Settings on the saifsys
// page). The same rhythm as saifsys's Real Estate cheque reminders: 7, 3, 1 and 0 days before
// the cheque date, weekly once overdue, and 3, 7 and 14 days after a deposit that has not cleared.
export const ALERT_DEFAULTS = Object.freeze({
  enabled: true, hour: 8, due_days: [7, 3, 1, 0], overdue_every_days: 7, deposited_days: [3, 7, 14], bounce_now: true,
});

export const DIRECTIONS = {
  issued: { label: 'Issued', long: 'Issued by us', party: 'Paid to' },
  received: { label: 'Received', long: 'Received by us', party: 'Received from' },
};
export const STATUSES = {
  pending: 'Pending', deposited: 'Deposited', cleared: 'Cleared', on_hold: 'On hold',
  bounced: 'Bounced', replaced: 'Replaced', cancelled: 'Cancelled', other: 'Other',
};
const MAX = { party_name: 200, cheque_no: 50, bank: 120, purpose: 255, location: 150, reference: 100, approved_by: 150, issued_by: 150, notes: 1000, company_name: 200 };
const MAX_OTHER = 60;
const MAX_NOTE = 255;
const MAX_EMAIL = 150;
const MAX_AMOUNT = 1_000_000_000;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A day that exists: 2026-02-30 and 2026-13-01 look like dates and are not.
const realDate = (s) => {
  if (!DATE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const toTime = (s) => Date.parse(`${s}T00:00:00Z`);
const shift = (s, n) => new Date(toTime(s) + n * DAY).toISOString().slice(0, 10);
const daysFrom = (today, date) => Math.round((toTime(date) - toTime(today)) / DAY);
const money = (n) => Math.round(Number(n) * 100) / 100;
const aed = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pretty = (s) => new Date(toTime(s)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A status as words: "Cleared", or the name typed for "other" ("With legal"). */
export const statusLabel = (status, other) => (status === 'other' && String(other ?? '').trim() ? String(other).trim() : STATUSES[status] || status);

/**
 * What the status box says, as [status, name of an "other"], or null when it says nothing
 * usable. "custom:With legal" is a name typed before and picked again; "other" takes the
 * name from `typed`.
 */
export function parseStatus(choice, typed) {
  const c = String(choice ?? '');
  if (c.startsWith('custom:')) {
    const name = text(c.slice(7), MAX_OTHER);
    return name ? ['other', name] : null;
  }
  if (c === 'other') {
    const name = text(typed, MAX_OTHER);
    return name ? ['other', name] : null;
  }
  return STATUSES[c] ? [c, null] : null;
}

// ---------- reading ----------

const CHEQUE = `SELECT p.*, u.name AS created_by_name FROM company_pdcs p LEFT JOIN users u ON u.id = p.created_by`;
const LIVE = 'p.deleted_at IS NULL';

const shape = (p) => ({
  id: p.id, company_id: p.company_id, direction: p.direction, party_name: p.party_name, cheque_no: p.cheque_no, bank: p.bank,
  cheque_date: p.cheque_date, amount: money(p.amount), purpose: p.purpose, location: p.location, reference: p.reference,
  approved_by: p.approved_by, issued_by: p.issued_by, status: p.status, status_other: p.status_other,
  status_label: statusLabel(p.status, p.status_other), status_date: p.status_date, notes: p.notes,
  attachment: !!p.attachment, original_name: p.original_name, created_by: p.created_by_name || null, created_at: Number(p.created_at),
});

const chequeOf = async (companyId, id) =>
  (await db.prepare(`${CHEQUE} WHERE p.id = ? AND p.company_id = ? AND ${LIVE}`).get(Number(id) || 0, companyId)) || null;

/** The names typed for "other" so far in this company, so each can be picked again. */
export async function customStatuses(companyId) {
  const rows = await db.prepare(`SELECT DISTINCT trim(x) AS x FROM (
      SELECT p.status_other AS x FROM company_pdcs p WHERE p.company_id = ? AND p.status = 'other' AND ${LIVE}
      UNION SELECT h.to_other FROM company_pdc_history h JOIN company_pdcs p ON p.id = h.pdc_id
        WHERE p.company_id = ? AND h.to_status = 'other' AND ${LIVE}
    ) t WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1`).all(companyId, companyId);
  return rows.map((r) => r.x);
}

/**
 * The list of one company, filtered, with the four numbers on top (those count every cheque
 * of the company, whatever the filter).
 *   dir: issued | received      status: all | open (pending or deposited) | a status | custom:Name
 *   month: YYYY-MM of the cheque date      due=7: dated up to seven days from today      q: search
 */
export async function listCheques(user, companyId, query = {}, today = dubaiDate()) {
  const week = shift(today, LIST_DUE_DAYS);
  const where = ['p.company_id = ?', LIVE];
  const args = [companyId];
  const dir = DIRECTIONS[query.dir] ? query.dir : '';
  const status = String(query.status ?? 'all');
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month || '') ? query.month : '';
  const q = text(query.q, 100);
  if (dir) { where.push('p.direction = ?'); args.push(dir); }
  if (status.startsWith('custom:')) { where.push("p.status = 'other' AND p.status_other = ?"); args.push(status.slice(7)); }
  else if (status === 'open') where.push("p.status IN ('pending', 'deposited')");
  else if (STATUSES[status]) { where.push('p.status = ?'); args.push(status); }
  if (month) { where.push('substr(p.cheque_date, 1, 7) = ?'); args.push(month); }
  if (String(query.due) === '7') { where.push('p.cheque_date <= ?'); args.push(week); }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const cols = ['party_name', 'cheque_no', 'bank', 'purpose', 'reference', 'location', 'issued_by'];
    where.push(`(${cols.map((c) => `p.${c} ILIKE ?`).join(' OR ')})`);
    args.push(...cols.map(() => like));
  }
  const rows = await db.prepare(`${CHEQUE} WHERE ${where.join(' AND ')} ORDER BY p.cheque_date, p.id`).all(...args);
  const sum = await db.prepare(`SELECT
      COALESCE(sum(amount) FILTER (WHERE status = 'pending' AND direction = 'issued'), 0)::float8 AS out_amt,
      (count(*) FILTER (WHERE status = 'pending' AND direction = 'issued'))::int AS out_n,
      COALESCE(sum(amount) FILTER (WHERE status IN ('pending', 'deposited') AND direction = 'received'), 0)::float8 AS in_amt,
      (count(*) FILTER (WHERE status IN ('pending', 'deposited') AND direction = 'received'))::int AS in_n,
      COALESCE(sum(amount) FILTER (WHERE status = 'pending' AND cheque_date <= ?), 0)::float8 AS due_amt,
      (count(*) FILTER (WHERE status = 'pending' AND cheque_date <= ?))::int AS due_n,
      COALESCE(sum(amount) FILTER (WHERE status = 'bounced'), 0)::float8 AS bounced_amt,
      (count(*) FILTER (WHERE status = 'bounced'))::int AS bounced_n
    FROM company_pdcs p WHERE p.company_id = ? AND ${LIVE}`).get(week, week, companyId);
  const months = await db.prepare(`SELECT DISTINCT substr(p.cheque_date, 1, 7) AS m FROM company_pdcs p
    WHERE p.company_id = ? AND ${LIVE} ORDER BY 1 DESC`).all(companyId);
  const { n } = await db.prepare('SELECT count(*)::int AS n FROM company_pdc_alert_recipients WHERE company_id = ?').get(companyId);
  const cheques = rows.map(shape);
  return {
    today, cheques, total: money(cheques.reduce((t, c) => t + c.amount, 0)),
    summary: { ...sum, out_amt: money(sum.out_amt), in_amt: money(sum.in_amt), due_amt: money(sum.due_amt), bounced_amt: money(sum.bounced_amt) },
    months: months.map((r) => r.m), customs: await customStatuses(companyId), alert_recipients: n,
  };
}

/** One cheque with its history, newest change first. null: not this company's, or deleted. */
export async function getCheque(user, companyId, id) {
  const p = await chequeOf(companyId, id);
  if (!p) return null;
  const history = await db.prepare(`SELECT h.id, h.from_status, h.from_other, h.to_status, h.to_other, h.changed_on, h.note, u.name AS by_name
    FROM company_pdc_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.pdc_id = ? ORDER BY h.changed_on DESC, h.id DESC`).all(p.id);
  return {
    cheque: shape(p),
    history: history.map((h) => ({
      id: h.id, from_status: h.from_status, from_other: h.from_other, from_label: h.from_status ? statusLabel(h.from_status, h.from_other) : null,
      to_status: h.to_status, to_other: h.to_other, to_label: statusLabel(h.to_status, h.to_other),
      changed_on: h.changed_on, note: h.note, by: h.by_name || null,
    })),
    customs: await customStatuses(companyId),
  };
}

// ---------- saving ----------

// What was typed, checked. Every thing wrong is said at once, so the form is fixed in one go.
function readCheque(input) {
  const f = { direction: String(input.direction ?? '') };
  for (const [k, max] of Object.entries(MAX)) f[k] = text(input[k], max);
  f.cheque_date = String(input.cheque_date ?? '').trim();
  const amount = Number(String(input.amount ?? '').replace(/,/g, ''));
  f.amount = Number.isFinite(amount) ? money(amount) : 0;
  const wrong = [];
  if (!DIRECTIONS[f.direction]) wrong.push('Please choose whether we issued or received the cheque.');
  if (!f.party_name) wrong.push(`Please enter who the cheque is ${f.direction === 'received' ? 'from' : 'to'}.`);
  if (!f.cheque_no) wrong.push('Please enter the cheque number.');
  if (!realDate(f.cheque_date)) wrong.push('Please enter the cheque date.');
  if (!(f.amount > 0) || f.amount > MAX_AMOUNT) wrong.push('Please enter the amount.');
  return { f, wrong };
}

/**
 * Add a cheque (id null) or change one. The status is given only when adding; afterwards it
 * is changed with setStatus, so that every change is in the history. The same cheque number
 * of the same bank, the same way round, is refused: it is the same cheque typed twice.
 * null: no such cheque.
 */
export async function saveCheque(user, companyId, id, input = {}, today = dubaiDate()) {
  const old = id === null ? null : await chequeOf(companyId, id);
  if (id !== null && !old) return null;
  const { f, wrong } = readCheque(input);
  let first = ['pending', null];
  if (!old) {
    const picked = parseStatus(input.status ?? 'pending', input.status_other);
    if (!picked) wrong.push(input.status === 'other' ? 'Please type the name of the status.' : 'Please choose the status.');
    else first = picked;
  }
  if (wrong.length) throw bad(wrong.join(' '));
  const twin = await db.prepare(`SELECT id FROM company_pdcs p WHERE p.company_id = ? AND p.cheque_no = ? AND COALESCE(p.bank, '') = ?
    AND p.direction = ? AND p.id <> ? AND ${LIVE}`).get(companyId, f.cheque_no, f.bank, f.direction, old?.id || 0);
  if (twin) throw bad(`Cheque ${f.cheque_no}${f.bank ? ` of ${f.bank}` : ''} is already in the list.`, 409);

  const vals = [f.direction, f.party_name, f.cheque_no, f.bank || null, f.cheque_date, f.amount, f.purpose || null, f.location || null,
    f.reference || null, f.approved_by || null, f.issued_by || null, f.notes || null];
  let chequeId = old?.id;
  await tx(async () => {
    if (old) {
      await db.prepare(`UPDATE company_pdcs SET direction = ?, party_name = ?, cheque_no = ?, bank = ?, cheque_date = ?, amount = ?, purpose = ?,
        location = ?, reference = ?, approved_by = ?, issued_by = ?, notes = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`)
        .run(...vals, user?.id ?? null, old.id);
      return;
    }
    chequeId = (await db.prepare(`INSERT INTO company_pdcs (direction, party_name, cheque_no, bank, cheque_date, amount, purpose, location, reference,
        approved_by, issued_by, notes, status, status_other, status_date, company_id, company_name, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .run(...vals, first[0], first[1], today, companyId, f.company_name || null, user?.id ?? null)).id;
    await db.prepare(`INSERT INTO company_pdc_history (pdc_id, from_status, to_status, to_other, changed_on, note, changed_by)
      VALUES (?, NULL, ?, ?, ?, 'Added', ?)`).run(chequeId, first[0], first[1], today, user?.id ?? null);
  });
  return shape(await chequeOf(companyId, chequeId));
}

/**
 * Change the status, and write the change in the history. A cheque set to Bounced is
 * emailed about straight away; `alert` says what happened to that email.
 * null: no such cheque.
 */
export async function setStatus(user, companyId, id, input = {}, { today = dubaiDate(), send = sendMail } = {}) {
  const p = await chequeOf(companyId, id);
  if (!p) return null;
  const picked = parseStatus(input.to, input.to_other);
  if (!picked) throw bad(input.to === 'other' ? 'Please type the name of the new status.' : 'Please choose the new status.');
  const on = String(input.on ?? '').trim() || today;
  if (!realDate(on) || on > today) throw bad('Please enter the date of the change (not in the future).');
  const [to, other] = picked;
  if (to === p.status && String(other ?? '').toLowerCase() === String(p.status_other ?? '').toLowerCase()) {
    throw bad(`The cheque is already ${statusLabel(p.status, p.status_other)}.`, 409);
  }
  const note = text(input.note, MAX_NOTE);
  let historyId = 0;
  await tx(async () => {
    // One change at a time per cheque: two people pressing at once must not both go through
    // (two lines in the history, and a bounce emailed twice).
    const now = await db.prepare('SELECT status, status_other FROM company_pdcs WHERE id = ? FOR UPDATE').get(p.id);
    if (now.status !== p.status || String(now.status_other ?? '') !== String(p.status_other ?? '')) {
      throw bad(`Somebody else just changed this cheque to ${statusLabel(now.status, now.status_other)}. Please look at it again.`, 409);
    }
    // A bounce email still owed for an earlier bounce is overtaken by this change.
    await db.prepare("DELETE FROM company_pdc_alerts WHERE pdc_id = ? AND kind = 'bounced' AND result IN ('failed', 'sending')").run(p.id);
    await db.prepare(`UPDATE company_pdcs SET status = ?, status_other = ?, status_date = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`)
      .run(to, other, on, user?.id ?? null, p.id);
    historyId = (await db.prepare(`INSERT INTO company_pdc_history (pdc_id, from_status, from_other, to_status, to_other, changed_on, note, changed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(p.id, p.status, p.status_other, to, other, on, note || null, user?.id ?? null)).id;
  });
  const after = await chequeOf(companyId, p.id);
  let alert = null;
  if (to === 'bounced' && (await alertSettings(companyId)).bounce_now) {
    // The status is saved whatever happens to the email.
    alert = await sendAlert(after, 'bounced', `h${historyId}`, note, { send, today })
      .catch((e) => { console.error('[company pdc] bounce alert:', e.message); return { result: 'failed', to: [] }; });
  }
  return { cheque: shape(after), alert };
}

/**
 * A cheque put in by mistake, taken off the list. It stays as a record of who deleted it and
 * when, with its history, and keeps no file. Its number can then be typed again.
 * null: no such cheque.
 */
export async function deleteCheque(user, companyId, id) {
  const p = await chequeOf(companyId, id);
  if (!p) return null;
  await db.prepare(`UPDATE company_pdcs SET deleted_at = ${NOW}, deleted_by = ?, attachment = NULL, original_name = NULL WHERE id = ?`)
    .run(user?.id ?? null, p.id);
  dropFile(p.attachment);
  return { ok: true, cheque_no: p.cheque_no, party_name: p.party_name };
}

// ---------- the copy of the cheque ----------

const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const dropFile = (path) => { if (path) rmSync(path, { force: true }); };

/** Keep a copy of the cheque with it; a new one replaces the old. null: no such cheque. */
export async function setAttachment(user, companyId, id, file, name = '') {
  const p = await chequeOf(companyId, id);
  if (!p) return null;
  const ext = FILE_TYPES[file?.mimetype];
  if (!ext || !file.buffer?.length) throw bad('The cheque copy must be a picture (JPG, PNG) or a PDF');
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/cheque-${p.id}-${Date.now()}.${ext}`;
  await writeFile(path, file.buffer);
  await db.prepare('UPDATE company_pdcs SET attachment = ?, original_name = ? WHERE id = ?')
    .run(path, text(name, 255) || `cheque-${p.id}.${ext}`, p.id);
  dropFile(p.attachment);
  return { ok: true };
}

/** The copy taken off; the cheque stays as it is. null: no such cheque. */
export async function removeAttachment(user, companyId, id) {
  const p = await chequeOf(companyId, id);
  if (!p) return null;
  await db.prepare('UPDATE company_pdcs SET attachment = NULL, original_name = NULL WHERE id = ?').run(p.id);
  dropFile(p.attachment);
  return { ok: true };
}

export const attachmentPath = async (companyId, id) => (await chequeOf(companyId, id))?.attachment || null;

// ---------- who is emailed ----------

export const listRecipients = async (companyId) => (await db.prepare(`SELECT id, email, on_due, on_bounce FROM company_pdc_alert_recipients
  WHERE company_id = ? ORDER BY email`).all(companyId));

/** Add addresses (typed with spaces, commas or semicolons between them). Says how many were new, and which are not addresses. */
export async function addRecipients(user, companyId, input = {}) {
  const typed = String(input.emails ?? '').split(/[\s,;]+/).filter(Boolean);
  if (!typed.length) throw bad('Type at least one email address');
  const wrong = [];
  let added = 0;
  for (const e of typed) {
    if (!EMAIL.test(e) || e.length > MAX_EMAIL) { wrong.push(e); continue; }
    added += (await db.prepare(`INSERT INTO company_pdc_alert_recipients (company_id, email, on_due, on_bounce, created_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (company_id, email) DO NOTHING`).run(companyId, e.toLowerCase(), !!input.on_due, !!input.on_bounce, user?.id ?? null)).changes;
  }
  return { added, bad: wrong };
}

/** Switch one kind of alert on or off for an address. what: due | bounce. null: no such address. */
export async function setRecipient(user, companyId, id, input = {}) {
  const col = input.what === 'bounce' ? 'on_bounce' : 'on_due';
  const row = await db.prepare(`UPDATE company_pdc_alert_recipients SET ${col} = ? WHERE id = ? AND company_id = ? RETURNING id`)
    .get(!!input.on, Number(id) || 0, companyId);
  return row ? { ok: true } : null;
}

export async function removeRecipient(user, companyId, id) {
  const row = await db.prepare('DELETE FROM company_pdc_alert_recipients WHERE id = ? AND company_id = ? RETURNING id').get(Number(id) || 0, companyId);
  return row ? { ok: true } : null;
}

/** The last alerts of a company, newest first, for the Email alerts box. */
export async function recentAlerts(companyId, limit = 8) {
  const rows = await db.prepare(`SELECT a.id, a.kind, a.sent_to, a.result, a.error, a.created_at, p.cheque_no, p.party_name
    FROM company_pdc_alerts a JOIN company_pdcs p ON p.id = a.pdc_id WHERE p.company_id = ? ORDER BY a.id DESC LIMIT ?`).all(companyId, limit);
  return rows.map((a) => ({ id: a.id, kind: a.kind, sent_to: a.sent_to, result: a.result, error: a.error, at: Number(a.created_at), cheque_no: a.cheque_no, party_name: a.party_name }));
}

// ---------- how a company wants its emails ----------

const settingsOf = (r) => ({
  enabled: r.enabled, hour: r.hour, due_days: [...r.due_days], overdue_every_days: r.overdue_every_days,
  deposited_days: [...r.deposited_days], bounce_now: r.bounce_now,
});

/** A company's email settings; the defaults until it has saved its own. */
export async function alertSettings(companyId) {
  const r = await db.prepare(`SELECT enabled, hour, due_days, overdue_every_days, deposited_days, bounce_now
    FROM company_pdc_alert_settings WHERE company_id = ?`).get(companyId);
  return settingsOf(r || ALERT_DEFAULTS);
}

// A list of days as typed ("7, 3, 1, 0") or as an array: whole numbers within [min, max], each once.
function daysList(value, { min, max, what }) {
  const parts = (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter((x) => x !== '');
  if (parts.length > 12) throw bad(`${what}: twelve numbers at most.`);
  const out = new Set();
  for (const x of parts) {
    const n = Number(x);
    if (!/^\d+$/.test(x) || n < min || n > max) throw bad(`${what}: type whole numbers from ${min} to ${max}, with commas between them (like 7, 3, 1).`);
    out.add(n);
  }
  return [...out];
}
const yes = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

/**
 * Save a company's email settings. Anything left out stays as it is. An empty list of days
 * switches that kind of reminder off. reset: back to the defaults.
 */
export async function saveAlertSettings(user, companyId, input = {}) {
  if (yes(input.reset)) {
    await db.prepare('DELETE FROM company_pdc_alert_settings WHERE company_id = ?').run(companyId);
    return alertSettings(companyId);
  }
  const now = await alertSettings(companyId);
  const whole = (v, min, max, what) => {
    const n = Number(v);
    if (!/^\d+$/.test(String(v).trim()) || n < min || n > max) throw bad(`${what}: type a whole number from ${min} to ${max}.`);
    return n;
  };
  const s = {
    enabled: input.enabled === undefined ? now.enabled : yes(input.enabled),
    hour: input.hour === undefined ? now.hour : whole(input.hour, 0, 23, 'The hour the daily email is sent'),
    due_days: input.due_days === undefined ? now.due_days
      : daysList(input.due_days, { min: 0, max: 90, what: 'Days before the cheque date' }).sort((a, b) => b - a),
    overdue_every_days: input.overdue_every_days === undefined ? now.overdue_every_days
      : whole(input.overdue_every_days, 0, 90, 'How often an overdue cheque is repeated'),
    deposited_days: input.deposited_days === undefined ? now.deposited_days
      : daysList(input.deposited_days, { min: 1, max: 180, what: 'Days after a deposit that has not cleared' }).sort((a, b) => a - b),
    bounce_now: input.bounce_now === undefined ? now.bounce_now : yes(input.bounce_now),
  };
  await db.prepare(`INSERT INTO company_pdc_alert_settings (company_id, enabled, hour, due_days, overdue_every_days, deposited_days, bounce_now, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (company_id) DO UPDATE SET enabled = EXCLUDED.enabled, hour = EXCLUDED.hour,
      due_days = EXCLUDED.due_days, overdue_every_days = EXCLUDED.overdue_every_days, deposited_days = EXCLUDED.deposited_days,
      bounce_now = EXCLUDED.bounce_now, updated_by = EXCLUDED.updated_by, updated_at = ${NOW}`)
    .run(companyId, s.enabled, s.hour, s.due_days, s.overdue_every_days, s.deposited_days, s.bounce_now, user?.id ?? null);
  return alertSettings(companyId);
}

/**
 * The one reminder a cheque is due today, as { kind, ref }, or null. `ref` names the step, so
 * each step is told once; it carries the date it counts from, so a cheque given a new date
 * (or deposited again) starts afresh.
 *   pending, not yet due: the nearest "days before" the cheque has reached. Only that one: a
 *     cheque first seen 5 days ahead gets the 7-day reminder, then 3, 1 and 0 as they come.
 *   pending, date passed: "overdue" the day after, and again every `overdue_every_days`
 *     (0: only that once).
 *   deposited, not cleared: once the deposit is that many days old (the latest one reached).
 */
export function dueStep(p, today, s) {
  if (p.status === 'pending') {
    const days = daysFrom(today, p.cheque_date);
    if (days < 0) {
      const round = s.overdue_every_days > 0 ? Math.floor((-days - 1) / s.overdue_every_days) : 0;
      return { kind: 'overdue', ref: `${p.cheque_date}:o${round}` };
    }
    const reached = s.due_days.filter((n) => days <= n).sort((a, b) => a - b)[0];
    return reached === undefined ? null : { kind: 'due_soon', ref: `${p.cheque_date}:d${reached}` };
  }
  if (p.status === 'deposited' && p.status_date) {
    const since = daysFrom(p.status_date, today);
    const reached = s.deposited_days.filter((n) => since >= n).sort((a, b) => b - a)[0];
    return reached === undefined ? null : { kind: 'not_cleared', ref: `${p.status_date}:c${reached}` };
  }
  return null;
}

// ---------- the emails ----------

const saifsysUrl =() => (process.env.SAIFSYS_URL || 'https://saifholdinggroup.com/sys').replace(/\/+$/, '');

/** The addresses for one cheque and one kind of alert: whoever added it first, then the company's list. No repeats. */
export async function alertTo(p, kind) {
  const to = new Map();
  const add = (e) => { if (e && EMAIL.test(e) && !to.has(e.toLowerCase())) to.set(e.toLowerCase(), e); };
  if (p.created_by) add((await db.prepare('SELECT email FROM users WHERE id = ?').get(p.created_by))?.email);
  const col = kind === 'bounced' ? 'on_bounce' : 'on_due';
  for (const r of await db.prepare(`SELECT email FROM company_pdc_alert_recipients WHERE company_id = ? AND ${col} ORDER BY id`).all(p.company_id)) add(r.email);
  return [...to.values()];
}

const whyLine = (many) => `You get this because your address is on the Company's Post Dated Cheques alert list, or you added ${many ? 'these cheques' : 'this cheque'}.`;

/** One cheque's alert, as an email. */
export function alertMail(p, kind, note = '', today = dubaiDate()) {
  const dir = DIRECTIONS[p.direction] || { long: '', party: 'Party' };
  const days = daysFrom(today, p.cheque_date);
  const what = kind === 'bounced' ? 'has BOUNCED'
    : kind === 'overdue' ? `is overdue (dated ${pretty(p.cheque_date)}, ${plural(Math.abs(days), 'day')} ago)`
      : days === 0 ? 'is due today' : `is due in ${plural(days, 'day')} (${pretty(p.cheque_date)})`;
  const subject = `[Company's PDC] Cheque ${p.cheque_no} · ${p.party_name} · AED ${aed(p.amount)} ${what}`;
  const rows = [
    ...(p.company_name ? [['Company', p.company_name]] : []),
    ['Type', dir.long], [dir.party, p.party_name], ['Cheque no.', p.cheque_no], ...(p.bank ? [['Bank', p.bank]] : []),
    ['Cheque date', pretty(p.cheque_date)], ['Amount', `AED ${aed(p.amount)}`],
    ['Status', statusLabel(kind === 'bounced' ? 'bounced' : p.status, p.status_other)],
    ...(p.purpose ? [['Reason', p.purpose]] : []), ...(note ? [['Note', note]] : []),
  ];
  const url = `${saifsysUrl()}/modules/loan_tracker/pdc_form.php?id=${p.id}`;
  const html = `<p>Company's post dated cheque <b>${esc(p.cheque_no)}</b> ${esc(what)}.</p>`
    + '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">'
    + rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join('')
    + `</table><p><a href="${esc(url)}">Open the cheque</a></p>`
    + `<p style="color:#6b7280;font-size:12px">${whyLine(false)}</p>`;
  const plain = `Company's post dated cheque ${p.cheque_no} ${what}.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${url}\n\n${whyLine(false)}`;
  return { subject, html, text: plain };
}

/**
 * One email for one person: a table of their cheques that are overdue, coming due, or
 * deposited and still not cleared - in that order.
 */
export function digestMail(items, today = dubaiDate()) {
  const rank = { overdue: 0, due_soon: 1, not_cleared: 2 };
  const list = [...items].sort((a, b) => rank[a.kind] - rank[b.kind] || a.p.cheque_date.localeCompare(b.p.cheque_date));
  const count = (kind) => list.filter((i) => i.kind === kind).length;
  const [over, soon, waiting] = [count('overdue'), count('due_soon'), count('not_cleared')];
  const total = list.reduce((t, i) => t + Number(i.p.amount), 0);
  const parts = [over ? `${over} overdue` : '', soon ? `${soon} due soon` : '', waiting ? `${waiting} deposited, not cleared` : ''].filter(Boolean).join(', ');
  const subject = `[Company's PDC] ${parts} · AED ${aed(total)}`;
  const th = 'style="text-align:left;padding:6px 10px;background:#1e3a8a;color:#fff;font-size:12px"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px"';
  const when = (i) => {
    if (i.kind === 'not_cleared') return `Deposited ${plural(daysFrom(i.p.status_date, today), 'day')} ago, not cleared`;
    const days = daysFrom(today, i.p.cheque_date);
    return i.kind === 'overdue' ? `Overdue ${plural(Math.abs(days), 'day')}` : days === 0 ? 'Today' : `In ${plural(days, 'day')}`;
  };
  const url = `${saifsysUrl()}/modules/loan_tracker/pdc.php?status=open`;
  const html = `<p>Company's post dated cheques that need attention: <b>${esc(parts)}</b>.</p>`
    + '<table style="border-collapse:collapse;font-family:Arial,sans-serif">'
    + `<tr><th ${th}>When</th><th ${th}>Cheque date</th><th ${th}>Cheque no.</th><th ${th}>Type</th><th ${th}>Paid to / from</th>`
    + `<th ${th}>Bank</th><th ${th}>Reason</th><th ${th} align="right">Amount (AED)</th></tr>`
    + list.map((i) => `<tr><td ${td}>${i.kind === 'overdue' ? `<b style="color:#b91c1c">${esc(when(i))}</b>` : `<span style="color:#b45309">${esc(when(i))}</span>`}</td>`
      + `<td ${td}>${esc(pretty(i.p.cheque_date))}</td><td ${td}><b>${esc(i.p.cheque_no)}</b></td><td ${td}>${esc(DIRECTIONS[i.p.direction]?.label || '')}</td>`
      + `<td ${td}>${esc(i.p.party_name)}</td><td ${td}>${esc(i.p.bank || '—')}</td><td ${td}>${esc(i.p.purpose || '—')}</td>`
      + `<td ${td} align="right">${aed(i.p.amount)}</td></tr>`).join('')
    + `<tr><td colspan="7" style="padding:8px 10px;font-weight:bold;font-size:13px">Total</td><td style="padding:8px 10px;font-weight:bold;font-size:13px" align="right">${aed(total)}</td></tr></table>`
    + `<p><a href="${esc(url)}">Open Company's Post Dated Cheques</a></p>`
    + `<p style="color:#6b7280;font-size:12px">${whyLine(true)} When and how often a cheque is listed is set under Email alerts on that page.</p>`;
  const plain = `Company's post dated cheques that need attention: ${parts}.\n\n`
    + list.map((i) => `${when(i)} · ${pretty(i.p.cheque_date)} · ${i.p.cheque_no} · ${DIRECTIONS[i.p.direction]?.label || ''} · ${i.p.party_name} · AED ${aed(i.p.amount)}`).join('\n')
    + `\n\nTotal: AED ${aed(total)}\n\n${url}\n\n${whyLine(true)}`;
  return { subject, html, text: plain };
}

// An alert is written down BEFORE its emails go, as "sending", and given its end after:
// sent, nobody to send it to, or failed. So two checks at once (the timer and "Check now", or
// the button pressed twice) cannot both send it, and a restart in the middle of sending does
// not send it all again. A failed one stays open: the next check takes it up again, and only
// for the addresses that did not get it (sent_to keeps the ones that did). "Sending" left
// behind by a restart counts as failed after a quarter of an hour.
const STALE = 15 * 60;
const open = (t) => `(${t}.result = 'failed' OR (${t}.result = 'sending' AND ${t}.created_at < ${NOW} - ${STALE}))`;
const settled = async (pdcId, kind, refKey) =>
  !!(await db.prepare(`SELECT 1 FROM company_pdc_alerts a WHERE a.pdc_id = ? AND a.kind = ? AND a.ref_key = ? AND NOT ${open('a')}`).get(pdcId, kind, refKey));
const addresses = (text) => String(text || '').split(',').map((a) => a.trim()).filter(Boolean);

/** Take an alert to send. null: it is done, or somebody else is sending it. got: who has it already, in small letters. */
async function claim(pdcId, kind, refKey) {
  // A try is counted once an hour at most (tried_at is when the last one was counted): the
  // timer's hourly look counts, "Check now" pressed again and again in between does not.
  const counts = `(company_pdc_alerts.tried_at IS NULL OR company_pdc_alerts.tried_at <= ${NOW} - ${TRY_APART})`;
  const taken = await db.prepare(`INSERT INTO company_pdc_alerts (pdc_id, kind, ref_key, result, tries, tried_at) VALUES (?, ?, ?, 'sending', 1, ${NOW})
    ON CONFLICT (pdc_id, kind, ref_key) DO UPDATE SET result = 'sending', error = NULL, created_at = ${NOW},
        tries = company_pdc_alerts.tries + CASE WHEN ${counts} THEN 1 ELSE 0 END,
        tried_at = CASE WHEN ${counts} THEN ${NOW} ELSE company_pdc_alerts.tried_at END
      WHERE ${open('company_pdc_alerts')} RETURNING sent_to, tries`).get(pdcId, kind, refKey);
  if (!taken) return null;
  // sent_to is kept through every try, also one cut off by a restart: who has it is not sent it again.
  return { got: new Set(addresses(taken.sent_to).map((a) => a.toLowerCase())), tries: taken.tries };
}
// An alert that keeps failing is tried on so many different hours, then given up: an address
// that no longer exists must not be tried for ever, and a mail server too slow to answer in
// time must not deliver the same email again and again. A reminder has five hours - by then
// the day's next reminder is not far off. A bounce is the one that must get through, and has
// no next one behind it: it is tried for two days.
const TRY_APART = 50 * 60; // a little under the hour between two looks of the timer
const MAX_TRIES = { bounced: 48 };
const MAX_TRIES_USUAL = 5;
/**
 * The end of an alert taken with claim(): who got it, and how it went. Failed for the last
 * time it is "gave_up", which is an end like any other. Returns the result as kept.
 */
async function finish(mine, pdcId, kind, refKey, got, result, error) {
  const kept = result === 'failed' && mine.tries >= (MAX_TRIES[kind] || MAX_TRIES_USUAL) ? 'gave_up' : result;
  await db.prepare(`UPDATE company_pdc_alerts SET sent_to = ?, result = ?, error = ?, created_at = ${NOW}
    WHERE pdc_id = ? AND kind = ? AND ref_key = ?`).run(got.join(', ').slice(0, 1000) || null, kept, error ? String(error).slice(0, 255) : null, pdcId, kind, refKey);
  return kept;
}

// The emails of one alert or one check go out together, and none may take longer than this:
// somebody is waiting at the screen (a cheque just set to Bounced, "Check now"), and a mail
// server that does not answer must not keep them there. One that was too slow counts as
// failed, and is tried again.
const SEND_WAIT = 10_000;
const inTime = (work) => {
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('The mail server did not answer in time')), SEND_WAIT); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};
/** Send each mail; says for each address whether it got through. */
async function sendAll(send, mails) {
  const ends = await Promise.allSettled(mails.map((m) => inTime(Promise.resolve().then(() => send(m)))));
  return ends.map((e, i) => ({ to: mails[i].to, ok: e.status === 'fulfilled', error: e.reason?.message || null }));
}

/**
 * One alert about one cheque, once. Returns { result: sent | failed | no_recipients | already, to }.
 * Sent means every address got it; if one did not, it is failed and tried again for that one.
 * `send` is sendMail, replaceable for tests.
 */
export async function sendAlert(p, kind, refKey, note = '', { send = sendMail, today = dubaiDate() } = {}) {
  const mine = await claim(p.id, kind, refKey);
  if (!mine) return { result: 'already', to: [] };
  const to = await alertTo(p, kind);
  const has = (addr) => mine.got.has(addr.toLowerCase());
  const mail = alertMail(p, kind, note, today);
  const ends = await sendAll(send, to.filter((addr) => !has(addr)).map((addr) => ({ to: addr, ...mail })));
  const got = [...to.filter(has), ...ends.filter((e) => e.ok).map((e) => e.to)];
  const missed = ends.find((e) => !e.ok);
  const result = await finish(mine, p.id, kind, refKey, got, !to.length ? 'no_recipients' : missed ? 'failed' : 'sent', missed?.error);
  // to: everybody it is for, until all have it; got: who has it so far.
  return { result, to: result === 'sent' || result === 'no_recipients' ? got : to, got };
}

/**
 * The check behind the daily email. Each pending or deposited cheque is asked what reminder
 * it is due under its company's settings (dueStep): coming due, overdue, or deposited and
 * not cleared. A step already told is not told again. Each person gets ONE email with a
 * table of all their cheques, not one per cheque. A bounce alert that failed earlier is
 * sent again too. Returns one line per cheque: id, cheque_no, kind, result, to.
 *   companyId: only that company; none: every company. Whether a company's daily email is
 *     switched on, and its hour, are the timer's to mind (alertTick): asked for here, by the
 *     "Check now" button, the check is always made.
 *   dry: work out who and what, send and write down nothing.
 */
export async function runDueAlerts({ today = dubaiDate(), send = sendMail, dry = false, companyId = null } = {}) {
  const rows = await db.prepare(`SELECT p.* FROM company_pdcs p
    WHERE ${LIVE} AND p.status IN ('pending', 'deposited') AND (?::int IS NULL OR p.company_id = ?::int)
    ORDER BY p.cheque_date, p.id`).all(companyId, companyId);
  const settings = new Map();
  const items = [];
  const byTo = new Map();
  for (const p of rows) {
    if (!settings.has(p.company_id)) settings.set(p.company_id, await alertSettings(p.company_id));
    const step = dueStep(p, today, settings.get(p.company_id));
    if (!step) continue;
    // A dry run only looks. A real one takes each alert before any email goes (see claim).
    const mine = dry ? (await settled(p.id, step.kind, step.ref) ? null : { got: new Set() }) : await claim(p.id, step.kind, step.ref);
    if (!mine) continue;
    const to = await alertTo(p, step.kind);
    const item = { p, mine, kind: step.kind, ref: step.ref, to, had: to.filter((a) => mine.got.has(a.toLowerCase())), sent: [], error: null };
    item.left = to.filter((a) => !item.had.includes(a));
    items.push(item);
    for (const addr of item.left) byTo.set(addr.toLowerCase(), { addr, list: [...(byTo.get(addr.toLowerCase())?.list || []), item] });
  }
  if (dry) return items.map((i) => ({ id: i.p.id, cheque_no: i.p.cheque_no, kind: i.kind, result: 'dry', to: i.to }));
  const digests = [...byTo.values()];
  const ends = await sendAll(send, digests.map(({ addr, list }) => ({ to: addr, ...digestMail(list, today) })));
  ends.forEach((end, n) => {
    for (const i of digests[n].list) {
      if (end.ok) i.sent.push(end.to); else i.error = end.error;
    }
    if (!end.ok) console.error(`[company pdc] digest to ${end.to}:`, end.error);
  });
  const out = [];
  for (const i of items) {
    // Sent once everybody has it. One address missed: failed, and the next check sends it to that one only.
    const missed = i.sent.length < i.left.length;
    const got = [...i.had, ...i.sent];
    // An earlier step of this cheque that never got out is overtaken by this one: it is not owed any more.
    await db.prepare(`DELETE FROM company_pdc_alerts WHERE pdc_id = ? AND kind IN ('due_soon', 'overdue', 'not_cleared')
      AND ${open('company_pdc_alerts')} AND ref_key <> ?`).run(i.p.id, i.ref);
    const result = await finish(i.mine, i.p.id, i.kind, i.ref, got, !i.to.length ? 'no_recipients' : missed ? 'failed' : 'sent', missed ? i.error : null);
    out.push({ id: i.p.id, cheque_no: i.p.cheque_no, kind: i.kind, result, to: missed ? i.to : got });
  }
  out.push(...await retryBounces({ today, send, companyId }));
  return out;
}

/**
 * A bounce is emailed about the moment the cheque is set to Bounced. If that email could not
 * be sent (the mail server was down), it is tried again here, for as long as the cheque is
 * still bounced: of all the alerts, this is the one that must not be lost. It is part of
 * the daily check, and the timer also makes it on its own for a company that has its daily
 * email switched off.
 */
export async function retryBounces({ today = dubaiDate(), send = sendMail, companyId = null } = {}) {
  const lost = await db.prepare(`SELECT a.ref_key, h.note AS bounce_note, p.* FROM company_pdc_alerts a
      JOIN company_pdcs p ON p.id = a.pdc_id
      LEFT JOIN company_pdc_history h ON h.pdc_id = p.id AND 'h' || h.id = a.ref_key
    WHERE a.kind = 'bounced' AND ${open('a')} AND p.status = 'bounced' AND ${LIVE} AND (?::int IS NULL OR p.company_id = ?::int)
    ORDER BY a.id`).all(companyId, companyId);
  const out = [];
  for (const p of lost) {
    const r = await sendAlert(p, 'bounced', p.ref_key, p.bounce_note || '', { send, today });
    if (r.result !== 'already') out.push({ id: p.id, cheque_no: p.cheque_no, kind: 'bounced', result: r.result, to: r.to });
  }
  return out;
}

// ---------- the timer ----------

/**
 * One hourly look. Each company with cheques gets its daily check once a day, at the hour it
 * has set (Dubai time) or the first look after it, and not at all while it has its daily
 * email switched off - for such a company only a bounce email still owed is tried again.
 * `state.days` remembers the day each company was last done. A company is done for the day
 * only once its check went through with nothing left owing: a check that broke, or an email
 * that failed, is tried again at the next hourly look. One company's trouble never stops
 * the others.
 */
export async function alertTick(state, { today = dubaiDate(), hour = dubaiHour(), run = runDueAlerts, retry = retryBounces } = {}) {
  const companies = await db.prepare(`SELECT DISTINCT p.company_id FROM company_pdcs p WHERE ${LIVE} ORDER BY 1`).all();
  const out = [];
  for (const { company_id: id } of companies) {
    try {
      const s = await alertSettings(id);
      if (!s.enabled || hour < s.hour || state.days.get(id) === today) {
        // No daily check at this look. A bounce email still owed does not wait for one: it is tried now.
        out.push(...await retry({ today, companyId: id }));
        continue;
      }
      const res = await run({ today, companyId: id });
      out.push(...res);
      if (!res.some((r) => r.result === 'failed')) state.days.set(id, today);
    } catch (e) {
      console.error(`[company pdc] the check for company ${id}:`, e.message);
    }
  }
  return out;
}

let timer = null;

/** Hourly. It emails real people, so index.js starts it only where sending is on. */
export function startCompanyPdc() {
  if (timer) return;
  const state = { days: new Map() };
  const tick = () => alertTick(state)
    .then((res) => res?.length && console.log(`[company pdc] ${res.filter((r) => r.result === 'sent').length} of ${res.length} cheque alerts emailed`))
    .catch((e) => console.error('[company pdc]', e.message));
  timer = setInterval(tick, 60 * 60_000);
  timer.unref();
  setTimeout(tick, 120_000).unref();
}

// ---------- routes ----------

export const companyPdcRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));

// The accounts people come in from saifsys, which has checked their role. Signed in to Reem itself, it is the master's.
companyPdcRoutes.use((req, res, next) => (req.fromSaifsys || req.user?.role === 'master'
  ? next() : res.status(403).json({ error: "Company's Post Dated Cheques is opened from saifsys" })));

// Every call says which company's list it is about (?company=, saifsys's company id).
companyPdcRoutes.use((req, res, next) => {
  const id = Number(req.query.company);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'saifsys did not say which company these cheques belong to' });
  req.companyId = id;
  next();
});

companyPdcRoutes.get('/', wrap(async (req, res) => res.json(await listCheques(req.user, req.companyId, req.query))));
companyPdcRoutes.get('/customs', wrap(async (req, res) => res.json({ customs: await customStatuses(req.companyId) }))); // for the "add a cheque" form
companyPdcRoutes.post('/cheques', wrap(async (req, res) => res.json(await saveCheque(req.user, req.companyId, null, req.body))));
companyPdcRoutes.get('/cheques/:id', wrap(async (req, res) => send(res, await getCheque(req.user, req.companyId, req.params.id))));
companyPdcRoutes.put('/cheques/:id', wrap(async (req, res) => send(res, await saveCheque(req.user, req.companyId, req.params.id, req.body))));
companyPdcRoutes.post('/cheques/:id/status', wrap(async (req, res) => send(res, await setStatus(req.user, req.companyId, req.params.id, req.body))));
companyPdcRoutes.delete('/cheques/:id', wrap(async (req, res) => send(res, await deleteCheque(req.user, req.companyId, req.params.id))));

// The copy of the cheque. The upload is called "photo" because that is the name saifsys's
// line to Reem sends every file under (see binv_reem there); ?name= is what it was called.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
companyPdcRoutes.post('/cheques/:id/attachment', upload.single('photo'), wrap(async (req, res) => {
  if (!req.file) throw bad('No file came through');
  send(res, await setAttachment(req.user, req.companyId, req.params.id, req.file, req.query.name || req.file.originalname));
}));
companyPdcRoutes.delete('/cheques/:id/attachment', wrap(async (req, res) => send(res, await removeAttachment(req.user, req.companyId, req.params.id))));
companyPdcRoutes.get('/cheques/:id/attachment', wrap(async (req, res) => {
  const path = await attachmentPath(req.companyId, req.params.id);
  if (!path) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=600').set('X-Content-Type-Options', 'nosniff').sendFile(path);
}));

// The Email alerts box: who is emailed, how the company wants its emails, the last alerts, and "Check now and send".
companyPdcRoutes.get('/alerts', wrap(async (req, res) => res.json({
  recipients: await listRecipients(req.companyId), log: await recentAlerts(req.companyId),
  settings: await alertSettings(req.companyId), defaults: ALERT_DEFAULTS,
})));
companyPdcRoutes.put('/alerts/settings', wrap(async (req, res) => res.json(await saveAlertSettings(req.user, req.companyId, req.body))));
companyPdcRoutes.post('/alerts/recipients', wrap(async (req, res) => res.json(await addRecipients(req.user, req.companyId, req.body))));
companyPdcRoutes.put('/alerts/recipients/:id', wrap(async (req, res) => send(res, await setRecipient(req.user, req.companyId, req.params.id, req.body))));
companyPdcRoutes.delete('/alerts/recipients/:id', wrap(async (req, res) => send(res, await removeRecipient(req.user, req.companyId, req.params.id))));
companyPdcRoutes.post('/alerts/run', wrap(async (req, res) => res.json({ results: await runDueAlerts({ companyId: req.companyId }) })));
