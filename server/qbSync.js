import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { db } from './db.js';
import { todayHere } from './leasingRegion.js';
import { depositState } from './leasing.js';

// Keeping QuickBooks in step with the app. The app is where things are recorded; QuickBooks
// gets the same entries, made the way the bookkeeper makes them (looked at in the company
// file on 2026-10-22: rent as bank deposits, money out as checks, nothing invoiced):
//
//   deposit:<day>      the rent and charges received that day: one Deposit into the bank,
//                      a line per income account (rent, late fees, other charges, deposits)
//   refund:<lease>     a security deposit given back: a Check out of the bank, from the
//                      account the deposits sit in
//   kept:<lease>       the part of a deposit kept at check-out, moved from the deposits
//                      account (when it is a liability) to income: a Journal Entry
//   expense:<id>       an expense recorded in Accounts: a Check, or a Credit Card Charge when
//                      it was paid by card
//
// Nothing is remembered as "to send". Each time the Web Connector calls, plan() works out what
// QuickBooks should have from the app as it is now, compares it with what was sent (qb_sync,
// by fingerprint) and queues what differs: new entries are added, changed ones changed (or,
// for a journal entry, taken out and made again), and ones gone from the app taken out of
// QuickBooks. A day's rent goes once the day is over, so it is sent whole. Nothing before the
// start date is sent: the bookkeeper's own entries up to then are left alone.

export const SETTINGS = ['start_date', 'bank_account', 'rent_account', 'deposit_account', 'late_account', 'charge_account', 'kept_account'];
const LIABILITY = new Set(['OtherCurrentLiability', 'LongTermLiability']);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
// QuickBooks' XML reader refuses the request outright on a character beyond plain ASCII
// (seen 2026-10-22 on a "·" in a memo), so anything else goes as a character reference.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[^\x09\x0A\x0D\x20-\x7E]/gu, (c) => `&#${c.codePointAt(0)};`);
const amt = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);
const fingerprint = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
const ref = (listId) => `<ListID>${esc(listId)}</ListID>`;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, isArray: (name) => name.endsWith('Ret') });

// ---------- the master's choices ----------

export async function settings() {
  const rows = await db.prepare('SELECT key, value FROM qb_settings').all();
  return Object.fromEntries(SETTINGS.map((k) => [k, rows.find((r) => r.key === k)?.value || '']));
}

const account = (listId) => db.prepare("SELECT list_id, full_name, type, active FROM qb_lists WHERE kind = 'Account' AND list_id = ?").get(String(listId));

/** Saves the keys given; an empty value clears one. Accounts must be in QuickBooks' list as last read. */
export async function saveSettings(body = {}) {
  for (const key of SETTINGS) {
    if (!(key in body)) continue;
    const value = String(body[key] ?? '').trim();
    if (value && key === 'start_date' && !isDate(value)) throw bad('The start date is not a date.');
    if (value && key !== 'start_date') {
      const a = await account(value);
      if (!a) throw bad('That account is not in QuickBooks\' list. Read the lists again.');
      if (key === 'bank_account' && a.type !== 'Bank') throw bad(`${a.full_name} is not a bank account.`);
    }
    if (value) await db.prepare('INSERT INTO qb_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value').run(key, value);
    else await db.prepare('DELETE FROM qb_settings WHERE key = ?').run(key);
  }
  return settings();
}

// ---------- what QuickBooks should have ----------

const lineLabel = { rent: 'Rent', deposit: 'Security deposits', late: 'Late fees', charge: 'Other charges' };

/** The day's rent and charges as one bank deposit, a line per income account. */
async function depositEntry(day, s) {
  const rows = await db.prepare(`SELECT p.amount, i.kind, i.held FROM lease_payments p JOIN lease_installments i ON i.id = p.installment_id
    WHERE p.received_on = ?`).all(day);
  const lines = new Map();
  for (const r of rows) {
    const group = r.kind === 'deposit' || r.held ? 'deposit' : r.kind === 'late' ? 'late' : r.kind === 'fee' || r.kind === 'charge' ? 'charge' : 'rent';
    const acct = (group === 'deposit' && s.deposit_account) || (group === 'late' && (s.late_account || s.charge_account)) || (group === 'charge' && s.charge_account) || s.rent_account;
    const at = lines.get(acct) || { account: acct, labels: new Set(), amount: 0 };
    at.labels.add(lineLabel[group]);
    at.amount += Number(r.amount);
    lines.set(acct, at);
  }
  const list = [...lines.values()].filter((l) => Math.round(l.amount * 100) > 0)
    .map((l) => ({ account: l.account, memo: [...l.labels].join(', '), amount: amt(l.amount) }))
    .sort((a, b) => a.account.localeCompare(b.account));
  if (!list.length) return null;
  const memo = `Lease app: rent and charges received ${day}`;
  const head = `<TxnDate>${day}</TxnDate><DepositToAccountRef>${ref(s.bank_account)}</DepositToAccountRef><Memo>${esc(memo)}</Memo>`;
  return {
    type: 'Deposit',
    hash: fingerprint(['Deposit', day, s.bank_account, list]),
    add: () => `<DepositAdd>${head}${list.map((l) => `<DepositLineAdd><AccountRef>${ref(l.account)}</AccountRef><Memo>${esc(l.memo)}</Memo><Amount>${l.amount}</Amount></DepositLineAdd>`).join('')}</DepositAdd>`,
    mod: (txnId, seq) => `<DepositMod><TxnID>${esc(txnId)}</TxnID><EditSequence>${esc(seq)}</EditSequence>${head}${list.map((l) => `<DepositLineMod><TxnLineID>-1</TxnLineID><AccountRef>${ref(l.account)}</AccountRef><Memo>${esc(l.memo)}</Memo><Amount>${l.amount}</Amount></DepositLineMod>`).join('')}</DepositMod>`,
  };
}

const leaseOf = (id) => db.prepare(`SELECT b.id, b.deposit_refunded, to_char(b.deposit_settled_on, 'YYYY-MM-DD') AS settled, to_char(b.start_date, 'YYYY-MM-DD') AS start, t.full_name AS tenant
  FROM lease_bookings b LEFT JOIN lease_tenants t ON t.id = b.tenant_id WHERE b.id = ?`).get(Number(id));
const leaseRef = (b) => `LS-${b.start.slice(0, 4)}-${String(b.id).padStart(4, '0')}`;

/** A check out of the bank, from the given lines; `payee` a vendor's ListID (or none), `refNo` the check number. */
function checkEntry({ payFrom, payee, refNo, date, memo, lines, card = false }) {
  const type = card ? 'CreditCardCharge' : 'Check';
  const P = payee ? `<PayeeEntityRef>${ref(payee)}</PayeeEntityRef>` : '';
  const R = refNo ? `<RefNumber>${esc(refNo)}</RefNumber>` : '';
  const D = `<TxnDate>${date}</TxnDate>`;
  const M = memo ? `<Memo>${esc(memo)}</Memo>` : '';
  // The two take the same parts in a slightly different order.
  const head = card ? `<AccountRef>${ref(payFrom)}</AccountRef>${P}${D}${R}${M}` : `<AccountRef>${ref(payFrom)}</AccountRef>${P}${R}${D}${M}`;
  const line = (l, mod) => `<ExpenseLine${mod ? 'Mod' : 'Add'}>${mod ? '<TxnLineID>-1</TxnLineID>' : ''}<AccountRef>${ref(l.account)}</AccountRef><Amount>${amt(l.amount)}</Amount>${l.memo ? `<Memo>${esc(l.memo)}</Memo>` : ''}</ExpenseLine${mod ? 'Mod' : 'Add'}>`;
  return {
    type,
    hash: fingerprint([type, payFrom, payee, refNo, date, memo, lines.map((l) => [l.account, amt(l.amount), l.memo || ''])]),
    add: () => `<${type}Add>${head}${lines.map((l) => line(l, false)).join('')}</${type}Add>`,
    mod: (txnId, seq) => `<${type}Mod><TxnID>${esc(txnId)}</TxnID><EditSequence>${esc(seq)}</EditSequence>${head}${lines.map((l) => line(l, true)).join('')}</${type}Mod>`,
  };
}

async function refundEntry(id, s) {
  const b = await leaseOf(id);
  if (!b || !s.deposit_account || !b.settled || !(Number(b.deposit_refunded) > 0)) return null;
  const memo = `Lease app: security deposit refund, ${leaseRef(b)}${b.tenant ? `, ${b.tenant}` : ''}`;
  return checkEntry({ payFrom: s.bank_account, date: b.settled, memo, lines: [{ account: s.deposit_account, amount: b.deposit_refunded, memo: 'Security deposit refund' }] });
}

async function keptEntry(id, s) {
  if (!s.deposit_account || !s.kept_account) return null;
  if (!LIABILITY.has((await account(s.deposit_account))?.type)) return null; // deposits booked as income are income already
  const b = await leaseOf(id);
  if (!b?.settled || b.deposit_refunded == null) return null;
  const kept = Math.round(((await depositState(b.id)).held - Number(b.deposit_refunded)) * 100) / 100;
  if (!(kept > 0)) return null;
  const memo = `Lease app: security deposit kept, ${leaseRef(b)}${b.tenant ? `, ${b.tenant}` : ''}`;
  const lines = `<JournalDebitLine><AccountRef>${ref(s.deposit_account)}</AccountRef><Amount>${amt(kept)}</Amount><Memo>${esc(memo)}</Memo></JournalDebitLine>`
    + `<JournalCreditLine><AccountRef>${ref(s.kept_account)}</AccountRef><Amount>${amt(kept)}</Amount><Memo>${esc(memo)}</Memo></JournalCreditLine>`;
  return {
    type: 'JournalEntry',
    hash: fingerprint(['JournalEntry', b.settled, s.deposit_account, s.kept_account, amt(kept)]),
    add: () => `<JournalEntryAdd><TxnDate>${b.settled}</TxnDate>${lines}</JournalEntryAdd>`,
    mod: null, // changed by taking it out and making it again
  };
}

async function expenseEntry(id) {
  const e = await db.prepare("SELECT *, to_char(paid_on, 'YYYY-MM-DD') AS paid FROM expenses WHERE id = ?").get(Number(id));
  if (!e) return null;
  if (!e.vendor_list_id) return { needsVendor: e.vendor_name };
  const lines = (await db.prepare('SELECT account_list_id AS account, amount, memo FROM expense_lines WHERE expense_id = ? ORDER BY id').all(e.id));
  if (!lines.length) return null;
  const card = (await account(e.pay_from))?.type === 'CreditCard';
  const memo = [e.memo, `Lease app expense #${e.id}`].filter(Boolean).join(' - ').slice(0, 4000);
  return checkEntry({ payFrom: e.pay_from, payee: e.vendor_list_id, refNo: e.ref_no, date: e.paid, memo, lines, card });
}

/** What one key should be in QuickBooks now; null when it should not be there. */
export async function entryFor(key, s, today = todayHere()) {
  const [kind, id] = String(key).split(/:(.*)/s);
  if (!s.start_date || !s.bank_account) return null;
  if (kind === 'deposit') return id >= s.start_date && id < today && s.rent_account ? depositEntry(id, s) : null;
  if (kind === 'refund' || kind === 'kept') {
    const b = await leaseOf(id);
    if (!b?.settled || b.settled < s.start_date || b.settled >= today) return null;
    return kind === 'refund' ? refundEntry(id, s) : keptEntry(id, s);
  }
  if (kind === 'expense') {
    const e = await db.prepare("SELECT to_char(paid_on, 'YYYY-MM-DD') AS paid FROM expenses WHERE id = ?").get(Number(id));
    return e && e.paid >= s.start_date && e.paid <= today ? expenseEntry(id) : null;
  }
  return null;
}

/** Every key the app could have in QuickBooks now, and every key it has there. */
async function allKeys(s, today) {
  const keys = new Set((await db.prepare('SELECT key FROM qb_sync').all()).map((r) => r.key));
  if (s.start_date && s.bank_account) {
    for (const r of await db.prepare("SELECT DISTINCT to_char(received_on, 'YYYY-MM-DD') AS d FROM lease_payments WHERE received_on >= ? AND received_on < ?").all(s.start_date, today)) keys.add(`deposit:${r.d}`);
    for (const r of await db.prepare('SELECT id FROM lease_bookings WHERE deposit_settled_on >= ? AND deposit_settled_on < ?').all(s.start_date, today)) { keys.add(`refund:${r.id}`); keys.add(`kept:${r.id}`); }
    for (const r of await db.prepare('SELECT id FROM expenses WHERE paid_on >= ? AND paid_on <= ?').all(s.start_date, today)) keys.add(`expense:${r.id}`);
  }
  return keys;
}

/** Queues every entry that QuickBooks does not have as the app has it now. Returns how many were queued. */
export async function plan(today = todayHere()) {
  const s = await settings();
  const sent = new Map((await db.prepare('SELECT key, hash FROM qb_sync').all()).map((r) => [r.key, r.hash]));
  const open = new Set((await db.prepare("SELECT what FROM qb_queue WHERE kind = 'sync' AND status IN ('waiting', 'sent', 'failed')").all()).map((r) => r.what));
  let queued = 0;
  for (const key of await allKeys(s, today)) {
    if (open.has(key)) continue;
    const want = await entryFor(key, s, today);
    const differs = want ? want.needsVendor || sent.get(key) !== want.hash : sent.has(key);
    if (!differs) continue;
    await db.prepare("INSERT INTO qb_queue (kind, what) VALUES ('sync', ?)").run(key);
    queued++;
  }
  return queued;
}

// ---------- the Web Connector's round ----------

/** The request for a queued key, as it should be now: { body, stage, hash }, or null when there is nothing to do. */
export async function syncRequest(item, today = todayHere()) {
  const s = await settings();
  const want = await entryFor(item.what, s, today);
  const had = await db.prepare('SELECT * FROM qb_sync WHERE key = ?').get(item.what);
  const rq = (name, inner) => `<${name}Rq requestID="${item.id}">${inner}</${name}Rq>`;
  const del = () => ({ body: rq('TxnDel', `<TxnDelType>${had.txn_type}</TxnDelType><TxnID>${esc(had.txn_id)}</TxnID>`), stage: 'del', hash: null });
  if (want?.needsVendor) {
    return { body: rq('VendorAdd', `<VendorAdd><Name>${esc(want.needsVendor.slice(0, 41))}</Name></VendorAdd>`), stage: 'vendor', hash: null };
  }
  if (want && !had) return { body: rq(`${want.type}Add`, want.add()), stage: 'add', hash: want.hash };
  if (want && had && had.hash === want.hash) return null;
  if (want && had && had.txn_type === want.type && want.mod) return { body: rq(`${want.type}Mod`, want.mod(had.txn_id, had.edit_seq)), stage: 'mod', hash: want.hash };
  if (had) return del(); // gone from the app, or changed in a way only a new entry can carry
  return null;
}

/** QuickBooks' answer to a sync request: what it made, changed or took out is written down. */
export async function syncApply(item, xml, today = todayHere()) {
  const msgs = parser.parse(String(xml || ''))?.QBXML?.QBXMLMsgsRs || {};
  const [name, rs] = Object.entries(msgs).find(([k]) => k.endsWith('Rs')) || [];
  if (!rs) throw new Error('QuickBooks sent an answer the app could not read.');
  const code = Number(rs.statusCode);
  const failed = rs.statusSeverity === 'Error' && code !== 0;
  const again = () => db.prepare("UPDATE qb_queue SET status = 'waiting', ticket = NULL, stage = NULL, sent_hash = NULL, error = NULL WHERE id = ?").run(item.id);
  const done = () => db.prepare("UPDATE qb_queue SET status = 'done', error = NULL, done_at = now() WHERE id = ?").run(item.id);

  if (item.stage === 'vendor') {
    if (failed) throw new Error(code === 3100 ? 'A vendor with this name is already in QuickBooks. Read the lists again on the QuickBooks screen, then try again.' : `QuickBooks said: ${rs.statusMessage} (${code})`);
    const v = rs.VendorRet?.[0];
    await db.prepare(`INSERT INTO qb_lists (kind, list_id, name, full_name, active) VALUES ('Vendor', ?, ?, ?, true)
      ON CONFLICT (kind, list_id) DO UPDATE SET name = EXCLUDED.name, full_name = EXCLUDED.full_name, seen_at = now()`).run(v.ListID, v.Name, v.FullName ?? v.Name);
    for (const t of ['expenses', 'expense_repeats']) await db.prepare(`UPDATE ${t} SET vendor_list_id = ? WHERE vendor_list_id IS NULL AND lower(vendor_name) = lower(?)`).run(v.ListID, v.Name);
    await again(); // now the expense itself
    return `vendor ${v.Name} made`;
  }
  if (item.stage === 'del') {
    if (failed && code !== 3120) throw new Error(`QuickBooks said: ${rs.statusMessage} (${code})`); // 3120: already gone from QuickBooks
    await db.prepare('DELETE FROM qb_sync WHERE key = ?').run(item.what);
    if (await entryFor(item.what, await settings(), today)) await again(); // to be made again as it is now
    else await done();
    return 'taken out';
  }
  if (failed) {
    if (code === 3200) throw new Error('It was changed in QuickBooks since the app sent it. Undo that change in QuickBooks, or delete the entry there, then try again.');
    throw new Error(`QuickBooks said: ${rs.statusMessage} (${code})`);
  }
  const type = name.replace(/(Add|Mod)Rs$/, '');
  const ret = rs[`${type}Ret`]?.[0];
  if (!ret?.TxnID) throw new Error('QuickBooks did not say what it made.');
  await db.prepare(`INSERT INTO qb_sync (key, txn_type, txn_id, edit_seq, hash, sent_at) VALUES (?, ?, ?, ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET txn_type = EXCLUDED.txn_type, txn_id = EXCLUDED.txn_id, edit_seq = EXCLUDED.edit_seq, hash = EXCLUDED.hash, sent_at = now()`)
    .run(item.what, type, ret.TxnID, ret.EditSequence ?? null, item.sent_hash);
  await done();
  return item.stage === 'mod' ? 'changed' : 'made';
}

/** Where each of these keys stands with QuickBooks: 'sent', 'waiting', 'failed' (with why), or 'not_sent'. */
export async function syncStates(keys) {
  if (!keys.length) return {};
  const s = await settings();
  const sent = new Map((await db.prepare('SELECT key, hash FROM qb_sync WHERE key = ANY(?)').all(keys)).map((r) => [r.key, r.hash]));
  const open = new Map((await db.prepare("SELECT what, status, error FROM qb_queue WHERE kind = 'sync' AND what = ANY(?) AND status IN ('waiting', 'sent', 'failed') ORDER BY id").all(keys)).map((r) => [r.what, r]));
  const out = {};
  for (const key of keys) {
    const q = open.get(key);
    if (q?.status === 'failed') { out[key] = { state: 'failed', error: q.error }; continue; }
    if (q) { out[key] = { state: 'waiting' }; continue; }
    const want = await entryFor(key, s);
    out[key] = { state: !want ? (sent.has(key) ? 'waiting' : 'not_sent') : sent.get(key) === want.hash ? 'sent' : 'waiting' };
  }
  return out;
}
