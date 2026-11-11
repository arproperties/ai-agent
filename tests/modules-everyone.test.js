import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { moduleOverview, setModuleForAll, setModuleForNewPeople, userModules } from '../server/modules.js';
import { createUser } from '../server/admin.js';

test.after(() => closeDb());

const user = (id) => db.prepare('SELECT id, role, external FROM users WHERE id = ?').get(id);

test('give to all reaches the staff, never the master or an external person', async () => {
  await reset();
  const boss = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(boss);
  const rona = await makeUser('Rona');
  const said = await makeUser('Said');
  const lawyer = await makeUser('Lawyer');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(lawyer);

  assert.equal(await setModuleForAll('diary', true), 2);
  assert.ok((await userModules(await user(rona))).includes('diary'));
  assert.ok((await userModules(await user(said))).includes('diary'));
  const rows = await db.prepare('SELECT user_id FROM module_access WHERE module = ?').all('diary');
  assert.deepEqual(rows.map((r) => r.user_id).sort(), [rona, said].sort());

  const o = await moduleOverview();
  assert.equal(o.staff, 2);
  assert.equal(o.modules.find((m) => m.key === 'diary').have, 2);
});

test('take from all leaves an external person their own modules', async () => {
  await reset();
  const rona = await makeUser('Rona');
  const lawyer = await makeUser('Lawyer');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(lawyer);
  await db.prepare("INSERT INTO module_access (user_id, module) VALUES (?, 'shelf'), (?, 'shelf')").run(rona, lawyer);

  assert.equal(await setModuleForAll('shelf', false), 0);
  assert.ok(!(await userModules(await user(rona))).includes('shelf'));
  assert.ok((await userModules(await user(lawyer))).includes('shelf'));
});

test('new people start with the modules marked for them, nobody already here changes', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const rona = await makeUser('Rona');
  await setModuleForNewPeople('diary', true);
  assert.ok(!(await userModules(await user(rona))).includes('diary'));

  const fresh = await createUser({ id: boss }, { name: 'New', email: 'new@example.com', password: 'longenough1' });
  assert.ok((await userModules(await user(fresh.id))).includes('diary'));

  await setModuleForNewPeople('diary', false);
  const later = await createUser({ id: boss }, { name: 'Later', email: 'later@example.com', password: 'longenough1' });
  assert.ok(!(await userModules(await user(later.id))).includes('diary'));
  await assert.rejects(setModuleForAll('nope', true), /Unknown module/);
});
