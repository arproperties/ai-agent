import './helpers/push-env.js'; // before helpers/db.js: push.js reads the keys as it loads
import test from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { saveSubscription } from '../server/push.js';
import { createTodo, updateTodo } from '../server/todos.js';
import { createRoutine } from '../server/routines.js';
import { runRemindersOnce } from '../server/reminders.js';

test.after(() => closeDb());

// Nothing reaches Apple or Google; what each notice said is recorded instead.
const posted = [];
webpush.sendNotification = async (sub, payload) => { posted.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); return { statusCode: 201 }; };

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);
const device = (n) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: `p-${n}`, auth: `a-${n}` } });

async function person(name = 'Sara', { notifications = true } = {}) {
  const id = await makeUser(name);
  if (notifications) await saveSubscription(id, device(`${name}-${id}`), name);
  return id;
}

const sentRows = () => db.prepare('SELECT * FROM reminders_sent ORDER BY id').all();

test('a reminder whose time has come buzzes the phone', async () => {
  await reset();
  posted.length = 0;
  const me = await person();
  await createTodo(me, { text: 'Renew the trade licence', remind_at: now() - 60 });

  await runRemindersOnce();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].title, 'Reminder');
  assert.equal(posted[0].body, 'Renew the trade licence');
  assert.equal(posted[0].url, '/?todos=1');
});

test('a reminder still in the future says nothing', async () => {
  await reset();
  posted.length = 0;
  const me = await person();
  await createTodo(me, { text: 'Not yet', remind_at: now() + HOUR });

  await runRemindersOnce();

  assert.equal(posted.length, 0);
  assert.equal((await sentRows()).length, 0); // and nothing is written off early
});

test('it buzzes once, not every minute', async () => {
  await reset();
  posted.length = 0;
  const me = await person();
  await createTodo(me, { text: 'Only once', remind_at: now() - 60 });

  await runRemindersOnce();
  await runRemindersOnce();
  await runRemindersOnce();

  assert.equal(posted.length, 1);
});

test('moving a reminder to a new time buzzes again at that time', async () => {
  await reset();
  posted.length = 0;
  const me = await person();
  const t = await createTodo(me, { text: 'Chase the landlord', remind_at: now() - 60 });
  await runRemindersOnce();
  assert.equal(posted.length, 1);

  // Pushed back, then that new time arrives: a moved reminder is a new reminder.
  await updateTodo(me, t.id, { remind_at: now() - 30 });
  await runRemindersOnce();

  assert.equal(posted.length, 2);
  assert.equal((await sentRows()).length, 2); // one row per time it was due, not per todo
});

test('a todo already ticked off is left alone', async () => {
  await reset();
  posted.length = 0;
  const me = await person();
  const t = await createTodo(me, { text: 'Done before it was due', remind_at: now() - 60 });
  await updateTodo(me, t.id, { done: true });

  await runRemindersOnce();

  assert.equal(posted.length, 0);
});

test('a server that was off overnight does not wake anyone to yesterday', async () => {
  await reset();
  posted.length = 0;
  const me = await person();
  await createTodo(me, { text: 'Yesterday morning', remind_at: now() - 20 * HOUR });
  await createTodo(me, { text: 'Ten minutes ago', remind_at: now() - 600 });

  await runRemindersOnce();

  // Only the recent one is worth a buzz. Both are still due, and both are still on the
  // list — this decides what interrupts, not what exists.
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body, 'Ten minutes ago');
  // The stale one is written off so it can never buzz later either.
  assert.equal((await sentRows()).length, 2);

  await runRemindersOnce();
  assert.equal(posted.length, 1);
});

test('several things due at once are one notice, not three', async () => {
  await reset();
  posted.length = 0;
  const me = await person();
  await createTodo(me, { text: 'Call the bank', remind_at: now() - 90 });
  await createTodo(me, { text: 'Send the invoice', remind_at: now() - 60 });
  await createTodo(me, { text: 'Book the flight', remind_at: now() - 30 });

  await runRemindersOnce();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].title, '3 things are due');
  assert.match(posted[0].body, /and 2 more$/);
});

test('each person only hears about their own', async () => {
  await reset();
  posted.length = 0;
  const sara = await person('Sara');
  const tom = await person('Tom');
  await createTodo(sara, { text: 'Sara thing', remind_at: now() - 60 });
  await createTodo(tom, { text: 'Tom thing', remind_at: now() - 60 });

  await runRemindersOnce();

  assert.equal(posted.length, 2);
  const bodies = Object.fromEntries(posted.map((p) => [p.endpoint.split('/').pop().split('-')[0], p.body]));
  assert.equal(bodies.Sara, 'Sara thing');
  assert.equal(bodies.Tom, 'Tom thing');
});

test('somebody who never switched notifications on is not written off', async () => {
  await reset();
  posted.length = 0;
  const me = await person('Quiet', { notifications: false });
  await createTodo(me, { text: 'Still on the list', remind_at: now() - 60 });

  await runRemindersOnce();

  assert.equal(posted.length, 0);
  // The row is still recorded: this is about what was decided, not what a phone received.
  // Their badge and first screen are what tell them, exactly as before.
  assert.equal((await sentRows()).length, 1);
});

test('a routine that has come round buzzes too, and only once per turn', async () => {
  await reset();
  posted.length = 0;
  const me = await person();
  // Anchored yesterday so today's turn is already due.
  await createRoutine(me, { text: 'Water the plants', starts_at: now() - 26 * HOUR, every: 1, unit: 'day' });

  await runRemindersOnce();
  await runRemindersOnce();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].title, 'Routine due');
  assert.equal(posted[0].body, 'Water the plants');
  assert.equal((await sentRows()).length, 1);
  assert.equal((await sentRows())[0].todo_id, null); // recorded against the routine
});

test('a paused routine is silent', async () => {
  await reset();
  posted.length = 0;
  const me = await person();
  const r = await createRoutine(me, { text: 'Paused one', starts_at: now() - 26 * HOUR, every: 1, unit: 'day' });
  await db.prepare('UPDATE routines SET paused = true WHERE id = ?').run(r.id);

  await runRemindersOnce();

  assert.equal(posted.length, 0);
});
