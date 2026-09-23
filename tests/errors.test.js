import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { recordError, recentErrors, errorCount } from '../server/errors.js';

test.after(() => closeDb());

test('an error is recorded against whoever met it', async () => {
  await reset();
  const user = await makeUser('Sara');
  await recordError({ userId: user, source: 'client', message: 'Cannot read properties of null', stack: 'at Chat.jsx:120', url: '/' });

  const [row] = await recentErrors();
  assert.equal(row.message, 'Cannot read properties of null');
  assert.equal(row.source, 'client');
  assert.equal(row.user_id, user);
  assert.equal(row.user_name, 'Sara', 'the list names the person without a second query');
});

test('an error with nobody signed in is still recorded', async () => {
  await reset();
  await recordError({ source: 'client', message: 'Sign-in screen blew up' });

  const [row] = await recentErrors();
  assert.equal(row.user_id, null);
  assert.equal(row.user_name, null);
});

test('deleting an account keeps the faults it met', async () => {
  await reset();
  const user = await makeUser('Sara');
  await recordError({ userId: user, source: 'server', message: 'Timeout talking to Claude' });
  await db.prepare('DELETE FROM users WHERE id = ?').run(user);

  const [row] = await recentErrors();
  assert.equal(row.message, 'Timeout talking to Claude', 'the fault outlives the account');
  assert.equal(row.user_id, null);
});

test('oversized reports are cut down rather than refused', async () => {
  await reset();
  await recordError({ source: 'client', message: 'x'.repeat(5000), stack: 'y'.repeat(99999), url: 'z'.repeat(1000) });

  const [row] = await recentErrors();
  assert.equal(row.message.length, 500);
  assert.equal(row.stack.length, 4000);
  assert.equal(row.url.length, 300);
});

test('a NUL byte in a report does not stop it being stored', async () => {
  await reset();
  // Postgres refuses NUL in text, and a browser can put one in a message. Dropping the
  // byte keeps the report; letting it through would lose the whole row.
  await recordError({ source: 'client', message: 'bad\u0000message' });
  const [row] = await recentErrors();
  assert.equal(row.message, 'badmessage');
});

test('recording an error never throws, whatever it is handed', async () => {
  await reset();
  await recordError({ source: 'client', message: null });
  await recordError({ source: 'nonsense', message: 'odd source' });

  const rows = await recentErrors();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.message === 'Unknown error')?.source, 'client', 'a missing message still records');
  assert.equal(rows.find((r) => r.message === 'odd source')?.source, 'server', 'an unknown source is taken as server-side');
});

test('newest first, and the week count ignores what is older', async () => {
  await reset();
  await recordError({ source: 'server', message: 'old one' });
  await recordError({ source: 'server', message: 'new one' });
  const old = Math.floor(Date.now() / 1000) - 30 * 86400;
  await db.prepare('UPDATE error_log SET created_at = ? WHERE message = ?').run(old, 'old one');

  assert.deepEqual((await recentErrors()).map((r) => r.message), ['new one', 'old one']);
  assert.equal((await errorCount(7)).n, 1, 'last week only');
  assert.equal((await errorCount(60)).n, 2);
});

test('the list is capped however many are asked for', async () => {
  await reset();
  for (let i = 0; i < 5; i++) await recordError({ source: 'server', message: `fault ${i}` });

  assert.equal((await recentErrors(2)).length, 2);
  assert.equal((await recentErrors(99999)).length, 5, 'a huge limit is clamped, not refused');
  assert.equal((await recentErrors(0)).length, 5, 'a junk limit falls back to the default');
});
