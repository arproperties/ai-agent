import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db } from './helpers/db.js';
import { addTenant, getBooking, updateBooking, availability, takePayment } from '../server/leasing.js';
import { create } from '../server/properties.js';
import { parseRollRows, usDate, monthEnd, rollName, planLeases, matchData, importLeases, undoLeaseImport, BILLED_FROM, readRollFiles } from '../server/leaseImport.js';

test.after(() => closeDb());

const TODAY = '2026-10-16';
const roll = (unit, tenant, rent = '1,100.00', move_in = '8/17/26', lease_end = '1/31/27') => ({ unit, tenant, rent, move_in, lease_end });

test('the rows come out of the reply, and dates are read the American way', () => {
  const rows = parseRollRows('{"rows":[["GSL 101","DICKERSON, JAMES","1,100.00","8/17/26","1/31/27"],["GSL 107","<VACANT>","0.00","",""],["GSL 1');
  assert.deepEqual(rows.map((r) => r.unit), ['GSL 101', 'GSL 107'], 'a reply cut short keeps the rows before the cut');
  assert.equal(usDate('8/17/26'), '2026-08-17');
  assert.equal(usDate('08/01/2026'), '2026-08-01');
  assert.equal(usDate('2/30/26'), '', 'not a day');
  assert.equal(monthEnd('2026-02-27'), '2026-02-28');
  assert.equal(monthEnd('2026-10-30'), '2026-10-31');
  assert.equal(BILLED_FROM('2026-10-16'), '2026-11-01');
  assert.equal(BILLED_FROM('2026-12-05'), '2027-01-01');
});

test('a Rent Roll name is turned round and its tags come out', () => {
  assert.equal(rollName('DICKERSON, JAMES').name, 'JAMES DICKERSON');
  assert.deepEqual([rollName('James (Legacy), Jarimiah').name, rollName('James (Legacy), Jarimiah').tags], ['Jarimiah James', ['LEGACY']]);
  assert.equal(rollName('Irving MTM, Kayle').name, 'Kayle Irving');
  assert.equal(rollName('Gunter, Bethany HUD').name, 'Bethany Gunter');
  assert.equal(rollName('HUD Charles, Crystal').name, 'Crystal Charles');
  assert.equal(rollName('Randall, Lennord *SEE NOTE*').name, 'Lennord Randall');
});

const units = [101, 102, 103, 104, 105, 106, 107, 201, 204, 413].map((n, i) => ({ id: i + 1, unit_no: String(n), building: 'Gates 1' }));
const tenants = [
  { id: 1, full_name: 'JAMES DICKERSON', notes: 'Unit in Rent Manager: GSL 101.' },
  { id: 2, full_name: 'Stedman Whittington', notes: null },
  { id: 3, full_name: 'Jarimish James', notes: 'Rent Manager: LEGACY. Unit in Rent Manager: GSL 105.' },
  { id: 4, full_name: 'Stephenie Johnson', notes: 'Unit in Rent Manager: GSL 201.' },
  { id: 5, full_name: 'Armando Paredes', notes: 'Unit in Rent Manager: GSL 204 AIRBNB.' },
  { id: 6, full_name: 'Brittany Hockless', notes: 'Unit in Rent Manager: GSL 413.' },
  { id: 7, full_name: 'BROOKE BELL', notes: 'Unit in Rent Manager: GSL 103.' },
];
const plan = (rows, leases = []) => planLeases(rows, { units, tenants, leases, today: TODAY });

test('each row is matched to its unit and tenant, and only clear ones are ticked', () => {
  const [ok, vacant, old, airbnb, zero, backwards, nobody, legacy] = plan([
    roll('GSL 101', 'DICKERSON, JAMES'),
    roll('GSL 107', '<VACANT>', '0.00', '', ''),
    roll('GSL 201', 'Johnson, Stephenie', '1,050.00', '2/10/25', '2/27/26'),
    roll('GSL 204 AIRBNB', 'Paredes, Armando', '1,795.00', '7/23/26', '1/31/27'),
    roll('GSL 103', 'BELL, BROOKE', '0.00', '9/11/26', '8/31/27'),
    roll('GSL 413', 'Hockless, Brittany', '1,395.00', '9/3/26', '8/31/26'),
    roll('GSL 104', 'Pearson, Charles'),
    roll('GSL 105', 'James (Legacy), Jarimiah', '1,195.00', '11/12/24', '10/31/26'),
  ]);
  assert.deepEqual([ok.status, ok.pick, ok.unit_id, ok.tenant_id, ok.start_date, ok.end_date, ok.rent], ['new', true, 1, 1, '2026-08-17', '2027-01-31', 1100]);
  assert.equal(vacant.status, 'skip');
  assert.deepEqual([old.status, old.pick, old.end_date], ['check', false, '2026-02-28'], 'ended in Rent Manager, and moved to the month end');
  assert.match(old.reasons.join(' '), /month to month/);
  assert.match(old.notes, /Lease end there: 2\/27\/26/);
  assert.deepEqual([airbnb.status, airbnb.tenant_id], ['new', 5]);
  assert.match(airbnb.notes, /AIRBNB/);
  assert.equal(zero.status, 'check');
  assert.match(zero.reasons.join(' '), /No rent/);
  assert.equal(backwards.status, 'check');
  assert.match(backwards.reasons.join(' '), /before the move-in/);
  assert.equal(nobody.status, 'missing', 'no such tenant on file');
  assert.deepEqual([legacy.tenant_id, legacy.status], [3, 'check'], 'found by the unit in the notes; the spelling differs, so it is looked at');
  assert.match(legacy.reasons.join(' '), /On file as Jarimish James/);
  assert.equal(plan([roll('GSL 999', 'DICKERSON, JAMES')])[0].status, 'missing', 'no such unit');
  assert.equal(plan([roll('GSL 102', 'Whittington, Stedman')])[0].tenant_id, 2, 'found by name alone');
});

test('a unit already leased, or a row imported before, is not offered again', () => {
  const leased = { unit_id: 1, tenant_id: 9, status: 'confirmed', tenant: 'Someone Else', start_date: '2026-09-01', end_date: '2027-08-31' };
  assert.equal(plan([roll('GSL 101', 'DICKERSON, JAMES')], [leased])[0].status, 'exists');
  const imported = { unit_id: 1, tenant_id: 1, status: 'confirmed', import_batch: 'x', tenant: 'JAMES DICKERSON', start_date: '2026-08-17', end_date: '2027-01-31' };
  assert.equal(plan([roll('GSL 101', 'DICKERSON, JAMES')], [imported])[0].status, 'exists');
  const twice = plan([roll('GSL 101', 'DICKERSON, JAMES'), roll('GSL 101', 'DICKERSON, JAMES')]);
  assert.deepEqual(twice.map((r) => r.status), ['new', 'exists']);
});

test('importing makes confirmed leases of tenants already in, billed from next month, and undo takes them back', async () => {
  await reset();
  const c = await create('company', { name: 'J&R' });
  const b = await create('building', { name: 'The Gates@ Sour Lake - 1' }, c.id);
  const u101 = await create('unit', { unit_no: '101' }, b.id);
  await create('unit', { unit_no: '201' }, b.id);
  await create('unit', { unit_no: '403' }, b.id);
  await addTenant({ full_name: 'JAMES DICKERSON', notes: 'Unit in Rent Manager: GSL 101.' });
  await addTenant({ full_name: 'Stephenie Johnson' });
  await addTenant({ full_name: 'Lakisha Cormier' });

  const rows = planLeases([
    roll('GSL 101', 'DICKERSON, JAMES', '1,100.00', '8/17/26', '1/31/27'),
    roll('GSL 201', 'Johnson, Stephenie', '1,050.00', '2/10/25', '2/27/26'),
    roll('GSL 403', 'Cormier, Lakisha', '1,400.00', '2/5/22', '1/31/27'),
  ], { ...(await matchData()), today: TODAY });
  assert.deepEqual(rows.map((r) => r.status), ['new', 'check', 'new']);
  const r = await importLeases(rows, null, TODAY);
  assert.deepEqual([r.added, r.failed, r.billed_from], [3, [], '2026-11-01']);

  const leases = await db.prepare("SELECT id FROM lease_bookings ORDER BY id").all();
  const [dick, johnson, cormier] = await Promise.all(leases.map((l) => getBooking(l.id)));
  assert.deepEqual([cormier.status, cormier.moved_in, cormier.start_date, cormier.end_date], ['confirmed', true, '2022-02-05', '2027-01-31'], 'no move-in inspection: the tenant is already in');
  assert.match(cormier.notes, /Imported from Rent Manager/);
  const dues = async (id) => (await db.prepare("SELECT to_char(due_date, 'YYYY-MM-DD') AS due FROM lease_installments WHERE booking_id = ? ORDER BY due_date").all(id)).map((x) => x.due);
  assert.deepEqual(await dues(cormier.id), ['2026-11-01', '2026-12-01', '2027-01-01'], 'nothing from 2022 is shown as owed');
  assert.deepEqual(await dues(dick.id), ['2026-11-01', '2026-12-01', '2027-01-01'], 'due on the 1st, as Rent Manager bills it, not on the move-in day');
  const amounts = (await db.prepare("SELECT amount FROM lease_installments WHERE booking_id = ? AND kind = 'rent' ORDER BY due_date").all(dick.id)).map((x) => Number(x.amount));
  assert.deepEqual(amounts, [1100, 1100, 1100], 'each month in full');
  assert.deepEqual([johnson.stage, await dues(johnson.id)], ['ended', []], 'ended in Rent Manager: nothing more to bill');
  assert.equal((await availability(b.id, TODAY, TODAY)).find((x) => x.id === u101.id).free, false);
  assert.equal((await availability(b.id, '2027-03-01', '2027-03-31')).find((x) => x.unit_no === '201').free, false, 'past its end date the tenant still holds the unit until the move-out inspection');

  // A deposit added by hand later is due from the first month billed here, not from 2022.
  await updateBooking(cormier.id, { security_deposit: 450 });
  assert.equal((await db.prepare("SELECT to_char(due_date, 'YYYY-MM-DD') AS due FROM lease_installments WHERE booking_id = ? AND kind = 'deposit'").get(cormier.id)).due, '2026-11-01');

  const again = await importLeases(rows, null, TODAY);
  assert.deepEqual([again.added, again.skipped], [0, 3], 'importing the same rows twice adds nothing');

  // A lease with a payment on it by now is kept on undo.
  const first = await db.prepare("SELECT id, amount FROM lease_installments WHERE booking_id = ? AND kind = 'rent' ORDER BY due_date LIMIT 1").get(dick.id);
  await takePayment(first.id, { amount: Number(first.amount), method: 'cash', received_on: '2026-11-01' }, null, '2026-11-01');
  const undone = await undoLeaseImport(r.batch);
  assert.deepEqual([undone.removed, undone.kept], [2, 1]);
  assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM lease_tenants').get()).n), 3, 'the tenants stay');
});

test('a lease that cannot be saved is reported, and the others are still saved', async () => {
  await reset();
  const c = await create('company', { name: 'J&R' });
  const b = await create('building', { name: 'G' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  const t = await addTenant({ full_name: 'A B' });
  const r = await importLeases([
    { unit_no: '101', name: 'A B', unit_id: u.id, tenant_id: t.id, start_date: '2026-08-01', end_date: '2027-07-31', rent: 0 },
    { unit_no: '101', name: 'A B', unit_id: u.id, tenant_id: t.id, start_date: '2026-08-01', end_date: '2027-07-31', rent: 900 },
  ], null, TODAY);
  assert.equal(r.added, 1);
  assert.match(r.failed[0].reason, /rent/i);
});

test('the same Rent Roll file is not read twice', async () => {
  let calls = 0;
  const store = new Map();
  const saved = { get: async (h) => store.get(h), set: async (h, rows) => store.set(h, rows) };
  const read = async () => { calls += 1; return '{"rows":[["GSL 101","DICKERSON, JAMES","1,100.00","8/17/26","1/31/27"]]}'; };
  const file = { originalname: 'roll.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF roll') };
  await readRollFiles([file], { read, saved });
  const again = await readRollFiles([file], { read, saved });
  assert.equal(calls, 1);
  assert.equal(again.rows[0].tenant, 'DICKERSON, JAMES');
});
