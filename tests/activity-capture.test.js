import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { attachActivityTriggers } from '../server/activityCapture.js';

test.after(() => closeDb());

// The activity log: every change to every table is written down by the database itself,
// with the old and the new values, so nothing a feature adds later can slip past it.

const log = (table) => db.prepare('SELECT * FROM activity_log WHERE table_name = ? ORDER BY id').all(table);

async function fresh() {
  await attachActivityTriggers();
  await reset();
  return makeUser('Sara');
}

test('adding, changing and deleting a to-do are each written down, old and new', async () => {
  const sara = await fresh();
  const { id } = await db.prepare('INSERT INTO todos (user_id, text) VALUES (?, ?) RETURNING id').run(sara, 'Call the plumber');
  await db.prepare('UPDATE todos SET text = ?, updated_at = updated_at + 1 WHERE id = ?').run('Call the electrician', id);
  await db.prepare('DELETE FROM todos WHERE id = ?').run(id);

  const [added, changed, deleted] = await log('todos');
  assert.equal(added.action, 'insert');
  assert.equal(added.new.text, 'Call the plumber');
  assert.equal(added.old, null);
  assert.equal(added.row_id, String(id));
  assert.equal(changed.action, 'update');
  assert.deepEqual(changed.changed, ['text'], 'updated_at alone is not a change');
  assert.equal(changed.old.text, 'Call the plumber');
  assert.equal(changed.new.text, 'Call the electrician');
  assert.equal(deleted.action, 'delete');
  assert.equal(deleted.old.text, 'Call the electrician');
  assert.equal(deleted.new, null);
});

test('with nobody signed in, the change is the system\'s', async () => {
  const sara = await fresh();
  await db.prepare('INSERT INTO todos (user_id, text) VALUES (?, ?)').run(sara, 'x');
  const [row] = await log('todos');
  assert.equal(row.via, 'system');
  assert.equal(row.actor_user_id, null);
});

test('passwords and keys are hidden, and long text is cut short', async () => {
  const sara = await fresh();
  const [user] = await log('users');
  assert.equal(user.new.password_hash, '[hidden]');
  assert.equal(user.new.name, 'Sara');
  await db.prepare('INSERT INTO todos (user_id, text) VALUES (?, ?)').run(sara, 'a'.repeat(600));
  const [todo] = await log('todos');
  assert.equal(todo.new.text.length, 501);
  assert.ok(todo.new.text.endsWith('…'));
});

test('a changed password is still logged as a change, without the password', async () => {
  const sara = await fresh();
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('new-hash', sara);
  const rows = await log('users');
  const last = rows.at(-1);
  assert.deepEqual(last.changed, ['password_hash']);
  assert.equal(last.old.password_hash, '[hidden]');
  assert.equal(last.new.password_hash, '[hidden]');
});

test('being seen in the app is not logged', async () => {
  const sara = await fresh();
  const before = (await log('users')).length;
  await db.prepare('UPDATE users SET last_seen_at = 5 WHERE id = ?').run(sara);
  assert.equal((await log('users')).length, before);
});

test('a table added later is picked up by the next sweep', async () => {
  await fresh();
  await db.exec('DROP TABLE IF EXISTS zz_future; CREATE TABLE zz_future (id SERIAL PRIMARY KEY, x TEXT)');
  try {
    assert.ok((await attachActivityTriggers()).includes('zz_future'));
    assert.deepEqual(await attachActivityTriggers(), [], 'a second sweep has nothing left to do');
    await db.prepare('INSERT INTO zz_future (x) VALUES (?)').run('hello');
    const [row] = await log('zz_future');
    assert.equal(row.new.x, 'hello');
  } finally {
    await db.exec('DROP TABLE zz_future');
  }
});

test('the log itself cannot be changed or deleted', async () => {
  const sara = await fresh();
  await db.prepare('INSERT INTO todos (user_id, text) VALUES (?, ?)').run(sara, 'x');
  await assert.rejects(db.exec("UPDATE activity_log SET via = 'screen'"), /cannot be changed/);
  await assert.rejects(db.exec('DELETE FROM activity_log'), /cannot be changed/);
});

test('machine-only tables are left out', async () => {
  const sara = await fresh();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run('t', sara, 1);
  assert.equal((await log('sessions')).length, 0);
});
