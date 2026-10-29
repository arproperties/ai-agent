import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { ensureActionAccess } from '../server/db.js';
import { ACTIONS, userActions, listAppActions, setAppActions } from '../server/actions.js';
import { LABELS } from '../server/activity.js';

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
