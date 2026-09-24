import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import {
  occurrence, nextOccurrence, lastOccurrence, covers, cadence,
  createRoutine, listRoutines, dueRoutines, getRoutine, updateRoutine, deleteRoutine, setDone, routineKit,
} from '../server/routines.js';

test.after(() => closeDb());

// Every time below is written as Dubai wall-clock, because that is what the user means
// by "9am" and what the whole module is built to preserve.
const at = (iso) => Math.round(Date.parse(`${iso}+04:00`) / 1000);
const says = (secs) => new Date(secs * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Dubai' }).replace(' ', 'T');

// ---------- the calendar ----------

test('a daily routine keeps its time of day', () => {
  const anchor = at('2026-10-01T09:00:00');
  assert.equal(says(occurrence(anchor, 1, 'day', 1)), '2026-10-02T09:00:00');
  assert.equal(says(occurrence(anchor, 1, 'day', 30)), '2026-10-31T09:00:00');
});

test('a weekly routine keeps its weekday', () => {
  const anchor = at('2026-10-01T18:30:00'); // a Thursday
  for (const k of [1, 2, 9]) {
    const d = new Date(occurrence(anchor, 1, 'week', k) * 1000);
    assert.equal(d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'long' }), 'Thursday');
  }
  assert.equal(says(occurrence(anchor, 2, 'week', 1)), '2026-10-15T18:30:00', 'fortnightly');
});

test('the 31st stays the 31st, and clamps only where there is no 31st', () => {
  const anchor = at('2027-01-31T09:00:00');
  assert.equal(says(occurrence(anchor, 1, 'month', 1)), '2027-02-28T09:00:00', 'February has no 31st');
  assert.equal(says(occurrence(anchor, 1, 'month', 2)), '2027-03-31T09:00:00', 'and March gets it back');
  assert.equal(says(occurrence(anchor, 1, 'month', 3)), '2027-04-30T09:00:00');
  assert.equal(says(occurrence(anchor, 1, 'month', 4)), '2027-05-31T09:00:00');
});

test('a month step never spills into the next month', () => {
  const anchor = at('2027-01-30T09:00:00');
  assert.equal(says(occurrence(anchor, 1, 'month', 1)), '2027-02-28T09:00:00', 'not 2 March');
});

test('quarterly and yearly are the same arithmetic', () => {
  const anchor = at('2026-10-05T10:00:00');
  assert.equal(says(occurrence(anchor, 3, 'month', 1)), '2027-01-05T10:00:00');
  assert.equal(says(occurrence(anchor, 1, 'year', 1)), '2027-10-05T10:00:00');
});

test('29 February comes back as the 28th in an ordinary year', () => {
  const anchor = at('2028-02-29T09:00:00'); // 2028 is a leap year
  assert.equal(says(occurrence(anchor, 1, 'year', 1)), '2029-02-28T09:00:00');
  assert.equal(says(occurrence(anchor, 1, 'year', 4)), '2032-02-29T09:00:00', 'and the 29th when there is one');
});

test('a time of day survives however far ahead you look', () => {
  const anchor = at('2026-10-01T07:15:00');
  // The server runs on UTC; if the arithmetic leaked into UTC this would drift to 03:15.
  assert.equal(says(occurrence(anchor, 1, 'day', 500)), '2028-02-13T07:15:00');
});

test('next and last bracket the moment you ask about', () => {
  const anchor = at('2026-10-01T09:00:00');
  const noon = at('2026-10-03T12:00:00');
  assert.equal(says(lastOccurrence(anchor, 1, 'day', noon)), '2026-10-03T09:00:00');
  assert.equal(says(nextOccurrence(anchor, 1, 'day', noon)), '2026-10-04T09:00:00');
});

test('exactly on an occurrence, that one counts as already here', () => {
  const anchor = at('2026-10-01T09:00:00');
  const on = at('2026-10-05T09:00:00');
  assert.equal(lastOccurrence(anchor, 1, 'day', on), on, 'due now, not this afternoon');
  assert.equal(says(nextOccurrence(anchor, 1, 'day', on)), '2026-10-06T09:00:00');
});

test('nothing has happened yet before the first one', () => {
  const anchor = at('2026-10-01T09:00:00');
  const before = at('2026-09-20T09:00:00');
  assert.equal(lastOccurrence(anchor, 1, 'day', before), null);
  assert.equal(nextOccurrence(anchor, 1, 'day', before), anchor);
});

test('a routine untouched for years lands on the right turn without grinding', () => {
  const anchor = at('2010-01-15T08:00:00');
  const now = at('2026-09-24T12:00:00');
  const t0 = Date.now();
  assert.equal(says(lastOccurrence(anchor, 1, 'month', now)), '2026-09-15T08:00:00');
  assert.equal(says(nextOccurrence(anchor, 1, 'month', now)), '2026-10-15T08:00:00');
  assert.equal(says(lastOccurrence(anchor, 1, 'day', now)), '2026-09-24T08:00:00');
  assert.ok(Date.now() - t0 < 200, 'sixteen years of daily turns is arithmetic, not a loop');
});

test('doing it a little early still counts as this turn', () => {
  const anchor = at('2026-10-01T09:00:00');
  const due = at('2026-10-05T09:00:00');
  assert.equal(covers(at('2026-10-05T09:30:00'), due, anchor, 1, 'day'), true, 'after');
  assert.equal(covers(at('2026-10-05T08:50:00'), due, anchor, 1, 'day'), true, 'ten minutes early');
  assert.equal(covers(at('2026-10-04T22:00:00'), due, anchor, 1, 'day'), true, 'last night, past the midpoint');
  assert.equal(covers(at('2026-10-04T12:00:00'), due, anchor, 1, 'day'), false, 'that was yesterday\'s turn');
});

test('cadence says it in words', () => {
  assert.equal(cadence({ every_n: 1, unit: 'day' }), 'Daily');
  assert.equal(cadence({ every_n: 1, unit: 'year' }), 'Yearly');
  assert.equal(cadence({ every_n: 3, unit: 'month' }), 'Quarterly');
  assert.equal(cadence({ every_n: 2, unit: 'week' }), 'Fortnightly');
  assert.equal(cadence({ every_n: 5, unit: 'day' }), 'Every 5 days');
});

// ---------- the list ----------

test('a routine needs something to do, and a rhythm that exists', async () => {
  await reset();
  const user = await makeUser('Sara');
  await assert.rejects(() => createRoutine(user, { text: ' ', unit: 'day' }), /needs something to do/);
  await assert.rejects(() => createRoutine(user, { text: 'x', unit: 'fortnight' }), /day, week, month or year/);
  await assert.rejects(() => createRoutine(user, { text: 'x', unit: 'day', every: 0 }), /between every 1 and every 366/);
});

test('"weekly" and "weeks" mean the same thing', async () => {
  await reset();
  const user = await makeUser('Sara');
  const r = await createRoutine(user, { text: 'Team call', unit: 'weeks' });
  assert.equal(r.unit, 'week');
  assert.equal(r.cadence, 'Weekly');
});

test('a routine with no start date is not due the second it is made', async () => {
  await reset();
  const user = await makeUser('Sara');
  const r = await createRoutine(user, { text: 'Water the plants', unit: 'day' });
  assert.equal(r.due, false, 'tomorrow, not right now');
  assert.ok(r.next_at > Math.floor(Date.now() / 1000));
  assert.equal((await dueRoutines(user)).length, 0);
});

test('a routine started in the past is owed straight away', async () => {
  await reset();
  const user = await makeUser('Sara');
  const r = await createRoutine(user, { text: 'Send the weekly report', unit: 'week', starts_at: at('2026-09-01T09:00:00') });
  const now = at('2026-09-24T12:00:00');
  const [live] = await listRoutines(user, { now });
  assert.equal(live.due, true);
  assert.equal(says(live.due_at), '2026-09-22T09:00:00', 'this week\'s turn, not the first one ever');
  assert.equal(says(live.next_at), '2026-09-29T09:00:00');
});

test('ticking a turn off settles it until the next one', async () => {
  await reset();
  const user = await makeUser('Sara');
  const r = await createRoutine(user, { text: 'Take the tablets', unit: 'day', starts_at: at('2026-09-01T09:00:00') });
  const now = at('2026-09-24T10:00:00');

  assert.equal((await getRoutine(user, r.id, now)).due, true);
  const done = await setDone(user, r.id, true, now);
  assert.equal(done.due, false, 'settled');
  assert.equal(done.done_at, now);
  assert.equal(says(done.next_at), '2026-09-25T09:00:00');

  // and it is owed again once the next one comes round
  const tomorrow = at('2026-09-25T09:30:00');
  assert.equal((await getRoutine(user, r.id, tomorrow)).due, true);
});

test('ticking off and un-ticking are exact opposites', async () => {
  await reset();
  const user = await makeUser('Sara');
  const r = await createRoutine(user, { text: 'Lock up', unit: 'day', starts_at: at('2026-09-01T18:00:00') });
  const now = at('2026-09-24T19:00:00');

  await setDone(user, r.id, true, now);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM routine_completions').get()).n, 1);

  const back = await setDone(user, r.id, false, now);
  assert.equal(back.due, true);
  assert.equal(back.done_at, null);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM routine_completions').get()).n, 0, 'nothing left behind');
});

test('ticking the same turn twice does not write it twice', async () => {
  await reset();
  const user = await makeUser('Sara');
  const r = await createRoutine(user, { text: 'Stand-up', unit: 'day', starts_at: at('2026-09-01T09:00:00') });
  const now = at('2026-09-24T09:05:00');
  await setDone(user, r.id, true, now);
  await setDone(user, r.id, true, now + 60);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM routine_completions').get()).n, 1);
});

test('missing several turns leaves one thing owed, not a pile of them', async () => {
  await reset();
  const user = await makeUser('Sara');
  const r = await createRoutine(user, { text: 'Water the plants', unit: 'day', starts_at: at('2026-09-01T09:00:00') });
  const now = at('2026-09-24T12:00:00'); // 23 turns missed

  const live = await getRoutine(user, r.id, now);
  assert.equal(live.due, true);
  assert.equal(says(live.due_at), '2026-09-24T09:00:00', 'today\'s turn is what is owed');
  assert.equal((await dueRoutines(user, now)).length, 1, 'one nag, not twenty-three');
});

test('a paused routine stops asking but keeps its history', async () => {
  await reset();
  const user = await makeUser('Sara');
  const r = await createRoutine(user, { text: 'Gym', unit: 'day', starts_at: at('2026-09-01T07:00:00') });
  const now = at('2026-09-24T12:00:00');
  await setDone(user, r.id, true, at('2026-09-23T07:10:00'));

  const paused = await updateRoutine(user, r.id, { paused: true });
  assert.equal(paused.paused, true);
  assert.equal(paused.due, false);
  assert.equal((await dueRoutines(user, now)).length, 0);
  assert.equal(paused.history.length, 1, 'what was done is still there');

  const resumed = await updateRoutine(user, r.id, { paused: false });
  assert.equal((await getRoutine(user, resumed.id, now)).due, true);
});

test('changing the rhythm re-reads everything from the new one', async () => {
  await reset();
  const user = await makeUser('Sara');
  const r = await createRoutine(user, { text: 'Invoice the client', unit: 'week', starts_at: at('2026-09-01T09:00:00') });
  const now = at('2026-09-24T12:00:00');
  assert.equal(says((await getRoutine(user, r.id, now)).next_at), '2026-09-29T09:00:00');

  const monthly = await updateRoutine(user, r.id, { every: 1, unit: 'month' });
  assert.equal(monthly.cadence, 'Monthly');
  assert.equal(says((await getRoutine(user, r.id, now)).next_at), '2026-10-01T09:00:00');
});

test('due routines lead the list, paused ones bring up the rear', async () => {
  await reset();
  const user = await makeUser('Sara');
  const now = at('2026-09-24T12:00:00');
  const owed = await createRoutine(user, { text: 'Owed', unit: 'day', starts_at: at('2026-09-01T09:00:00') });
  const soon = await createRoutine(user, { text: 'Soon', unit: 'day', starts_at: at('2026-09-25T09:00:00') });
  const later = await createRoutine(user, { text: 'Later', unit: 'month', starts_at: at('2026-10-20T09:00:00') });
  const off = await createRoutine(user, { text: 'Off', unit: 'day', starts_at: at('2026-09-01T09:00:00') });
  await updateRoutine(user, off.id, { paused: true });

  assert.deepEqual((await listRoutines(user, { now })).map((r) => r.id), [owed.id, soon.id, later.id, off.id]);
});

// ---------- one list never reaches another ----------

test('routines never cross between accounts', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const omar = await makeUser('Omar');
  const his = await createRoutine(omar, { text: 'His own rhythm', unit: 'day', starts_at: at('2026-09-01T09:00:00') });
  const now = at('2026-09-24T12:00:00');

  assert.equal((await listRoutines(sara, { now })).length, 0);
  assert.equal((await dueRoutines(sara, now)).length, 0);
  assert.equal(await getRoutine(sara, his.id, now), null);
  assert.equal(await updateRoutine(sara, his.id, { paused: true }), null);
  assert.equal(await setDone(sara, his.id, true, now), null);
  assert.equal(await deleteRoutine(sara, his.id), false);
  assert.equal((await getRoutine(omar, his.id, now)).paused, false, 'and his is untouched');
});

test('deleting a routine takes its history with it, and the account takes the lot', async () => {
  await reset();
  const user = await makeUser('Sara');
  const r = await createRoutine(user, { text: 'Gym', unit: 'day', starts_at: at('2026-09-01T07:00:00') });
  await setDone(user, r.id, true, at('2026-09-23T07:10:00'));
  await deleteRoutine(user, r.id);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM routine_completions').get()).n, 0);

  const other = await makeUser('Omar');
  const r2 = await createRoutine(other, { text: 'Run', unit: 'day', starts_at: at('2026-09-01T07:00:00') });
  await setDone(other, r2.id, true, at('2026-09-23T07:10:00'));
  await db.prepare('DELETE FROM users WHERE id = ?').run(other);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM routines').get()).n, 0);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM routine_completions').get()).n, 0);
});

test('losing the agent that set a routine up does not lose the routine', async () => {
  await reset();
  const user = await makeUser('Sara');
  const hr = await makeAgent(user, 'HR');
  const r = await createRoutine(user, { text: 'Payroll', unit: 'month', agentId: hr, starts_at: at('2026-10-01T09:00:00') });
  await db.prepare('DELETE FROM agents WHERE id = ?').run(hr);
  const after = await getRoutine(user, r.id);
  assert.ok(after, 'the rhythm outlives the agent');
  assert.equal(after.agent_id, null);
});

// ---------- what the agents can do ----------

const call = (kit, name, input) => kit.run({ id: `tu_${name}`, name, input });

test('an agent sets up a routine and is told not to promise an alert', async () => {
  await reset();
  const user = await makeUser('Sara');
  const hr = await makeAgent(user, 'HR');
  const kit = routineKit(user, { agentId: hr, conversationId: null });

  const out = await call(kit, 'add_routine', { text: 'Send the VAT return', every: 3, unit: 'month', starts_at: '2026-10-28T09:00:00+04:00' });
  assert.equal(out.is_error, undefined);
  assert.match(out.content, /routine #1/);
  assert.match(out.content, /quarterly/);
  assert.match(out.content, /cannot notify them elsewhere/);

  const [r] = await listRoutines(user);
  assert.equal(r.agent_id, hr);
  assert.equal(r.every_n, 3);
  assert.equal(r.unit, 'month');
  assert.equal(says(r.starts_at), '2026-10-28T09:00:00');
});

test('list_routines says what is due, what is done and what is next', async () => {
  await reset();
  const user = await makeUser('Sara');
  const kit = routineKit(user, {});
  assert.match((await call(kit, 'list_routines', {})).content, /no routines set up/);

  await createRoutine(user, { text: 'Take the tablets', unit: 'day', starts_at: at('2026-09-01T09:00:00') });
  await createRoutine(user, { text: 'Pay the rent', unit: 'month', starts_at: at('2027-01-01T09:00:00') });

  const all = (await call(kit, 'list_routines', {})).content;
  assert.match(all, /Take the tablets — Daily, DUE NOW/);
  assert.match(all, /Pay the rent — Monthly, not due/);

  const only = (await call(kit, 'list_routines', { due_only: true })).content;
  assert.match(only, /Take the tablets/);
  assert.doesNotMatch(only, /Pay the rent/);
});

test('an agent ticks a turn off, is told when it is next, and cannot double-tick', async () => {
  await reset();
  const user = await makeUser('Sara');
  const kit = routineKit(user, {});
  const r = await createRoutine(user, { text: 'Stand-up', unit: 'day', starts_at: at('2026-09-01T09:00:00') });

  const first = await call(kit, 'complete_routine', { id: r.id });
  assert.match(first.content, /Ticked off this turn/);
  const again = await call(kit, 'complete_routine', { id: r.id });
  assert.match(again.content, /already ticked off/);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM routine_completions').get()).n, 1);
});

test('an agent pauses and resumes, but is given no way to delete', async () => {
  await reset();
  const user = await makeUser('Sara');
  const kit = routineKit(user, {});
  const r = await createRoutine(user, { text: 'Gym', unit: 'day', starts_at: at('2026-09-01T07:00:00') });

  assert.match((await call(kit, 'pause_routine', { id: r.id, paused: true })).content, /is paused/);
  assert.equal((await getRoutine(user, r.id)).paused, true);
  assert.match((await call(kit, 'pause_routine', { id: r.id, paused: false })).content, /running again/);

  assert.deepEqual(kit.definitions.map((d) => d.name), ['add_routine', 'list_routines', 'complete_routine', 'pause_routine']);
  for (const d of kit.definitions) assert.ok(kit.status(d.name), `${d.name} has a status label`);
  assert.equal(kit.status('add_todo'), null, 'and says nothing about another kit\'s tools');
});

test('an agent cannot reach a routine on somebody else\'s list', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const omar = await makeUser('Omar');
  const his = await createRoutine(omar, { text: 'His own rhythm', unit: 'day', starts_at: at('2026-09-01T09:00:00') });
  const kit = routineKit(sara, {});

  const out = await call(kit, 'complete_routine', { id: his.id });
  assert.equal(out.is_error, true);
  assert.match(out.content, /no routine #/);
  assert.equal((await getRoutine(omar, his.id)).done_at, null);
});

test('a rhythm nobody can read comes back as a tool_result, not a thrown turn', async () => {
  await reset();
  const user = await makeUser('Sara');
  const kit = routineKit(user, {});
  const out = await call(kit, 'add_routine', { text: 'Something', unit: 'fortnight' });
  assert.equal(out.is_error, true);
  assert.equal(out.tool_use_id, 'tu_add_routine');
  assert.equal((await listRoutines(user)).length, 0, 'nothing half-written was left behind');
});
