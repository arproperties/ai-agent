import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { requireMaster } from './auth.js';

// Recurring: money that is owed to the office (receivables) and money the office owes
// (payables), each entry against an account, with how it is paid, whether it is paid,
// when it is due and the paper that proves it.
//
// The module keeps its own chart of accounts and takes nothing from saifsys or from any
// other part of the app. The chart has two levels: a parent (the company) and the
// accounts under it ("Cash to Mr Tauqeer"). Every parent and account belongs to one
// side, so the Receivables page only ever sees the receivable chart and the Payables
// page the payable one - the side comes from the page, it is never picked by hand.
//
// An entry cannot be saved without its attachment. "Overdue" is not stored: it is a
// pending entry whose due date has passed, by Dubai's calendar.
//
// Master only, for now.

export const SIDES = ['receivable', 'payable'];
export const METHODS = ['cash', 'bank', 'cheque'];
export const STATUSES = ['pending', 'paid'];

const MAX_NAME = 80;
const MAX_NOTE = 500;
const MAX_AMOUNT = 1_000_000_000;
const NOW = 'extract(epoch from now())::bigint';
const TODAY = `(now() AT TIME ZONE 'Asia/Dubai')::date`;
const DIR = `${DATA_DIR}/recurring`;
const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const sideOf = (side) => { if (!SIDES.includes(side)) throw bad('Not found', 404); return side; };
const dropFile = (path) => { if (path) rmSync(path, { force: true }); };

// ---------- the chart of accounts ----------

const accountRow = (side, id) => db.prepare('SELECT * FROM recurring_accounts WHERE id = ? AND side = ?').get(Number(id) || 0, side);

/** One side's chart: its parents in name order, each with its accounts and how many entries each has. */
export async function chart(side) {
  const rows = await db.prepare(`SELECT a.id, a.parent_id, a.name, a.hidden,
      (SELECT count(*)::int FROM recurring_entries e WHERE e.account_id = a.id) AS entries
    FROM recurring_accounts a WHERE a.side = ? ORDER BY lower(a.name), a.id`).all(sideOf(side));
  return rows.filter((r) => !r.parent_id).map((p) => ({
    id: p.id, name: p.name, hidden: p.hidden,
    accounts: rows.filter((r) => r.parent_id === p.id).map((a) => ({ id: a.id, name: a.name, hidden: a.hidden, entries: a.entries })),
  }));
}

async function nameFree(side, parentId, name, exceptId = 0) {
  const taken = await db.prepare(`SELECT 1 FROM recurring_accounts
    WHERE side = ? AND coalesce(parent_id, 0) = ? AND lower(name) = lower(?) AND id <> ?`).get(side, parentId || 0, name, exceptId);
  if (taken) throw bad(parentId ? `This parent already has an account called ${name}` : `There is already a parent account called ${name}`);
}

/** Add a parent (no parent_id) or an account under one. */
export async function addAccount(user, side, input) {
  sideOf(side);
  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad(input?.parent_id ? 'Give the account a name, like Cash to Mr Tauqeer' : 'Give the parent account a name, like the company\'s name');
  let parentId = null;
  if (input?.parent_id) {
    const parent = await accountRow(side, input.parent_id);
    if (!parent || parent.parent_id) throw bad('Pick the parent account from the list');
    parentId = parent.id;
  }
  await nameFree(side, parentId, name);
  const { id } = await db.prepare('INSERT INTO recurring_accounts (side, parent_id, name, created_by) VALUES (?, ?, ?, ?) RETURNING id')
    .run(side, parentId, name, user.id);
  return { id, parent_id: parentId, name, hidden: false };
}

/** Rename, or hide from the picker (and bring back). null: no such account on this side. */
export async function changeAccount(side, id, input) {
  const row = await accountRow(sideOf(side), id);
  if (!row) return null;
  const name = input?.name === undefined ? row.name : line(input.name, MAX_NAME);
  if (!name) throw bad('The name cannot be empty');
  if (name !== row.name) await nameFree(side, row.parent_id, name, row.id);
  const hidden = input?.hidden === undefined ? row.hidden : !!input.hidden;
  await db.prepare('UPDATE recurring_accounts SET name = ?, hidden = ? WHERE id = ?').run(name, hidden, row.id);
  return { id: row.id, parent_id: row.parent_id, name, hidden };
}

/** Only what was never used can be removed; anything with entries is hidden instead, so the history stays whole. */
export async function deleteAccount(side, id) {
  const row = await accountRow(sideOf(side), id);
  if (!row) return null;
  if (!row.parent_id && await db.prepare('SELECT 1 FROM recurring_accounts WHERE parent_id = ?').get(row.id)) {
    throw bad(`${row.name} still has accounts under it. Remove those first.`, 409);
  }
  if (await db.prepare('SELECT 1 FROM recurring_entries WHERE account_id = ?').get(row.id)) {
    throw bad(`${row.name} has entries, so it cannot be removed. Hide it instead.`, 409);
  }
  await db.prepare('DELETE FROM recurring_accounts WHERE id = ?').run(row.id);
  return { ok: true };
}

// ---------- the entries ----------

const ENTRY = `SELECT e.id, e.side, e.account_id, a.name AS account, p.name AS parent, e.amount, e.method, e.status,
    to_char(e.due_date, 'YYYY-MM-DD') AS due_date, (e.status = 'pending' AND e.due_date < ${TODAY}) AS overdue,
    e.note, e.file, e.file_name, e.file_mime, e.updated_at, u.name AS updated_by
  FROM recurring_entries e JOIN recurring_accounts a ON a.id = e.account_id JOIN recurring_accounts p ON p.id = a.parent_id
  LEFT JOIN users u ON u.id = e.updated_by`;

const shape = (r) => ({
  id: r.id, account_id: r.account_id, account: r.account, parent: r.parent, amount: Number(r.amount), method: r.method,
  // What the page shows: a pending entry past its due date is overdue.
  status: r.overdue ? 'overdue' : r.status,
  due_date: r.due_date, note: r.note, file_name: r.file_name, file_mime: r.file_mime, updated_at: r.updated_at, updated_by: r.updated_by,
});

const entryRow = (side, id) => db.prepare(`${ENTRY} WHERE e.id = ? AND e.side = ?`).get(Number(id) || 0, side);

/** Everything one page needs: the chart, the entries (soonest due first) and the totals. */
export async function getSide(side) {
  const entries = (await db.prepare(`${ENTRY} WHERE e.side = ? ORDER BY e.status = 'paid', e.due_date, e.id`).all(sideOf(side))).map(shape);
  const totals = { pending: 0, overdue: 0, paid: 0 };
  for (const e of entries) totals[e.status] = Math.round((totals[e.status] + e.amount) * 100) / 100;
  return { side, chart: await chart(side), entries, totals, methods: METHODS };
}

/** What was typed about one entry, checked. The account must be one of this side's own. */
async function readFields(side, input, old) {
  const account = await accountRow(side, input?.account_id);
  if (!account || !account.parent_id) throw bad('Pick the account from the list');
  if (account.hidden && account.id !== old?.account_id) throw bad(`${account.name} is hidden. Bring it back under Accounts to use it.`);
  const amount = Number(input.amount);
  if (input.amount === '' || input.amount === undefined || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw bad('The amount must be a number above 0');
  if (!METHODS.includes(input.method)) throw bad('The payment is cash, bank transfer or cheque');
  const status = input.status || 'pending';
  if (!STATUSES.includes(status)) throw bad('The status is pending or paid');
  const due = String(input.due_date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`))) throw bad('Give the due date');
  return { account_id: account.id, amount: Math.round(amount * 100) / 100, method: input.method, status, due_date: due, note: String(input.note ?? '').trim().slice(0, MAX_NOTE) || null };
}

function readFile(file) {
  if (!file?.buffer?.length) return null;
  const ext = FILE_TYPES[file.mimetype];
  if (!ext) throw bad('The attachment must be a picture (JPG, PNG) or a PDF');
  return { ext, mime: file.mimetype, name: line(file.originalname, 200) || `attachment.${ext}`, buffer: file.buffer };
}

async function keepFile(side, f) {
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/${side}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${f.ext}`;
  await writeFile(path, f.buffer);
  return path;
}

/**
 * Add an entry (id null) or change one. A new entry must come with its attachment; a
 * changed one keeps the attachment it has unless a new one is sent.
 * null: no such entry on this side.
 */
export async function saveEntry(user, side, id, input, file) {
  sideOf(side);
  const old = id ? await entryRow(side, id) : null;
  if (id && !old) return null;
  const f = await readFields(side, input || {}, old);
  const att = readFile(file);
  if (!old && !att) throw bad('Add the attachment: an entry cannot be saved without one');

  const path = att ? await keepFile(side, att) : null;
  try {
    if (!old) {
      const { id: newId } = await db.prepare(`INSERT INTO recurring_entries (side, account_id, amount, method, status, due_date, note, file, file_name, file_mime, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?::date, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .run(side, f.account_id, f.amount, f.method, f.status, f.due_date, f.note, path, att.name, att.mime, user.id, user.id);
      return shape(await entryRow(side, newId));
    }
    await db.prepare(`UPDATE recurring_entries SET account_id = ?, amount = ?, method = ?, status = ?, due_date = ?::date, note = ?,
      file = ?, file_name = ?, file_mime = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`)
      .run(f.account_id, f.amount, f.method, f.status, f.due_date, f.note, path || old.file, att?.name || old.file_name, att?.mime || old.file_mime, user.id, old.id);
  } catch (e) {
    dropFile(path);
    throw e;
  }
  if (path) dropFile(old.file);
  return shape(await entryRow(side, old.id));
}

/** Mark paid, or back to pending, from the list. */
export async function setStatus(user, side, id, status) {
  const old = await entryRow(sideOf(side), id);
  if (!old) return null;
  if (!STATUSES.includes(status)) throw bad('The status is pending or paid');
  await db.prepare(`UPDATE recurring_entries SET status = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`).run(status, user.id, old.id);
  return shape(await entryRow(side, old.id));
}

export async function deleteEntry(side, id) {
  const old = await entryRow(sideOf(side), id);
  if (!old) return null;
  await db.prepare('DELETE FROM recurring_entries WHERE id = ?').run(old.id);
  dropFile(old.file);
  return { ok: true };
}

// ---------- routes ----------

export const recurringRoutes = Router();
recurringRoutes.use(requireMaster);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

recurringRoutes.get('/:side', wrap(async (req, res) => res.json(await getSide(req.params.side))));
recurringRoutes.post('/:side/accounts', wrap(async (req, res) => res.json(await addAccount(req.user, req.params.side, req.body))));
recurringRoutes.put('/:side/accounts/:id', wrap(async (req, res) => send(res, await changeAccount(req.params.side, req.params.id, req.body))));
recurringRoutes.delete('/:side/accounts/:id', wrap(async (req, res) => send(res, await deleteAccount(req.params.side, req.params.id))));
recurringRoutes.post('/:side/entries', upload.single('file'), wrap(async (req, res) => send(res, await saveEntry(req.user, req.params.side, null, req.body, req.file))));
recurringRoutes.put('/:side/entries/:id', upload.single('file'), wrap(async (req, res) => send(res, await saveEntry(req.user, req.params.side, req.params.id, req.body, req.file))));
recurringRoutes.put('/:side/entries/:id/status', wrap(async (req, res) => send(res, await setStatus(req.user, req.params.side, req.params.id, req.body?.status))));
recurringRoutes.delete('/:side/entries/:id', wrap(async (req, res) => send(res, await deleteEntry(req.params.side, req.params.id))));
recurringRoutes.get('/:side/entries/:id/file', wrap(async (req, res) => {
  const row = SIDES.includes(req.params.side) && await entryRow(req.params.side, req.params.id);
  if (!row?.file) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').type(row.file_mime).sendFile(row.file);
}));
