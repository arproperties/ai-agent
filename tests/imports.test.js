import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { pauseFor, cleanIgnored, importsFor } from '../server/imports.js';

test.after(() => closeDb());

// ---------- pauseFor: Claude's trouble is not the file's ----------

test('an empty credit balance pauses the queue for a while', () => {
  const p = pauseFor('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');
  assert.equal(p.reason, 'credits');
});

test('rate limits and overload pause briefly', () => {
  for (const m of ['429 {"type":"rate_limit_error"}', '529 {"type":"overloaded_error"}', 'Connection error.']) {
    assert.equal(pauseFor(m)?.reason, 'busy', m);
  }
});

test('a file that cannot be read is the file\'s problem, not a pause', () => {
  for (const m of ['No readable text found', 'Unsupported file type: x.bin', 'This scanned PDF has 140 pages; the limit for scanned documents is 100']) {
    assert.equal(pauseFor(m), null, m);
  }
});

// ---------- cleanIgnored: only the counts the summary knows how to say ----------

test('cleanIgnored keeps known kinds with positive whole counts', () => {
  assert.deepEqual(cleanIgnored({ voice: 894, excel: '18', videos: 0, contacts: -3, archives: 1.7, bogus: 5 }), { voice: 894, excel: 18, archives: 1 });
});

test('cleanIgnored survives nothing at all', () => {
  assert.deepEqual(cleanIgnored(undefined), {});
});

// ---------- importsFor: progress read off the files themselves ----------

test('importsFor counts waiting, filed and failed files', async () => {
  await reset();
  const uid = await makeUser();
  const { id } = await db.prepare(`INSERT INTO imports (user_id, name, added, ignored, uploaded) VALUES (?, 'Chat', 3, '{"voice":2}', true) RETURNING id`).run(uid);
  for (const status of ['queued', 'ready', 'error']) {
    await db.prepare('INSERT INTO documents (user_id, name, status, import_id) VALUES (?, ?, ?, ?)').run(uid, `${status}.pdf`, status, id);
  }
  const [imp] = await importsFor(uid);
  assert.equal(imp.waiting, 1);
  assert.equal(imp.filed, 1);
  assert.equal(imp.failed, 1);
  assert.deepEqual(imp.ignored, { voice: 2 });
});

test('importsFor shows only the user\'s own imports', async () => {
  await reset();
  const aid = await makeUser();
  const bid = await makeUser();
  await db.prepare(`INSERT INTO imports (user_id, name) VALUES (?, 'Mine')`).run(aid);
  assert.equal((await importsFor(bid)).length, 0);
});
