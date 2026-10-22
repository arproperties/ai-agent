import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { reset, closeDb, db, makeUser, giveModules } from './helpers/db.js';
import { MODULES, userModules, listModuleAccess, setModuleAccess, holders, needed, moduleGate } from '../server/modules.js';
import { alertRoutes, runAlerts } from '../server/leasingAlerts.js';
import { createWorkOrder } from '../server/workOrders.js';
import { adminRoutes } from '../server/admin.js';
import { create, addDocument, setBuildingStaff } from '../server/properties.js';
import { leasingKit, LEASING_TOOLS } from '../server/leasingKit.js';
import { RENEWAL_TOOLS } from '../server/renewals.js';

test.after(() => closeDb());

const ALL = ['tour', 'overview', 'chats', 'leasing', 'tenants', 'workorders', 'reports', 'alerts', 'documents', 'properties', 'sources', 'activity', 'accounts'];

async function people() {
  await reset();
  const master = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  const sara = await makeUser('Sara');
  return { master: { id: master, role: 'master' }, sara: { id: sara, role: 'user' } };
}

test('the modules are the menu, in its order', () => {
  assert.deepEqual(MODULES.map((m) => m.key), ALL);
});

test('nothing ticked is Chats only, and the master has every module', async () => {
  const { master, sara } = await people();
  assert.deepEqual(await userModules(sara), ['chats']);
  assert.deepEqual(await userModules(master), ALL);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM module_access').get()).n, 0, 'nobody is seeded');
});

test('ticking replaces the whole set, drops chats and duplicates, and refuses an unknown key', async () => {
  const { master, sara } = await people();
  assert.equal(await setModuleAccess(sara.id, ['workorders', 'chats', 'workorders', 'tenants']), 2);
  assert.deepEqual(await userModules(sara), ['chats', 'tenants', 'workorders']);

  assert.equal(await setModuleAccess(sara.id, ['reports']), 1);
  assert.deepEqual(await userModules(sara), ['chats', 'reports']);

  await assert.rejects(() => setModuleAccess(sara.id, ['reports', 'payroll']), (e) => e.status === 400 && /Unknown module: payroll/.test(e.message));
  assert.deepEqual(await userModules(sara), ['chats', 'reports'], 'a refused save changes nothing');

  await assert.rejects(() => setModuleAccess(9999, ['reports']), (e) => e.status === 404);
  assert.equal(await setModuleAccess(sara.id, 'not a list'), 0);
  assert.deepEqual(await userModules(sara), ['chats']);

  assert.equal(await setModuleAccess(master.id, ['reports']), 0, 'the master is never listed');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM module_access').get()).n, 0);
});

test('the People screen is told every module, which are on, and that Chats is locked', async () => {
  const { master, sara } = await people();
  await giveModules(sara.id, 'leasing');
  const a = await listModuleAccess(sara.id);
  assert.equal(a.master, false);
  assert.deepEqual(a.modules.map((m) => m.key), ALL);
  assert.deepEqual(a.modules.filter((m) => m.on).map((m) => m.key), ['chats', 'leasing']);
  assert.deepEqual(a.modules.filter((m) => m.locked).map((m) => m.key), ['chats']);
  assert.equal(a.modules.find((m) => m.key === 'workorders').label, 'Work orders');

  const m = await listModuleAccess(master.id);
  assert.equal(m.master, true);
  assert.ok(m.modules.every((x) => x.on));
  await assert.rejects(() => listModuleAccess(9999), (e) => e.status === 404);
});

test('holders are the master and whoever is ticked', async () => {
  const { master, sara } = await people();
  const omar = await makeUser('Omar');
  await giveModules(sara.id, 'alerts');
  assert.deepEqual([...(await holders('alerts'))].sort(), [master.id, sara.id].sort());
  assert.deepEqual([...(await holders('reports'))], [master.id]);
  assert.equal((await holders('alerts')).has(omar), false);
  await db.prepare('UPDATE users SET disabled = true WHERE id = ?').run(sara.id);
  assert.equal((await holders('alerts')).has(sara.id), false, 'a disabled account is not buzzed');
  const boss2 = await makeUser('Boss2');
  await db.prepare("UPDATE users SET role = 'master', disabled = true WHERE id = ?").run(boss2);
  assert.equal((await holders('alerts')).has(boss2), false, 'nor a disabled master');
});

test('each route names the modules that may read it and the modules that may change it', () => {
  const rule = (path) => [needed('GET', path), needed('POST', path)];
  assert.deepEqual(rule('/leasing/overview'), [['overview', 'leasing'], []]);
  assert.deepEqual(rule('/leasing/bookings'), [['leasing'], ['leasing']]);
  assert.deepEqual(rule('/leasing/bookings/7/payments'), [['leasing'], ['leasing']]);
  assert.deepEqual(rule('/leasing/payments/7/receipt'), [['leasing'], ['leasing']]);
  assert.deepEqual(rule('/leasing/available'), [['leasing'], ['leasing']]);
  assert.deepEqual(rule('/leasing/tenants'), [['tenants', 'leasing', 'reports'], ['tenants', 'leasing']]);
  assert.deepEqual(rule('/leasing/tenants/3'), [['tenants', 'leasing', 'reports'], ['tenants', 'leasing']]);
  assert.deepEqual(rule('/leasing/tenants/3/history'), [['tenants'], ['tenants']]);
  assert.deepEqual(rule('/leasing/tenants/3/log'), [['tenants'], ['tenants']]);
  assert.deepEqual(rule('/leasing/log/9/files'), [['tenants'], ['tenants']]);
  assert.deepEqual(rule('/leasing/services'), [['leasing', 'properties'], ['leasing', 'properties']]);
  assert.deepEqual(rule('/leasing/sources/2'), [['sources', 'leasing'], ['sources', 'leasing']]);
  assert.deepEqual(rule('/leasing/work-orders'), [['workorders', 'leasing'], ['workorders']]);
  assert.deepEqual(rule('/leasing/work-orders/5/notes'), [['workorders', 'leasing'], ['workorders']]);
  assert.deepEqual(rule('/leasing/units/4/inspections'), [['leasing', 'properties'], ['leasing', 'properties']]);
  assert.deepEqual(rule('/leasing/inspection-photos/4'), [['leasing', 'properties'], ['leasing', 'properties']]);
  assert.deepEqual(rule('/leasing/reports/rent_roll'), [['reports'], []]);
  assert.deepEqual(rule('/leasing/alerts'), [['alerts', 'overview'], ['alerts']]);
  assert.deepEqual(needed('GET', '/leasing/alerts/reminder/8'), ['alerts', 'overview', 'leasing']);
  assert.deepEqual(needed('POST', '/leasing/alerts/reminder/8'), ['alerts', 'leasing']);
  assert.deepEqual(rule('/leasing/alerts/count'), ['*', []]);
  assert.deepEqual(rule('/leasing/region'), ['*', '*']);
  assert.deepEqual(rule('/properties/renewals'), [['documents'], ['documents']]);
  assert.deepEqual(rule('/properties/documents'), [['documents', 'properties'], ['documents', 'properties']]);
  assert.deepEqual(rule('/properties/docs/3/file'), [['documents', 'properties'], ['documents', 'properties']]);
  assert.deepEqual(rule('/properties/companies/3/docs'), [['documents', 'properties'], ['documents', 'properties']]);
  assert.deepEqual(rule('/properties/places'), [['documents', 'properties'], ['documents', 'properties']]);
  assert.deepEqual(rule('/properties/plans'), [['leasing', 'properties'], ['leasing', 'properties']]);
  assert.deepEqual(rule('/properties/buildings/2/plan'), [['leasing', 'properties'], ['leasing', 'properties']]);
  assert.deepEqual(rule('/properties/companies'), [['properties', 'leasing', 'reports'], ['properties']]);
  assert.deepEqual(rule('/properties/buildings/2'), [['properties', 'leasing', 'reports'], ['properties']]);
  assert.deepEqual(rule('/properties/unit-photos/2'), [['properties', 'leasing', 'reports'], ['properties']]);
  // An id written another way (5.0, %35) is the same id to the route, so the same rule.
  assert.deepEqual(needed('GET', '/leasing/tenants/5.0/history'), ['tenants']);
  assert.deepEqual(needed('GET', '/leasing/tenants/%35/history'), ['tenants']);
  assert.deepEqual(needed('POST', '/leasing/tenants/%35/log'), ['tenants']);
  assert.deepEqual(needed('GET', '/properties/companies/1.0/docs'), ['documents', 'properties']);
  assert.deepEqual(needed('GET', '/properties/companies/%31/docs'), ['documents', 'properties']);
  // A leasing route nobody has given a rule is the master's until somebody does.
  assert.deepEqual(rule('/leasing/something-new'), [[], []]);
  assert.deepEqual(needed('GET', '/Leasing/Bookings'), ['leasing'], 'Express matches a mount whatever its case, so the gate does too');
  // Everything else in the app is not a module's and is left alone.
  for (const p of ['/todos', '/messenger/chats', '/admin/users', '/auth/me', '/buildings', '/leasingx']) assert.equal(needed('GET', p), null, p);
});

// The gate over real HTTP, mounted as index.js mounts it, in front of a stand-in for every route.
let caller = { id: 0, role: 'user' };
const app = express();
app.use('/api', (req, res, next) => { req.user = caller; next(); });
app.use('/api', moduleGate);
app.use('/api', (req, res) => res.json({ ok: true }));
const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
test.after(() => new Promise((ok) => server.close(ok)));
const hit = async (method, path) => (await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method })).status;

test('a person reaches only the routes of the modules they hold', async () => {
  const { master, sara } = await people();
  caller = sara;
  assert.equal(await hit('GET', '/leasing/bookings'), 403);
  assert.equal(await hit('GET', '/properties/companies'), 403);
  assert.equal(await hit('GET', '/leasing/something-new'), 403, 'a route with no rule is refused, not let through');
  for (const p of ['/Leasing/bookings', '/LEASING/something-new', '/PROPERTIES/companies']) assert.equal(await hit('GET', p), 403, p);
  assert.equal(await hit('GET', '/todos'), 200, 'the rest of the app is untouched');
  assert.equal(await hit('GET', '/leasing/region'), 200);
  assert.equal(await hit('GET', '/leasing/alerts/count'), 200);
  const refused = await fetch(`http://127.0.0.1:${server.address().port}/api/leasing/bookings`);
  assert.deepEqual(await refused.json(), { error: 'Not allowed' });

  await giveModules(sara.id, 'workorders');
  assert.equal(await hit('GET', '/leasing/work-orders'), 200);
  assert.equal(await hit('POST', '/leasing/work-orders'), 200);
  assert.equal(await hit('GET', '/leasing/bookings'), 403);

  caller = master;
  for (const p of ['/leasing/bookings', '/leasing/something-new', '/properties/companies']) assert.equal(await hit('GET', p), 200, p);
  assert.equal(await hit('DELETE', '/leasing/reports/rent_roll'), 200, 'the master is never stopped here');
});

test('Leasing alone can make a lease: every read its form makes is allowed', async () => {
  const { sara } = await people();
  await giveModules(sara.id, 'leasing');
  caller = sara;
  for (const p of ['/properties/companies', '/properties/companies/1', '/properties/buildings/1', '/leasing/tenants', '/leasing/sources',
    '/leasing/services', '/leasing/available', '/leasing/bookings', '/leasing/overview', '/properties/plans', '/leasing/work-orders']) {
    assert.equal(await hit('GET', p), 200, p);
  }
  for (const p of ['/leasing/bookings', '/leasing/tenants', '/leasing/sources', '/leasing/services']) assert.equal(await hit('POST', p), 200, p);
  // What it reads from another module, it may not change there.
  assert.equal(await hit('POST', '/leasing/work-orders'), 403);
  assert.equal(await hit('POST', '/properties/companies'), 403);
  assert.equal(await hit('GET', '/leasing/tenants/1/history'), 403, 'a tenant’s history is the Tenants screen’s');
  assert.equal(await hit('GET', '/leasing/tenants/1.0/history'), 403, 'the id written another way is the same route');
  assert.equal(await hit('GET', '/leasing/reports/rent_roll'), 403);
});

test('unticking takes effect on the next request', async () => {
  const { sara } = await people();
  await giveModules(sara.id, 'reports');
  caller = sara;
  assert.equal(await hit('GET', '/leasing/reports/rent_roll'), 200);
  await setModuleAccess(sara.id, []);
  assert.equal(await hit('GET', '/leasing/reports/rent_roll'), 403);
});

test('the sidebar counts only what the person can open', async () => {
  const { master, sara } = await people();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  await addDocument({ building_id: b.id, title: 'Fire insurance', expiry_date: '2020-01-01' }); // long expired: an alert today

  let who = sara;
  const counts = express();
  counts.use((req, res, next) => { req.user = who; next(); });
  counts.use('/api/leasing/alerts', alertRoutes);
  const s = await new Promise((ok) => { const x = counts.listen(0, '127.0.0.1', () => ok(x)); });
  const count = async () => (await fetch(`http://127.0.0.1:${s.address().port}/api/leasing/alerts/count`)).json();
  try {
    assert.deepEqual([(await count()).count, (await count()).rules.document], [0, 0], 'with neither module, nothing');
    await giveModules(sara.id, 'documents');
    assert.deepEqual([(await count()).count, (await count()).rules.document], [0, 1], 'Documents shows its own badge only');
    await giveModules(sara.id, 'alerts');
    assert.equal((await count()).rules.document, 1);
    assert.ok((await count()).count >= 1);
    who = master;
    assert.equal((await count()).rules.document, 1);
  } finally { await new Promise((ok) => s.close(ok)); }
});

test('only the master ticks modules, over HTTP', async () => {
  const { master, sara } = await people();
  let who = sara;
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.user = who; next(); });
  a.use('/api/admin', adminRoutes);
  a.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const s = await new Promise((ok) => { const x = a.listen(0, '127.0.0.1', () => ok(x)); });
  const url = `http://127.0.0.1:${s.address().port}/api/admin/users/${sara.id}/modules`;
  const put = (modules) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modules }) });
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await put(['reports'])).status, 403);
    assert.deepEqual(await userModules(sara), ['chats'], 'she cannot tick her own');

    who = master;
    const saved = await put(['reports', 'chats']);
    assert.deepEqual([saved.status, await saved.json()], [200, { ok: true, modules: 1 }]);
    const read = await (await fetch(url)).json();
    assert.deepEqual(read.modules.filter((m) => m.on).map((m) => m.key), ['chats', 'reports']);

    const wrong = await put(['payroll']);
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /Unknown module: payroll/);
  } finally { await new Promise((ok) => s.close(ok)); }
});

test('Riley carries only the tools of the modules a person holds', async () => {
  const { sara } = await people();
  const names = (modules) => leasingKit(sara, { modules }).definitions.map((d) => d.name).sort();

  assert.deepEqual(names(['chats']), [], 'Chats alone looks nothing up in leasing');
  assert.deepEqual(names(['chats', 'workorders']), ['leasing_add_work_order', 'leasing_update_work_order', 'leasing_work_orders']);
  assert.deepEqual(names(['chats', 'reports']), ['leasing_report', 'leasing_tenant_statement']);
  assert.deepEqual(names(['chats', 'documents']), RENEWAL_TOOLS.map((t) => t.name).sort());
  assert.ok(names(['chats', 'tenants']).includes('leasing_tenant_history'));
  assert.ok(!names(['chats', 'leasing']).includes('leasing_tenant_history'));
  assert.equal(leasingKit(sara).definitions.length, LEASING_TOOLS.length + RENEWAL_TOOLS.length, 'no modules given: everything, as before');
  // Every tool belongs to some module: none is left that nobody could be given.
  const every = names(MODULES.map((m) => m.key));
  assert.equal(every.length, LEASING_TOOLS.length + RENEWAL_TOOLS.length);

  // A tool it does not carry is refused if asked for anyway.
  const kit = leasingKit(sara, { modules: ['chats', 'tenants'] });
  const report = await kit.run({ id: 't', name: 'leasing_report', input: { report: 'rent_roll' } });
  assert.equal(report.is_error, true);
  assert.match(report.content, /does not have that part of the app/);
  // The list tool is shared: it answers for what they hold and refuses the rest.
  const tenants = await kit.run({ id: 't', name: 'leasing_list', input: { what: 'tenants' } });
  assert.notEqual(tenants.is_error, true);
  const leases = await kit.run({ id: 't', name: 'leasing_list', input: { what: 'bookings' } });
  assert.equal(leases.is_error, true);
  assert.match(leases.content, /does not have that part of the app/);
});

test('a building’s staff are buzzed only about modules they hold', async () => {
  const { master, sara } = await people();
  const omar = await makeUser('Omar');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  await setBuildingStaff(b.id, [sara.id, omar]);
  await addDocument({ building_id: b.id, title: 'Fire insurance', expiry_date: '2027-01-08' }); // its window opens on 2026-10-10

  // Neither has Alerts: only the master hears, and nothing breaks for the two who do not.
  assert.deepEqual((await runAlerts('2026-10-10', 9)).map((n) => n.user_id), [master.id]);
  // Ticked later, she is told of what she has never been told.
  await giveModules(sara.id, 'alerts');
  assert.deepEqual((await runAlerts('2026-10-10', 10)).map((n) => n.user_id), [sara.id]);

  const sent = [];
  const push = async (to) => { sent.push([...to].sort((x, y) => x - y)); };
  await createWorkOrder({ unit_id: u.id, detail: 'Water through the ceiling', priority: 'urgent' }, master.id, '2026-10-10', { push });
  assert.deepEqual(sent, [], 'neither has Work orders, and the master raised it');
  await giveModules(omar, 'workorders');
  await createWorkOrder({ unit_id: u.id, detail: 'Sparks from a socket', priority: 'urgent' }, master.id, '2026-10-10', { push });
  assert.deepEqual(sent, [[omar]]);
});
