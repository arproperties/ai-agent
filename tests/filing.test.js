import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { pickShelf, saveUpload } from '../server/files.js';

test.after(() => closeDb());

// ---------- pickShelf: what the classifier is allowed to come back with ----------

const roster = [{ id: 3, name: 'Lawyer' }, { id: 7, name: 'HR' }];

test('pickShelf accepts an agent from the roster', () => {
  assert.equal(pickShelf(7, roster), 7);
});

test('pickShelf accepts the id as a string, which is how JSON often carries it', () => {
  assert.equal(pickShelf('3', roster), 3);
});

test('pickShelf refuses an agent that is not on offer', () => {
  assert.equal(pickShelf(99, roster), null, 'the model must not be able to name any agent it likes');
});

test('pickShelf falls back to the library when the model declines', () => {
  for (const raw of [null, undefined, '', 'none', 0, NaN, {}]) {
    assert.equal(pickShelf(raw, roster), null, `${JSON.stringify(raw)} should mean the library`);
  }
});

test('pickShelf returns the library when there is no roster', () => {
  assert.equal(pickShelf(3, []), null);
});

// ---------- dedup: one copy of a file per person, wherever it is filed ----------

const file = (text, name = 'contract.pdf') => ({
  buffer: Buffer.from(text), originalname: name, mimetype: 'application/pdf', size: text.length,
});

test('the same bytes are not stored twice, even when filed to a different agent', async () => {
  await reset();
  const user = await makeUser('Alice');
  const lawyer = await makeAgent(user, 'Lawyer');
  const hr = await makeAgent(user, 'HR');

  const first = await saveUpload(user, lawyer, file('tenancy agreement'));
  const second = await saveUpload(user, hr, file('tenancy agreement'));

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true, 'the classifier may pick a different shelf on a re-upload');
  assert.equal(second.doc.id, first.doc.id, 'and it must find the file already there, not make a second');

  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM documents WHERE user_id = ?').get(user);
  assert.equal(n, 1);
});

test('two people uploading the same bytes each keep their own copy', async () => {
  await reset();
  const alice = await makeUser('Alice');
  const bob = await makeUser('Bob');

  await saveUpload(alice, null, file('company handbook'));
  const bobs = await saveUpload(bob, null, file('company handbook'));

  assert.equal(bobs.duplicate, false, 'dedup is per person, never across people');
  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM documents').get();
  assert.equal(n, 2);
});

test('different bytes are still separate files', async () => {
  await reset();
  const user = await makeUser('Alice');

  await saveUpload(user, null, file('tenancy agreement'));
  const other = await saveUpload(user, null, file('invoice', 'invoice.pdf'));

  assert.equal(other.duplicate, false);
  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM documents WHERE user_id = ?').get(user);
  assert.equal(n, 2);
});
