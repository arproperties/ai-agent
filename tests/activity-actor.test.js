import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db, tx, reset, makeUser, closeDb } from './helpers/db.js';
import { withActor } from '../server/db.js';
import { create } from '../server/properties.js';
import { createBooking, payBooking } from '../server/leasing.js';
import { attachActivityTriggers, actorContext } from '../server/activityCapture.js';

test.after(() => closeDb());

// Each change in the activity log carries the person who made it, and whether they made it
// on the screens or through the chat.

const log = (table) => db.prepare('SELECT * FROM activity_log WHERE table_name = ? ORDER BY id').all(table);

async function people() {
  await attachActivityTriggers();
  await reset();
  return { sara: await makeUser('Sara') };
}

test('a change made for someone is theirs, with how they made it', async () => {
  const { sara } = await people();
  await withActor({ userId: sara, via: 'screen' }, () => db.prepare('INSERT INTO todos (user_id, text) VALUES (?, ?)').run(sara, 'x'));
  const [row] = await log('todos');
  assert.deepEqual([row.actor_user_id, row.actor_name, row.via], [sara, 'Sara', 'screen']);
});

test('a change inside a transaction carries the person too', async () => {
  const { sara } = await people();
  await withActor({ userId: sara, via: 'chat' }, () => tx(async () => {
    await db.prepare('INSERT INTO todos (user_id, text) VALUES (?, ?)').run(sara, 'a');
    await db.prepare('INSERT INTO todos (user_id, text) VALUES (?, ?)').run(sara, 'b');
  }));
  const rows = await log('todos');
  assert.deepEqual(rows.map((r) => [r.actor_user_id, r.via]), [[sara, 'chat'], [sara, 'chat']]);
  // the pooled connection does not keep the person for the next, unrelated write
  await db.prepare('INSERT INTO todos (user_id, text) VALUES (?, ?)').run(sara, 'c');
  assert.equal((await log('todos')).at(-1).via, 'system');
});

test('deleting a lease writes down each of its payments going, as the person who deleted it', async () => {
  const { sara } = await people();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  const bk = await createBooking({ unit_id: u.id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 950, status: 'confirmed',
    tenant: { full_name: 'Tom', phone: '050 123 4567' } }, sara);
  await payBooking(bk.id, { amount: 950, method: 'cash', received_on: '2026-09-15' }, sara, '2026-10-01');
  await withActor({ userId: sara, via: 'screen' }, () => db.prepare('DELETE FROM lease_bookings WHERE id = ?').run(bk.id));
  const gone = (await log('lease_payments')).filter((r) => r.action === 'delete');
  assert.equal(gone.length, 1);
  assert.equal(gone[0].actor_user_id, sara);
  assert.equal(gone[0].old.amount, 950);
});

test('a request to /chat is the chat, any other request the screens', async () => {
  const { sara } = await people();
  const app = express();
  app.use((req, res, next) => { req.user = { id: sara }; next(); });
  app.use(actorContext);
  app.post('/:any', async (req, res) => {
    await db.prepare('INSERT INTO todos (user_id, text) VALUES (?, ?)').run(sara, req.params.any);
    res.json({ ok: true });
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/chat`, { method: 'POST' });
    await fetch(`${base}/todos`, { method: 'POST' });
  } finally {
    server.close();
  }
  assert.deepEqual((await log('todos')).map((r) => [r.new.text, r.via]), [['chat', 'chat'], ['todos', 'screen']]);
});

test('reading changes nothing in the log', async () => {
  const { sara } = await people();
  const before = (await db.prepare('SELECT count(*)::int AS n FROM activity_log').get()).n;
  await withActor({ userId: sara, via: 'screen' }, () => db.prepare('SELECT * FROM todos').all());
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM activity_log').get()).n, before);
});
