import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import {
  listFor, addResponsibility, updateResponsibility, deleteResponsibility, responsibilityKit, propose, decide,
} from '../server/responsibilities.js';

test.after(() => closeDb());

const ask = async (kit, person) =>
  (await kit.run({ id: 't1', name: 'team_responsibilities', input: person ? { person } : {} })).content;

test('the master writes, edits and deletes; each person has their own list', async () => {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const rona = await makeUser('Rona');
  const sam = await makeUser('Sam');

  const long = 'Collect rent.\n'.repeat(500);
  const a = await addResponsibility(master, rona, { title: '  Rent   collection ', body: long });
  assert.equal(a.title, 'Rent collection');
  assert.equal(a.body, long.trim(), 'long free text is kept whole, line breaks and all');
  await addResponsibility(master, sam, { body: 'Maintenance calls' });

  assert.equal((await listFor(rona)).length, 1);
  assert.equal((await listFor(sam))[0].title, null, 'a title is optional');

  const b = await updateResponsibility(master, a.id, { title: 'Rent', body: 'Monthly' });
  assert.equal(b.body, 'Monthly');
  await assert.rejects(addResponsibility(master, rona, { title: ' ', body: '\n' }), /Write something/);
  await assert.rejects(addResponsibility(master, 9999, { body: 'x' }), /not found/);

  assert.equal(await deleteResponsibility(a.id), true);
  assert.equal((await listFor(rona)).length, 0);
});

test('Riley can say who handles what, for everyone, one person, or "me"', async () => {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const rona = await makeUser('Rona');
  const sam = await makeUser('Sam');
  await addResponsibility(master, rona, { title: 'Rent collection', body: 'Chase late payers' });
  await addResponsibility(master, sam, { title: 'Maintenance' });

  const all = await ask(responsibilityKit({ id: sam }));
  assert.match(all, /Rona:\n- Rent collection: Chase late payers/);
  assert.match(all, /Sam \(the user\):\n- Maintenance/);
  assert.doesNotMatch(await ask(responsibilityKit({ id: sam }), 'rona'), /Maintenance/);
  assert.doesNotMatch(all, /#\d/, 'ids are only shown to the master');
  assert.match(await ask(responsibilityKit(master)), /#1 Rent collection/);
  assert.match(await ask(responsibilityKit({ id: sam }), 'me'), /Sam \(the user\)/);

  await db.prepare('UPDATE users SET disabled = true WHERE id = ?').run(sam);
  assert.doesNotMatch(await ask(responsibilityKit(master)), /Sam/, 'a disabled account is left out');
});

test('only the master gets the tools that change them', () => {
  const names = (u) => responsibilityKit(u).definitions.map((d) => d.name);
  assert.deepEqual(names({ id: 2, role: 'user' }), ['team_responsibilities']);
  assert.deepEqual(names({ id: 1, role: 'master' }),
    ['team_responsibilities', 'assign_responsibility', 'change_responsibility', 'remove_responsibility']);
});

test('from chat, nothing changes until Save, and Save happens once', async () => {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const rona = await makeUser('Rona');
  let card = null;
  const kit = responsibilityKit(master, { onCard: (p) => { card = p; } });
  const call = (name, input) => kit.run({ id: 't', name, input });

  const out = await call('assign_responsibility', { person: 'rona', title: 'Rent', body: 'Chase late payers' });
  assert.match(out.content, /NOT saved/);
  assert.equal(card.person, 'Rona');
  assert.equal((await listFor(rona)).length, 0, 'proposed only');

  const saved = await decide(master, card.id, true);
  assert.equal(saved.status, 'saved');
  const [r] = await listFor(rona);
  assert.equal(r.body, 'Chase late payers');
  await assert.rejects(decide(master, card.id, true), /already/);
  assert.equal((await listFor(rona)).length, 1, 'a second tap writes nothing');

  await call('change_responsibility', { id: r.id, append: 'Send receipts' });
  assert.equal(card.body, 'Chase late payers\nSend receipts');
  await decide(master, card.id, false);
  assert.equal((await listFor(rona))[0].body, 'Chase late payers', 'cancel leaves it alone');

  await call('remove_responsibility', { id: r.id });
  await decide(master, card.id, true);
  assert.equal((await listFor(rona)).length, 0);

  const nobody = await call('assign_responsibility', { person: 'Zed', body: 'x' });
  assert.equal(nobody.is_error, true);
  assert.match(nobody.content, /Nobody called "Zed"/);
  await assert.rejects(propose(master, { action: 'edit', id: 999, body: 'x' }), /no responsibility #999/);
});
