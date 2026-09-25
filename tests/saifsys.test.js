import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

// A stand-in for saifsys's api/jarvis/v1: it checks the key and answers from `bookings`.
let bookings = [];
let calls = 0;
let down = false;
const fake = createServer((req, res) => {
  calls++;
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (down) return send(500, { ok: false, error: { message: 'boom' } });
  if (req.headers['x-jarvis-key'] !== 'test-key') return send(401, { ok: false, error: { message: 'Not authorised.' } });
  const date = url.searchParams.get('date');
  const list = bookings.filter((b) => b.check_out === date);
  send(200, { ok: true, date, count: list.length, checkouts: list });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.SAIFSYS_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.SAIFSYS_API_KEY = 'test-key';
const { checkouts, runCheckoutJob, saifsysKit, dubaiDate } = await import('../server/saifsys.js');

test.after(() => { fake.close(); return closeDb(); });

// 08:00 Dubai on 25 Sep 2026.
const MORNING = Date.parse('2026-09-25T08:00:00+04:00');
const stay = (unit, extra = {}) => ({
  booking_number: `B-${unit}`, status: 'checked_in', check_out: '2026-09-25', unit, building: 'Marina Tower',
  guest: 'Ali Hassan', guest_phone: '+971500000000', balance_due: 0, ...extra,
});
const master = async (name) => {
  const id = await makeUser(name);
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(id);
  return id;
};
const todosOf = (id) => db.prepare('SELECT * FROM todos WHERE user_id = ? ORDER BY id').all(id);

test('the Dubai date, not the UTC one', () => {
  assert.equal(dubaiDate(Date.parse('2026-09-24T21:00:00Z')), '2026-09-25');
});

test('checkouts come back for the day asked', async () => {
  bookings = [stay('101'), stay('102', { check_out: '2026-09-26' })];
  const r = await checkouts('2026-09-25');
  assert.equal(r.checkouts.length, 1);
  assert.equal(r.checkouts[0].unit, '101');
});

test('the morning job makes ONE 11am reminder listing every unit, for each master only', async () => {
  await reset();
  bookings = [stay('101'), stay('204', { balance_due: 350 })];
  const boss = await master('Boss');
  const staff = await makeUser('Staff');

  const r = await runCheckoutJob({ at: MORNING });
  assert.deepEqual(r, { day: '2026-09-25', checkouts: 2, todos: 1 });

  const [t, ...more] = await todosOf(boss);
  assert.equal(more.length, 0);
  assert.equal(t.text, '2 checkouts today at 11:00 — Marina Tower unit 101, Marina Tower unit 204');
  assert.equal(Number(t.remind_at), Date.parse('2026-09-25T11:00:00+04:00') / 1000);
  assert.match(t.notes, /balance due AED 350\.00/);
  assert.equal((await todosOf(staff)).length, 0);
});

test('it runs once a day, however many times the timer fires', async () => {
  await reset();
  bookings = [stay('101')];
  const boss = await master('Boss');
  await runCheckoutJob({ at: MORNING });
  assert.deepEqual(await runCheckoutJob({ at: MORNING + 600_000 }), { skipped: 'already done today' });
  assert.equal((await todosOf(boss)).length, 1);
});

test('no checkouts, no reminder', async () => {
  await reset();
  bookings = [];
  const boss = await master('Boss');
  assert.deepEqual(await runCheckoutJob({ at: MORNING }), { day: '2026-09-25', checkouts: 0, todos: 0 });
  assert.equal((await todosOf(boss)).length, 0);
});

test('outside the morning window it does nothing', async () => {
  await reset();
  bookings = [stay('101')];
  calls = 0;
  const r = await runCheckoutJob({ at: Date.parse('2026-09-25T15:00:00+04:00') });
  assert.equal(r.skipped, 'outside the morning window');
  assert.equal(calls, 0);
});

test('saifsys down: nothing is written, so the next tick tries again', async () => {
  await reset();
  bookings = [stay('101')];
  const boss = await master('Boss');
  down = true;
  await assert.rejects(runCheckoutJob({ at: MORNING }), /saifsys said: boom/);
  down = false;
  assert.equal((await runCheckoutJob({ at: MORNING })).todos, 1);
  assert.equal((await todosOf(boss)).length, 1);
});

test('the agent tool reads the list back in words', async () => {
  bookings = [stay('101')];
  const out = await saifsysKit().run({ id: 't1', name: 'saifsys_checkouts', input: { date: '2026-09-25' } });
  assert.ok(!out.is_error);
  assert.match(out.content, /1 checkout in saifsys on 2026-09-25/);
  assert.match(out.content, /Marina Tower unit 101 — Ali Hassan/);
});

test('a wrong key is an error the agent can see, not a crash', async () => {
  process.env.SAIFSYS_API_KEY = 'wrong';
  const out = await saifsysKit().run({ id: 't2', name: 'saifsys_checkouts', input: {} });
  process.env.SAIFSYS_API_KEY = 'test-key';
  assert.equal(out.is_error, true);
  assert.match(out.content, /Not authorised/);
});
