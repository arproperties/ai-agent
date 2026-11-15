import test from 'node:test';
import assert from 'node:assert/strict';
import { SpanBook, IDLE_AFTER } from '../src/spans.js';

const see = (b, at, app, title, idleSeconds = 0, locked = false) => b.observe({ at, app, title, idleSeconds, locked });

test('idle starts after three minutes without input', () => {
  assert.equal(IDLE_AFTER, 180);
});

test('the same window for a minute is one span, not twelve', () => {
  const b = new SpanBook();
  for (let t = 0; t < 60; t += 5) assert.equal(see(b, 1000 + t, 'Excel', 'Rent roll'), null);
  assert.deepEqual(b.close(1060), { startedAt: 1000, endedAt: 1060, app: 'Excel', title: 'Rent roll', kind: 'active' });
  assert.equal(b.close(1070), null, 'nothing open after a close');
});

test('changing window closes the old span', () => {
  const b = new SpanBook();
  see(b, 1000, 'Excel', 'A');
  assert.deepEqual(see(b, 1030, 'Chrome', 'B'), { startedAt: 1000, endedAt: 1030, app: 'Excel', title: 'A', kind: 'active' });
  assert.deepEqual(b.close(1040), { startedAt: 1030, endedAt: 1040, app: 'Chrome', title: 'B', kind: 'active' });
});

test('idle over 180 s becomes an idle span dated from when the hands left', () => {
  const b = new SpanBook();
  see(b, 1000, 'Excel', 'A');
  assert.equal(see(b, 1100, 'Excel', 'A', 100), null, 'a short pause is still active');
  const s = see(b, 1300, 'Excel', 'A', 200);
  assert.deepEqual(s, { startedAt: 1000, endedAt: 1100, app: 'Excel', title: 'A', kind: 'active' }, 'active ends at 1300 - 200');
  const idle = see(b, 1305, 'Chrome', 'B');
  assert.deepEqual(idle, { startedAt: 1100, endedAt: 1305, app: 'Excel', title: 'A', kind: 'idle' }, 'idle keeps the window it idled on and ends when input returns');
  assert.equal(b.close(1310).kind, 'active');
});

test('locked is away regardless of idle, and ends on unlock', () => {
  const b = new SpanBook();
  see(b, 1, 'Excel', 'A', 0, true);
  assert.equal(see(b, 50, 'Excel', 'A', 49, true), null);
  const away = see(b, 60, 'Excel', 'A', 0, false);
  assert.deepEqual(away, { startedAt: 1, endedAt: 60, app: 'Excel', title: 'A', kind: 'away' });
});

test('no front window (desktop, nothing focused) counts as its own app', () => {
  const b = new SpanBook();
  see(b, 1, null, null);
  assert.deepEqual(b.close(5), { startedAt: 1, endedAt: 5, app: 'Desktop', title: '', kind: 'active' });
});

test('running segments follow mark and stop', () => {
  const b = new SpanBook();
  b.markRunning(100); b.stopRunning(200); b.markRunning(300);
  assert.deepEqual(b.running, [[100, 200], [300, null]]);
  b.markRunning(310);
  assert.deepEqual(b.running, [[100, 200], [300, null]], 'marking while running opens nothing new');
});

test('a program Windows names only by its file reads as a name, not a file', () => {
  const b = new SpanBook();
  see(b, 1, 'Notepad.exe', 'notes.txt - Notepad');
  assert.equal(b.close(5).app, 'Notepad');
});
