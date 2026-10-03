import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { requireMaster } from './auth.js';

// Recurring: money that is owed to a company (receivables) and money it owes (payables),
// each entry against an account, with how it is paid, whether it is paid, when it is
// due and the paper that proves it.
//
// The module keeps its own companies and its own chart of accounts and takes nothing
// from saifsys or from any other part of the app. The company is what ties the two
// sides together: one company, what it is owed and what it owes. Under a company each
// side has its own open chart - any name, an optional number, any account under any
// other, to any depth. The side comes from the page, it is never picked by hand, so a
// receivable can never land on a payable account.
//
// An entry cannot be saved without its attachment. "Overdue" is not stored: it is a
// pending entry whose due date has passed, by Dubai's calendar.
//
// Master only, for now. The app shows Receivables only for now; Payables is held.

export const SIDES = ['receivable', 'payable'];
export const METHODS = ['cash', 'bank', 'cheque'];
export const STATUSES = ['pending', 'paid'];

const MAX_NAME = 80;
const MAX_NO = 20;
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

// ---------- the companies ----------

const companyRow = (id) => db.prepare('SELECT id, name FROM recurring_companies WHERE id = ?').get(Number(id) || 0);
const sum = () => ({ pending: 0, overdue: 0, paid: 0 });
const add = (totals, status, amount) => { totals[status] = Math.round((totals[status] + Number(amount)) * 100) / 100; };

/** Every company, with what it is owed and what it owes. */
export async function companies() {
  const rows = await db.prepare('SELECT id, name FROM recurring_companies ORDER BY lower(name)').all();
  const sums = await db.prepare(`SELECT a.company_id, e.side,
      CASE WHEN e.status = 'pending' AND e.due_date < ${TODAY} THEN 'overdue' ELSE e.status END AS status, sum(e.amount) AS amount
    FROM recurring_entries e JOIN recurring_accounts a ON a.id = e.account_id GROUP BY 1, 2, 3`).all();
  return rows.map((c) => {
    const out = { id: c.id, name: c.name, receivable: sum(), payable: sum() };
    for (const r of sums) if (r.company_id === c.id) add(out[r.side], r.status, r.amount);
    return out;
  });
}

async function companyName(input, exceptId = 0) {
  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad('Give the company a name');
  if (await db.prepare('SELECT 1 FROM recurring_companies WHERE lower(name) = lower(?) AND id <> ?').get(name, exceptId)) throw bad(`There is already a company called ${name}`);
  return name;
}

export async function addCompany(user, input) {
  const name = await companyName(input);
  const { id } = await db.prepare('INSERT INTO recurring_companies (name, created_by) VALUES (?, ?) RETURNING id').run(name, user.id);
  return { id, name };
}

export async function renameCompany(id, input) {
  const row = await companyRow(id);
  if (!row) return null;
  const name = await companyName(input, row.id);
  await db.prepare('UPDATE recurring_companies SET name = ? WHERE id = ?').run(name, row.id);
  return { id: row.id, name };
}

/** A company with entries stays; an empty one goes, and its unused accounts with it. */
export async function deleteCompany(id) {
  const row = await companyRow(id);
  if (!row) return null;
  if (await db.prepare('SELECT 1 FROM recurring_entries e JOIN recurring_accounts a ON a.id = e.account_id WHERE a.company_id = ?').get(row.id)) {
    throw bad(`${row.name} has entries, so it cannot be removed.`, 409);
  }
  // Children before parents: an account cannot be removed from under another's feet.
  await db.prepare('UPDATE recurring_accounts SET parent_id = NULL WHERE company_id = ?').run(row.id);
  await db.prepare('DELETE FROM recurring_companies WHERE id = ?').run(row.id);
  return { ok: true };
}

// ---------- the chart of accounts ----------

const accountRow = (companyId, side, id) => db.prepare('SELECT * FROM recurring_accounts WHERE id = ? AND company_id = ? AND side = ?')
  .get(Number(id) || 0, Number(companyId) || 0, side);

/**
 * One company's chart for one side, as a flat list in reading order: each account right
 * after its parent, with how deep it is and the names above it ("Cash › Petty cash").
 */
export async function chart(companyId, side) {
  const rows = await db.prepare(`SELECT a.id, a.parent_id, a.account_no, a.name, a.hidden,
      (SELECT count(*)::int FROM recurring_entries e WHERE e.account_id = a.id) AS entries
    FROM recurring_accounts a WHERE a.company_id = ? AND a.side = ?
    ORDER BY a.account_no NULLS LAST, lower(a.name), a.id`).all(Number(companyId) || 0, sideOf(side));
  const out = [];
  const walk = (parentId, depth, under) => {
    for (const r of rows.filter((x) => (x.parent_id || null) === parentId)) {
      out.push({ ...r, depth, under });
      walk(r.id, depth + 1, under ? `${under} › ${r.name}` : r.name);
    }
  };
  walk(null, 0, '');
  return out;
}

async function nameFree(companyId, side, parentId, name, exceptId = 0) {
  const taken = await db.prepare(`SELECT 1 FROM recurring_accounts
    WHERE company_id = ? AND side = ? AND coalesce(parent_id, 0) = ? AND lower(name) = lower(?) AND id <> ?`).get(companyId, side, parentId || 0, name, exceptId);
  if (taken) throw bad(`There is already an account called ${name} here`);
}

/** Add an account: at the top of the chart, or under any other account of the same chart. */
export async function addAccount(user, companyId, side, input) {
  sideOf(side);
  const company = await companyRow(companyId);
  if (!company) return null;
  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad('Give the account a name');
  let parentId = null;
  if (input?.parent_id) {
    const parent = await accountRow(company.id, side, input.parent_id);
    if (!parent) throw bad('Pick the account it goes under from the list');
    parentId = parent.id;
  }
  await nameFree(company.id, side, parentId, name);
  const no = line(input?.account_no, MAX_NO) || null;
  const { id } = await db.prepare('INSERT INTO recurring_accounts (company_id, side, parent_id, account_no, name, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .run(company.id, side, parentId, no, name, user.id);
  return { id, parent_id: parentId, account_no: no, name, hidden: false };
}

/** Rename, renumber, or hide from the picker (and bring back). null: no such account in this chart. */
export async function changeAccount(companyId, side, id, input) {
  const row = await accountRow(companyId, sideOf(side), id);
  if (!row) return null;
  const name = input?.name === undefined ? row.name : line(input.name, MAX_NAME);
  if (!name) throw bad('The name cannot be empty');
  if (name !== row.name) await nameFree(row.company_id, side, row.parent_id, name, row.id);
  const no = input?.account_no === undefined ? row.account_no : line(input.account_no, MAX_NO) || null;
  const hidden = input?.hidden === undefined ? row.hidden : !!input.hidden;
  await db.prepare('UPDATE recurring_accounts SET name = ?, account_no = ?, hidden = ? WHERE id = ?').run(name, no, hidden, row.id);
  return { id: row.id, parent_id: row.parent_id, account_no: no, name, hidden };
}

/** Only what was never used can be removed; anything with entries is hidden instead, so the history stays whole. */
export async function deleteAccount(companyId, side, id) {
  const row = await accountRow(companyId, sideOf(side), id);
  if (!row) return null;
  if (await db.prepare('SELECT 1 FROM recurring_accounts WHERE parent_id = ?').get(row.id)) {
    throw bad(`${row.name} still has accounts under it. Remove those first.`, 409);
  }
  if (await db.prepare('SELECT 1 FROM recurring_entries WHERE account_id = ?').get(row.id)) {
    throw bad(`${row.name} has entries, so it cannot be removed. Hide it instead.`, 409);
  }
  await db.prepare('DELETE FROM recurring_accounts WHERE id = ?').run(row.id);
  return { ok: true };
}

// ---------- the entries ----------

const ENTRY = `SELECT e.id, e.side, e.account_id, a.company_id, a.account_no, a.name AS account, e.amount, e.method, e.status,
    to_char(e.due_date, 'YYYY-MM-DD') AS due_date, (e.status = 'pending' AND e.due_date < ${TODAY}) AS overdue,
    e.note, e.file, e.file_name, e.file_mime, e.updated_at, u.name AS updated_by
  FROM recurring_entries e JOIN recurring_accounts a ON a.id = e.account_id LEFT JOIN users u ON u.id = e.updated_by`;

const shape = (r, under = '') => ({
  id: r.id, account_id: r.account_id, account_no: r.account_no, account: r.account, under, amount: Number(r.amount), method: r.method,
  // What the page shows: a pending entry past its due date is overdue.
  status: r.overdue ? 'overdue' : r.status,
  due_date: r.due_date, note: r.note, file_name: r.file_name, file_mime: r.file_mime, updated_at: r.updated_at, updated_by: r.updated_by,
});

const entryRow = (companyId, side, id) => db.prepare(`${ENTRY} WHERE e.id = ? AND a.company_id = ? AND e.side = ?`).get(Number(id) || 0, Number(companyId) || 0, side);
const entryOut = async (companyId, side, id) => {
  const row = await entryRow(companyId, side, id);
  return shape(row, (await chart(companyId, side)).find((a) => a.id === row.account_id)?.under || '');
};

/** Everything one page needs: the chart, the entries (soonest due first) and the totals. null: no such company. */
export async function getSide(companyId, side) {
  const company = await companyRow(companyId);
  if (!company) { sideOf(side); return null; }
  const accounts = await chart(company.id, side);
  const under = new Map(accounts.map((a) => [a.id, a.under]));
  const entries = (await db.prepare(`${ENTRY} WHERE a.company_id = ? AND e.side = ? ORDER BY e.status = 'paid', e.due_date, e.id`).all(company.id, side))
    .map((r) => shape(r, under.get(r.account_id) || ''));
  const totals = sum();
  for (const e of entries) add(totals, e.status, e.amount);
  return { company, side, chart: accounts, entries, totals, methods: METHODS };
}

/** What was typed about one entry, checked. The account must be one of this company's, on this side. */
async function readFields(companyId, side, input, old) {
  const account = await accountRow(companyId, side, input?.account_id);
  if (!account) throw bad('Pick the account from the list');
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
 * null: no such company, or no such entry of it on this side.
 */
export async function saveEntry(user, companyId, side, id, input, file) {
  sideOf(side);
  if (!(await companyRow(companyId))) return null;
  const old = id ? await entryRow(companyId, side, id) : null;
  if (id && !old) return null;
  const f = await readFields(companyId, side, input || {}, old);
  const att = readFile(file);
  if (!old && !att) throw bad('Add the attachment: an entry cannot be saved without one');

  const path = att ? await keepFile(side, att) : null;
  let entryId = old?.id;
  try {
    if (!old) {
      entryId = (await db.prepare(`INSERT INTO recurring_entries (side, account_id, amount, method, status, due_date, note, file, file_name, file_mime, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?::date, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .run(side, f.account_id, f.amount, f.method, f.status, f.due_date, f.note, path, att.name, att.mime, user.id, user.id)).id;
    } else {
      await db.prepare(`UPDATE recurring_entries SET account_id = ?, amount = ?, method = ?, status = ?, due_date = ?::date, note = ?,
        file = ?, file_name = ?, file_mime = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`)
        .run(f.account_id, f.amount, f.method, f.status, f.due_date, f.note, path || old.file, att?.name || old.file_name, att?.mime || old.file_mime, user.id, old.id);
    }
  } catch (e) {
    dropFile(path);
    throw e;
  }
  if (old && path) dropFile(old.file);
  return entryOut(companyId, side, entryId);
}

/** Mark paid, or back to pending, from the list. */
export async function setStatus(user, companyId, side, id, status) {
  const old = await entryRow(companyId, sideOf(side), id);
  if (!old) return null;
  if (!STATUSES.includes(status)) throw bad('The status is pending or paid');
  await db.prepare(`UPDATE recurring_entries SET status = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`).run(status, user.id, old.id);
  return entryOut(companyId, side, old.id);
}

export async function deleteEntry(companyId, side, id) {
  const old = await entryRow(companyId, sideOf(side), id);
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

recurringRoutes.get('/', wrap(async (req, res) => res.json(await companies())));
recurringRoutes.post('/companies', wrap(async (req, res) => res.json(await addCompany(req.user, req.body))));
recurringRoutes.put('/companies/:c', wrap(async (req, res) => send(res, await renameCompany(req.params.c, req.body))));
recurringRoutes.delete('/companies/:c', wrap(async (req, res) => send(res, await deleteCompany(req.params.c))));

const at = (req) => [req.params.c, req.params.side];
recurringRoutes.get('/:c/:side', wrap(async (req, res) => send(res, await getSide(...at(req)))));
recurringRoutes.post('/:c/:side/accounts', wrap(async (req, res) => send(res, await addAccount(req.user, ...at(req), req.body))));
recurringRoutes.put('/:c/:side/accounts/:id', wrap(async (req, res) => send(res, await changeAccount(...at(req), req.params.id, req.body))));
recurringRoutes.delete('/:c/:side/accounts/:id', wrap(async (req, res) => send(res, await deleteAccount(...at(req), req.params.id))));
recurringRoutes.post('/:c/:side/entries', upload.single('file'), wrap(async (req, res) => send(res, await saveEntry(req.user, ...at(req), null, req.body, req.file))));
recurringRoutes.put('/:c/:side/entries/:id', upload.single('file'), wrap(async (req, res) => send(res, await saveEntry(req.user, ...at(req), req.params.id, req.body, req.file))));
recurringRoutes.put('/:c/:side/entries/:id/status', wrap(async (req, res) => send(res, await setStatus(req.user, ...at(req), req.params.id, req.body?.status))));
recurringRoutes.delete('/:c/:side/entries/:id', wrap(async (req, res) => send(res, await deleteEntry(...at(req), req.params.id))));
recurringRoutes.get('/:c/:side/entries/:id/file', wrap(async (req, res) => {
  const row = SIDES.includes(req.params.side) && await entryRow(...at(req), req.params.id);
  if (!row?.file) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').type(row.file_mime).sendFile(row.file);
}));
