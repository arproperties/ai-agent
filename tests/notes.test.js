import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { noteName, saveNote } from '../server/files.js';

test.after(() => closeDb());

// ---------- the filename a note is given before the classifier titles it ----------

test('noteName uses the opening words', () => {
  assert.equal(noteName('Notice period is 30 days for permanent staff'), 'Notice period is 30 days for.txt');
});

test('noteName takes only the first line', () => {
  assert.equal(noteName('Parking rules\nVisitors use bay 4 and must sign in'), 'Parking rules.txt');
});

test('noteName drops characters a filename cannot carry', () => {
  assert.equal(noteName('Rent/deposit: AED 4,750 (paid)'), 'Rent deposit AED 4,750 paid.txt');
});

test('noteName falls back to a dated name when there are no usable words', () => {
  assert.match(noteName('***'), /^Note \d{4}-\d{2}-\d{2}\.txt$/);
  assert.match(noteName(''), /^Note \d{4}-\d{2}-\d{2}\.txt$/);
});

// ---------- saveNote: a note is an upload we synthesise ----------

async function fixture() {
  await reset();
  const user = await makeUser('Alice');
  const hr = await makeAgent(user, 'HR');
  return { user, hr };
}

test('a note is stored as a readable text file on the shelf it was written for', async () => {
  const { user, hr } = await fixture();
  const text = 'Notice period is 30 days for permanent staff.';

  const { doc, duplicate } = await saveNote(user, hr, text);

  assert.equal(duplicate, false);
  assert.equal(doc.kind, 'note', 'so the app can tell a note from an uploaded file');
  assert.equal(doc.agent_id, hr);
  assert.equal(doc.mime, 'text/plain');
  assert.equal(doc.shared, false, 'notes are private like everything else until shared');
  assert.ok(doc.path, 'a note needs a path or it cannot be opened');
  assert.equal(readFileSync(doc.path, 'utf8'), text, 'and what is on disk is the note itself');
});

test('a note with no shelf goes to the library, for the classifier to place', async () => {
  const { user } = await fixture();
  const { doc } = await saveNote(user, null, 'Buy more printer paper');
  assert.equal(doc.agent_id, null);
});

test('writing the same note twice does not make a second copy', async () => {
  const { user, hr } = await fixture();
  await saveNote(user, hr, 'Notice period is 30 days');
  const again = await saveNote(user, hr, 'Notice period is 30 days');

  assert.equal(again.duplicate, true);
  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM documents WHERE user_id = ?').get(user);
  assert.equal(n, 1);
});

test('an empty note is refused', async () => {
  const { user, hr } = await fixture();
  for (const empty of ['', '   ', '\n\n']) {
    await assert.rejects(() => saveNote(user, hr, empty), /empty/i, `${JSON.stringify(empty)} should be refused`);
  }
  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM documents').get();
  assert.equal(n, 0);
});

test('an uploaded file is still recorded as a doc, not a note', async () => {
  const { user } = await fixture();
  const { saveUpload } = await import('../server/files.js');
  const { doc } = await saveUpload(user, null, {
    buffer: Buffer.from('a real upload'), originalname: 'thing.txt', mimetype: 'text/plain', size: 13,
  });
  assert.equal(doc.kind, 'doc');
});
