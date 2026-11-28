import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';

// Recurring payments: money that should come in every month from something in a building -
// a shop's rent in the camp, the washing machine in Ayla.
//
// An entry is made once: a title, the building, the shop or unit or whatever it is (typed,
// not picked), the amount, and the day of the month. From then on a line for that month is
// created on that day, pending, and somebody marks it paid when the money is in - all at
// once, or in parts (a receipt each time some came in) until it adds up to the amount. It
// is a list to chase: no invoice, nothing posted to the company's accounts.
//
// Where the money is, is the module's own too: a free list of accounts ("Cash to Mr
// Tauqeer", "Bank"). Each receipt says which account its money went into; a transfer
// hands money from one account to another; both can carry a file (a receipt).
//
// What the money is for is the module's own as well: a free list of income heads ("Shop",
// "DEWA", "Washing Machine"), one list for every building. An entry comes under one, and
// the report adds up each building by head.
//
// The module stands on its own. Its buildings are its own list, typed here - not the
// Buildings screen, not the inventory, not the saifsys building list - and nothing else
// reads them. It is the accountants' list: whoever saifsys lets open its Recurring
// Payments screens sees and changes all of it (a role tick there), and in Reem itself
// only the master. Reem keeps all of it; the saifsys screens only show it, through the
// door in server/fromSaifsys.js.

const MAX_NAME = 80;
const MAX_TITLE = 120;
const MAX_UNIT = 80;
const MAX_NOTES = 500;
const MAX_AMOUNT = 100_000_000;
const NOW = 'extract(epoch from now())::bigint';
const DIR = `${DATA_DIR}/recurring`;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const money = (n) => Math.round(Number(n) * 100) / 100;

// ---------- saved together ----------

// A change and its line in the activity list are saved together, or not at all: if the line
// cannot be written, the change is undone and the person is told, so nothing can happen
// here without leaving its line. saved() is one such piece of work; one inside another
// joins it (tx() on its own would start a second, separate one). A file is only taken off
// the disk once the work is safely in - a deleted file cannot be put back.
const together = new AsyncLocalStorage();
async function saved(fn) {
  if (together.getStore()) return fn();
  const after = [];
  const out = await tx(() => together.run({ after }, fn));
  after.forEach((later) => later());
  return out;
}
const withItsLine = (fn) => (...args) => saved(() => fn(...args));
/**
 * Hold one row until the work is saved, so two taps on the same thing go one after the other:
 * the second then reads what the first left (the receipt gone, the entry already paused) and
 * does not write a second line for it. false: no such row.
 */
const hold = async (table, id) => !!(await db.prepare(`SELECT 1 AS there FROM ${table} WHERE id = ? FOR UPDATE`).get(Number(id) || 0));
/** Take a file off the disk - now, or when the work it is part of has been saved. */
const dropLater = (path) => {
  const work = together.getStore();
  if (work) work.after.push(() => dropFile(path)); else dropFile(path);
};

// ---------- days and months ----------

// Asia/Dubai, no daylight saving: "today" is the office's day, not the server's (UTC).
const OFFSET = 4 * 3600;
export const today = () => new Date(Date.now() + OFFSET * 1000).toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
const nextMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
};
/** The day a month's line is created. The 29th to the 31st in a shorter month is its last day. */
export const dueDate = (month, day) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(Math.min(day, new Date(Date.UTC(y, m, 0)).getUTCDate()))}`;
};

// ---------- the activity list ----------

// Every kind of line the list keeps, and which of the four numbers on top it counts under.
export const ACTIVITY = Object.freeze({
  entry_added: 'added', payment_created: 'added', transfer_added: 'added', file_added: 'added',
  money_received: 'received',
  entry_changed: 'changed', entry_paused: 'changed', entry_resumed: 'changed', payment_changed: 'changed', marked_pending: 'changed',
  entry_deleted: 'deleted', payment_deleted: 'deleted', receipt_deleted: 'deleted', transfer_deleted: 'deleted', file_removed: 'deleted',
});
const amt = (n) => money(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const aboutEntry = (p) => ({ ref_kind: 'entry', ref_id: p.id, title: p.title, building: p.building_name, unit: p.unit });
const aboutDue = (d) => ({ ref_kind: 'payment', ref_id: d.id, title: d.title, building: d.building_name, unit: d.unit, month: d.month });

/**
 * Write one line of the activity list. user null: nobody did it, Reem made the line on its
 * day. It is written inside the same piece of work as the change it tells of (see saved),
 * so if it fails the change fails with it.
 */
async function note(user, action, about = {}) {
  const name = user?.id ? (await db.prepare('SELECT name FROM users WHERE id = ?').get(user.id))?.name ?? null : AUTOMATIC;
  await db.prepare(`INSERT INTO recurring_activity (user_id, user_name, action, ref_kind, ref_id, title, building, unit, month, amount, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user?.id ?? null, name, action, about.ref_kind ?? null, about.ref_id ?? null,
    about.title ?? null, about.building ?? null, about.unit ?? null, about.month ?? null,
    about.amount == null ? null : money(about.amount), about.detail || null);
}
/**
 * The same for a file put on or taken off. A file on the disk cannot be undone with the
 * rest, so here the line comes after, and one that cannot be written is said in the
 * server's log and stops nothing.
 */
const noteFile = (user, action, about) => note(user, action, about).catch((e) => console.warn('[recurring activity]', action, e.message));

const AUTOMATIC = 'Reem (automatic)';
const ACTIVITY_PAGE = 100;

/**
 * The activity list between two days (both counted; none said = the last thirty days), a
 * hundred lines to a page, newest first (sort "old": oldest first), with the four numbers
 * for those days. type: one of added, received, changed, deleted. by: one person - their
 * user id, not their name, so two people called the same are not mixed - or "auto" for the
 * lines Reem made itself. The numbers are of everybody's or that person's lines, whatever
 * type and page are being looked at. Counting and cutting are done by the database, so a
 * long list costs no more to open than a short one.
 */
export async function listActivity(user, query = {}, now = today()) {
  const day = (v, otherwise) => (DATE.test(v || '') ? v : otherwise);
  const monthAgo = new Date(Date.parse(`${now}T00:00:00Z`) - 29 * 86400_000).toISOString().slice(0, 10);
  const [from, to] = [day(query.from, monthAgo), day(query.to, now)].sort();
  // A day is the office's day: midnight to midnight in Dubai.
  const start = Date.parse(`${from}T00:00:00Z`) / 1000 - OFFSET;
  const end = Date.parse(`${to}T00:00:00Z`) / 1000 - OFFSET + 86400;
  const auto = query.by === 'auto';
  const who = auto ? null : (Number.isInteger(Number(query.by)) && Number(query.by) > 0 ? Number(query.by) : null);
  const type = Object.values(ACTIVITY).includes(query.type) ? query.type : '';
  const oldest = query.sort === 'old';
  const page = Math.min(Math.max(Math.trunc(Number(query.page)) || 1, 1), 100_000);
  const WHERE = `at >= ? AND at < ? AND (?::int IS NULL OR user_id = ?::int) AND (NOT ?::boolean OR (user_id IS NULL AND user_name = '${AUTOMATIC}'))`;
  const args = [start, end, who, who, auto];

  const counts = Object.fromEntries(['added', 'received', 'changed', 'deleted'].map((t) => [t, { n: 0, amount: 0 }]));
  for (const c of await db.prepare(`SELECT action, count(*)::int AS n, COALESCE(sum(amount), 0)::float8 AS amount
    FROM recurring_activity WHERE ${WHERE} GROUP BY action`).all(...args)) {
    const t = counts[ACTIVITY[c.action] || 'changed'];
    t.n += c.n;
    t.amount = money(t.amount + c.amount);
  }
  const actions = Object.keys(ACTIVITY).filter((a) => !type || ACTIVITY[a] === type);
  const order = oldest ? 'at, id' : 'at DESC, id DESC';
  // One more than a page is asked for, only to know whether there is a next page.
  const rows = await db.prepare(`SELECT id, at, user_id, user_name, action, ref_kind, ref_id, title, building, unit, month, amount, detail, old
    FROM recurring_activity WHERE ${WHERE} AND (?::text = '' OR action = ANY(?::text[])) ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, type, actions, ACTIVITY_PAGE + 1, (page - 1) * ACTIVITY_PAGE);
  const activity = rows.slice(0, ACTIVITY_PAGE).map((r) => ({
    id: r.id, at: Number(r.at), by: r.user_name, by_id: r.user_id, action: r.action, type: ACTIVITY[r.action] || 'changed', ref_kind: r.ref_kind, ref_id: r.ref_id,
    title: r.title, building: r.building, unit: r.unit, month: r.month, amount: r.amount, detail: r.detail, old: r.old,
  }));
  // Everybody who is in the list at all, each once, under the name on their latest line.
  const people = (await db.prepare(`SELECT DISTINCT ON (user_id) user_id AS id, user_name AS name FROM recurring_activity
    WHERE user_id IS NOT NULL ORDER BY user_id, id DESC`).all()).sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id - b.id);
  const automatic = !!(await db.prepare(`SELECT 1 AS yes FROM recurring_activity WHERE user_id IS NULL AND user_name = '${AUTOMATIC}' LIMIT 1`).get());
  return {
    from, to, type, by: auto ? 'auto' : who, sort: oldest ? 'old' : 'new', page, per_page: ACTIVITY_PAGE,
    people, automatic, counts, activity, more: rows.length > ACTIVITY_PAGE,
  };
}

// ---------- the creator ----------

const insertDue =(entry, month, date = dueDate(month, entry.day)) => db.prepare(`INSERT INTO recurring_payment_dues (payment_id, month, due_date, amount)
  VALUES (?, ?, ?, ?) ON CONFLICT (payment_id, month) DO NOTHING RETURNING id`).run(entry.id, month, date, entry.amount);

/**
 * Create every line whose day has come and that is not there yet: for each active entry
 * that creates its own, each month from its first one up to today. So a month missed
 * while the server was down is made on the next run, and running it twice makes nothing
 * new. Returns how many lines it made. entryId: only that entry. by: whose doing it is in
 * the activity list - the person who just saved or resumed the entry; nobody: Reem, on the day.
 */
export async function createDuePayments(now = today(), entryId = null, by = null) {
  const entries = await db.prepare(`SELECT id, amount, day, first_month FROM recurring_payments
    WHERE active AND auto_create AND (?::int IS NULL OR id = ?::int)`).all(entryId, entryId);
  let made = 0;
  for (const e of entries) {
    for (let month = e.first_month; month <= now.slice(0, 7) && dueDate(month, e.day) <= now; month = nextMonth(month)) {
      const added = await saved(async () => {
        const row = await insertDue(e, month);
        const d = row.changes ? await dueOf(row.id) : null;
        if (d) await note(by, 'payment_created', { ...aboutDue(d), amount: d.amount, detail: `Due ${d.due_date}` });
        return row;
      });
      if (added.changes) made += 1;
    }
  }
  return made;
}

// ---------- the buildings ----------

/** The module's own buildings, by name, each with how many entries it has. */
export const listBuildings = async () => (await db.prepare(`SELECT b.id, b.name,
    (SELECT count(*)::int FROM recurring_payments p WHERE p.building_id = b.id) AS entries
  FROM recurring_buildings b ORDER BY lower(b.name), b.id`).all());

const buildingOf = async (id) => (await db.prepare('SELECT id, name FROM recurring_buildings WHERE id = ?').get(Number(id) || 0)) || null;
const buildingNamed = async (name) => (await db.prepare('SELECT id, name FROM recurring_buildings WHERE lower(name) = lower(?)').get(name)) || null;

/** Add a building (id null) or rename one. A name is there once, whatever its capitals. null: no such building. */
export async function saveBuilding(user, id, input) {
  const old = id === null ? null : await buildingOf(id);
  if (id !== null && !old) return null;
  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad('Give the building a name');
  const same = await buildingNamed(name);
  if (same && same.id !== old?.id) throw bad(`"${same.name}" is already in the list`, 409);
  if (old) await db.prepare('UPDATE recurring_buildings SET name = ? WHERE id = ?').run(name, old.id);
  const savedId = old?.id ?? (await db.prepare('INSERT INTO recurring_buildings (name, created_by) VALUES (?, ?) RETURNING id').run(name, user.id)).id;
  return (await listBuildings()).find((b) => b.id === savedId);
}

/** Only a building with no entries can go. */
export async function deleteBuilding(user, id) {
  const b = (await listBuildings()).find((x) => x.id === Number(id));
  if (!b) return null;
  if (b.entries > 0) throw bad(`"${b.name}" has ${b.entries} ${b.entries === 1 ? 'entry' : 'entries'}, so it cannot be deleted. Move or delete those first.`, 409);
  await db.prepare('DELETE FROM recurring_buildings WHERE id = ?').run(b.id);
  return { ok: true };
}

// ---------- the income heads ----------

/** The module's own income heads, by name, each with how many entries come under it. */
export const listHeads = async () => (await db.prepare(`SELECT h.id, h.name,
    (SELECT count(*)::int FROM recurring_payments p WHERE p.head_id = h.id) AS entries
  FROM recurring_heads h ORDER BY lower(h.name), h.id`).all());

const headOf = async (id) => (await db.prepare('SELECT id, name FROM recurring_heads WHERE id = ?').get(Number(id) || 0)) || null;
const headNamed = async (name) => (await db.prepare('SELECT id, name FROM recurring_heads WHERE lower(name) = lower(?)').get(name)) || null;
const headPicks = async () => (await listHeads()).map((h) => ({ id: h.id, name: h.name }));

/** Add an income head (id null) or rename one. A name is there once, whatever its capitals. null: no such head. */
export async function saveHead(user, id, input) {
  const old = id === null ? null : await headOf(id);
  if (id !== null && !old) return null;
  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad('Give the income head a name, like Shop or DEWA');
  const same = await headNamed(name);
  if (same && same.id !== old?.id) throw bad(`"${same.name}" is already in the list`, 409);
  if (old) await db.prepare('UPDATE recurring_heads SET name = ? WHERE id = ?').run(name, old.id);
  const savedId = old?.id ?? (await db.prepare('INSERT INTO recurring_heads (name, created_by) VALUES (?, ?) RETURNING id').run(name, user.id)).id;
  return (await listHeads()).find((h) => h.id === savedId);
}

/** Only an income head with no entries can go. */
export async function deleteHead(user, id) {
  const h = (await listHeads()).find((x) => x.id === Number(id));
  if (!h) return null;
  if (h.entries > 0) throw bad(`"${h.name}" has ${h.entries} ${h.entries === 1 ? 'entry' : 'entries'}, so it cannot be deleted. Move or delete those first.`, 409);
  await db.prepare('DELETE FROM recurring_heads WHERE id = ?').run(h.id);
  return { ok: true };
}

// ---------- reading ----------

const picks = async () => (await listBuildings()).map((b) => ({ id: b.id, name: b.name }));

const ENTRY = `SELECT p.*, b.name AS building_name, h.name AS head_name, (SELECT count(*)::int FROM recurring_payment_dues d WHERE d.payment_id = p.id AND d.deleted_at IS NULL) AS payments,
    EXISTS (SELECT 1 FROM recurring_payment_dues d WHERE d.payment_id = p.id AND d.month = ? AND d.deleted_at IS NULL) AS has_this_month
  FROM recurring_payments p JOIN recurring_buildings b ON b.id = p.building_id LEFT JOIN recurring_heads h ON h.id = p.head_id`;
const RECEIVED = 'COALESCE((SELECT sum(r.amount) FROM recurring_payment_receipts r WHERE r.due_id = d.id), 0)::float8';
const DUE = `SELECT d.id, d.payment_id, d.month, d.due_date, d.amount, d.status, d.paid_at, d.paid_on, u.name AS paid_by, ${RECEIVED} AS received,
    EXISTS (SELECT 1 FROM recurring_payment_receipts r WHERE r.due_id = d.id AND r.attachment IS NOT NULL) AS receipt_files,
    d.account_id, a.name AS account_name, d.attachment, p.title, p.unit, p.building_id, b.name AS building_name,
    p.head_id, h.name AS head_name
  FROM recurring_payment_dues d JOIN recurring_payments p ON p.id = d.payment_id JOIN recurring_buildings b ON b.id = p.building_id
  LEFT JOIN recurring_heads h ON h.id = p.head_id
  LEFT JOIN users u ON u.id = d.paid_by LEFT JOIN recurring_accounts a ON a.id = d.account_id`;

const shapeHead = (row) => (row.head_id ? { id: row.head_id, name: row.head_name } : null);
const shapeEntry = (p) => ({
  id: p.id, title: p.title, building: { id: p.building_id, name: p.building_name }, unit: p.unit, head: shapeHead(p), amount: p.amount, day: p.day,
  auto_create: p.auto_create, first_month: p.first_month, active: p.active, notes: p.notes,
  payments: p.payments, has_this_month: p.has_this_month,
  created_at: p.created_at == null ? null : Number(p.created_at), // when the entry was made (ms since 1970)
  created_by_system: p.created_by == null, // no person made it: the system did
});
// received: what came in so far, over all its receipts; left: what is still to come.
// attachment: the line's own file, from before receipts had their own; receipt_files: any receipt has one.
const shapeDue = (d) => ({
  id: d.id, entry_id: d.payment_id, month: d.month, title: d.title, building: { id: d.building_id, name: d.building_name }, unit: d.unit, head: shapeHead(d),
  due_date: d.due_date, amount: d.amount, status: d.status, paid_at: d.paid_at, paid_on: d.paid_on, paid_by: d.paid_by,
  account: d.account_id ? { id: d.account_id, name: d.account_name } : null, attachment: !!d.attachment,
  received: money(d.received), left: money(Math.max(0, d.amount - d.received)), receipt_files: !!d.receipt_files,
});

const entryOf = async (user, id, now = today()) => (await db.prepare(`${ENTRY} WHERE p.id = ?`).get(now.slice(0, 7), Number(id) || 0)) || null;

/** Every entry, and the buildings and the income heads to pick from. */
export async function listEntries(user, now = today()) {
  const rows = await db.prepare(`${ENTRY} ORDER BY lower(b.name), lower(p.title), p.id`).all(now.slice(0, 7));
  return { month: now.slice(0, 7), buildings: await picks(), heads: await headPicks(), entries: rows.map(shapeEntry) };
}

/**
 * One month's lines, with what is still pending and what has
 * been paid. The totals are the month's (and the building's, the income head's and the shop
 * or unit's, when one is picked), whatever status is being looked at. No month said = this
 * month. units: every shop or unit typed on an entry of the buildings looked at, to pick
 * from. head: a head's id, or "none" for the entries that have no head yet.
 */
export async function listDues(user, query = {}, now = today()) {
  const buildings = await picks();
  const month = MONTH.test(query.month || '') ? query.month : now.slice(0, 7);
  const one = Number(query.building) || 0;
  const ids = buildings.map((b) => b.id).filter((id) => !one || id === one);
  const unit = line(query.unit, MAX_UNIT).toLowerCase();
  const head = Number(query.head) || 0;
  const units = (await db.prepare(`SELECT min(unit) AS unit FROM recurring_payments WHERE building_id = ANY(?::int[]) AND unit IS NOT NULL
    GROUP BY lower(unit) ORDER BY lower(unit)`).all(ids)).map((r) => r.unit);
  const rows = (await db.prepare(`${DUE} WHERE d.month = ? AND d.deleted_at IS NULL AND p.building_id = ANY(?::int[]) ORDER BY d.due_date, lower(p.title), d.id`).all(month, ids))
    .map(shapeDue).filter((d) => !unit || (d.unit || '').toLowerCase() === unit)
    .filter((d) => (query.head === 'none' ? !d.head : !head || d.head?.id === head));
  const of = (status) => rows.filter((d) => d.status === status);
  const sum = (list, key) => money(list.reduce((t, d) => t + d[key], 0));
  return {
    month,
    buildings,
    units,
    heads: await headPicks(),
    dues: ['pending', 'paid'].includes(query.status) ? of(query.status) : rows,
    // The money: what is still to come, and what came in (a part paid line's part too). The
    // counts: lines still pending (partly paid among them), and lines paid in full.
    totals: {
      pending: sum(rows, 'left'), paid: sum(rows, 'received'), pending_count: of('pending').length, paid_count: of('paid').length,
      partly_count: of('pending').filter((d) => d.received > 0).length,
    },
  };
}

/**
 * What each building brought in from each income head, over the months from..to (both
 * counted; none said = this month): what came in, what is still to come, and the two
 * together (a part paid line is in both, by its parts). A building
 * with no line in those months is left out; its entries with no head are its last row.
 */
export async function getReport(user, query = {}, now = today()) {
  const month = (v) => (MONTH.test(v || '') ? v : now.slice(0, 7));
  const [from, to] = [month(query.from), month(query.to)].sort();
  const one = Number(query.building) || null;
  const found = await db.prepare(`SELECT p.building_id, b.name AS building_name, p.head_id, h.name AS head_name,
      COALESCE(sum(LEAST(COALESCE(r.got, 0), d.amount)), 0)::float8 AS paid,
      COALESCE(sum(GREATEST(d.amount - COALESCE(r.got, 0), 0)), 0)::float8 AS pending
    FROM recurring_payment_dues d JOIN recurring_payments p ON p.id = d.payment_id JOIN recurring_buildings b ON b.id = p.building_id
    LEFT JOIN recurring_heads h ON h.id = p.head_id
    LEFT JOIN (SELECT due_id, sum(amount) AS got FROM recurring_payment_receipts GROUP BY due_id) r ON r.due_id = d.id
    WHERE d.month >= ? AND d.month <= ? AND d.deleted_at IS NULL AND (?::int IS NULL OR p.building_id = ?::int)
    GROUP BY p.building_id, b.name, p.head_id, h.name
    ORDER BY lower(b.name), p.building_id, (p.head_id IS NULL), lower(h.name), p.head_id`).all(from, to, one, one);
  const sums = (list) => {
    const paid = money(list.reduce((t, x) => t + x.paid, 0));
    const pending = money(list.reduce((t, x) => t + x.pending, 0));
    return { paid, pending, total: money(paid + pending) };
  };
  const rows = [];
  for (const f of found) {
    if (rows.at(-1)?.building.id !== f.building_id) rows.push({ building: { id: f.building_id, name: f.building_name }, heads: [] });
    rows.at(-1).heads.push({ head: shapeHead(f), ...sums([f]) });
  }
  for (const r of rows) Object.assign(r, sums(r.heads));
  return { from, to, buildings: await picks(), rows, totals: sums(rows) };
}

// ---------- writing ----------

/** What was typed about one entry, checked. */
async function readEntry(user, input, now) {
  const title = line(input?.title, MAX_TITLE);
  if (!title) throw bad('Give the entry a title, like Washing machine rent');
  // A name typed on the form is a building too: the one already called that, or a new one.
  const typed = line(input.new_building, MAX_NAME);
  const building = typed ? (await buildingNamed(typed)) || (await saveBuilding(user, null, { name: typed })) : await buildingOf(input.building_id);
  if (!building) throw bad('Pick the building from the list, or type a new one');
  // The income head is the same: picked, or typed. None at all is allowed.
  const typedHead = line(input.new_head, MAX_NAME);
  const picked = Number(input.head_id) || 0;
  const head = typedHead ? (await headNamed(typedHead)) || (await saveHead(user, null, { name: typedHead })) : picked ? await headOf(picked) : null;
  if (picked && !typedHead && !head) throw bad('Pick the income head from the list, or type a new one');
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw bad('The amount must be a number more than 0');
  const day = Number(input.day);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw bad('The day of the month is a number from 1 to 31');
  const first = String(input.first_month ?? '').trim() || now.slice(0, 7);
  if (!MONTH.test(first)) throw bad('Pick the first month');
  // A typo in the year must not create years of payments nobody is owed.
  if (first < `${Number(now.slice(0, 4)) - 3}${now.slice(4, 7)}`) throw bad('The first month cannot be more than three years back');
  return {
    title, building_id: building.id, head_id: head?.id ?? null, unit: line(input.unit, MAX_UNIT) || null, amount, day,
    auto_create: input.auto_create === undefined ? true : !!input.auto_create,
    first_month: first, notes: String(input.notes ?? '').trim().slice(0, MAX_NOTES) || null,
  };
}

/**
 * Add an entry (id null) or change one. Lines already created keep their date, and their
 * amount once money came in on them; a new amount also goes on the lines still pending with
 * nothing received, so a wrong amount fixed on the entry fixes them too. A line whose day has already come is
 * made straight away, so an entry added on the 5th for the 1st shows this month at once.
 * null: not their entry.
 */
async function saveEntryWork(user, id, input, now = today()) {
  const old = id === null ? null : await entryOf(user, id, now);
  if (id !== null && !old) return null;
  const f = await readEntry(user, input || {}, now);
  const values = [f.building_id, f.head_id, f.unit, f.title, f.amount, f.day, f.auto_create, f.first_month, f.notes, user.id];
  let entryId = old?.id;
  if (old) {
    await db.prepare(`UPDATE recurring_payments SET building_id = ?, head_id = ?, unit = ?, title = ?, amount = ?, day = ?, auto_create = ?,
      first_month = ?, notes = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`).run(...values, old.id);
    if (f.amount !== old.amount) {
      await db.prepare(`UPDATE recurring_payment_dues d SET amount = ? WHERE d.payment_id = ? AND d.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM recurring_payment_receipts r WHERE r.due_id = d.id)`).run(f.amount, old.id);
    }
  } else {
    entryId = (await db.prepare(`INSERT INTO recurring_payments (building_id, head_id, unit, title, amount, day, auto_create, first_month, notes, updated_by, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(...values, user.id)).id;
  }
  const after = await entryOf(user, entryId, now);
  if (!old) {
    await note(user, 'entry_added', { ...aboutEntry(after), amount: after.amount, detail: `Day ${after.day} of the month, from ${after.first_month}` });
  } else {
    // What was changed, said field by field: "Amount: 150.00 → 200.00".
    const was = (label, a, b) => (String(a ?? '') === String(b ?? '') ? null : `${label}: ${a ?? 'none'} → ${b ?? 'none'}`);
    const changes = [
      was('Title', old.title, after.title), was('Building', old.building_name, after.building_name), was('Unit', old.unit, after.unit),
      was('Income head', old.head_name, after.head_name),
      old.amount === after.amount ? null : `Amount: ${amt(old.amount)} → ${amt(after.amount)}`,
      was('Day', old.day, after.day), was('First month', old.first_month, after.first_month),
      old.auto_create === after.auto_create ? null : (after.auto_create ? 'Now creates its payments by itself' : 'Its payments are now created by hand'),
      String(old.notes ?? '') === String(after.notes ?? '') ? null : 'Notes changed',
    ].filter(Boolean);
    if (changes.length) await note(user, 'entry_changed', { ...aboutEntry(after), amount: after.amount, detail: changes.join('; ') });
  }
  await createDuePayments(now, entryId, user);
  return shapeEntry(await entryOf(user, entryId, now));
}

/** Pause an entry (no new lines; the ones it has stay) or start it again. */
async function setActiveWork(user, id, active, now = today()) {
  if (!(await hold('recurring_payments', id))) return null;
  const p = await entryOf(user, id, now);
  if (!p) return null;
  await db.prepare(`UPDATE recurring_payments SET active = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`).run(!!active, user.id, p.id);
  if (!!active !== p.active) await note(user, active ? 'entry_resumed' : 'entry_paused', { ...aboutEntry(p), amount: p.amount });
  if (active) await createDuePayments(now, p.id, user);
  return shapeEntry(await entryOf(user, p.id, now));
}

/**
 * An entry that never created a line can go. One with lines goes only when that is asked for
 * in so many words (withPayments): every line, receipt and file goes with it, and the money is
 * out of those accounts again. Without it, one with lines is paused instead.
 */
async function deleteEntryWork(user, id, withPayments = false) {
  if (!(await hold('recurring_payments', id))) return null;
  const p = await entryOf(user, id);
  if (!p) return null;
  if (p.payments > 0 && !withPayments) throw bad(`"${p.title}" already has payments, so it cannot be deleted. Pause it instead.`, 409);
  // The files of its lines and receipts, found first: the rows go with the entry (ON DELETE CASCADE).
  const files = p.payments > 0 ? await db.prepare(`
    SELECT d.attachment AS path FROM recurring_payment_dues d WHERE d.payment_id = ? AND d.attachment IS NOT NULL
    UNION ALL
    SELECT r.attachment FROM recurring_payment_receipts r JOIN recurring_payment_dues d ON d.id = r.due_id
      WHERE d.payment_id = ? AND r.attachment IS NOT NULL
    UNION ALL
    SELECT f.path FROM recurring_payment_receipt_files f JOIN recurring_payment_receipts r ON r.id = f.receipt_id
      JOIN recurring_payment_dues d ON d.id = r.due_id WHERE d.payment_id = ?`).all(p.id, p.id, p.id) : [];
  const { got } = await db.prepare(`SELECT COALESCE(sum(r.amount), 0)::float8 AS got FROM recurring_payment_receipts r
    JOIN recurring_payment_dues d ON d.id = r.due_id WHERE d.payment_id = ?`).get(p.id);
  await db.prepare('DELETE FROM recurring_payments WHERE id = ?').run(p.id);
  files.forEach((f) => dropLater(f.path));
  await note(user, 'entry_deleted', {
    ...aboutEntry(p), amount: p.amount,
    detail: p.payments > 0 ? `With its ${p.payments} ${p.payments === 1 ? 'payment' : 'payments'}; ${amt(got)} received on them is out of the accounts` : 'It had no payments',
  });
  return { ok: true };
}

/**
 * A line made by hand: for an entry that does not create its own, or ahead of its day.
 * No date said: this month's, on the entry's day. A date said (an invoice entered late,
 * with its old date): that month's line, dated that day, even before the entry's start.
 */
async function createNowWork(user, id, now = today(), date = null) {
  const p = await entryOf(user, id, now);
  if (!p) return null;
  const on = String(date ?? '').trim();
  if (on && !DATE.test(on)) throw bad('Pick the date of the payment');
  const month = (on || now).slice(0, 7);
  if (!p.active) throw bad(`"${p.title}" is paused. Resume it first.`, 409);
  if (!on && month < p.first_month) throw bad(`"${p.title}" starts in a later month.`, 409);
  const when = on || dueDate(month, p.day);
  const back = await db.prepare(`UPDATE recurring_payment_dues SET deleted_at = NULL, deleted_by = NULL, due_date = ?, amount = ?
    WHERE payment_id = ? AND month = ? AND deleted_at IS NOT NULL RETURNING id`).run(when, p.amount, p.id, month);
  const { id: dueId } = back.id ? back : await insertDue(p, month, when);
  if (!dueId) throw bad(on ? `"${p.title}" already has a payment for ${month}.` : "This month's payment is already there.", 409);
  const made = await dueOf(dueId);
  await note(user, 'payment_created', { ...aboutDue(made), amount: made.amount, detail: `Created by hand, due ${made.due_date}` });
  return shapeDue(made);
}

const dueOf = async (id) => (await db.prepare(`${DUE} WHERE d.id = ? AND d.deleted_at IS NULL`).get(Number(id) || 0)) || null;

const RECEIPT = `SELECT r.id, r.due_id, r.account_id, a.name AS account_name, r.amount, r.paid_on, r.attachment, r.created_at, u.name AS by
  FROM recurring_payment_receipts r LEFT JOIN recurring_accounts a ON a.id = r.account_id LEFT JOIN users u ON u.id = r.created_by`;
const shapeReceipt = (r) => ({
  id: r.id, amount: r.amount, paid_on: r.paid_on, account: r.account_id ? { id: r.account_id, name: r.account_name } : null,
  by: r.by, at: Number(r.created_at), attachment: !!r.attachment,
});
// Each receipt with its further files (files: [{ id }]), besides its own attachment.
const receiptsOf = async (dueId) => {
  const rows = (await db.prepare(`${RECEIPT} WHERE r.due_id = ? ORDER BY r.paid_on, r.id`).all(dueId)).map(shapeReceipt);
  for (const r of rows) {
    r.files = (await db.prepare('SELECT id FROM recurring_payment_receipt_files WHERE receipt_id = ? ORDER BY id').all(r.id))
      .map((f) => ({ id: f.id }));
  }
  return rows;
};

/**
 * Put a line in step with its receipts: paid once they add up to its amount, pending till
 * then; its paid_on, paid_by, paid_at and account are the last receipt's (none: empty).
 */
const syncDue = (dueId) => db.prepare(`UPDATE recurring_payment_dues d SET
    status = CASE WHEN s.got >= d.amount THEN 'paid' ELSE 'pending' END,
    paid_on = l.paid_on, paid_by = l.created_by, paid_at = l.created_at, account_id = l.account_id
  FROM (SELECT COALESCE(sum(amount), 0) AS got FROM recurring_payment_receipts WHERE due_id = ?) s
  LEFT JOIN LATERAL (SELECT paid_on, created_by, created_at, account_id FROM recurring_payment_receipts
    WHERE due_id = ? ORDER BY paid_on DESC, id DESC LIMIT 1) l ON true
  WHERE d.id = ?`).run(dueId, dueId, dueId);

/** One line with its receipts, and the accounts to pick from when money comes in for it. */
export async function getDue(user, dueId) {
  const d = await dueOf(dueId);
  return d && { today: today(), due: shapeDue(d), receipts: await receiptsOf(d.id), accounts: await accountPicks() };
}

/** The account and the day of a receipt, checked. */
async function readReceipt(input, now) {
  const account = await accountOf(input?.account_id);
  if (!account) throw bad('Pick the account the money went into');
  const on = String(input?.paid_on ?? '').trim() || now;
  if (!DATE.test(on)) throw bad('Pick the date the money was received');
  return { account, on };
}

/**
 * Money that came in for a line - all of what is left, or a part: how much (none said =
 * all that is left), the account it went into and the day it was received (none said =
 * today). Never more than is left. The line is paid once its receipts add up to its
 * amount. Returns the line, with receipt_id: the new receipt's, to keep a file with.
 */
async function addReceiptWork(user, dueId, input = {}, now = today()) {
  const d = await dueOf(dueId);
  if (!d) return null;
  const { account, on } = await readReceipt(input, now);
  const typed = String(input?.amount ?? '').trim();
  const id = await saved(async () => {
    // One at a time per line, so two taps cannot both take what is left.
    const due = await db.prepare(`SELECT amount::float8 AS amount, ${RECEIVED} AS received FROM recurring_payment_dues d WHERE d.id = ? FOR UPDATE`).get(d.id);
    const left = money(due.amount - due.received);
    if (left <= 0) throw bad('This payment is already paid in full', 409);
    const amount = typed === '' ? left : money(typed.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) throw bad('The amount received must be a number more than 0');
    if (amount > left) throw bad(`Only ${left.toFixed(2)} is left to pay on this one`);
    const { id: receiptId } = await db.prepare(`INSERT INTO recurring_payment_receipts (due_id, account_id, amount, paid_on, created_by)
      VALUES (?, ?, ?, ?, ?) RETURNING id`).run(d.id, account.id, amount, on, user.id);
    await syncDue(d.id);
    return receiptId;
  });
  const got = (await db.prepare('SELECT amount::float8 AS amount FROM recurring_payment_receipts WHERE id = ?').get(id))?.amount;
  await note(user, 'money_received', {
    ...aboutDue(d), ref_kind: 'receipt', ref_id: id, amount: got,
    detail: `Into ${account.name} on ${on}${got < d.amount ? `; part of ${amt(d.amount)}` : ''}`,
  });
  return { ...shapeDue(await dueOf(d.id)), receipt_id: id };
}

/** A receipt written by mistake: gone, with its file; the line is pending again if it is no longer paid in full. */
async function deleteReceiptWork(user, id) {
  if (!(await hold('recurring_payment_receipts', id))) return null;
  const r = await db.prepare(`SELECT r.id, r.due_id, r.attachment, r.amount::float8 AS amount, r.paid_on, a.name AS account_name
    FROM recurring_payment_receipts r LEFT JOIN recurring_accounts a ON a.id = r.account_id WHERE r.id = ?`).get(Number(id) || 0);
  if (!r) return null;
  const extra = await db.prepare('SELECT path FROM recurring_payment_receipt_files WHERE receipt_id = ?').all(r.id);
  await saved(async () => {
    await db.prepare('DELETE FROM recurring_payment_receipts WHERE id = ?').run(r.id);
    await syncDue(r.due_id);
  });
  dropLater(r.attachment);
  extra.forEach((f) => dropLater(f.path));
  const d = await dueOf(r.due_id);
  await note(user, 'receipt_deleted', {
    ...(d ? aboutDue(d) : {}), ref_kind: 'receipt', ref_id: r.id, amount: r.amount,
    detail: `It was in ${r.account_name || 'an account'}, received on ${r.paid_on}`,
  });
  return shapeDue(d);
}

/**
 * The whole line paid in one go, or put back to pending. Paid: one receipt of its whole
 * amount; one already there is changed to that (its file stays), and a line paid in
 * several parts is changed part by part instead. Pending: every receipt goes, with its
 * file, and the money is out of those accounts again.
 */
async function setPaidWork(user, dueId, paid, input = {}, now = today()) {
  const d = await dueOf(dueId);
  if (!d) return null;
  if (!paid) {
    const files = await db.prepare('SELECT attachment FROM recurring_payment_receipts WHERE due_id = ? AND attachment IS NOT NULL').all(d.id);
    const extra = await db.prepare(`SELECT f.path FROM recurring_payment_receipt_files f
      JOIN recurring_payment_receipts r ON r.id = f.receipt_id WHERE r.due_id = ?`).all(d.id);
    const gone = await db.prepare('SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::float8 AS got FROM recurring_payment_receipts WHERE due_id = ?').get(d.id);
    await saved(async () => {
      await db.prepare('DELETE FROM recurring_payment_receipts WHERE due_id = ?').run(d.id);
      await syncDue(d.id);
    });
    files.forEach((f) => dropLater(f.attachment));
    extra.forEach((f) => dropLater(f.path));
    if (gone.n > 0) {
      await note(user, 'marked_pending', {
        ...aboutDue(d), amount: gone.got,
        detail: `Set back to pending: ${gone.n} ${gone.n === 1 ? 'receipt' : 'receipts'} removed, and the money is out of the accounts`,
      });
    }
    return shapeDue(await dueOf(d.id));
  }
  const { account, on } = await readReceipt(input, now);
  let before = null; // the one receipt that was there already, if any
  await saved(async () => {
    const had = await db.prepare(`SELECT r.id, r.amount::float8 AS amount, r.paid_on, r.account_id,
        (SELECT a.name FROM recurring_accounts a WHERE a.id = r.account_id) AS account_name
      FROM recurring_payment_receipts r WHERE r.due_id = ? FOR UPDATE OF r`).all(d.id);
    before = had[0] || null;
    if (had.length > 1) throw bad('This payment came in parts. Change or delete its parts instead.', 409);
    if (had.length) {
      await db.prepare('UPDATE recurring_payment_receipts SET account_id = ?, amount = ?, paid_on = ?, created_by = ? WHERE id = ?')
        .run(account.id, d.amount, on, user.id, had[0].id);
    } else {
      await db.prepare('INSERT INTO recurring_payment_receipts (due_id, account_id, amount, paid_on, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(d.id, account.id, d.amount, on, user.id);
    }
    await syncDue(d.id);
  });
  // Only the money that is new counts as received: what a receipt already said came in is
  // in the list from then, and counting it again would make the total too big.
  const fresh = money(d.amount - (before?.amount || 0));
  if (fresh > 0) {
    await note(user, 'money_received', {
      ...aboutDue(d), amount: fresh,
      detail: `Paid in full into ${account.name} on ${on}${before ? `; ${amt(before.amount)} of the ${amt(d.amount)} came in before` : ''}`,
    });
  } else if (before && (before.account_id !== account.id || before.paid_on !== on)) {
    // Already paid in full, and only where or when is put right.
    const changes = [
      before.account_id === account.id ? null : `Account: ${before.account_name || 'none'} → ${account.name}`,
      before.paid_on === on ? null : `Received on: ${before.paid_on} → ${on}`,
    ].filter(Boolean);
    await note(user, 'payment_changed', { ...aboutDue(d), amount: d.amount, detail: changes.join('; ') });
  }
  return shapeDue(await dueOf(d.id));
}

/**
 * A line typed wrong, put right by hand: its due date and its amount. A date in another
 * month moves the line to that month - refused when the entry has a line there already -
 * and leaves a deleted marker in the old month, so the creator does not make it again.
 * The amount cannot be less than what came in already; the line is paid or pending by its
 * receipts again. Only this line changes, never its entry. null: no such line.
 */
async function updateDueWork(user, dueId, input = {}) {
  const d = await dueOf(dueId);
  if (!d) return null;
  const on = String(input?.due_date ?? '').trim();
  if (!DATE.test(on) || new Date(`${on}T00:00:00Z`).toISOString().slice(0, 10) !== on) throw bad('Pick the due date');
  const typed = String(input?.amount ?? '').trim().replace(/,/g, '');
  const amount = typed === '' ? NaN : money(typed);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw bad('The amount must be a number more than 0');
  const month = on.slice(0, 7);
  await saved(async () => {
    const now = await db.prepare(`SELECT month, due_date, amount::float8 AS amount, ${RECEIVED} AS received FROM recurring_payment_dues d WHERE d.id = ? FOR UPDATE`).get(d.id);
    if (amount < money(now.received)) throw bad(`${money(now.received).toFixed(2)} came in on this payment already, so the amount cannot be less than that`);
    if (month !== now.month) {
      const there = await db.prepare('SELECT id, deleted_at FROM recurring_payment_dues WHERE payment_id = ? AND month = ? FOR UPDATE').get(d.payment_id, month);
      if (there && !there.deleted_at) throw bad(`"${d.title}" already has a payment for ${month}. Delete that one first, or pick another date.`, 409);
      if (there) await db.prepare('DELETE FROM recurring_payment_dues WHERE id = ?').run(there.id);
    }
    await db.prepare('UPDATE recurring_payment_dues SET month = ?, due_date = ?, amount = ? WHERE id = ?').run(month, on, amount, d.id);
    if (month !== now.month) {
      await db.prepare(`INSERT INTO recurring_payment_dues (payment_id, month, due_date, amount, deleted_at, deleted_by)
        VALUES (?, ?, ?, ?, ${NOW}, ?)`).run(d.payment_id, now.month, now.due_date, now.amount, user.id);
    }
    await syncDue(d.id);
  });
  const after = await dueOf(d.id);
  const changes = [
    d.due_date === on ? null : `Due date: ${d.due_date} → ${on}`,
    d.amount === amount ? null : `Amount: ${amt(d.amount)} → ${amt(amount)}`,
  ].filter(Boolean);
  if (changes.length) await note(user, 'payment_changed', { ...aboutDue(after), amount, detail: changes.join('; ') });
  return shapeDue(after);
}

/**
 * A line put in by mistake, deleted. Only one nothing came in on: its receipts are deleted
 * first. It stays behind as a marker, so the creator does not make that month again; its
 * file goes. "Create now" for that month brings the line back. null: no such line.
 */
async function deleteDueWork(user, dueId) {
  if (!(await hold('recurring_payment_dues', dueId))) return null;
  const d = await dueOf(dueId);
  if (!d) return null;
  await saved(async () => {
    const now = await db.prepare(`SELECT ${RECEIVED} AS received FROM recurring_payment_dues d WHERE d.id = ? FOR UPDATE`).get(d.id);
    const parts = await db.prepare('SELECT count(*)::int AS n FROM recurring_payment_receipts WHERE due_id = ?').get(d.id);
    if (parts.n > 0 || now.received > 0) throw bad(`Money came in on "${d.title}". Delete its receipts first, then delete the payment.`, 409);
    await db.prepare(`UPDATE recurring_payment_dues SET deleted_at = ${NOW}, deleted_by = ?, attachment = NULL WHERE id = ?`).run(user.id, d.id);
  });
  dropLater(d.attachment);
  await note(user, 'payment_deleted', { ...aboutDue(d), amount: d.amount, detail: `It was due ${d.due_date}` });
  return { ok: true, id: d.id, title: d.title };
}

// ---------- the accounts ----------

const BALANCE = `(COALESCE((SELECT sum(r.amount) FROM recurring_payment_receipts r WHERE r.account_id = a.id), 0)
    + COALESCE((SELECT sum(t.amount) FROM recurring_transfers t WHERE t.to_account_id = a.id), 0)
    - COALESCE((SELECT sum(t.amount) FROM recurring_transfers t WHERE t.from_account_id = a.id), 0))::float8`;
const USED = `(EXISTS (SELECT 1 FROM recurring_payment_receipts r WHERE r.account_id = a.id)
    OR EXISTS (SELECT 1 FROM recurring_payment_dues d WHERE d.account_id = a.id)
    OR EXISTS (SELECT 1 FROM recurring_transfers t WHERE a.id IN (t.from_account_id, t.to_account_id)))`;

/** The module's own accounts, by name, each with what it holds and whether anything was ever put through it. */
export const listAccounts = async () => (await db.prepare(`SELECT a.id, a.name, ${BALANCE} AS balance, ${USED} AS used
  FROM recurring_accounts a ORDER BY lower(a.name), a.id`).all()).map((a) => ({ ...a, balance: money(a.balance) }));

const accountPicks = async () => (await listAccounts()).map((a) => ({ id: a.id, name: a.name }));
const accountOf = async (id) => (await db.prepare('SELECT id, name FROM recurring_accounts WHERE id = ?').get(Number(id) || 0)) || null;

/** Add an account (id null) or rename one. A name is there once, whatever its capitals. null: no such account. */
export async function saveAccount(user, id, input) {
  const old = id === null ? null : await accountOf(id);
  if (id !== null && !old) return null;
  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad('Give the account a name, like Cash to Mr Tauqeer');
  const same = await db.prepare('SELECT id, name FROM recurring_accounts WHERE lower(name) = lower(?)').get(name);
  if (same && same.id !== old?.id) throw bad(`"${same.name}" is already in the list`, 409);
  if (old) await db.prepare('UPDATE recurring_accounts SET name = ? WHERE id = ?').run(name, old.id);
  const savedId = old?.id ?? (await db.prepare('INSERT INTO recurring_accounts (name, created_by) VALUES (?, ?) RETURNING id').run(name, user.id)).id;
  return (await listAccounts()).find((a) => a.id === savedId);
}

/** Only an account nothing ever went through can go. */
export async function deleteAccount(user, id) {
  const a = (await listAccounts()).find((x) => x.id === Number(id));
  if (!a) return null;
  if (a.used) throw bad(`"${a.name}" has payments or transfers, so it cannot be deleted.`, 409);
  await db.prepare('DELETE FROM recurring_accounts WHERE id = ?').run(a.id);
  return { ok: true };
}

/**
 * One account and everything that went through it, newest first: receipts of payments and
 * transfers in (amount above 0), transfers out (below 0).
 */
export async function getAccount(user, id) {
  const account = (await listAccounts()).find((a) => a.id === Number(id));
  if (!account) return null;
  // A part of a line says so: "part of 5,000.00".
  const paid = (await db.prepare(`SELECT r.id, r.amount, r.paid_on, r.created_at, r.attachment, u.name AS by, d.amount AS due_amount, d.month,
      p.title, p.unit, b.name AS building_name
    FROM recurring_payment_receipts r JOIN recurring_payment_dues d ON d.id = r.due_id JOIN recurring_payments p ON p.id = d.payment_id
    JOIN recurring_buildings b ON b.id = p.building_id LEFT JOIN users u ON u.id = r.created_by
    WHERE r.account_id = ?`).all(account.id)).map((r) => ({
    kind: 'receipt', id: r.id, at: Number(r.created_at), date: r.paid_on,
    text: [r.title, r.building_name, r.unit, r.month, r.amount < r.due_amount ? `part of ${r.due_amount.toFixed(2)}` : null].filter(Boolean).join(' · '),
    amount: r.amount, by: r.by, attachment: !!r.attachment,
  }));
  const moved = (await db.prepare(`${TRANSFER} WHERE ? IN (t.from_account_id, t.to_account_id)`).all(account.id)).map((t) => {
    const out = t.from_account_id === account.id;
    return {
      kind: 'transfer', id: t.id, at: Number(t.created_at), date: t.date,
      text: (out ? `Transfer to ${t.to_name}` : `Transfer from ${t.from_name}`) + (t.notes ? ` · ${t.notes}` : ''),
      amount: out ? -t.amount : t.amount, by: t.by, attachment: !!t.attachment,
    };
  });
  const movements = [...paid, ...moved].sort((x, y) => y.date.localeCompare(x.date) || y.at - x.at || y.id - x.id);
  return { account, movements };
}

// ---------- the transfers ----------

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TRANSFER = `SELECT t.id, t.from_account_id, f.name AS from_name, t.to_account_id, o.name AS to_name, t.amount, t.date, t.notes,
    t.attachment, t.created_at, u.name AS by
  FROM recurring_transfers t JOIN recurring_accounts f ON f.id = t.from_account_id JOIN recurring_accounts o ON o.id = t.to_account_id
  LEFT JOIN users u ON u.id = t.created_by`;
const shapeTransfer = (t) => ({
  id: t.id, from: { id: t.from_account_id, name: t.from_name }, to: { id: t.to_account_id, name: t.to_name },
  amount: t.amount, date: t.date, notes: t.notes, by: t.by, attachment: !!t.attachment,
});

/** Every transfer, newest first, and the accounts with what each holds. */
export async function listTransfers() {
  const rows = await db.prepare(`${TRANSFER} ORDER BY t.date DESC, t.id DESC`).all();
  return { today: today(), accounts: await listAccounts(), transfers: rows.map(shapeTransfer) };
}

/**
 * Money handed from one account to another. Nothing stops an account going below zero:
 * these are the accountants' own books, and cash may have been there before the list was.
 */
async function addTransferWork(user, input, now = today()) {
  const from = await accountOf(input?.from_id);
  const to = await accountOf(input?.to_id);
  if (!from) throw bad('Pick the account the money comes from');
  if (!to) throw bad('Pick the account the money goes to');
  if (from.id === to.id) throw bad('Pick two different accounts');
  const amount = money(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw bad('The amount must be a number more than 0');
  const date = String(input.date ?? '').trim() || now;
  if (!DATE.test(date)) throw bad('Pick the date of the transfer');
  const { id } = await db.prepare(`INSERT INTO recurring_transfers (from_account_id, to_account_id, amount, date, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).run(from.id, to.id, amount, date, String(input.notes ?? '').trim().slice(0, MAX_NOTES) || null, user.id);
  const made = await db.prepare(`${TRANSFER} WHERE t.id = ?`).get(id);
  await note(user, 'transfer_added', aboutTransfer(made));
  return shapeTransfer(made);
}
const aboutTransfer = (t) => ({
  ref_kind: 'transfer', ref_id: t.id, title: `${t.from_name} → ${t.to_name}`, amount: t.amount,
  detail: `Dated ${t.date}${t.notes ? ` · ${t.notes}` : ''}`,
});

/** A transfer made by mistake: gone, with its file, and both accounts are as they were. */
async function deleteTransferWork(user, id) {
  if (!(await hold('recurring_transfers', id))) return null;
  const t = await db.prepare(`${TRANSFER} WHERE t.id = ?`).get(Number(id) || 0);
  if (!t) return null;
  await db.prepare('DELETE FROM recurring_transfers WHERE id = ?').run(t.id);
  dropLater(t.attachment);
  await note(user, 'transfer_deleted', aboutTransfer(t));
  return { ok: true };
}

// ---------- the files ----------

const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const FILE_OF = { due: 'recurring_payment_dues', receipt: 'recurring_payment_receipts', transfer: 'recurring_transfers' };
const dropFile = (path) => { if (path) rmSync(path, { force: true }); };
const LIVE = { due: ' AND deleted_at IS NULL', receipt: '', transfer: '' }; // a deleted line keeps no file

// What a file belongs to, for the activity list: the payment its receipt is of, or the transfer.
async function aboutFile(kind, id) {
  if (kind === 'transfer') {
    const t = await db.prepare(`${TRANSFER} WHERE t.id = ?`).get(id);
    return t ? { ...aboutTransfer(t), detail: 'The attachment of a transfer' } : {};
  }
  const dueId = kind === 'receipt' ? (await db.prepare('SELECT due_id FROM recurring_payment_receipts WHERE id = ?').get(id))?.due_id : id;
  const d = dueId ? await dueOf(dueId) : null;
  return d ? { ...aboutDue(d), detail: 'An attachment of a payment' } : {};
}

/** Keep a file with a receipt, a line (kind 'due', from before receipts) or a transfer; a new one replaces the old. null: no such line. */
export async function setAttachment(user, kind, id, file) {
  const row = await db.prepare(`SELECT id, attachment FROM ${FILE_OF[kind]} WHERE id = ?${LIVE[kind]}`).get(Number(id) || 0);
  if (!row) return null;
  const ext = FILE_TYPES[file?.mimetype];
  if (!ext || !file.buffer?.length) throw bad('The attachment must be a picture (JPG, PNG) or a PDF');
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/${kind}-${row.id}-${Date.now()}.${ext}`;
  await writeFile(path, file.buffer);
  await db.prepare(`UPDATE ${FILE_OF[kind]} SET attachment = ? WHERE id = ?`).run(path, row.id);
  dropLater(row.attachment);
  const about = await aboutFile(kind, row.id);
  await noteFile(user, 'file_added', { ...about, detail: `${about.detail || 'An attachment'}${row.attachment ? ', in place of the one before' : ''}` });
  return { ok: true };
}

/** A file kept by mistake, taken off: the line, receipt or transfer stays as it is. null: none there. */
export async function removeAttachment(user, kind, id) {
  const row = await db.prepare(`SELECT id, attachment FROM ${FILE_OF[kind]} WHERE id = ?${LIVE[kind]}`).get(Number(id) || 0);
  if (!row) return null;
  await db.prepare(`UPDATE ${FILE_OF[kind]} SET attachment = NULL WHERE id = ?`).run(row.id);
  dropLater(row.attachment);
  if (row.attachment) await noteFile(user, 'file_removed', await aboutFile(kind, row.id));
  return { ok: true };
}

export const attachmentPath = async (kind, id) => (await db.prepare(`SELECT attachment FROM ${FILE_OF[kind]} WHERE id = ?`).get(Number(id) || 0))?.attachment || null;

/** One more file for a receipt, kept beside its own attachment. null: no such receipt. */
export async function addReceiptFile(user, receiptId, file) {
  const r = await db.prepare('SELECT id FROM recurring_payment_receipts WHERE id = ?').get(Number(receiptId) || 0);
  if (!r) return null;
  const ext = FILE_TYPES[file?.mimetype];
  if (!ext || !file.buffer?.length) throw bad('The attachment must be a picture (JPG, PNG) or a PDF');
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/receipt-${r.id}-${Date.now()}.${ext}`;
  await writeFile(path, file.buffer);
  const { id } = await db.prepare('INSERT INTO recurring_payment_receipt_files (receipt_id, path, created_by) VALUES (?, ?, ?) RETURNING id')
    .run(r.id, path, user?.id ?? null);
  await noteFile(user, 'file_added', await aboutFile('receipt', r.id));
  return { ok: true, id };
}

export const receiptFilePath = async (id) =>
  (await db.prepare('SELECT path FROM recurring_payment_receipt_files WHERE id = ?').get(Number(id) || 0))?.path || null;

/** One further file of a receipt gone, row and file. null: no such file. */
export async function deleteReceiptFile(user, id) {
  const f = await db.prepare('SELECT id, path, receipt_id FROM recurring_payment_receipt_files WHERE id = ?').get(Number(id) || 0);
  if (!f) return null;
  await db.prepare('DELETE FROM recurring_payment_receipt_files WHERE id = ?').run(f.id);
  dropLater(f.path);
  await noteFile(user, 'file_removed', await aboutFile('receipt', f.receipt_id));
  return { ok: true };
}

// ---------- what is saved with its line ----------

// Each of these, as the rest of Reem calls it: the work above, saved together with its line
// in the activity list (see saved). Inside this file they call each other by these names too.
export const saveEntry = withItsLine(saveEntryWork);
export const setActive = withItsLine(setActiveWork);
export const deleteEntry = withItsLine(deleteEntryWork);
export const createNow = withItsLine(createNowWork);
export const addReceipt = withItsLine(addReceiptWork);
export const deleteReceipt = withItsLine(deleteReceiptWork);
export const setPaid = withItsLine(setPaidWork);
export const updateDue = withItsLine(updateDueWork);
export const deleteDue = withItsLine(deleteDueWork);
export const addTransfer = withItsLine(addTransferWork);
export const deleteTransfer = withItsLine(deleteTransferWork);

// ---------- the timer ----------

const EVERY = 60 * 60_000;
let timer = null;

/** Looks every hour for lines whose day has come. Cheap, and safe to run again. */
export function startRecurringPayments() {
  if (timer) return;
  const tick = () => createDuePayments()
    .then((made) => made && console.log(`[recurring payments] ${made} created`))
    .catch((e) => console.warn('[recurring payments]', e.message));
  timer = setInterval(tick, EVERY);
  setTimeout(tick, 15_000);
}

// ---------- routes ----------

export const recurringPaymentRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));

// The accountants come in from saifsys, which has checked their role. Signed in to Reem itself, it is the master's.
recurringPaymentRoutes.use((req, res, next) => (req.fromSaifsys || req.user?.role === 'master'
  ? next() : res.status(403).json({ error: 'Recurring Payments is opened from saifsys' })));

recurringPaymentRoutes.get('/', wrap(async (req, res) => res.json(await listDues(req.user, req.query))));
recurringPaymentRoutes.get('/activity', wrap(async (req, res) => res.json(await listActivity(req.user, req.query))));
recurringPaymentRoutes.get('/entries', wrap(async (req, res) => res.json(await listEntries(req.user))));
recurringPaymentRoutes.post('/entries', wrap(async (req, res) => res.json(await saveEntry(req.user, null, req.body))));
recurringPaymentRoutes.put('/entries/:id', wrap(async (req, res) => send(res, await saveEntry(req.user, req.params.id, req.body))));
recurringPaymentRoutes.delete('/entries/:id', wrap(async (req, res) => send(res, await deleteEntry(req.user, req.params.id, req.query.with_payments === '1'))));
recurringPaymentRoutes.post('/entries/:id/active', wrap(async (req, res) => send(res, await setActive(req.user, req.params.id, req.body?.active))));
recurringPaymentRoutes.post('/entries/:id/dues', wrap(async (req, res) => send(res, await createNow(req.user, req.params.id, today(), req.body?.date))));
recurringPaymentRoutes.get('/dues/:id', wrap(async (req, res) => send(res, await getDue(req.user, req.params.id))));
recurringPaymentRoutes.post('/dues/:id/paid', wrap(async (req, res) => send(res, await setPaid(req.user, req.params.id, true, req.body))));
recurringPaymentRoutes.post('/dues/:id/pending', wrap(async (req, res) => send(res, await setPaid(req.user, req.params.id, false))));
recurringPaymentRoutes.put('/dues/:id', wrap(async (req, res) => send(res, await updateDue(req.user, req.params.id, req.body))));
recurringPaymentRoutes.delete('/dues/:id', wrap(async (req, res) => send(res, await deleteDue(req.user, req.params.id))));
recurringPaymentRoutes.post('/dues/:id/receipts', wrap(async (req, res) => send(res, await addReceipt(req.user, req.params.id, req.body))));
recurringPaymentRoutes.delete('/receipts/:id', wrap(async (req, res) => send(res, await deleteReceipt(req.user, req.params.id))));
recurringPaymentRoutes.get('/buildings', wrap(async (req, res) => res.json({ buildings: await listBuildings() })));
recurringPaymentRoutes.post('/buildings', wrap(async (req, res) => res.json(await saveBuilding(req.user, null, req.body))));
recurringPaymentRoutes.put('/buildings/:id', wrap(async (req, res) => send(res, await saveBuilding(req.user, req.params.id, req.body))));
recurringPaymentRoutes.delete('/buildings/:id', wrap(async (req, res) => send(res, await deleteBuilding(req.user, req.params.id))));

recurringPaymentRoutes.get('/heads', wrap(async (req, res) => res.json({ heads: await listHeads() })));
recurringPaymentRoutes.post('/heads', wrap(async (req, res) => res.json(await saveHead(req.user, null, req.body))));
recurringPaymentRoutes.put('/heads/:id', wrap(async (req, res) => send(res, await saveHead(req.user, req.params.id, req.body))));
recurringPaymentRoutes.delete('/heads/:id', wrap(async (req, res) => send(res, await deleteHead(req.user, req.params.id))));
recurringPaymentRoutes.get('/report', wrap(async (req, res) => res.json(await getReport(req.user, req.query))));

recurringPaymentRoutes.get('/accounts', wrap(async (req, res) => res.json({ accounts: await listAccounts() })));
recurringPaymentRoutes.post('/accounts', wrap(async (req, res) => res.json(await saveAccount(req.user, null, req.body))));
recurringPaymentRoutes.get('/accounts/:id', wrap(async (req, res) => send(res, await getAccount(req.user, req.params.id))));
recurringPaymentRoutes.put('/accounts/:id', wrap(async (req, res) => send(res, await saveAccount(req.user, req.params.id, req.body))));
recurringPaymentRoutes.delete('/accounts/:id', wrap(async (req, res) => send(res, await deleteAccount(req.user, req.params.id))));

recurringPaymentRoutes.get('/transfers', wrap(async (req, res) => res.json(await listTransfers())));
recurringPaymentRoutes.post('/transfers', wrap(async (req, res) => res.json(await addTransfer(req.user, req.body))));
recurringPaymentRoutes.delete('/transfers/:id', wrap(async (req, res) => send(res, await deleteTransfer(req.user, req.params.id))));

// The file of a receipt, of a line (from before receipts) or of a transfer. The upload is called "photo" because that is
// the name saifsys's line to Reem sends every file under (see binv_reem there).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
for (const [kind, at] of [['due', '/dues/:id/attachment'], ['receipt', '/receipts/:id/attachment'], ['transfer', '/transfers/:id/attachment']]) {
  recurringPaymentRoutes.post(at, upload.single('photo'), wrap(async (req, res) => {
    if (!req.file) throw bad('No file came through');
    send(res, await setAttachment(req.user, kind, req.params.id, req.file));
  }));
  recurringPaymentRoutes.delete(at, wrap(async (req, res) => send(res, await removeAttachment(req.user, kind, req.params.id))));
  recurringPaymentRoutes.get(at, wrap(async (req, res) => {
    const path = await attachmentPath(kind, req.params.id);
    if (!path) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').sendFile(path);
  }));
}

// A receipt's further files: add one (field "photo", like the rest), open one, delete one.
recurringPaymentRoutes.post('/receipts/:id/files', upload.single('photo'), wrap(async (req, res) => {
  if (!req.file) throw bad('No file came through');
  send(res, await addReceiptFile(req.user, req.params.id, req.file));
}));
recurringPaymentRoutes.get('/receipt-files/:id/attachment', wrap(async (req, res) => {
  const path = await receiptFilePath(req.params.id);
  if (!path) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').sendFile(path);
}));
recurringPaymentRoutes.delete('/receipt-files/:id', wrap(async (req, res) => send(res, await deleteReceiptFile(req.user, req.params.id))));
