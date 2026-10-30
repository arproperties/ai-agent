import { Router } from 'express';
import { createHash } from 'node:crypto';
import { db, tx } from './db.js';
import { upload } from './properties.js';
import { todayHere } from './leasingRegion.js';
import { spreadWithin } from './leasing.js';
import { syncStates } from './qbSync.js';

// Rent paid online through Zego (gozego.com), brought in from Zego's payments report instead of
// being typed into each lease and then into QuickBooks by hand.
//
// The report (PDF, or the same as CSV) lists each payout Zego made into the bank ("#1468",
// its date, its total) and under it the tenants' payments it was made of (Trans #, resident,
// property, unit, the day they paid, card or bank, amount). Reading it changes nothing
// (readReport): each payment is matched to a lease by the tenant's name, and what cannot be
// matched is shown for a person to pick. Recording (recordReport) puts each payment on its
// lease as a Zego payment, spread as payBooking spreads money, under its Trans #, so a report
// uploaded twice records nothing twice. A name picked by hand is remembered for next time.
//
// Each payout goes to QuickBooks as one Deposit on the day Zego paid it, for its whole total
// (server/qbSync.js, key zego:<payout>), so it matches the bank statement line for line. Its
// payments are left out of the day's own deposit; a Zego payment typed in by hand is not.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const money = (n) => Math.round(Number(n) * 100) / 100;

// ---------- reading the report ----------

// The report's columns, by the words of their heading.
const HEADINGS = [
  ['bank', /^bank( account)?$/], ['date', /^(date|deposit date|payout date)$/], ['total', /^(total|deposit total|payout total)$/],
  ['trans', /^trans(action)? ?(#|no\.?|number|id)?$/], ['resident', /^(resident|tenant|name)$/], ['property', /^property$/],
  ['unit', /^unit$/], ['init', /^init(iated)?( date)?$/], ['type', /^(type|payment type)$/], ['bill', /^bill( type)?$/], ['amount', /^amount$/],
];
const headingOf = (s) => HEADINGS.find(([, re]) => re.test(String(s).trim().toLowerCase().replace(/\s+/g, ' ')))?.[0];

/** "$1,465.00" -> 1465; "($20.00)" or "-$20.00" -> -20; null when it is not an amount. */
export function amountOf(s) {
  const t = String(s ?? '').replace(/\s/g, '');
  const m = t.match(/^(\(|-)?\$?(-)?([\d,]+(?:\.\d{1,2})?)\)?$/);
  if (!m) return null;
  return money((m[1] || m[2] ? -1 : 1) * Number(m[3].replace(/,/g, '')));
}

/** "10-01-2026" or "10/01/2026" -> "2026-10-01"; "2026-10-01" stays. null when it is not a date. */
export function dateOf(s) {
  const t = String(s ?? '').replace(/\s/g, '');
  let m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  const iso = m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : (t.match(/^\d{4}-\d{2}-\d{2}$/) || [])[0];
  if (!iso || Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) return null;
  m = iso.split('-').map(Number);
  return new Date(Date.UTC(m[0], m[1] - 1, m[2])).toISOString().slice(0, 10) === iso ? iso : null;
}

/** The report's rows, from the PDF's text: each cell put in its column by where it sits under the headings. */
async function pdfRows(buffer) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  let cols = null; // [{ key, x }] by x
  const rows = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const items = (await (await pdf.getPage(n)).getTextContent()).items
      .filter((i) => i.str && i.str.trim()).map((i) => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5] }));
    let below = Infinity;
    if (!cols) {
      const anchor = items.find((i) => headingOf(i.s) === 'trans');
      if (!anchor) continue;
      const line = items.filter((i) => Math.abs(i.y - anchor.y) < 2 && headingOf(i.s));
      const seen = new Set();
      cols = line.sort((a, b) => a.x - b.x).map((i) => ({ key: headingOf(i.s), x: i.x }))
        .filter((c) => !seen.has(c.key) && seen.add(c.key));
      below = anchor.y - 2;
    }
    // A cell belongs to the column whose heading it is nearest to, between the headings' midpoints.
    const colOf = (x) => cols.reduce((best, c) => (Math.abs(c.x - x) < Math.abs(best.x - x) ? c : best)).key;
    const cells = items.filter((i) => i.y < below).map((i) => ({ ...i, key: colOf(i.x) }));
    // A row starts at a Trans # (a payment) or a bank account (a payout); its cells run down to the next row.
    const starts = cells.filter((c) => (c.key === 'trans' && /^\d{5,}$/.test(c.s)) || (c.key === 'bank' && /^#?\d+$/.test(c.s)))
      .sort((a, b) => b.y - a.y);
    starts.forEach((st, k) => {
      const next = starts[k + 1]?.y ?? -Infinity;
      const mine = cells.filter((c) => c.y <= st.y + 1 && c.y > next + 1).sort((a, b) => b.y - a.y || a.x - b.x);
      const row = {};
      for (const c of mine) row[c.key] = row[c.key] ? `${row[c.key]}${/-$/.test(row[c.key]) ? '' : ' '}${c.s}` : c.s;
      rows.push(row);
    });
  }
  if (!cols) throw bad('This does not look like a Zego payments report: it has no Trans # column.');
  return rows;
}

/** One CSV line's fields, quotes understood. */
function csvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** The report's rows, from a CSV with the report's headings. */
function csvRows(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const at = lines.findIndex((l) => csvLine(l).some((h) => headingOf(h) === 'trans'));
  if (at < 0) throw bad('This does not look like a Zego payments report: it has no Trans # column.');
  const keys = csvLine(lines[at]).map(headingOf);
  return lines.slice(at + 1).map((l) => {
    const row = {};
    csvLine(l).forEach((v, k) => { if (keys[k] && v) row[keys[k]] = v; });
    return row;
  });
}

/**
 * The payouts in the report's rows. As Zego prints it, a payout line (bank, date, total) comes
 * first and its payments under it; a CSV that puts the payout's date on every payment instead
 * is grouped by that date.
 */
export function payoutsFrom(rows) {
  const payouts = [];
  const byDate = new Map();
  let current = null;
  for (const r of rows) {
    if (!r.trans) {
      if (r.total == null && r.date == null) continue;
      const paid_on = dateOf(r.date);
      const total = amountOf(r.total);
      if (!paid_on || total == null) continue;
      current = { bank: r.bank || null, paid_on, total, transactions: [] };
      payouts.push(current);
      continue;
    }
    const t = {
      trans_no: String(r.trans).replace(/\s/g, ''), resident: String(r.resident || '').replace(/\s+/g, ' ').trim(),
      property: r.property ? String(r.property).replace(/\s+/g, ' ').trim() : null, unit: r.unit || null,
      init_date: dateOf(r.init), pay_type: r.type ? String(r.type).replace(/\s+/g, ' ') : null, amount: amountOf(r.amount),
    };
    if (!t.init_date || t.amount == null || !t.resident) throw bad(`Trans # ${t.trans_no} could not be read: it needs a resident, a date and an amount.`);
    let p = current;
    if (r.date) { // the payout's date on the payment itself
      const paid_on = dateOf(r.date);
      const key = `${r.bank || ''}|${paid_on}`;
      p = byDate.get(key);
      if (!p) { p = { bank: r.bank || null, paid_on, total: null, transactions: [] }; byDate.set(key, p); payouts.push(p); }
    }
    if (!p) throw bad(`Trans # ${t.trans_no} is not under a payout (bank, date and total).`);
    p.transactions.push(t);
  }
  for (const p of payouts) {
    const sum = money(p.transactions.reduce((s, t) => s + t.amount, 0));
    if (p.total == null) p.total = sum;
    if (sum !== p.total) p.warning = `Its payments add up to ${sum.toFixed(2)}, not the ${p.total.toFixed(2)} Zego paid.`;
  }
  const all = payouts.flatMap((p) => p.transactions.map((t) => t.trans_no));
  const twice = all.find((t, k) => all.indexOf(t) !== k);
  if (twice) throw bad(`Trans # ${twice} is in the report twice.`);
  if (!payouts.some((p) => p.transactions.length)) throw bad('No payments found in this report.');
  return payouts.filter((p) => p.transactions.length);
}

/** The payouts in a report file: a PDF as Zego prints it, or a CSV. */
export async function parseReport(file) {
  if (!file?.buffer?.length) throw bad('Choose the Zego report (PDF or CSV).');
  const pdf = file.buffer.subarray(0, 5).toString() === '%PDF-';
  const csv = /\.csv$/i.test(file.originalname || '') || /csv|text\/plain/.test(file.mimetype || '');
  if (!pdf && !csv) throw bad('The Zego report has to be a PDF or a CSV.');
  return payoutsFrom(pdf ? await pdfRows(file.buffer) : csvRows(file.buffer.toString('utf8')));
}

// ---------- matching a name to a lease ----------

// Words staff add to a name in Zego that are not part of it ("Crystal HUD Charles", "Kayle Irving MTM",
// "Lennord SEE NOTE Randall").
const NOISE = new Set(['hud', 'mtm', 'see', 'note']);
/** A name as a key: lower case, letters only, the noise words left out. */
export const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w && !NOISE.has(w)).join(' ');
const sortedKey = (s) => nameKey(s).split(' ').sort().join(' ');

const LEASES = `SELECT b.id, b.tenant_id, t.full_name AS tenant, u.unit_no, bl.name AS building,
    to_char(b.start_date, 'YYYY-MM-DD') AS start_date, to_char(b.end_date, 'YYYY-MM-DD') AS end_date, b.no_payments
  FROM lease_bookings b JOIN lease_tenants t ON t.id = b.tenant_id JOIN prop_units u ON u.id = b.unit_id JOIN prop_buildings bl ON bl.id = u.building_id
  WHERE b.status = 'confirmed'`;

/** Every confirmed lease, for a person to pick from. */
export const leaseChoices = () => db.prepare(`${LEASES} ORDER BY lower(t.full_name), b.start_date DESC`).all();

/** The tenant's lease on the day they paid: the one running then, else the nearest before it, else the next one. */
function leaseOn(leases, day) {
  const running = leases.filter((l) => l.start_date <= day && day <= l.end_date);
  if (running.length) return running.length === 1 ? running[0] : null; // two units at once: a person says which
  const before = leases.filter((l) => l.start_date <= day).sort((a, b) => b.start_date.localeCompare(a.start_date));
  return before[0] || leases.sort((a, b) => a.start_date.localeCompare(b.start_date))[0] || null;
}

/** A payment of the same amount already on the lease within five days, not from a Zego report: likely this one, typed in by hand. */
async function sameOnLease(bookingId, t) {
  const r = await db.prepare(`SELECT to_char(min(p.received_on), 'YYYY-MM-DD') AS received_on, sum(p.amount) AS amount, min(p.method) AS method
    FROM lease_payments p JOIN lease_installments i ON i.id = p.installment_id
    WHERE i.booking_id = ? AND p.received_on BETWEEN ?::date - 5 AND ?::date + 5 AND NOT EXISTS (SELECT 1 FROM zego_transactions z WHERE z.batch = p.batch)
    GROUP BY coalesce(p.batch, p.id::text) HAVING sum(p.amount) = ? LIMIT 1`).get(bookingId, t.init_date, t.init_date, t.amount);
  return r ? { ...r, amount: Number(r.amount) } : null;
}

/** For each payment: the lease it goes to and how that was found, or the leases to choose from. */
async function match(payouts) {
  const leases = await leaseChoices();
  const tenants = await db.prepare('SELECT id, full_name, old_name FROM lease_tenants').all();
  const names = new Map((await db.prepare('SELECT name_key, tenant_id FROM zego_names').all()).map((r) => [r.name_key, r.tenant_id]));
  const byKey = (fn) => {
    const m = new Map();
    for (const t of tenants) for (const n of [t.full_name, t.old_name]) {
      const k = n && fn(n);
      if (k) m.set(k, [...new Set([...(m.get(k) || []), t.id])]);
    }
    return m;
  };
  const exact = byKey(nameKey);
  const loose = byKey(sortedKey);
  const done = new Map((await db.prepare('SELECT trans_no, booking_id, batch FROM zego_transactions WHERE trans_no = ANY(?)')
    .all(payouts.flatMap((p) => p.transactions.map((t) => t.trans_no)))).map((r) => [r.trans_no, r]));
  for (const p of payouts) for (const t of p.transactions) {
    const had = done.get(t.trans_no);
    if (had?.batch) { Object.assign(t, { recorded: true, booking_id: had.booking_id }); continue; }
    const key = nameKey(t.resident);
    let ids = names.has(key) ? [names.get(key)] : null;
    let how = ids ? 'remembered' : 'name';
    if (!ids) ids = exact.get(key) || loose.get(sortedKey(t.resident)) || [];
    const mine = leases.filter((l) => ids.includes(l.tenant_id));
    const lease = ids.length === 1 ? leaseOn(mine, t.init_date) : null;
    if (lease) {
      Object.assign(t, { booking_id: lease.id, how, duplicate: await sameOnLease(lease.id, t) });
      if (t.duplicate) t.booking_id = null; // a person decides: it may have been typed in by hand already
      t.suggest = [lease.id];
    } else if (ids.length === 1 && !mine.length) {
      Object.assign(t, { booking_id: null, how: null, no_lease: tenants.find((x) => x.id === ids[0]).full_name, suggest: [] });
    } else {
      // Nothing sure: the leases of the tenants it could be, or of anyone with a word of the name in common.
      const words = new Set(key.split(' ').filter((w) => w.length > 2));
      const near = mine.length ? mine : leases.filter((l) => nameKey(l.tenant).split(' ').some((w) => words.has(w)));
      Object.assign(t, { booking_id: null, how: null, suggest: near.slice(0, 8).map((l) => l.id) });
    }
  }
  return payouts;
}

// A report read is kept for an hour under its fingerprint, so "Record" records exactly what was shown.
const reads = new Map();
const KEEP = 60 * 60_000;

/** What the report holds and where each payment would go. Changes nothing. */
export async function readReport(file) {
  const payouts = await parseReport(file);
  const token = createHash('sha256').update(file.buffer).digest('hex');
  for (const [k, v] of reads) if (Date.now() - v.at >= KEEP) reads.delete(k);
  reads.set(token, { at: Date.now(), payouts: structuredClone(payouts), file_name: String(file.originalname || '').slice(0, 200) || null });
  await match(payouts);
  return { token, payouts, leases: await leaseChoices() };
}

// ---------- recording ----------

/**
 * Records the report read under `token`. `picks` gives a lease for a payment by its Trans #
 * (overriding the match), or null to leave it on no lease. Each payment is recorded on its own:
 * one that cannot be (the lease takes no payments, say) is reported and left for later.
 */
export async function recordReport({ token, picks = {} } = {}, by, today = todayHere()) {
  const kept = reads.get(String(token || ''));
  if (!kept) throw bad('Upload the report again: it was read more than an hour ago.', 409);
  const payouts = await match(structuredClone(kept.payouts));
  const out = { recorded: 0, already: 0, skipped: 0, failed: [] };
  const leaseOf = new Map((await leaseChoices()).map((l) => [l.id, l]));
  for (const p of payouts) {
    // The same payout uploaded before is the one already there.
    const nos = p.transactions.map((t) => t.trans_no);
    const had = await db.prepare('SELECT payout_id FROM zego_transactions WHERE trans_no = ANY(?) LIMIT 1').get(nos);
    const payoutId = had?.payout_id ?? (await db.prepare('INSERT INTO zego_payouts (bank, paid_on, total, file_name, uploaded_by) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .get(p.bank, p.paid_on, p.total, kept.file_name, by ?? null)).id;
    for (const t of p.transactions) {
      if (t.recorded) { out.already++; continue; }
      const picked = Object.hasOwn(picks, t.trans_no) ? (picks[t.trans_no] == null || picks[t.trans_no] === '' ? null : Number(picks[t.trans_no])) : t.booking_id;
      if (picked != null && !leaseOf.has(picked)) throw bad(`The lease chosen for Trans # ${t.trans_no} is not a confirmed lease.`);
      const row = [t.trans_no, payoutId, t.resident, t.property, t.unit, t.init_date, t.pay_type, t.amount];
      const save = (bookingId, batch) => db.prepare(`INSERT INTO zego_transactions (trans_no, payout_id, resident, property, unit, init_date, pay_type, amount, booking_id, batch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (trans_no) DO UPDATE SET booking_id = EXCLUDED.booking_id, batch = EXCLUDED.batch
        WHERE zego_transactions.batch IS NULL RETURNING trans_no`).get(...row, bookingId, batch);
      if (picked == null) { await save(null, null); out.skipped++; continue; }
      try {
        const done = await tx(async () => {
          // Taken first, so two uploads at once cannot both record it.
          if (!(await save(picked, 'pending'))) return false;
          const made = await spreadWithin(picked, {
            amount: t.amount, method: 'zego', received_on: t.init_date, keep_credit: true,
            reference: `Zego ${t.trans_no}`, notes: `Zego payout ${p.paid_on}${t.pay_type ? ` · ${t.pay_type}` : ''}`,
          }, by, today);
          await db.prepare('UPDATE zego_transactions SET batch = ? WHERE trans_no = ?').run(made[0].batch, t.trans_no);
          // A name that is not the tenant's own is remembered for the next report.
          const tenantId = leaseOf.get(picked).tenant_id;
          if (nameKey(t.resident) !== nameKey(leaseOf.get(picked).tenant)) {
            await db.prepare('INSERT INTO zego_names (name_key, tenant_id) VALUES (?, ?) ON CONFLICT (name_key) DO UPDATE SET tenant_id = EXCLUDED.tenant_id').run(nameKey(t.resident), tenantId);
          }
          return true;
        });
        if (done) out.recorded++; else out.already++;
      } catch (e) {
        if (!e.status) throw e;
        await save(null, null);
        out.failed.push({ trans_no: t.trans_no, resident: t.resident, error: e.message });
      }
    }
  }
  return out;
}

// ---------- what was brought in ----------

/** The payouts brought in, newest first, with where each stands with QuickBooks. */
export async function listPayouts({ limit = 100 } = {}) {
  const rows = await db.prepare(`SELECT p.id, p.bank, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.total, p.file_name, p.created_at, w.name AS uploaded_by,
      count(t.*)::int AS payments, count(t.batch)::int AS on_leases
    FROM zego_payouts p LEFT JOIN zego_transactions t ON t.payout_id = p.id LEFT JOIN users w ON w.id = p.uploaded_by
    GROUP BY p.id, w.name ORDER BY p.paid_on DESC, p.id DESC LIMIT ?`).all(Math.min(500, Number(limit) || 100));
  const states = await syncStates(rows.map((r) => `zego:${r.id}`));
  return rows.map((r) => ({ ...r, total: Number(r.total), quickbooks: states[`zego:${r.id}`] }));
}

/** One payout's payments, and the lease each went to. */
export async function getPayout(id) {
  const p = (await listPayouts({ limit: 500 })).find((r) => r.id === Number(id));
  if (!p) throw bad('Not found', 404);
  const transactions = (await db.prepare(`SELECT t.trans_no, t.resident, t.property, t.unit, to_char(t.init_date, 'YYYY-MM-DD') AS init_date, t.pay_type, t.amount,
      t.booking_id, (t.batch IS NOT NULL) AS on_lease, lt.full_name AS tenant, u.unit_no, bl.name AS building
    FROM zego_transactions t LEFT JOIN lease_bookings b ON b.id = t.booking_id AND t.batch IS NOT NULL LEFT JOIN lease_tenants lt ON lt.id = b.tenant_id
    LEFT JOIN prop_units u ON u.id = b.unit_id LEFT JOIN prop_buildings bl ON bl.id = u.building_id
    WHERE t.payout_id = ? ORDER BY t.init_date, t.trans_no`).all(p.id)).map((t) => ({ ...t, amount: Number(t.amount) }));
  return { ...p, transactions };
}

// ---------- routes (under the Accounts module) ----------

export const zegoRoutes = Router();
zegoRoutes.post('/read', upload.single('file'), async (req, res) => res.json(await readReport(req.file)));
zegoRoutes.post('/record', async (req, res) => res.json(await recordReport(req.body, req.user.id)));
zegoRoutes.get('/leases', async (req, res) => res.json(await leaseChoices()));
zegoRoutes.get('/payouts', async (req, res) => res.json(await listPayouts(req.query)));
zegoRoutes.get('/payouts/:id', async (req, res) => res.json(await getPayout(req.params.id)));
