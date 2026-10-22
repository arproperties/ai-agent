import { Router } from 'express';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';
import { saveFile, sendDoc, upload } from './properties.js';
import { requireMaster } from './auth.js';
import { todayHere } from './leasingRegion.js';
import { fileBlock } from './documentReader.js';
import { syncStates } from './qbSync.js';

// Accounts: money going out, recorded here and sent to QuickBooks (server/qbSync.js) as the
// bookkeeper enters it there: a check (or a credit card charge) from the account it was paid
// from, to a vendor, split over expense accounts. The vendors and accounts are QuickBooks' own,
// as last read into qb_lists, so the two always use the same names. A vendor typed in that
// QuickBooks does not have yet is made there first.
//
// A receipt or bill can be read by the AI (readReceipt): it fills the vendor, the date, the
// amounts and the accounts, and a person checks them before saving.
//
// A bill paid every month (insurance, a loan, a utility) is a repeat: on its day each month it
// becomes an expense by itself (runRepeats), and so goes to QuickBooks like any other.

const DIR = `${DATA_DIR}/expenses`;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const money = (n) => Math.round(Number(n) * 100) / 100;
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max) || null;
const PAY_FROM = new Set(['Bank', 'CreditCard']);
const NOT_AN_EXPENSE = new Set(['AccountsReceivable', 'AccountsPayable', 'Bank', 'CreditCard']);
const MAX_LINES = 30;

const list = (kind) => db.prepare('SELECT list_id, name, full_name, type FROM qb_lists WHERE kind = ? AND active ORDER BY full_name').all(kind);
const accountRow = (id) => db.prepare("SELECT list_id, full_name, type, active FROM qb_lists WHERE kind = 'Account' AND list_id = ?").get(String(id ?? ''));

/** What the expense form picks from: QuickBooks' vendors and accounts, and the app's buildings and units. */
export async function choices() {
  const accounts = await list('Account');
  return {
    ready: accounts.length > 0,
    vendors: (await list('Vendor')).map((v) => ({ id: v.list_id, name: v.full_name })),
    pay_from: accounts.filter((a) => PAY_FROM.has(a.type)).map((a) => ({ id: a.list_id, name: a.full_name, card: a.type === 'CreditCard' })),
    accounts: accounts.filter((a) => !NOT_AN_EXPENSE.has(a.type)).map((a) => ({ id: a.list_id, name: a.full_name, type: a.type })),
    buildings: await db.prepare('SELECT id, name FROM prop_buildings ORDER BY lower(name)').all(),
    units: await db.prepare('SELECT u.id, u.unit_no, u.building_id FROM prop_units u ORDER BY u.building_id, u.unit_no').all(),
  };
}

// ---------- expenses ----------

/** The fields of an expense, checked; `lines` as a list or as the JSON of one (a form with a file sends text). */
async function fields(body = {}, today) {
  const paid_on = String(body.paid_on ?? '').trim();
  if (!isDate(paid_on)) throw bad('Choose the date it was paid.');
  if (paid_on > today) throw bad('The date paid cannot be in the future.');

  let vendor_list_id = text(body.vendor_list_id, 60);
  let vendor_name = text(body.vendor_name, 41);
  if (vendor_list_id) {
    const v = await db.prepare("SELECT full_name FROM qb_lists WHERE kind = 'Vendor' AND list_id = ?").get(vendor_list_id);
    if (!v) throw bad('That vendor is not in QuickBooks\' list. Read the lists again.');
    vendor_name = v.full_name;
  } else if (vendor_name) {
    // A name typed that QuickBooks already has is that vendor; otherwise it is made there first.
    vendor_list_id = (await db.prepare("SELECT list_id FROM qb_lists WHERE kind = 'Vendor' AND lower(full_name) = lower(?)").get(vendor_name))?.list_id ?? null;
  }
  if (!vendor_name) throw bad('Say who was paid.');

  const from = await accountRow(body.pay_from);
  if (!from || !PAY_FROM.has(from.type)) throw bad('Choose the bank account or card it was paid from.');
  const ref_no = text(body.ref_no, 11);

  let lines = body.lines;
  if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch { lines = null; } }
  if (!Array.isArray(lines) || !lines.length) throw bad('Add what it was for: an account and an amount.');
  if (lines.length > MAX_LINES) throw bad(`At most ${MAX_LINES} lines.`);
  const out = [];
  for (const l of lines) {
    const a = await accountRow(l?.account_list_id);
    if (!a || !a.active || NOT_AN_EXPENSE.has(a.type)) throw bad('Choose an expense account for every line.');
    const amount = money(l.amount);
    if (!(amount > 0)) throw bad(`Enter an amount above zero for ${a.full_name}.`);
    out.push({ account_list_id: a.list_id, amount, memo: text(l.memo, 200) });
  }

  let building_id = Number(body.building_id) || null;
  const unit_id = Number(body.unit_id) || null;
  if (unit_id) {
    const u = await db.prepare('SELECT building_id FROM prop_units WHERE id = ?').get(unit_id);
    if (!u) throw bad('Unit not found.', 404);
    building_id = u.building_id;
  }
  return {
    row: { paid_on, vendor_name, vendor_list_id, pay_from: from.list_id, ref_no, memo: text(body.memo, 500), building_id, unit_id, work_order_id: Number(body.work_order_id) || null },
    lines: out,
  };
}

const COLS = `e.id, to_char(e.paid_on, 'YYYY-MM-DD') AS paid_on, e.vendor_name, e.vendor_list_id, e.pay_from, e.ref_no, e.memo, e.building_id, e.unit_id,
  e.work_order_id, e.repeat_id, e.file_name, (e.file_path IS NOT NULL) AS has_file, e.created_at, b.name AS building, u.unit_no,
  pf.full_name AS pay_from_name, w.name AS added_by`;
const FROM = `FROM expenses e LEFT JOIN prop_buildings b ON b.id = e.building_id LEFT JOIN prop_units u ON u.id = e.unit_id
  LEFT JOIN qb_lists pf ON pf.kind = 'Account' AND pf.list_id = e.pay_from LEFT JOIN users w ON w.id = e.created_by`;

async function withLines(rows) {
  if (!rows.length) return rows;
  const lines = await db.prepare(`SELECT l.expense_id, l.account_list_id, a.full_name AS account, l.amount, l.memo FROM expense_lines l
    LEFT JOIN qb_lists a ON a.kind = 'Account' AND a.list_id = l.account_list_id WHERE l.expense_id = ANY(?) ORDER BY l.id`).all(rows.map((r) => r.id));
  const states = await syncStates(rows.map((r) => `expense:${r.id}`));
  return rows.map((r) => {
    const mine = lines.filter((l) => l.expense_id === r.id).map(({ expense_id, ...l }) => ({ ...l, amount: Number(l.amount) }));
    return { ...r, lines: mine, total: money(mine.reduce((t, l) => t + l.amount, 0)), quickbooks: states[`expense:${r.id}`] };
  });
}

export async function listExpenses({ from, to, q, building_id } = {}) {
  const where = [];
  const args = [];
  if (isDate(from)) { where.push('e.paid_on >= ?'); args.push(from); }
  if (isDate(to)) { where.push('e.paid_on <= ?'); args.push(to); }
  if (Number(building_id)) { where.push('e.building_id = ?'); args.push(Number(building_id)); }
  if (String(q || '').trim()) {
    where.push(`(e.vendor_name ILIKE ? OR e.memo ILIKE ? OR e.ref_no ILIKE ? OR EXISTS (SELECT 1 FROM expense_lines l JOIN qb_lists a ON a.kind = 'Account' AND a.list_id = l.account_list_id
      WHERE l.expense_id = e.id AND (a.full_name ILIKE ? OR l.memo ILIKE ?)))`);
    const like = `%${String(q).trim()}%`;
    args.push(like, like, like, like, like);
  }
  const rows = await db.prepare(`SELECT ${COLS} ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.paid_on DESC, e.id DESC LIMIT 500`).all(...args);
  return withLines(rows);
}

export async function getExpense(id) {
  const r = await db.prepare(`SELECT ${COLS} ${FROM} WHERE e.id = ?`).get(Number(id) || 0);
  if (!r) throw bad('Not found', 404);
  return (await withLines([r]))[0];
}

const writeLines = async (id, lines) => {
  await db.prepare('DELETE FROM expense_lines WHERE expense_id = ?').run(id);
  for (const l of lines) await db.prepare('INSERT INTO expense_lines (expense_id, account_list_id, amount, memo) VALUES (?, ?, ?, ?)').run(id, l.account_list_id, l.amount, l.memo);
};

export async function createExpense(body, file, by, today = todayHere()) {
  const { row, lines } = await fields(body, today);
  const id = await tx(async () => {
    const all = { ...row, ...saveFile(file, DIR), created_by: by ?? null };
    const cols = Object.keys(all);
    const { id } = await db.prepare(`INSERT INTO expenses (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).get(...cols.map((c) => all[c]));
    await writeLines(id, lines);
    return id;
  });
  return getExpense(id);
}

export async function updateExpense(id, body, file, today = todayHere()) {
  const old = await db.prepare('SELECT id, file_path FROM expenses WHERE id = ?').get(Number(id) || 0);
  if (!old) throw bad('Not found', 404);
  const { row, lines } = await fields(body, today);
  const f = file ? saveFile(file, DIR) : {};
  await tx(async () => {
    const all = { ...row, ...f };
    const cols = Object.keys(all);
    await db.prepare(`UPDATE expenses SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => all[c]), old.id);
    await writeLines(old.id, lines);
  });
  if (file && old.file_path) rmSync(old.file_path, { force: true });
  return getExpense(old.id);
}

/** Deleted here, it is taken out of QuickBooks too on the next round. */
export async function removeExpense(id) {
  const e = await db.prepare('SELECT id, file_path FROM expenses WHERE id = ?').get(Number(id) || 0);
  if (!e) throw bad('Not found', 404);
  await db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
  if (e.file_path) rmSync(e.file_path, { force: true });
  return { ok: true };
}

// ---------- reading a receipt ----------

let ask = (...args) => import('./ai.js').then((m) => m.ask(...args));
/** Tests put their own reader in place of Claude. */
export const useAsk = (fn) => { ask = fn; seen.clear(); };
const seen = new Map(); // the file's fingerprint -> { at, read }
const KEEP = 60 * 60_000;
const WAIT = 60_000;

const PROMPT = (vendors, accounts) => `This is a receipt, invoice or bill that a property business paid. Read it and reply with one JSON object and nothing else, leaving out any key you cannot see on it:
"vendor": who was paid. If it is one of the KNOWN VENDORS below, give that name exactly as written there; otherwise the name as printed.
"paid_on": the date it was paid, or else the invoice date, as YYYY-MM-DD
"total": the total paid, as a plain number (no currency, no commas)
"memo": a short note a bookkeeper would write: the invoice or account number, and what it was for
"lines": a list of {"account": one of the ACCOUNTS below, exactly as written, "amount": plain number, "memo": what it was for}. One line for the whole total, unless the receipt clearly covers different kinds of cost.
Never guess a number or a date.

KNOWN VENDORS:
${vendors.join('\n')}

ACCOUNTS:
${accounts.join('\n')}`;

/** What a receipt says, matched to QuickBooks' vendors and accounts. {} when it cannot be read. */
export async function readReceipt(file, { timeoutMs = WAIT } = {}) {
  const block = file?.buffer && fileBlock(file);
  if (!block) return {};
  const key = createHash('sha256').update(file.buffer).digest('hex');
  const kept = seen.get(key);
  if (kept && Date.now() - kept.at < KEEP) return kept.read;
  const c = await choices();
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('the reading took too long')), timeoutMs); });
  try {
    const reply = await Promise.race([ask(null, { maxTokens: 800, content: [block, { type: 'text', text: PROMPT(c.vendors.map((v) => v.name), c.accounts.map((a) => a.name)) }] }), late]);
    const read = await receiptFrom(reply, c);
    for (const [k, v] of seen) if (Date.now() - v.at >= KEEP) seen.delete(k);
    seen.set(key, { at: Date.now(), read });
    return read;
  } catch (e) {
    console.error('[receipt-reader]', e.message);
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** What is worth using out of the reply, tied to QuickBooks' own names. */
export async function receiptFrom(reply, c) {
  let o;
  try { o = JSON.parse(String(reply).match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return {}; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out = {};
  const lower = (s) => String(s ?? '').trim().toLowerCase();
  if (typeof o.vendor === 'string' && o.vendor.trim()) {
    const v = c.vendors.find((x) => lower(x.name) === lower(o.vendor));
    out.vendor_name = (v?.name || o.vendor.trim()).slice(0, 41);
    if (v) out.vendor_list_id = v.id;
  }
  if (isDate(o.paid_on)) out.paid_on = o.paid_on;
  const total = money(String(o.total ?? '').replace(/[^\d.]/g, ''));
  if (total > 0) out.total = total;
  if (typeof o.memo === 'string' && o.memo.trim()) out.memo = o.memo.trim().slice(0, 500);
  const lines = (Array.isArray(o.lines) ? o.lines : []).map((l) => ({
    account_list_id: c.accounts.find((a) => lower(a.name) === lower(l?.account))?.id || '',
    amount: money(String(l?.amount ?? '').replace(/[^\d.]/g, '')),
    memo: typeof l?.memo === 'string' ? l.memo.trim().slice(0, 200) : '',
  })).filter((l) => l.amount > 0).slice(0, MAX_LINES);
  // No account it could name: the one this vendor was last booked to here, if any.
  if (out.vendor_list_id) {
    const last = await db.prepare(`SELECT l.account_list_id FROM expense_lines l JOIN expenses e ON e.id = l.expense_id
      WHERE e.vendor_list_id = ? ORDER BY e.paid_on DESC, l.id LIMIT 1`).get(out.vendor_list_id);
    if (last) for (const l of lines) if (!l.account_list_id) l.account_list_id = last.account_list_id;
    if (last && !lines.length && total > 0) lines.push({ account_list_id: last.account_list_id, amount: total, memo: '' });
  }
  if (lines.length) out.lines = lines;
  return out;
}

// ---------- bills paid every month ----------

const month = (d) => d.slice(0, 7);
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };

async function repeatFields(body = {}, today) {
  const { row, lines } = await fields({ ...body, paid_on: today, lines: [{ account_list_id: body.account_list_id, amount: body.amount, memo: body.memo }] }, today);
  const day = Number(body.day);
  if (!Number.isInteger(day) || day < 1 || day > 28) throw bad('Choose the day of the month it is paid, 1 to 28.');
  return {
    vendor_name: row.vendor_name, vendor_list_id: row.vendor_list_id, pay_from: row.pay_from, ref_no: row.ref_no, memo: lines[0].memo,
    account_list_id: lines[0].account_list_id, amount: lines[0].amount, day, building_id: row.building_id,
  };
}

export async function listRepeats() {
  return (await db.prepare(`SELECT r.*, a.full_name AS account, pf.full_name AS pay_from_name, b.name AS building FROM expense_repeats r
    LEFT JOIN qb_lists a ON a.kind = 'Account' AND a.list_id = r.account_list_id LEFT JOIN qb_lists pf ON pf.kind = 'Account' AND pf.list_id = r.pay_from
    LEFT JOIN prop_buildings b ON b.id = r.building_id ORDER BY r.active DESC, r.day, lower(r.vendor_name)`).all())
    .map((r) => ({ ...r, amount: Number(r.amount) }));
}

/** A new monthly bill. Its first one is this month if its day is still to come, else next month. */
export async function createRepeat(body, by, today = todayHere()) {
  const r = await repeatFields(body, today);
  const first_month = Number(today.slice(8, 10)) <= r.day ? month(today) : nextMonth(month(today));
  const all = { ...r, first_month, created_by: by ?? null };
  const cols = Object.keys(all);
  const { id } = await db.prepare(`INSERT INTO expense_repeats (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).get(...cols.map((c) => all[c]));
  return (await listRepeats()).find((x) => x.id === id);
}

/** Changes apply from the next one made; the ones already made are expenses of their own. */
export async function updateRepeat(id, body, today = todayHere()) {
  const old = await db.prepare('SELECT id FROM expense_repeats WHERE id = ?').get(Number(id) || 0);
  if (!old) throw bad('Not found', 404);
  const r = { ...(await repeatFields(body, today)), active: body.active === undefined ? true : !!body.active && body.active !== 'false' };
  const cols = Object.keys(r);
  await db.prepare(`UPDATE expense_repeats SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => r[c]), old.id);
  return (await listRepeats()).find((x) => x.id === old.id);
}

export async function removeRepeat(id) {
  const r = await db.prepare('DELETE FROM expense_repeats WHERE id = ? RETURNING id').get(Number(id) || 0);
  if (!r) throw bad('Not found', 404);
  return { ok: true };
}

/** Makes each monthly bill whose day has come, once a month, from its first month on. Returns how many were made. */
export async function runRepeats(today = todayHere()) {
  let made = 0;
  for (const r of await db.prepare('SELECT * FROM expense_repeats WHERE active').all()) {
    let m = r.last_month ? nextMonth(r.last_month) : r.first_month;
    while (m <= month(today)) {
      const paid_on = `${m}-${String(r.day).padStart(2, '0')}`;
      if (paid_on > today) break;
      await tx(async () => {
        const e = await db.prepare(`INSERT INTO expenses (paid_on, vendor_name, vendor_list_id, pay_from, ref_no, memo, building_id, repeat_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (repeat_id, paid_on) DO NOTHING RETURNING id`)
          .get(paid_on, r.vendor_name, r.vendor_list_id, r.pay_from, r.ref_no, r.memo, r.building_id, r.id);
        if (e) {
          await db.prepare('INSERT INTO expense_lines (expense_id, account_list_id, amount, memo) VALUES (?, ?, ?, ?)').run(e.id, r.account_list_id, r.amount, r.memo);
          made++;
        }
        await db.prepare('UPDATE expense_repeats SET last_month = ? WHERE id = ?').run(m, r.id);
      });
      m = nextMonth(m);
    }
  }
  return made;
}

export function startRepeats() {
  const run = () => runRepeats().then((n) => n && console.log(`[expenses] ${n} monthly bill(s) made`)).catch((e) => console.error('[expenses]', e.message));
  run();
  return setInterval(run, 60 * 60_000);
}

// ---------- routes (the Accounts module) ----------

export const expenseRoutes = Router();
expenseRoutes.get('/choices', async (req, res) => res.json(await choices()));
expenseRoutes.get('/expenses', async (req, res) => res.json(await listExpenses(req.query)));
expenseRoutes.get('/expenses/:id', async (req, res) => res.json(await getExpense(req.params.id)));
expenseRoutes.get('/expenses/:id/file', async (req, res) => sendDoc(req, res, await db.prepare('SELECT file_path, file_name, file_mime FROM expenses WHERE id = ?').get(Number(req.params.id) || 0) || {}));
expenseRoutes.post('/expenses', upload.single('file'), async (req, res) => res.json(await createExpense(req.body, req.file, req.user.id)));
expenseRoutes.put('/expenses/:id', upload.single('file'), async (req, res) => res.json(await updateExpense(req.params.id, req.body, req.file)));
expenseRoutes.delete('/expenses/:id', requireMaster, async (req, res) => res.json(await removeExpense(req.params.id)));
expenseRoutes.post('/receipts/read', upload.single('file'), async (req, res) => res.json(await readReceipt(req.file)));
expenseRoutes.get('/repeats', async (req, res) => res.json(await listRepeats()));
expenseRoutes.post('/repeats', async (req, res) => res.json(await createRepeat(req.body, req.user.id)));
expenseRoutes.put('/repeats/:id', async (req, res) => res.json(await updateRepeat(req.params.id, req.body)));
expenseRoutes.delete('/repeats/:id', async (req, res) => res.json(await removeRepeat(req.params.id)));

