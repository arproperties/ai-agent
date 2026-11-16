import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSend, yesterdayUnsent } from '../src/dayEnd.js';

const base = { nowDubai: '18:31', dayEnd: '18:30', sentAt: null, shuttingDown: false, lastTry: null, now: 1000, lastSpanAt: 900 };

test('the day goes at its end time, once', () => {
  assert.equal(shouldSend(base), true);
  assert.equal(shouldSend({ ...base, nowDubai: '18:29' }), false, 'not before');
  assert.equal(shouldSend({ ...base, sentAt: 950 }), false, 'already sent today and nothing new since');
});

test('a shutdown after 15:00 sends even before the end time', () => {
  assert.equal(shouldSend({ ...base, nowDubai: '16:00', shuttingDown: true }), true);
  assert.equal(shouldSend({ ...base, nowDubai: '14:59', shuttingDown: true }), false, 'a lunchtime restart is not the end of the day');
});

test('work after the day was sent goes again at shutdown, not every minute', () => {
  const sentThenWorked = { ...base, nowDubai: '20:00', sentAt: 950, lastSpanAt: 990 };
  assert.equal(shouldSend(sentThenWorked), false, 'while working on, wait for the shutdown');
  assert.equal(shouldSend({ ...sentThenWorked, shuttingDown: true }), true, 'shutting down with new work since the send: resend');
  assert.equal(shouldSend({ ...sentThenWorked, shuttingDown: true, lastSpanAt: 940 }), false, 'nothing new since the send: no resend');
});

test('after a failed try, wait fifteen minutes', () => {
  assert.equal(shouldSend({ ...base, lastTry: 1000 - 899 }), false);
  assert.equal(shouldSend({ ...base, lastTry: 1000 - 900 }), true);
  assert.equal(shouldSend({ ...base, lastTry: 1000 - 10, shuttingDown: true }), true, 'a shutdown is the last chance, try anyway');
});

test('days that never reached Reem, before today, are what to send at start', () => {
  const store = { unsentDates: () => ['2026-11-13', '2026-11-14', '2026-11-15'] };
  assert.deepEqual(yesterdayUnsent(store, '2026-11-15'), ['2026-11-13', '2026-11-14']);
});
