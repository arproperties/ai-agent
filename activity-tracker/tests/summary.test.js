import test from 'node:test';
import assert from 'node:assert/strict';
import { dubaiDate, dubaiTime, cleanTitle, splitAtMidnight, summarise } from '../src/summary.js';

// Dubai is UTC+4 all year, so 04:00 UTC is 08:00 in the office.
const dubai = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 4, mi) / 1000;
const span = (startedAt, endedAt, app, title, kind = 'active') => ({ startedAt, endedAt, app, title, kind });

test('dates and times are Dubai, whatever the PC clock zone', () => {
  assert.equal(dubaiDate(dubai(2026, 11, 15, 8, 52)), '2026-11-15');
  assert.equal(dubaiTime(dubai(2026, 11, 15, 8, 52)), '08:52');
  assert.equal(dubaiDate(dubai(2026, 11, 15, 0, 10)), '2026-11-15', 'ten past midnight Dubai is the new day even though it is still the 14th in UTC');
});

test('a span over Dubai midnight is two spans on two dates', () => {
  const t = dubai(2026, 11, 15, 23, 50);
  const [a, b] = splitAtMidnight([span(t, t + 1200, 'X', 'T')]);
  assert.equal(dubaiDate(a.startedAt), '2026-11-15');
  assert.equal(dubaiDate(b.startedAt), '2026-11-16');
  assert.equal(a.endedAt, b.startedAt);
  assert.equal(b.endedAt - b.startedAt, 600);
  assert.equal(splitAtMidnight([span(t, t + 60, 'X', 'T')]).length, 1, 'a span inside one day is left alone');
});

test('titles are cleaned of the app suffix and site padding', () => {
  assert.equal(cleanTitle('Google Chrome', 'Dubai Land Department - Google Chrome'), 'Dubai Land Department');
  assert.equal(cleanTitle('Excel', 'Rent roll Nov.xlsx - Excel'), 'Rent roll Nov.xlsx');
  assert.equal(cleanTitle('Firefox', 'Gmail — Mozilla Firefox'), 'Gmail');
  assert.equal(cleanTitle('Google Chrome', 'Inbox (3) - someone@company.com - Gmail - Google Chrome'), 'Inbox (3) - someone@company.com - Gmail');
  assert.equal(cleanTitle('Google Chrome', 'Dashboard | saifsys - Google Chrome'), 'Dashboard');
  assert.equal(cleanTitle('Excel', ''), '');
});

const T0 = dubai(2026, 11, 15, 8, 50);
const SPANS = [
  span(T0, T0 + 600, 'Google Chrome', 'DLD - Google Chrome'),
  ...Array.from({ length: 7 }, (_, i) => span(T0 + 600 + i * 300, T0 + 600 + (i + 1) * 300, 'Excel', `Sheet ${i} - Excel`)),
  span(T0 + 2700, T0 + 2900, 'Excel', 'Sheet 0 - Excel', 'idle'),
  span(T0 + 2900, T0 + 3500, 'Excel', 'Sheet 0 - Excel', 'away'),
  span(T0 + 3500, T0 + 3600, 'Excel', 'Sheet 0 - Excel'),
];

test('summarise follows the contract: totals, apps by time, five titles at most', () => {
  const d = summarise(SPANS, [[T0, T0 + 3600]], '2026-11-15');
  assert.equal(d.date, '2026-11-15');
  assert.equal(d.first_seen, '08:50');
  assert.equal(d.last_seen, '09:50');
  assert.equal(d.active_seconds, 600 + 2100 + 100);
  assert.equal(d.idle_seconds, 200);
  assert.equal(d.away_seconds, 600);
  assert.equal(d.apps[0].name, 'Excel');
  assert.equal(d.apps[0].seconds, 2200);
  assert.equal(d.apps[0].titles.length, 5, 'seven titles, five kept');
  assert.equal(d.apps[0].titles[0].title, 'Sheet 0', 'the most-used title first, cleaned');
  assert.equal(d.apps[0].titles[0].seconds, 400);
  assert.equal(d.active_seconds, d.apps.reduce((n, a) => n + a.seconds, 0), 'apps add up to the active total');
  assert.deepEqual(d.running, [['08:50', '09:50']]);
});

test('a running segment still open is closed at the last span, and spans of other days are ignored', () => {
  const d = summarise([...SPANS, span(T0 + 90000, T0 + 90060, 'Word', 'Tomorrow')], [[T0, null]], '2026-11-15');
  assert.deepEqual(d.running, [['08:50', '09:50']]);
  assert.equal(d.apps.some((a) => a.name === 'Word'), false);
});

test('an empty day still has the contract shape', () => {
  const d = summarise([], [], '2026-11-15');
  assert.deepEqual(d, { date: '2026-11-15', first_seen: '00:00', last_seen: '00:00', active_seconds: 0, idle_seconds: 0, away_seconds: 0, running: [], apps: [] });
});

test('a PC locked overnight: the day starts and ends with activity, and away counts only inside it', () => {
  const night = span(dubai(2026, 11, 15, 0, 0), dubai(2026, 11, 15, 8, 50), 'Desktop', '', 'away');
  const evening = span(dubai(2026, 11, 15, 17, 0), dubai(2026, 11, 15, 23, 59), 'Desktop', '', 'away');
  const lunch = span(dubai(2026, 11, 15, 12, 0), dubai(2026, 11, 15, 13, 0), 'Excel', 'A', 'away');
  const d = summarise([night, ...SPANS, lunch, span(dubai(2026, 11, 15, 13, 0), dubai(2026, 11, 15, 17, 0), 'Word', 'B'), evening], [], '2026-11-15');
  assert.equal(d.first_seen, '08:50', 'the night before counts for nothing');
  assert.equal(d.last_seen, '17:00');
  assert.equal(d.away_seconds, 600 + 3600, 'only the away stretches between first and last activity');
});
