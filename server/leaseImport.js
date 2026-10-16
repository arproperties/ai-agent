import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { db } from './db.js';
import { listTenants, listBookings, importBooking, todayHere } from './leasing.js';
import { readFiles, untag } from './tenantImport.js';

// Bringing in the leases from Rent Manager (the old software): its "Rent Roll Analysis" report,
// one row per unit with the tenant, the rent, the move-in date and the lease end. Claude only
// copies the rows out; the rules are here. Each row is matched to a unit by its number and to a
// tenant already on file (the tenant list is imported first), and nothing is saved until the rows
// have been looked at and ticked. Deposits and other charges are not in the report: staff add
// them on each lease by hand.
//
// An imported lease is confirmed at once: the tenant is already living there, so there is no
// move-in inspection and no documents are asked for. Its rent is asked for from the first of next
// month (BILLED_FROM): what fell due before was billed in Rent Manager.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------- reading the files ----------

const PROMPT = `This is a rent roll from property management software (such as Rent Manager's "Rent Roll Analysis"). For every unit row, copy the Unit cell, the Tenant Name cell, the Rent (not the Market Rent), the Move In date and the Lease End date exactly as written: keep tags such as AIRBNB, WDR, WDC*, HUD, MTM, (Legacy), *SEE NOTE* and <VACANT> where they are. Where a cell is empty, give "".
Reply with one JSON object and nothing else: {"rows":[["unit","tenant","rent","move_in","lease_end"], ...]}
Leave out column headings, page headers and footers, property headings, totals and the report summary. If this is not a rent roll, reply {"rows":[]}.`;

const STR = '"((?:[^"\\\\]|\\\\.)*)"';
const ROW = new RegExp(`\\[\\s*${STR}\\s*,\\s*${STR}\\s*,\\s*${STR}\\s*,\\s*${STR}\\s*,\\s*${STR}\\s*\\]`, 'g');
const unquote = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The rows out of the reader's reply, one array at a time, so a reply cut short still gives every row before the cut. */
export function parseRollRows(reply) {
  return [...String(reply).matchAll(ROW)]
    .map(([, unit, tenant, rent, moveIn, end]) => ({ unit: squash(unquote(unit)), tenant: squash(unquote(tenant)), rent: squash(unquote(rent)), move_in: squash(unquote(moveIn)), lease_end: squash(unquote(end)) }))
    .filter((r) => r.unit || r.tenant);
}

export const readRollFiles = (files, opts = {}) => readFiles(files, { prompt: PROMPT, parse: parseRollRows, log: 'lease-import', ...opts });

// ---------- dates and money ----------

/** 8/17/26, 08/01/2026 or 2026-08-17 as 2026-08-17; '' when it is not a date. */
export function usDate(s) {
  const v = squash(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return '';
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2])));
  if (d.getUTCMonth() !== Number(m[1]) - 1) return '';
  return d.toISOString().slice(0, 10);
}
/** The last day of the date's month: a lease here always ends at a month's end. */
export const monthEnd = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7), 0)).toISOString().slice(0, 10);
/** The first of the month after today's. */
export const BILLED_FROM = (today = todayHere()) => new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 1)).toISOString().slice(0, 10);
const amount = (s) => { const n = Number(String(s ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const us = (iso) => (iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}/${iso.slice(2, 4)}` : '');

// ---------- matching a row ----------

const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 1);
/** The unit numbers a tenant's notes give from the tenant import ("Unit in Rent Manager: GSL 312 WDC."). */
const notedUnits = (notes) => (String(notes ?? '').match(/Unit in Rent Manager: ([^.]*)\./)?.[1] ?? '').split(',').map((u) => u.match(/\d+/)?.[0]).filter(Boolean);

/** "Last, First" as First Last, with Rent Manager's tags (HUD, MTM, (Legacy)…) taken out and kept. */
export function rollName(cell) {
  const raw = squash(cell);
  const [last, ...rest] = raw.split(',');
  const parts = [untag(rest.join(',')), untag(last)];
  return { name: squash(parts.map((p) => p.name).join(' ')), tags: parts.flatMap((p) => p.tags), marks: parts.flatMap((p) => p.marks) };
}

/** The tenant on file for this row: by name, else by the unit kept in the notes when a part of the name agrees. */
function findTenant(name, unitNo, tenants) {
  const k = key(name);
  const reversed = key(name.split(' ').reverse().join(' '));
  const byName = tenants.filter((t) => key(t.full_name) === k || key(t.full_name) === reversed);
  const inUnit = tenants.filter((t) => notedUnits(t.notes).includes(unitNo));
  if (byName.length === 1) return { tenant: byName[0] };
  if (byName.length > 1) {
    const both = byName.filter((t) => inUnit.includes(t));
    return both.length === 1 ? { tenant: both[0] } : { reason: `${byName.length} tenants on file are called ${name}` };
  }
  const near = inUnit.filter((t) => words(t.full_name).some((w) => words(name).includes(w)));
  if (near.length === 1) return { tenant: near[0], reason: near[0].full_name.toLowerCase() === name.toLowerCase() ? null : `On file as ${near[0].full_name}` };
  return { reason: `No tenant called ${name} is on file. Import the tenant list first, or add the tenant` };
}

/**
 * The preview. Each row: the unit and tenant it matches, the terms (start = move-in, end = the
 * month's end of the lease end), and its status: new (ticked), check (something to look at,
 * unticked), exists (already imported, or the unit is leased for those dates), missing (no such
 * unit or tenant here) or skip (vacant).
 */
export function planLeases(rows, { units = [], tenants = [], leases = [], today = todayHere() } = {}) {
  const unitsByNo = new Map();
  for (const u of units) unitsByNo.set(String(u.unit_no).trim(), [...(unitsByNo.get(String(u.unit_no).trim()) || []), u]);
  const seen = new Set();
  return rows.map((r, i) => {
    // The unit's tags (AIRBNB, WDR, WDC*…) sometimes come in the tenant cell when the unit cell runs into it.
    const unitTags = (`${r.unit} ${r.tenant}`.match(/\b(airbnb|wd[a-z])\b\*?/gi) || []).map((t) => t.toUpperCase());
    const unitNo = r.unit.match(/\d+/)?.[0] ?? '';
    const base = { i, unit_cell: r.unit, tenant_cell: r.tenant, unit_no: unitNo };
    if (/vacant/i.test(r.tenant) || !r.tenant) return { ...base, status: 'skip', pick: false, reasons: ['Vacant'], name: '', tags: unitTags };
    const { name, tags, marks } = rollName(r.tenant.replace(/\bairbnb\b/gi, ' '));
    const allTags = [...new Set([...unitTags, ...tags, ...(/airbnb/i.test(r.tenant) ? ['AIRBNB'] : [])])];
    const start = usDate(r.move_in);
    const written = usDate(r.lease_end);
    const end = written && monthEnd(written);
    const rent = amount(r.rent);
    const reasons = marks.map((m) => `Rent Manager marks it "${m}"`);
    const missing = [];

    const here = unitsByNo.get(unitNo) || [];
    const unit = here.length === 1 ? here[0] : null;
    if (!unitNo || !here.length) missing.push(`No unit ${unitNo || r.unit} here`);
    else if (here.length > 1) missing.push(`Unit ${unitNo} is in more than one building`);
    const found = name ? findTenant(name, unitNo, tenants) : { reason: 'No tenant name' };
    if (!found.tenant) missing.push(found.reason);
    else if (found.reason) reasons.push(found.reason);

    if (!start) missing.push('No move-in date');
    if (!written) missing.push('No lease end');
    if (start && end && end < start) reasons.push(`The lease end (${r.lease_end}) is before the move-in. Fix the end date`);
    if (end && end < today) reasons.push(`The lease ended on ${us(end)} in Rent Manager: the tenant may be month to month`);
    if (!(rent > 0)) reasons.push('No rent in Rent Manager. Type the rent to import it');

    let status = missing.length ? 'missing' : reasons.length ? 'check' : 'new';
    const pair = unit && found.tenant ? `${unit.id}:${found.tenant.id}` : null;
    if (unit && start && end) {
      const twice = pair && seen.has(pair);
      const already = leases.find((b) => b.unit_id === unit.id && b.status !== 'cancelled' && ((b.import_batch && b.tenant_id === found.tenant?.id) || (b.status === 'confirmed' && b.start_date <= end && b.end_date >= start)));
      if (twice) { status = 'exists'; reasons.unshift('This unit and tenant are on an earlier row'); }
      else if (already) { status = 'exists'; reasons.unshift(`Unit ${unit.unit_no} is already leased to ${already.tenant}, ${us(already.start_date)} to ${us(already.end_date)}`); }
    }
    if (pair) seen.add(pair);
    const notes = [`Imported from Rent Manager: ${r.unit}, ${r.tenant}.`, written && end !== written && `Lease end there: ${r.lease_end}.`, allTags.length && `Rent Manager: ${allTags.join(', ')}.`]
      .filter(Boolean).join(' ');
    return {
      ...base, name, tags: allTags, unit_id: unit?.id ?? null, building: unit?.building ?? null, tenant_id: found.tenant?.id ?? null, tenant: found.tenant?.full_name ?? null,
      start_date: start, end_date: end, end_written: r.lease_end, rent, notes, reasons: [...missing, ...reasons], status, pick: status === 'new',
    };
  });
}

/** What the preview is matched against: the units with their building, the tenants, the leases. */
export async function matchData() {
  const units = await db.prepare('SELECT u.id, u.unit_no, bl.name AS building FROM prop_units u JOIN prop_buildings bl ON bl.id = u.building_id').all();
  return { units, tenants: await listTenants(), leases: await listBookings() };
}

// ---------- saving ----------

/**
 * The ticked rows saved as confirmed leases, all under one batch so they can be undone together.
 * Each lease is saved on its own: one that cannot be (the unit is taken, the rent is missing) is
 * reported back with the reason, and the others are still saved.
 */
export async function importLeases(rows, by, today = todayHere()) {
  if (!Array.isArray(rows) || !rows.length) throw bad('Tick the leases to import.');
  if (rows.length > 2000) throw bad('That is more leases than one import takes.');
  const batch = randomUUID();
  const billedFrom = BILLED_FROM(today);
  const failed = [];
  let added = 0;
  let skipped = 0;
  for (const r of rows) {
    const label = `Unit ${r.unit_no || '?'}${r.name ? ` (${r.name})` : ''}`;
    if (!r.unit_id || !r.tenant_id) { failed.push({ i: r.i ?? null, unit: label, reason: 'No unit or tenant to put the lease on.' }); continue; }
    const done = await db.prepare("SELECT 1 FROM lease_bookings WHERE unit_id = ? AND tenant_id = ? AND import_batch IS NOT NULL AND status <> 'cancelled'").get(Number(r.unit_id), Number(r.tenant_id));
    if (done) { skipped += 1; continue; }
    try {
      await importBooking({
        unit_id: r.unit_id, tenant_id: r.tenant_id, start_date: r.start_date, end_date: r.end_date, rent_amount: r.rent,
        rent_period: 'month', payment_frequency: 'monthly', notes: String(r.notes ?? '').slice(0, 2000),
      }, by, { batch, billedFrom });
      added += 1;
    } catch (e) {
      if (!e.status) throw e;
      failed.push({ i: r.i ?? null, unit: label, reason: e.message });
    }
  }
  return { batch, added, skipped, failed, billed_from: billedFrom };
}

/** One import taken back: its leases deleted, except any that have a payment, a document or an inspection by now. */
export async function undoLeaseImport(batch) {
  if (!batch) throw bad('Which import?');
  const r = await db.prepare(`DELETE FROM lease_bookings b WHERE b.import_batch = ?
    AND NOT EXISTS (SELECT 1 FROM lease_payments p JOIN lease_installments i ON i.id = p.installment_id WHERE i.booking_id = b.id)
    AND NOT EXISTS (SELECT 1 FROM lease_documents d WHERE d.booking_id = b.id)
    AND NOT EXISTS (SELECT 1 FROM prop_inspections i WHERE i.booking_id = b.id)`).run(String(batch));
  const { n } = await db.prepare('SELECT count(*)::int AS n FROM lease_bookings WHERE import_batch = ?').get(String(batch));
  return { removed: r.changes, kept: n };
}

// ---------- the reading, as a job the page asks after ----------

const jobs = new Map();
const KEEP_MS = 30 * 60 * 1000;

export function startRollReading(files, by) {
  if (!files?.length) throw bad("Choose the Rent Roll Analysis PDF.");
  for (const [id, j] of jobs) if (Date.now() - j.at > KEEP_MS) jobs.delete(id);
  const id = randomUUID();
  const job = { by, at: Date.now(), done: 0, total: files.length, finished: false };
  jobs.set(id, job);
  readRollFiles(files, { onProgress: (d) => { job.done = d; } })
    .then(async ({ rows, failed }) => Object.assign(job, { rows: planLeases(rows, { ...(await matchData()) }), failed, billed_from: BILLED_FROM() }))
    .catch((e) => { console.error('[lease-import]', e.message); job.error = 'The files could not be read. Try again.'; })
    .finally(() => { job.finished = true; });
  return { id };
}

export function rollReadingStatus(id, by) {
  const j = jobs.get(id);
  if (!j || j.by !== by) throw bad('That reading is no longer here. Upload the file again.', 404);
  return { done: j.done, total: j.total, finished: j.finished, error: j.error, failed: j.failed, billed_from: j.billed_from, rows: j.finished ? j.rows : undefined };
}

// ---------- routes, under /api/leasing/bookings/import ----------

export const leaseImportRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const files = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } }).array('files', 10);

leaseImportRoutes.post('/read', files, wrap(async (req, res) => res.json(startRollReading(req.files, req.user.id))));
leaseImportRoutes.get('/read/:id', wrap(async (req, res) => res.json(rollReadingStatus(req.params.id, req.user.id))));
leaseImportRoutes.post('/', wrap(async (req, res) => res.json(await importLeases(req.body?.rows, req.user.id))));
leaseImportRoutes.delete('/:batch', wrap(async (req, res) => res.json(await undoLeaseImport(req.params.batch))));
