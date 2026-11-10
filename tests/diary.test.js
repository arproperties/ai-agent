import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { listEntries, getEntry, createEntry, updateEntry, deleteEntry } from '../server/diary.js';
import { userModules } from '../server/modules.js';

test.after(() => closeDb());

const drawing = JSON.stringify({ w: 800, h: 600, strokes: [{ c: '#111', s: 3, p: [1, 2, 50, 3, 4, 50] }] });

test('a page keeps its writing and its pen strokes', async () => {
  await reset();
  const rona = await makeUser('Rona');
  const e = await createEntry(rona, { title: '  Site  visit ', body: 'Pump room leaks', drawing, thumb: 'data:image/png;base64,AAAA' });
  assert.equal(e.title, 'Site visit');
  assert.equal(e.drawing, drawing);

  const [row] = await listEntries(rona);
  assert.equal(row.preview, 'Pump room leaks');
  assert.equal(row.has_drawing, true);
  assert.equal(row.drawing, undefined, 'the list does not carry every stroke');

  // Saving the writing alone leaves the drawing as it was.
  const after = await updateEntry(rona, e.id, { body: 'Pump room leaks - fixed' });
  assert.equal(after.drawing, drawing);
  // An empty canvas is no drawing.
  assert.equal((await updateEntry(rona, e.id, { drawing: { strokes: [] } })).drawing, null);
  await assert.rejects(updateEntry(rona, e.id, { drawing: 'not json' }), /could not be read/);
  await assert.rejects(updateEntry(rona, e.id, { thumb: 'javascript:alert(1)' }), /preview/);
});

test('a diary is private: nobody else, the master included, reads or changes it', async () => {
  await reset();
  const rona = await makeUser('Rona');
  const said = await makeUser('Said');
  const e = await createEntry(rona, { body: 'mine' });
  assert.equal((await listEntries(said)).length, 0);
  await assert.rejects(getEntry(said, e.id), /not found/);
  await assert.rejects(updateEntry(said, e.id, { body: 'hacked' }), /not found/);
  await assert.rejects(deleteEntry(said, e.id), /not found/);
  assert.equal((await getEntry(rona, e.id)).body, 'mine');
});

test('pinned pages come first, search finds the title or the text', async () => {
  await reset();
  const rona = await makeUser('Rona');
  const a = await createEntry(rona, { title: 'Keys', body: 'Unit 304 keys with Ali' });
  await createEntry(rona, { title: 'Ideas', body: 'new lobby' });
  await updateEntry(rona, a.id, { pinned: true });
  assert.equal((await listEntries(rona))[0].id, a.id);
  assert.deepEqual((await listEntries(rona, { q: 'lobby' })).map((r) => r.title), ['Ideas']);
  assert.deepEqual((await listEntries(rona, { q: '304' })).map((r) => r.title), ['Keys']);
  assert.equal((await listEntries(rona, { q: '%' })).length, 0, 'a % is searched for, not a wildcard');
  await deleteEntry(rona, a.id);
  assert.equal((await listEntries(rona)).length, 1);
});

test('Diary is a company module: ticked people get it, external people never do', async () => {
  await reset();
  const rona = await makeUser('Rona');
  const guest = await makeUser('Guest');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(guest);
  assert.ok(!(await userModules({ id: rona, role: 'user' })).includes('diary'), 'not given until ticked');
  for (const id of [rona, guest]) await db.prepare("INSERT INTO module_access (user_id, module) VALUES (?, 'diary')").run(id);
  assert.ok((await userModules({ id: rona, role: 'user' })).includes('diary'));
  assert.ok(!(await userModules({ id: guest, role: 'user', external: true })).includes('diary'));
  assert.ok((await userModules({ role: 'master' })).includes('diary'));
});
