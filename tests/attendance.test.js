import { db, reset, makeUser } from './helpers/db.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { parseChat, workDays, saveRows, personOf } from '../server/attendanceRead.js';
import { periodOf, judge, daysOf, getPeriod, setDay, setReview, mergePeople, mergeDay, splitPerson, setTeam } from '../server/attendance.js';

after(closeDb);
beforeEach(reset);

// Claude stand-in: every list is the company its team label says (or "Shop" with none), and
// every name is a new person named as written - unless `same` says two spellings are one.
const fakeRead = (same = {}) => async (content, { format }) => {
  const lines = String(content).split('\n').filter((l) => /^\d+\. /.test(l));
  const props = format.schema.properties;
  if (props.teams) {
    return { teams: lines.map((l, i) => ({ line: i + 1, company: l.split(' | ')[2].replace('(no label)', 'Shop'), section: '' })) };
  }
  if (props.names) {
    return { names: lines.map((l, i) => {
      const written = l.replace(/^\d+\. /, '').split(' | ')[0];
      return { line: i + 1, person_id: 0, name: same[written] || written };
    }) };
  }
  throw new Error('unexpected read');
};

const row = (date, name, extra = {}) => ({ date, time: '09:00', posted_by: 'Hany', team: 'Engineering', name, status: 'present', hours: '7am-5pm', note: '', ...extra });

test('a pay period runs from the 26th to the next 25th, across the new year too', () => {
  assert.deepEqual(periodOf('2026-10-05'), { start: '2026-09-26', end: '2026-10-25' });
  assert.deepEqual(periodOf('2026-10-26'), { start: '2026-10-26', end: '2026-11-25' });
  assert.deepEqual(periodOf('2026-12-30'), { start: '2026-12-26', end: '2027-01-25' });
  assert.deepEqual(periodOf('2027-01-10'), { start: '2026-12-26', end: '2027-01-25' });
  assert.equal(daysOf('2026-09-26', '2026-10-25').length, 30);
});

test('the chat is split on Windows line endings, and a list keeps its lines', () => {
  const chat = '[23/04/2026, 10:08:05] Soheb Restaurant: 23/04/2026\r\n1- Adeela present\r\n2- Laiba vacation\r\n[23/04/2026, 10:08:16] Mehboob Grocery: Date: 23/04/2026\r\nMahbub\r\n9am-3pm\r\n';
  const m = parseChat(chat);
  assert.equal(m.length, 2);
  assert.equal(m[1].who, 'Mehboob Grocery');
  assert.match(m[0].text, /Laiba vacation/);
});

test("a list with yesterday's date copied on top is today's when yesterday already had one", () => {
  const list = (d, head, who = 'Eng Hany') => `[${d}, 11:46:10] ${who}: ${head}\nHany 24hrs\n____\nTajdar Khan 7am-5pm\n____\nUsman 9am-7pm`;
  const m = workDays(parseChat([list('28/09/2026', '28/09/2026'), list('29/09/2026', '28/09/2026')].join('\n')));
  assert.deepEqual(m.map((x) => x.work), ['2026-09-28', '2026-09-29']);
  assert.match(m[1].text, /^29\/09\/2026/);
  // No list of its own the day before: a late list, for the day written on it.
  const late = workDays(parseChat(list('30/09/2026', '29/09/2026', 'Francis')));
  assert.equal(late[0].work, '2026-09-29');
});

test('complete means never off every list two days running', () => {
  const days = daysOf('2026-09-26', '2026-10-05');
  const all = new Set(days);
  assert.equal(judge(days, all).complete, true);
  // Single days off on their own (Sundays) are fine.
  assert.equal(judge(days, new Set(days.filter((d) => d !== '2026-09-27' && d !== '2026-10-04'))).complete, true);
  const gap = judge(days, new Set(days.filter((d) => d < '2026-10-01' || d > '2026-10-03')));
  assert.equal(gap.complete, false);
  assert.deepEqual(gap.gaps, [{ from: '2026-10-01', to: '2026-10-03', n: 3 }]);
});

test('a day said by several lists shows the best of them, and a change by hand wins', () => {
  assert.equal(mergeDay([{ status: 'absent' }, { status: 'present' }]).status, 'present');
  assert.equal(mergeDay([{ status: 'present' }, { status: 'off', source: 'manual' }]).status, 'off');
});

test('names are learnt once: the next list with the same spelling lands on the same person', async () => {
  const read = fakeRead();
  await saveRows(null, [row('2026-09-28', 'Tajdar Khan')], { source: 'chat', read });
  const id = await personOf('Engineering', 'tajdar  khan');
  assert.ok(id);
  let asked = 0;
  await saveRows(null, [row('2026-09-29', 'Tajdar Khan')], { source: 'chat', read: async (...a) => { asked++; return read(...a); } });
  assert.equal(asked, 0);
  const n = await db.prepare('SELECT count(*)::int AS n FROM attendance_entries WHERE person_id = ?').get(id);
  assert.equal(n.n, 2);
});

test('two names on the same list are two people, even when they were joined', async () => {
  // Claude joins Hussain and Azhar; both are on one list, so they are kept apart.
  await saveRows(null, [row('2026-04-23', 'Hussain'), row('2026-04-23', 'Azhar')], { source: 'chat', read: fakeRead({ Azhar: 'Hussain' }) });
  const a = await personOf('Engineering', 'Hussain');
  const b = await personOf('Engineering', 'Azhar');
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test('the period lists everyone with their days; gaps make them need a look', async () => {
  const user = { id: await makeUser('Rona'), name: 'Rona' };
  const days = daysOf('2026-09-26', '2026-10-10');
  const rows = [
    ...days.filter((d) => d !== '2026-09-27').map((d) => row(d, 'Hidayat')),
    ...days.filter((d) => d < '2026-10-01' || d > '2026-10-05').map((d) => row(d, 'Tajdar')),
  ];
  await saveRows(null, rows, { source: 'chat', read: fakeRead() });
  let p = await getPeriod('2026-09-26');
  assert.equal(p.coverEnd, '2026-10-10'); // a period still running is judged up to the last day read
  const [hid, taj] = p.people;
  assert.equal(hid.name, 'Hidayat');
  assert.equal(hid.complete, true);
  assert.equal(taj.complete, false);
  assert.match(taj.reasons[0], /1 Oct – 5 Oct \(5 days\)/);

  // Filled in by hand, the gap is gone and the person is complete.
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) await setDay(user, taj.id, d, { status: 'present', hours: '6am-3pm' });
  p = await getPeriod('2026-09-26');
  const after1 = p.people.find((x) => x.id === taj.id);
  assert.equal(after1.complete, true);
  assert.equal(after1.days.find((d) => d.d === '2026-10-01').m, true);

  await setReview(user, taj.id, '2026-09-26', 'verified');
  await setReview(user, hid.id, '2026-09-26', 'skipped', 'waiting for HR');
  p = await getPeriod('2026-09-26');
  assert.equal(p.people.find((x) => x.id === taj.id).state, 'verified');
  assert.deepEqual(p.people.find((x) => x.id === hid.id).review, { note: 'waiting for HR', at: p.people.find((x) => x.id === hid.id).review.at, by: 'Rona' });
  await assert.rejects(setReview(user, taj.id, '2026-09-27', 'verified'), /Not a period/);
});

test('merging two people moves their days and spellings, and takes back their reviews', async () => {
  const user = { id: await makeUser('Rona'), name: 'Rona' };
  await saveRows(null, [row('2026-09-28', 'Tajdar Khan'), row('2026-10-19', 'Tajhdar Khan', { posted_by: 'francis', team: 'JVC School' })], { source: 'chat', read: fakeRead() });
  const a = await personOf('Engineering', 'Tajdar Khan');
  const b = await personOf('JVC School', 'Tajhdar Khan');
  assert.notEqual(a, b);
  await setReview(user, a, '2026-09-26', 'verified');
  await mergePeople(b, a);
  assert.equal(await personOf('JVC School', 'Tajhdar Khan'), a);
  const p = await getPeriod('2026-09-26');
  assert.equal(p.people.length, 1);
  assert.deepEqual(p.people[0].companies.sort(), ['Engineering', 'JVC School']);
  assert.equal(p.people[0].state, 'to_verify');
});

test('splitting a person gives one company\'s days to someone new, with that company\'s spellings', async () => {
  // Two Franciscas joined into one: the grocery one and the food truck one.
  await saveRows(null, [row('2026-10-07', 'Francisca', { team: 'Grocery' }), row('2026-10-07', 'Francisca B', { team: 'Food Truck', posted_by: 'francis' })],
    { source: 'chat', read: fakeRead({ 'Francisca B': 'Francisca' }) });
  const one = await personOf('Grocery', 'Francisca');
  assert.equal(await personOf('Food Truck', 'Francisca B'), one);
  const { id } = await splitPerson(one, 'Food Truck');
  assert.equal(await personOf('Food Truck', 'Francisca B'), id);
  assert.equal(await personOf('Grocery', 'Francisca'), one);
  await assert.rejects(splitPerson(one, 'Grocery'), /more than one/);
});

test('moving a list to another company moves its days, and its names still land on the same people', async () => {
  await saveRows(null, [row('2026-10-07', 'Kevin Paul', { posted_by: 'Shahid', team: '' })], { source: 'chat', read: fakeRead() });
  const kevin = await personOf('Shop', 'Kevin Paul');
  await setTeam({ poster: 'Shahid', team: '', company: 'Eng Hany team' });
  const p = await getPeriod('2026-09-26');
  assert.deepEqual(p.people[0].companies, ['Eng Hany team']);
  assert.equal(await personOf('Eng Hany team', 'Kevin Paul'), kevin);
  // The next list from Shahid goes to the new company and to Kevin, with no question asked.
  await saveRows(null, [row('2026-10-08', 'Kevin Paul', { posted_by: 'Shahid', team: '' })], { source: 'chat', read: async () => { throw new Error('asked'); } });
  const n = await db.prepare(`SELECT count(*)::int AS n FROM attendance_entries WHERE person_id = ? AND company = 'Eng Hany team'`).get(kevin);
  assert.equal(n.n, 2);
});
