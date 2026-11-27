import './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { titleWords, sameForm, olderVersions, markReplaced } from '../server/shelfVersions.js';

test.after(() => closeDb());

// A saved file with a stored original, as a Save to Shelf or an upload leaves it.
async function file(userId, title, { kind = 'doc', name = `${title}.pdf` } = {}) {
  const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, kind, status, path)
    VALUES (?, ?, ?, ?, 'ready', ?) RETURNING id`).run(userId, name, title, kind, `/tmp/${title}.pdf`);
  return id;
}
const oldOf = async (id) => (await db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(id)).superseded_by;

test('the version in brackets is not part of the name', () => {
  assert.deepEqual([...titleWords('Ayla Building – Quarterly AC Service Checklist (Level 2).pdf')],
    ['ayla', 'building', 'quarterly', 'ac', 'service', 'checklist']);
  assert.ok(sameForm('Ayla Building – Quarterly AC Service Checklist (Indoor Unit Only)', 'Ayla Building – Quarterly AC Service Checklist (Level 2)'));
  // Another building's form, or another kind of form, is not the same one.
  assert.ok(!sameForm('Ayla Building – Quarterly AC Service Checklist', 'Camps – Quarterly AC Preventive Maintenance Checklist'));
  assert.ok(!sameForm('Ayla Building – Quarterly AC Service Checklist', 'Park Place – Quarterly AC Service Checklist'));
});

test('finds the older copy of the same form, and the file the reply was made from', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const level2 = await file(boss, 'Ayla Building – Quarterly AC Service Checklist (Level 2)');
  await file(boss, 'Camps – Quarterly AC Preventive Maintenance Checklist');
  const contract = await file(boss, 'Labour Contract – Faisal Khan');
  await file(boss, 'Ayla AC fact', { kind: 'fact' });
  const fresh = await file(boss, 'Ayla Building – Quarterly AC Service Checklist (Indoor Unit Only)');
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(fresh);

  const found = await olderVersions(boss, doc, doc.title, 'cut down from the Level 2 checklist');
  assert.deepEqual(found.map((f) => f.id), [level2]);

  // Named by its number: found even under another heading, the 25 Nov "Packet".
  const packet = await file(boss, 'Ayla Building – Quarterly AC Preventive Maintenance Packet (Level 2)');
  const p = await db.prepare('SELECT * FROM documents WHERE id = ?').get(packet);
  assert.deepEqual((await olderVersions(boss, p, p.title, `This is the Level 2 checklist (file #${level2}).`)).map((f) => f.id), [level2]);
  // A number with nothing in common with the title is a chat or something else: left alone.
  assert.deepEqual(await olderVersions(boss, p, p.title, `see #${contract}`), []);
});

test('only their own current files are offered', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const other = await makeUser('Other');
  await file(other, 'Ayla Building – Quarterly AC Service Checklist');
  const gone = await file(boss, 'Ayla Building – Quarterly AC Service Checklist (Level 1)');
  const fresh = await file(boss, 'Ayla Building – Quarterly AC Service Checklist (Indoor Unit Only)');
  await db.prepare('UPDATE documents SET superseded_by = ? WHERE id = ?').run(fresh, gone);
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(fresh);
  assert.deepEqual(await olderVersions(boss, doc, doc.title), []);
});

test('Yes marks the old copy OLD, replaced by the new one, and only for the owner', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const other = await makeUser('Other');
  const old = await file(boss, 'Ayla Building – Quarterly AC Service Checklist (Level 2)');
  const fresh = await file(boss, 'Ayla Building – Quarterly AC Service Checklist (Indoor Unit Only)');
  const theirs = await file(other, 'Ayla Building – Quarterly AC Service Checklist');

  assert.equal(await markReplaced(other, fresh, old), false);
  assert.equal(await markReplaced(boss, fresh, theirs), false);
  assert.equal(await markReplaced(boss, fresh, fresh), false);
  assert.equal(await oldOf(old), null);

  assert.equal(await markReplaced(boss, fresh, old), true);
  assert.equal(await oldOf(old), fresh);
  // Already OLD: not marked again, and the OLD copy cannot replace the current one.
  assert.equal(await markReplaced(boss, fresh, old), false);
  assert.equal(await markReplaced(boss, old, fresh), false);
  assert.equal(await oldOf(fresh), null);
});
