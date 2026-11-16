import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';

// A throwaway database file per test, removed afterwards.
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'tracker-')); return { path: join(dir, 'data.db'), done: () => rmSync(dir, { recursive: true, force: true }) }; };
const span = (startedAt, endedAt, app = 'Excel', title = 'A', kind = 'active') => ({ startedAt, endedAt, app, title, kind });

// 2026-11-15 08:00 Dubai, and the day after.
const DAY1 = Date.UTC(2026, 10, 15, 4) / 1000;
const DAY2 = DAY1 + 86400;

test('spans come back by Dubai date, in order', () => {
  const { path, done } = fresh();
  const s = openStore(path);
  s.addSpans([span(DAY1 + 100, DAY1 + 200), span(DAY2 + 10, DAY2 + 20, 'Word'), span(DAY1, DAY1 + 50, 'Chrome')]);
  assert.deepEqual(s.spansOn('2026-11-15').map((x) => x.app), ['Chrome', 'Excel']);
  assert.deepEqual(s.spansOn('2026-11-16').map((x) => x.app), ['Word']);
  assert.deepEqual(s.spansOn('2026-11-17'), []);
  assert.deepEqual(s.spansOn('2026-11-15')[0], span(DAY1, DAY1 + 50, 'Chrome'), 'the shape is the SpanBook span, nothing extra');
  s.close(); done();
});

test('running segments are kept per day, an open one included', () => {
  const { path, done } = fresh();
  const s = openStore(path);
  s.addRunning([DAY1, DAY1 + 3600]);
  s.addRunning([DAY1 + 7200, null]);
  assert.deepEqual(s.runningOn('2026-11-15'), [[DAY1, DAY1 + 3600], [DAY1 + 7200, null]]);
  s.addRunning([DAY1 + 7200, DAY1 + 8000]);
  assert.deepEqual(s.runningOn('2026-11-15'), [[DAY1, DAY1 + 3600], [DAY1 + 7200, DAY1 + 8000]], 'closing a segment replaces the open one');
  assert.deepEqual(s.runningOn('2026-11-16'), []);
  s.close(); done();
});

test('a day remembers when it was sent, and which dates have spans but were never sent', () => {
  const { path, done } = fresh();
  const s = openStore(path);
  s.addSpans([span(DAY1, DAY1 + 50), span(DAY2, DAY2 + 50)]);
  assert.equal(s.sentAt('2026-11-15'), null);
  s.markSent('2026-11-15', DAY1 + 40000);
  assert.equal(s.sentAt('2026-11-15'), DAY1 + 40000);
  assert.deepEqual(s.unsentDates(), ['2026-11-16']);
  s.close(); done();
});

test('prune keeps 30 days and drops the rest', () => {
  const { path, done } = fresh();
  const s = openStore(path);
  const now = DAY2;
  s.addSpans([span(now - 31 * 86400, now - 31 * 86400 + 10, 'Old'), span(now - 29 * 86400, now - 29 * 86400 + 10, 'Kept')]);
  s.addRunning([now - 31 * 86400, now - 31 * 86400 + 10]);
  s.prune(30, now);
  assert.deepEqual(s.spansOn(new Date((now - 29 * 86400 + 4 * 3600) * 1000).toISOString().slice(0, 10)).map((x) => x.app), ['Kept']);
  assert.deepEqual(s.spansOn(new Date((now - 31 * 86400 + 4 * 3600) * 1000).toISOString().slice(0, 10)), []);
  assert.deepEqual(s.runningOn(new Date((now - 31 * 86400 + 4 * 3600) * 1000).toISOString().slice(0, 10)), []);
  s.close(); done();
});

test('settings round-trip, and opening the same file twice is fine', () => {
  const { path, done } = fresh();
  const a = openStore(path);
  assert.equal(a.get('reem_url'), null);
  a.set('reem_url', 'http://localhost:3001');
  a.set('consented_at', 123);
  a.close();
  const b = openStore(path);
  assert.equal(b.get('reem_url'), 'http://localhost:3001');
  assert.equal(b.get('consented_at'), 123, 'numbers come back as numbers');
  b.close(); done();
});

test('a span over Dubai midnight is stored on both dates, and running segments are found by overlap', () => {
  const { path, done } = fresh();
  const s = openStore(path);
  const MID = DAY1 + 16 * 3600; // Dubai midnight between the two days (DAY1 is 08:00)
  const t = MID - 600; // 23:50 Dubai on day 1
  s.addSpans([span(t, t + 1200, 'Excel', 'Late night')]);
  assert.deepEqual(s.spansOn('2026-11-15').map((x) => [x.startedAt, x.endedAt]), [[t, MID]], 'ends at midnight');
  assert.deepEqual(s.spansOn('2026-11-16').map((x) => [x.startedAt, x.endedAt]), [[MID, t + 1200]], 'starts at midnight');
  s.addRunning([t, null]);
  assert.deepEqual(s.runningOn('2026-11-16'), [[t, null]], 'a PC left on overnight is still running on the new day');
  s.addRunning([t, t + 1200]);
  assert.deepEqual(s.runningOn('2026-11-16'), [[t, t + 1200]]);
  assert.deepEqual(s.runningOn('2026-11-17'), [], 'and not on a day it never touched');
  s.close(); done();
});

test('a day with work after it was sent counts as unsent again', () => {
  const { path, done } = fresh();
  const s = openStore(path);
  s.addSpans([span(DAY1, DAY1 + 50)]);
  s.markSent('2026-11-15', DAY1 + 100);
  assert.deepEqual(s.unsentDates(), []);
  s.addSpans([span(DAY1 + 200, DAY1 + 260)]);
  assert.deepEqual(s.unsentDates(), ['2026-11-15'], 'new work since the send: HR should hear of it');
  s.close(); done();
});
