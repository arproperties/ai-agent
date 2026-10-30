import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create, listUnits } from '../server/properties.js';
import { addTenant, removeTenant, createBooking, bookingPayments, payBooking, ledger } from '../server/leasing.js';
import { listWorkOrders } from '../server/workOrders.js';
import { tenantHistory } from '../server/leasingHistory.js';
import { ENDED, ARCHIVE_METHODS, listArchive, getArchive, addArchive, updateArchive, removeArchive, addArchivePayment, updateArchivePayment, removeArchivePayment,
  addArchiveWorkOrder, updateArchiveWorkOrder, removeArchiveWorkOrder, addArchiveFiles, getArchiveFile, removeArchiveFile, previousLeases } from '../server/leaseArchive.js';

test.after(() => closeDb());

async function setup() {
  await reset();
  const staff = await makeUser('Diana');
  const c = await create('company', { name: 'J&R' });
  const bl = await create('building', { name: 'The Gates at Sour Lake' }, c.id);
  const u = await create('unit', { unit_no: 'GSL 101' }, bl.id);
  const t = await addTenant({ full_name: 'Jane Old' });
  return { staff, bl, u, t };
}
const lease = (o = {}) => ({ start_date: '2024-01-01', end_date: '2024-12-31', rent_amount: 1000, security_deposit: 500, ended_how: 'renewed', ...o });
const live = (staff, u, t, o = {}) => createBooking({ unit_id: u.id, tenant_id: t.id, start_date: '2025-01-01', end_date: '2025-12-31', rent_amount: 1000, rent_period: 'month',
  payment_frequency: 'monthly', status: 'confirmed', ...o }, staff);

test('an archived lease with its payments, work orders and files reads back', async () => {
  const { staff, u, t } = await setup();
  const a = await addArchive({ unit_id: u.id, tenant_id: t.id, ...lease({ unpaid_at_end: 120, notes: 'typed' }) }, staff);
  assert.equal(a.tenant, 'Jane Old');
  assert.equal(a.start_date, '2024-01-01');
  assert.equal(a.rent_amount, 1000);
  await addArchivePayment(a.id, { received_on: '2024-02-01', amount: 1000, method: 'check', reference: '#12' }, { originalname: 'chk.png', mimetype: 'image/png', buffer: Buffer.from('x') }, staff);
  await addArchivePayment(a.id, { received_on: '2024-01-01', amount: 500, method: 'cash' }, null, staff);
  const w = await addArchiveWorkOrder(a.id, { reported_on: '2024-03-01', detail: 'Leak', resolution: 'Fixed', done_on: '2024-03-02', cost: 80 }, staff);
  await addArchiveFiles(a.id, [{ originalname: 'lease.pdf', mimetype: 'application/pdf', buffer: Buffer.from('p') }], { title: 'Contract', category: 'Lease' }, staff);
  await addArchiveFiles(a.id, [{ originalname: 'pic.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('j') }], { work_order_id: w.id }, staff);
  const g = await getArchive(a.id);
  assert.equal(g.unpaid_at_end, 120);
  assert.deepEqual(g.payments.map((p) => [p.received_on, p.amount, p.method]), [['2024-01-01', 500, 'cash'], ['2024-02-01', 1000, 'check']]);
  assert.equal(g.payments[1].file_name, 'chk.png');
  assert.equal(g.work_orders.length, 1);
  assert.equal(g.work_orders[0].cost, 80);
  assert.equal(g.work_orders[0].files.length, 1);
  assert.equal(g.files.length, 1, 'files without a work order');
  assert.equal(g.files[0].title, 'Contract');
  const list = await listArchive({ unit_id: u.id });
  assert.deepEqual([list[0].payments, list[0].work_orders, list[0].files, list[0].unit_no, list[0].building], [2, 1, 2, 'GSL 101', 'The Gates at Sour Lake']);
  assert.deepEqual(ENDED.map((e) => e[0]), ['renewed', 'moved_out', 'evicted', 'transferred']);
  assert.ok(ARCHIVE_METHODS.some((m) => m[0] === 'check') && !ARCHIVE_METHODS.some((m) => ['zego', 'rent_manager'].includes(m[0])));
  // lines can be edited and removed
  assert.equal((await updateArchive(a.id, { notes: 'fixed typo' }, staff)).notes, 'fixed typo');
  await updateArchivePayment(g.payments[0].id, { amount: 600 });
  assert.equal((await getArchive(a.id)).payments[0].amount, 600);
  await updateArchiveWorkOrder(w.id, { cost: 90 });
  assert.equal((await getArchive(a.id)).work_orders[0].cost, 90);
  await removeArchivePayment(g.payments[0].id);
  await removeArchiveWorkOrder(w.id);
  const after = await getArchive(a.id);
  assert.deepEqual([after.payments.length, after.work_orders.length], [1, 0]);
  const f = await getArchiveFile(after.files[0].id);
  await removeArchiveFile(f.id);
  assert.equal(existsSync(f.file_path), false);
});

test('archive needs a unit, a tenant or name, and dates in order', async () => {
  const { staff, u, t } = await setup();
  await assert.rejects(addArchive({ tenant_id: t.id, ...lease() }, staff), /Choose a unit\./);
  await assert.rejects(addArchive({ unit_id: u.id, ...lease() }, staff), /Choose the tenant or type their name\./);
  await assert.rejects(addArchive({ unit_id: u.id, tenant_id: t.id, ...lease({ start_date: '' }) }, staff), /date/i);
  await assert.rejects(addArchive({ unit_id: u.id, tenant_id: t.id, ...lease({ end_date: '2023-12-31' }) }, staff), /end/i);
  await assert.rejects(addArchive({ unit_id: u.id, tenant_id: t.id, ...lease({ rent_amount: -1 }) }, staff), /rent/i);
  await assert.rejects(addArchive({ unit_id: u.id, tenant_id: t.id, ...lease({ ended_how: 'gone' }) }, staff), /ended|how/i);
  const a = await addArchive({ unit_id: u.id, tenant_id: t.id, ...lease({ rent_amount: '', security_deposit: '' }) }, staff);
  assert.equal(a.rent_amount, null);
  await assert.rejects(addArchivePayment(a.id, { received_on: '2024-02-01', amount: 0, method: 'cash' }, null, staff), /amount/i);
  await assert.rejects(addArchivePayment(a.id, { amount: 5, method: 'cash' }, null, staff), /date/i);
  await assert.rejects(addArchivePayment(a.id, { received_on: '2024-02-01', amount: 5, method: 'zego' }, null, staff), /method/i);
  await assert.rejects(addArchiveWorkOrder(a.id, { reported_on: '2024-02-01' }, staff), /wrong|detail|problem/i);
  await assert.rejects(addArchiveWorkOrder(a.id, { detail: 'x' }, staff), /date/i);
});

test('a past tenant can be a typed name only, and no tenant record is made', async () => {
  const { staff, u } = await setup();
  const before = await db.prepare('SELECT count(*)::int AS n FROM lease_tenants').get();
  const a = await addArchive({ unit_id: u.id, tenant_name: '  Bob Gone ', ...lease() }, staff);
  assert.equal(a.tenant, 'Bob Gone');
  assert.equal(a.tenant_id, null);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM lease_tenants').get()).n, before.n);
});

test("a removed tenant's archive keeps the name", async () => {
  const { staff, u, t } = await setup();
  const a = await addArchive({ unit_id: u.id, tenant_id: t.id, ...lease() }, staff);
  await removeTenant(t.id);
  const g = await getArchive(a.id);
  assert.equal(g.tenant_id, null);
  assert.equal(g.tenant, 'Jane Old');
});

test('archive never touches live money', async () => {
  const { staff, bl, u, t } = await setup();
  const bk = await live(staff, u, t);
  const AT = '2025-06-15';
  await payBooking(bk.id, { amount: 300, method: 'cash', received_on: '2025-01-02' }, staff, AT);
  const snap = async () => ({ bal: (await ledger(bk.id, AT)).balance, rows: await bookingPayments(bk.id, AT), units: await listUnits(bl.id, AT), wo: (await listWorkOrders({}, AT)).length });
  const before = await snap();
  const a = await addArchive({ unit_id: u.id, tenant_id: t.id, ...lease({ start_date: '2024-06-01', end_date: '2025-06-30', unpaid_at_end: 999 }) }, staff);
  for (const amount of [100, 200, 300]) await addArchivePayment(a.id, { received_on: '2024-07-01', amount, method: 'check' }, null, staff);
  await addArchiveWorkOrder(a.id, { reported_on: '2024-08-01', detail: 'Leak', cost: 50 }, staff);
  assert.deepEqual(await snap(), before);
});

test('archive never blocks a live lease', async () => {
  const { staff, u, t } = await setup();
  await addArchive({ unit_id: u.id, tenant_id: t.id, ...lease() }, staff);
  const bk = await live(staff, u, t, { start_date: '2024-01-01', end_date: '2024-12-31' });
  assert.ok(bk.id);
});

test("previous leases are the tenant's own in that unit, oldest first", async () => {
  const { staff, u, t } = await setup();
  const other = await addTenant({ full_name: 'Other Person' });
  await addArchive({ unit_id: u.id, tenant_id: t.id, ...lease({ start_date: '2024-01-01', end_date: '2024-12-31' }) }, staff);
  await addArchive({ unit_id: u.id, tenant_id: t.id, ...lease({ start_date: '2023-01-01', end_date: '2023-12-31' }) }, staff);
  await addArchive({ unit_id: u.id, tenant_id: other.id, ...lease({ start_date: '2022-01-01', end_date: '2022-12-31' }) }, staff);
  const bk = await live(staff, u, t);
  assert.deepEqual((await previousLeases(bk.id)).map((r) => r.start_date), ['2023-01-01', '2024-01-01']);
  assert.deepEqual((await listArchive({ q: '2022' })).map((r) => r.tenant), ['Other Person']);
  assert.equal((await listArchive({ q: 'jane' })).length, 2);
  assert.equal((await listArchive({ q: 'gsl' })).length, 3);
});

test('removing an archived lease removes its files', async () => {
  const { staff, u, t } = await setup();
  const a = await addArchive({ unit_id: u.id, tenant_id: t.id, ...lease() }, staff);
  await addArchiveFiles(a.id, [{ originalname: 'a.pdf', mimetype: 'application/pdf', buffer: Buffer.from('a') }], {}, staff);
  await addArchivePayment(a.id, { received_on: '2024-02-01', amount: 5, method: 'check' }, { originalname: 'c.png', mimetype: 'image/png', buffer: Buffer.from('c') }, staff);
  const g = await getArchive(a.id);
  const paths = [(await getArchiveFile(g.files[0].id)).file_path, (await db.prepare('SELECT file_path FROM lease_archive_payments WHERE id = ?').get(g.payments[0].id)).file_path];
  assert.ok(paths.every((x) => existsSync(x)));
  await removeArchive(a.id);
  assert.ok(paths.every((x) => !existsSync(x)));
  await assert.rejects(getArchive(a.id), /not found/i);
});

test('tenant history lists archived leases', async () => {
  const { staff, bl, u, t } = await setup();
  const u2 = await create('unit', { unit_no: 'GSL 102' }, bl.id);
  await addArchive({ unit_id: u.id, tenant_id: t.id, ...lease() }, staff);
  await addArchive({ unit_id: u2.id, tenant_id: t.id, ...lease({ start_date: '2025-01-01', end_date: '2025-06-30' }) }, staff);
  assert.equal((await tenantHistory(t.id)).archive.length, 2);
});
