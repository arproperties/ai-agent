import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { reset, closeDb, db, makeUser, giveModules, giveActions } from './helpers/db.js';
import { ensureActionAccess } from '../server/db.js';
import { ACTIONS, userActions, listAppActions, setAppActions, actionFor, actionGate, COVERED } from '../server/actions.js';
import { moduleGate } from '../server/modules.js';
import { LABELS } from '../server/activity.js';
import { leasingRoutes } from '../server/leasing.js';
import { historyRoutes } from '../server/leasingHistory.js';
import { inspectionRoutes } from '../server/inspections.js';
import { workOrderRoutes } from '../server/workOrders.js';
import { propertyRoutes } from '../server/properties.js';
import { planRoutes } from '../server/floorPlans.js';
import { renewalRoutes } from '../server/renewals.js';
import { expenseRoutes } from '../server/expenses.js';
import { recurringPaymentRoutes } from '../server/recurringPayments.js';
import { inventoryRoutes } from '../server/inventory.js';
import { tenantImportRoutes } from '../server/tenantImport.js';
import { leaseImportRoutes } from '../server/leaseImport.js';
import { alertRoutes } from '../server/leasingAlerts.js';
import { regionRoutes } from '../server/leasingRegion.js';
import { adminRoutes } from '../server/admin.js';
import { leasingKit, LEASING_WRITES, TOOL_ACTIONS } from '../server/leasingKit.js';
import { create } from '../server/properties.js';

test.after(() => closeDb());

async function people() {
  await reset();
  const master = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  const sara = await makeUser('Sara');
  return { master: { id: master, role: 'master' }, sara: { id: sara, role: 'user' } };
}

test('the actions are Add, Edit and Delete', () => {
  assert.deepEqual(ACTIONS, [{ key: 'add', label: 'Add' }, { key: 'edit', label: 'Edit' }, { key: 'delete', label: 'Delete' }]);
  assert.equal(LABELS.action_access.name, 'Action access', 'ticking them shows in the Activity log by name');
});

test('nothing ticked is no actions, and the master has all three', async () => {
  const { master, sara } = await people();
  assert.deepEqual(await userActions(sara), []);
  assert.deepEqual(await userActions(master), ['add', 'edit', 'delete']);
});

test('ticking replaces the whole set, drops duplicates, refuses an unknown key', async () => {
  const { master, sara } = await people();
  assert.equal(await setAppActions(sara.id, ['delete', 'add', 'delete']), 2);
  assert.deepEqual(await userActions(sara), ['add', 'delete'], 'in the tab’s order');
  await assert.rejects(() => setAppActions(sara.id, ['view']), (e) => e.status === 400 && /Unknown action: view/.test(e.message));
  assert.deepEqual(await userActions(sara), ['add', 'delete'], 'a refused save changes nothing');
  await assert.rejects(() => setAppActions(9999, ['add']), (e) => e.status === 404);
  assert.equal(await setAppActions(sara.id, 'not a list'), 0);
  assert.deepEqual(await userActions(sara), []);
  assert.equal(await setAppActions(master.id, ['add']), 0, 'the master is never listed');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM action_access').get()).n, 0);
});

test('staff already there when the table first appears keep adding and editing', async () => {
  const { master, sara } = await people();
  await db.exec('DROP TABLE action_access');
  await ensureActionAccess();
  assert.deepEqual(await userActions(sara), ['add', 'edit']);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM action_access WHERE user_id = ?').get(master.id)).n, 0);
  const omar = { id: await makeUser('Omar'), role: 'user' };
  await ensureActionAccess();
  assert.deepEqual(await userActions(omar), [], 'only the first time: someone new starts with nothing');
});

test('the People screen is told all three and which are on', async () => {
  const { master, sara } = await people();
  await setAppActions(sara.id, ['edit']);
  const a = await listAppActions(sara.id);
  assert.equal(a.master, false);
  assert.deepEqual(a.actions, [{ key: 'add', label: 'Add', on: false }, { key: 'edit', label: 'Edit', on: true }, { key: 'delete', label: 'Delete', on: false }]);
  const m = await listAppActions(master.id);
  assert.equal(m.master, true);
  assert.ok(m.actions.every((x) => x.on));
  await assert.rejects(() => listAppActions(9999), (e) => e.status === 404);
});

// ---------- the gate ----------

test('the method is the action', () => {
  assert.equal(actionFor('POST', '/leasing/bookings'), 'add');
  assert.equal(actionFor('PUT', '/leasing/bookings/5'), 'edit');
  assert.equal(actionFor('PATCH', '/leasing/bookings/5'), 'edit');
  assert.equal(actionFor('DELETE', '/leasing/payments/9'), 'delete');
  assert.equal(actionFor('GET', '/leasing/bookings'), null);
  assert.equal(actionFor('HEAD', '/leasing/bookings'), null);
  assert.equal(actionFor('POST', '/Leasing/Bookings'), 'add', 'whatever the case, as Express matches it');
  for (const p of ['/todos', '/messenger/chats', '/imports', '/admin/users/3/modules', '/meetings', '/leasingx']) assert.equal(actionFor('POST', p), null, p);
});

test('a POST that changes something already there is an edit, and a read by Riley is no change', () => {
  assert.equal(actionFor('POST', '/leasing/payments/3/file'), 'edit');
  assert.equal(actionFor('POST', '/leasing/bookings/3/confirm'), 'edit');
  assert.equal(actionFor('POST', '/leasing/bookings/3/cancel'), 'edit');
  assert.equal(actionFor('POST', '/leasing/alerts/reminder/3'), 'edit');
  assert.equal(actionFor('POST', '/properties/buildings/3/photo'), 'edit');
  assert.equal(actionFor('POST', '/leasing/bookings/3/payments'), 'add');
  assert.equal(actionFor('POST', '/leasing/slips/read'), null);
  assert.equal(actionFor('POST', '/properties/documents/read'), null);
});

// Every router behind a covered path, mounted where index.js mounts it.
const MOUNTS = [['/properties/renewals', renewalRoutes], ['/properties', planRoutes], ['/properties', propertyRoutes],
  ['/leasing/alerts', alertRoutes], ['/leasing/region', regionRoutes], ['/leasing', inspectionRoutes], ['/leasing', historyRoutes],
  ['/leasing', workOrderRoutes], ['/leasing/tenants/import', tenantImportRoutes], ['/leasing/bookings/import', leaseImportRoutes],
  ['/leasing', leasingRoutes], ['/accounts', expenseRoutes], ['/recurring-payments', recurringPaymentRoutes], ['/inventory', inventoryRoutes]];
// The POSTs that make something new. Any other POST must be in OVERRIDES (server/actions.js).
const CREATES = ['/leasing/tenants', '/leasing/services', '/leasing/sources', '/leasing/bookings', '/leasing/bookings/1/docs', '/leasing/bookings/1/renew',
  '/leasing/bookings/1/payments', '/leasing/bookings/1/charges', '/leasing/installments/1/payments', '/leasing/tenants/1/log', '/leasing/log/1/files',
  '/leasing/units/1/inspections', '/leasing/inspections/1/photos', '/leasing/work-orders', '/leasing/work-orders/1/notes', '/leasing/work-orders/1/files',
  '/properties/companies/1/docs', '/properties/documents', '/properties/units/1/photos', '/properties/companies', '/properties/companies/1/buildings',
  '/properties/buildings/1/units', '/properties/renewals', '/properties/renewals/1/suppliers', '/properties/renewals/1/requests', '/properties/renewals/1/quotes',
  '/accounts/expenses', '/accounts/repeats', '/recurring-payments/entries', '/recurring-payments/entries/1/dues', '/recurring-payments/buildings',
  '/recurring-payments/accounts', '/recurring-payments/transfers', '/inventory/1/areas', '/inventory/1/items', '/leasing/tenants/import', '/leasing/bookings/import'];

test('every POST behind a covered path is classified on purpose', () => {
  const posts = MOUNTS.flatMap(([at, router]) => router.stack.filter((l) => l.route?.methods?.post)
    .map((l) => `${at}${l.route.path}`.replace(/:\w+/g, '1').replace(/\/$/, '')));
  assert.ok(posts.length > 50, `found ${posts.length} POST routes`);
  for (const p of posts) assert.ok(COVERED.test(p), `${p} is under a covered path`);
  const unclassified = posts.filter((p) => !CREATES.includes(p) && actionFor('POST', p) === 'add');
  assert.deepEqual(unclassified, [], 'a new POST that is not a plain add needs a line in OVERRIDES, or a place in CREATES here');
  for (const p of CREATES) assert.equal(actionFor('POST', p), 'add', p);
});

// The two gates over real HTTP, in index.js's order, in front of the real routers.
let caller = { id: 0, role: 'user' };
const app = express();
app.use(express.json());
app.use('/api', (req, res, next) => { req.user = caller; next(); });
app.use('/api', moduleGate);
app.use('/api', actionGate);
for (const [at, router] of MOUNTS) app.use(`/api${at}`, router);
app.use('/api/admin', adminRoutes);
app.use('/api', (req, res) => res.json({ ok: true })); // what no router answered: let through
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
test.after(() => new Promise((ok) => server.close(ok)));
const call = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const hit = async (...a) => (await call(...a)).status;

async function diana(...actions) {
  const { master } = await people();
  const d = { id: await makeUser('Diana'), role: 'user' };
  await giveModules(d.id, 'leasing', 'workorders', 'accounts', 'properties', 'alerts');
  if (actions.length) await giveActions(d.id, ...actions);
  caller = d;
  return { master, d };
}

test('without delete, a payment cannot be deleted; with it, the master lock is gone', async () => {
  await diana('add', 'edit');
  const no = await call('DELETE', '/leasing/payments/999');
  assert.equal(no.status, 403);
  assert.deepEqual(no.body, { error: 'You are not allowed to delete here. Ask the master.' });
  await diana('delete');
  assert.equal(await hit('DELETE', '/leasing/payments/999'), 404, 'reached the route: there is no such payment');
  assert.equal(await hit('DELETE', '/accounts/expenses/999'), 404);
  assert.equal(await hit('DELETE', '/leasing/work-orders/999'), 404);
  assert.equal(await hit('DELETE', '/properties/companies/999'), 404);
});

test('without delete, a lease cannot be deleted, so its payments stay', async () => {
  await diana('add', 'edit');
  assert.equal(await hit('DELETE', '/leasing/bookings/1'), 403);
  assert.equal(await hit('DELETE', '/leasing/tenants/1'), 403);
});

test('with add but no edit, nothing already there can be changed', async () => {
  await diana('add');
  assert.equal(await hit('POST', '/leasing/payments/1/file'), 403, 'a slip on a payment');
  assert.equal(await hit('PUT', '/leasing/bookings/1', {}), 403);
  assert.equal(await hit('POST', '/leasing/bookings/1/confirm'), 403);
  assert.notEqual(await hit('POST', '/leasing/tenants', {}), 403, 'adding is still theirs');
});

test('without add, nothing new; reading is untouched', async () => {
  await diana('edit');
  assert.equal(await hit('POST', '/leasing/tenants', {}), 403);
  assert.equal(await hit('POST', '/properties/companies', {}), 403);
  assert.equal(await hit('GET', '/leasing/bookings'), 200);
});

test('all three ticks still do not reach the master setup', async () => {
  await diana('add', 'edit', 'delete');
  assert.equal(await hit('PUT', '/leasing/region', {}), 403);
  assert.equal(await hit('PUT', '/leasing/alerts/settings', {}), 403);
  assert.equal(await hit('PUT', '/leasing/alerts/wording', {}), 403);
  assert.equal(await hit('PUT', '/properties/buildings/1/staff', {}), 403);
  assert.equal(await hit('POST', '/properties/renewals', {}), 403);
});

test('the module comes first: delete without Accounts reaches nothing there', async () => {
  const { d } = await diana('add', 'edit', 'delete');
  await db.prepare("DELETE FROM module_access WHERE user_id = ? AND module = 'accounts'").run(d.id);
  const r = await call('DELETE', '/accounts/expenses/1');
  assert.deepEqual([r.status, r.body], [403, { error: 'Not allowed' }]);
});

test('a person’s own things are not stopped by the ticks', async () => {
  await diana();
  assert.equal(await hit('POST', '/todos', {}), 200);
  assert.equal(await hit('DELETE', '/messenger/chats/1'), 200);
});

// ---------- Riley ----------

test('without add, Riley does not carry the add tools, and refuses one called anyway', async () => {
  const { d } = await diana();
  const kit = leasingKit(d, { modules: ['leasing', 'properties', 'tenants', 'workorders'], actions: ['edit'] });
  const names = kit.definitions.map((x) => x.name);
  assert.ok(!names.includes('leasing_add_booking'));
  assert.ok(!names.includes('leasing_add_company'));
  assert.ok(names.includes('leasing_change_booking'));
  assert.ok(names.includes('leasing_list'), 'reading needs no tick');
  const r = await kit.run({ id: 't', name: 'leasing_add_booking', input: {} });
  assert.deepEqual([r.is_error, r.content], [true, 'This person is not allowed to add here. Tell them to ask the master.']);
  const e = await leasingKit(d, { modules: ['leasing'], actions: ['add'] }).run({ id: 't', name: 'leasing_change_booking', input: {} });
  assert.match(e.content, /not allowed to edit/);
});

test('every Riley tool that changes something says which action it is', () => {
  const writers = Object.keys(LEASING_WRITES);
  assert.ok(writers.length >= 11);
  for (const n of writers) assert.ok(['add', 'edit', 'delete'].includes(TOOL_ACTIONS[n]), `${n} needs a line in TOOL_ACTIONS`);
});

test('with Properties and Add, Riley adds a company the way the screen now lets them', async () => {
  const { d } = await diana();
  const r = await leasingKit(d, { modules: ['properties'], actions: ['add'] }).run({ id: 't', name: 'leasing_add_company', input: { name: 'ACE' } });
  assert.ok(!r.is_error, r.content);
});

test('with add but no edit, Riley starts an inspection but does not change one already begun', async () => {
  const { d } = await diana();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  await create('unit', { unit_no: '101' }, b.id);
  const kit = leasingKit(d, { modules: ['leasing', 'properties'], actions: ['add'] });
  const record = () => kit.run({ id: 't', name: 'leasing_record_inspection', input: { building: 'Tower', unit_no: '101', kind: 'make_ready', notes: 'Started' } });
  const first = await record();
  assert.ok(!first.is_error, first.content);
  const again = await record();
  assert.deepEqual([again.is_error, again.content], [true, 'This person is not allowed to edit here. Tell them to ask the master.']);
  const withEdit = await leasingKit(d, { modules: ['leasing', 'properties'], actions: ['add', 'edit'] })
    .run({ id: 't', name: 'leasing_record_inspection', input: { building: 'Tower', unit_no: '101', kind: 'make_ready', notes: 'Carried on' } });
  assert.ok(!withEdit.is_error, withEdit.content);
});

test('the master is never stopped, and unticking works on the next request', async () => {
  const { master, d } = await diana('delete');
  assert.equal(await hit('DELETE', '/leasing/payments/999'), 404);
  await setAppActions(d.id, []);
  assert.equal(await hit('DELETE', '/leasing/payments/999'), 403);
  caller = master;
  assert.equal(await hit('DELETE', '/leasing/payments/999'), 404);
});
