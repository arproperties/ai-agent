import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser, giveModules } from './helpers/db.js';
import { MODULES, userModules, listModuleAccess, setModuleAccess, holders } from '../server/modules.js';

test.after(() => closeDb());

const ALL = ['tour', 'overview', 'chats', 'leasing', 'tenants', 'workorders', 'reports', 'alerts', 'documents', 'properties', 'sources'];

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
});
