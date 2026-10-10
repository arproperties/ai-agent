import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, bookingPayments, recordPayment } from '../server/leasing.js';
import { saveSettings } from '../server/leasingAlerts.js';
import { tenantHistory, addLog, updateLog, removeLog, addLogFiles, getLogFile, removeLogFile } from '../server/leasingHistory.js';
import { leasingKit } from '../server/leasingKit.js';
import { createWorkOrder, updateWorkOrder } from '../server/workOrders.js';

test.after(() => closeDb());

const AT = '2026-10-25';

// Sara: two months in 101 from 15 September at 4,500 a month. Nothing paid yet.
async function tower() {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u1 = await create('unit', { unit_no: '101' }, b.id);
  const bk = await createBooking({ unit_id: u1.id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, status: 'confirmed',
    tenant: { full_name: 'Sara', phone: '050 123 4567' } }, staff);
  const rent = async (due) => (await bookingPayments(bk.id, AT)).find((r) => r.kind === 'rent' && r.due_date === due);
  return { staff, bk, u1, sara: bk.tenant_id, rent };
}

test('late rent is worked out from the payments: paid late, still unpaid, and never rent paid in time', async () => {
  const { staff, bk, sara, rent } = await tower();
  assert.deepEqual((await tenantHistory(sara, '2026-09-15')).items, [], 'rent due today is not late yet');

  // September's rent comes in two parts, the last of them nine days late. October's is not paid at all.
  const sep = await rent('2026-09-15');
  await recordPayment(sep.id, { amount: 2000, method: 'cash', received_on: '2026-09-15' }, staff, AT);
  await recordPayment(sep.id, { amount: 2500, method: 'cash', received_on: '2026-09-24' }, staff, AT);
  const h = await tenantHistory(sara, AT);
  assert.deepEqual(h.items.map((i) => [i.type, i.date, i.days_late, i.paid_on, i.left, i.fee, i.ref, i.unit_no]), [
    ['late', '2026-10-15', 10, null, 4500, null, bk.ref, '101'],
    ['late', '2026-09-15', 9, '2026-09-24', 0, null, bk.ref, '101'],
  ]);
  assert.deepEqual(h.summary, { late: 2, late_unpaid: 1, late_days: 10, late_fees: 0, complaints: 0, complaints_open: 0, maintenance: 0, maintenance_open: 0 });
  assert.equal(h.tenant.full_name, 'Sara');

  // Paid on the due date itself: not late, so it leaves the history.
  const { sara: sara2, rent: rent2, staff: staff2 } = await tower();
  await recordPayment((await rent2('2026-09-15')).id, { amount: 4500, method: 'cash', received_on: '2026-09-15' }, staff2, AT);
  assert.deepEqual((await tenantHistory(sara2, AT)).items.map((i) => i.date), ['2026-10-15']);
  await assert.rejects(tenantHistory(999, AT), /Tenant not found/);
});

test('a late fee that was charged shows with the rent it was charged for', async () => {
  const { sara } = await tower();
  await saveSettings({ latefee: { on: true, days: 5, amount: 100, percent: 0 } }, '2026-09-01');
  const h = await tenantHistory(sara, AT);
  assert.deepEqual(h.items.map((i) => [i.date, i.fee]), [['2026-10-15', 100], ['2026-09-15', 100]]);
  assert.equal(h.summary.late_fees, 200);
});

test('complaints and maintenance are logged against the tenant and the booking of that day, resolved, changed and removed', async () => {
  const { staff, bk, u1, sara } = await tower();
  await assert.rejects(addLog(sara, { kind: 'complaint' }, staff, AT), /Say what happened/);
  await assert.rejects(addLog(sara, { kind: 'fine', detail: 'x' }, staff, AT), /is a complaint/);
  await assert.rejects(addLog(sara, { kind: 'maintenance', detail: 'x' }, staff, AT), /raised as a work order/);
  await assert.rejects(addLog(sara, { kind: 'complaint', detail: 'x', happened_on: '2026-13-40' }, staff, AT), /not a date/);
  await assert.rejects(addLog(sara, { kind: 'complaint', detail: 'x', happened_on: '2026-10-26' }, staff, AT), /in the future/);
  await assert.rejects(addLog(999, { kind: 'complaint', detail: 'x' }, staff, AT), /Tenant not found/);

  const noise = await addLog(sara, { kind: 'complaint', category: 'Noise', detail: 'Loud music after midnight', reported_by: 'Unit 102', happened_on: '2026-10-01' }, staff, AT);
  assert.deepEqual([noise.type, noise.date, noise.category, noise.reported_by, noise.ref, noise.unit_no, noise.building, noise.resolved_on, noise.logged_by],
    ['complaint', '2026-10-01', 'Noise', 'Unit 102', bk.ref, '101', 'Tower', null, 'Staff']);
  const ac = await createWorkOrder({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling' }, staff, AT);
  const quiet = await addLog(sara, { kind: 'complaint', detail: 'Bins left out' }, staff, AT);
  assert.equal(quiet.date, AT, 'with no date it is today');
  await removeLog(quiet.id);
  const old = await addLog(sara, { kind: 'complaint', detail: 'Before any booking', happened_on: '2026-01-05' }, staff, AT);
  assert.equal(old.ref, null, 'no booking had started by then');

  let h = await tenantHistory(sara, AT);
  assert.deepEqual(h.items.map((i) => [i.type, i.date]), [['maintenance', AT], ['late', '2026-10-15'], ['complaint', '2026-10-01'], ['late', '2026-09-15'], ['complaint', '2026-01-05']]);
  assert.deepEqual([h.summary.complaints, h.summary.complaints_open, h.summary.maintenance, h.summary.maintenance_open], [2, 2, 1, 1]);

  const done = await updateLog(noise.id, { resolved: true, resolution: 'Warned by phone' }, AT);
  assert.deepEqual([done.resolved_on, done.resolution, done.detail], [AT, 'Warned by phone', 'Loud music after midnight']);
  assert.equal((await updateLog(noise.id, { detail: 'Loud music, twice' }, AT)).resolved_on, AT, 'changing the words leaves it resolved');
  assert.equal((await updateLog(noise.id, { resolved: false }, AT)).resolved_on, null);
  await assert.rejects(updateLog(noise.id, { detail: ' ' }, AT), /Say what happened/);
  await updateWorkOrder(ac.id, { status: 'done', resolution: 'Regassed' }, staff, AT);
  h = await tenantHistory(sara, AT);
  assert.deepEqual([h.summary.complaints_open, h.summary.maintenance_open], [2, 0]);

  await removeLog(old.id);
  await assert.rejects(removeLog(old.id), /not found/);
  assert.equal((await tenantHistory(sara, AT)).summary.complaints, 1);
});

test('Riley can read a tenant’s history', async () => {
  const { staff, sara } = await tower();
  await addLog(sara, { kind: 'complaint', category: 'Noise', detail: 'Loud music after midnight', happened_on: '2026-10-01' }, staff, AT);
  const kit = leasingKit({ id: staff, role: 'member' });
  assert.ok(kit.definitions.some((d) => d.name === 'leasing_tenant_history'));
  const { content } = await kit.run({ id: 't1', name: 'leasing_tenant_history', input: { tenant: 'sara' } });
  assert.match(content, /^History · Sara/);
  assert.match(content, /Complaint \(Noise\), open: Loud music after midnight/);
});

test('an entry takes several attachments, each opened or removed by itself, and all go with the entry', async () => {
  const { staff, sara } = await tower();
  const file = (name, mime = 'image/jpeg') => ({ buffer: Buffer.from(name), originalname: name, mimetype: mime });
  const leak = await addLog(sara, { kind: 'complaint', category: 'Damage', detail: 'Broke the lobby door' }, staff, AT);
  assert.deepEqual(leak.files, []);
  await assert.rejects(addLogFiles(leak.id, [], staff), /Choose a file/);
  await assert.rejects(addLogFiles(999, [file('a.jpg')], staff), /not found/);

  const withTwo = await addLogFiles(leak.id, [file('before.jpg'), file('invoice.pdf', 'application/pdf')], staff);
  assert.deepEqual(withTwo.files.map((f) => [f.file_name, f.file_mime]), [['before.jpg', 'image/jpeg'], ['invoice.pdf', 'application/pdf']]);
  assert.equal((await addLogFiles(leak.id, [file('after.jpg')], staff)).files.length, 3, 'more can be added later');
  assert.equal((await tenantHistory(sara, AT)).items.find((i) => i.type === 'complaint' && i.id === leak.id).files.length, 3);

  const paths = (await db.prepare('SELECT file_path FROM lease_tenant_log_files ORDER BY id').all()).map((r) => r.file_path);
  assert.ok(paths.every((p) => existsSync(p)));
  assert.equal((await getLogFile(withTwo.files[0].id)).file_name, 'before.jpg');

  await removeLogFile(withTwo.files[0].id);
  assert.equal(existsSync(paths[0]), false);
  await assert.rejects(removeLogFile(withTwo.files[0].id), /Not found/);
  assert.deepEqual((await tenantHistory(sara, AT)).items.find((i) => i.type === 'complaint' && i.id === leak.id).files.map((f) => f.file_name), ['invoice.pdf', 'after.jpg']);

  await removeLog(leak.id);
  assert.ok(paths.every((p) => !existsSync(p)), 'deleting the entry deletes its files');
});
