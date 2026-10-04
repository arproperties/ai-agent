import { Router } from 'express';
import { db, tx } from './db.js';
import { requireMaster } from './auth.js';
import { create } from './properties.js';
import { makeBooking, takePayment, bookingPayments, isDate, bad, todayHere } from './leasing.js';

// Bringing the office's existing spreadsheet in: one row per tenancy, with the company,
// building and unit it is in, the tenant, the dates and rent, and how much rent has already
// been received. Anything not there yet (company, building, unit, tenant) is created.
//
// It is all or nothing. Every row is tried inside one transaction; if any row fails, or
// this is only the check before importing, the whole thing is undone and each row says
// what is wrong with it. So a sheet can be checked as often as needed, and a half-imported
// sheet cannot happen.

export const IMPORT_COLUMNS = ['company', 'building', 'unit_no', 'tenant_name', 'phone', 'email', 'emirates_id_no', 'start_date', 'end_date',
  'rent_amount', 'rent_period', 'payment_frequency', 'security_deposit', 'contract_no', 'rent_paid_so_far'];
const FREQ = { monthly: 'monthly', quarterly: 'quarterly', 'every 3 months': 'quarterly', every_6_months: 'every_6_months', 'every 6 months': 'every_6_months',
  yearly: 'yearly', annually: 'yearly', upfront: 'upfront', 'all upfront': 'upfront' };
const UNDO = Symbol('undo');

const str = (v) => String(v ?? '').trim();
const amount = (v, name) => {
  const n = Number(str(v).replace(/[^\d.-]/g, '')); // "AED 4,500" and "$4,500" are both 4500
  if (!Number.isFinite(n) || n < 0) throw bad(`${name} is not a number.`);
  return n;
};
/** 2026-11-01, or the way Excel writes it here: 01/11/2026 (day first). */
function date(v, name) {
  const s = str(v);
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  const out = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
  if (!isDate(out)) throw bad(`${name} is missing or not a date (use 2026-11-01 or 01/11/2026).`);
  return out;
}

/** The row with this name under this parent, made if it is not there. Names match whatever their capitals. */
async function need(kind, table, nameCol, name, parentCol, parentId) {
  const found = await db.prepare(`SELECT id FROM ${table} WHERE lower(${nameCol}) = lower(?)${parentCol ? ` AND ${parentCol} = ?` : ''}`).get(...[name, ...(parentCol ? [parentId] : [])]);
  return found ? found.id : (await create(kind, { [nameCol]: name }, parentId)).id;
}

async function importRow(r, by, today) {
  for (const f of ['company', 'building', 'unit_no', 'tenant_name']) if (!str(r[f])) throw bad(`${f.replace(/_/g, ' ')} is missing.`);
  const start_date = date(r.start_date, 'Start date');
  const end_date = date(r.end_date, 'End date');
  const rent_period = /year|annual/i.test(str(r.rent_period)) ? 'year' : 'month';
  const payment_frequency = FREQ[str(r.payment_frequency).toLowerCase() || 'monthly'];
  if (!payment_frequency) throw bad(`Paid "${str(r.payment_frequency)}" is not one of: monthly, quarterly, every 6 months, yearly, upfront.`);

  const companyId = await need('company', 'prop_companies', 'name', str(r.company));
  const buildingId = await need('building', 'prop_buildings', 'name', str(r.building), 'company_id', companyId);
  const unitId = await need('unit', 'prop_units', 'unit_no', str(r.unit_no), 'building_id', buildingId);
  // The same person twice in the sheet (two units) is one tenant: matched on Emirates ID, else on name and phone.
  const eid = str(r.emirates_id_no);
  const known = eid ? await db.prepare('SELECT id FROM lease_tenants WHERE emirates_id_no = ?').get(eid)
    : await db.prepare("SELECT id FROM lease_tenants WHERE lower(full_name) = lower(?) AND coalesce(phone, '') = ?").get(str(r.tenant_name), str(r.phone));

  const b = await makeBooking({
    unit_id: unitId, start_date, end_date, rent_amount: amount(r.rent_amount, 'Rent'), rent_period, payment_frequency, status: 'confirmed',
    security_deposit: str(r.security_deposit) ? amount(r.security_deposit, 'Deposit') : null, contract_no: r.contract_no,
    ...(known ? { tenant_id: known.id } : { tenant: { full_name: str(r.tenant_name), phone: r.phone, email: r.email, emirates_id_no: eid } }),
  }, by);

  // Rent already received goes against the schedule oldest first, as the office would have applied it.
  let paid = str(r.rent_paid_so_far) ? amount(r.rent_paid_so_far, 'Rent paid so far') : 0;
  const rent = (await bookingPayments(b.id, today)).filter((i) => i.kind === 'rent');
  if (paid > rent.reduce((t, i) => t + i.amount, 0) + 0.004) throw bad('Rent paid so far is more than the whole rent of this booking.');
  for (const i of rent) {
    if (paid <= 0.004) break;
    const part = Math.min(paid, i.amount);
    await takePayment(i.id, { amount: part, method: 'transfer', received_on: i.due_date < today ? i.due_date : today, reference: 'Imported' }, by, today);
    paid -= part;
  }
  return b.ref;
}

/** Try every row; keep them only when `commit` is set and none failed. Returns a result per row. */
export async function importBookings(rows, { commit = false, by, today = todayHere() } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw bad('The sheet has no rows.');
  if (rows.length > 2000) throw bad('At most 2,000 rows at a time.');
  const results = [];
  try {
    await tx(async () => {
      for (const r of rows) {
        await db.exec('SAVEPOINT import_row');
        try { results.push({ ok: true, ref: await importRow(r, by, today) }); } catch (e) {
          await db.exec('ROLLBACK TO SAVEPOINT import_row');
          results.push({ ok: false, error: e.status ? e.message : `Could not be read: ${e.message}` });
        }
      }
      if (!commit || results.some((x) => !x.ok)) throw UNDO;
    });
  } catch (e) { if (e !== UNDO) throw e; }
  const failed = results.filter((x) => !x.ok).length;
  return { imported: commit && !failed, total: rows.length, failed, results };
}

export const importRoutes = Router();
importRoutes.post('/', requireMaster, (req, res, next) => importBookings(req.body?.rows, { commit: !!req.body?.commit, by: req.user.id }).then((r) => res.json(r)).catch(next));
