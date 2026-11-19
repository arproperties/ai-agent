import test from 'node:test';
import assert from 'node:assert/strict';
import { moodFor, lineFor, nudgeDue, clampToScreen, LINES, STRETCH_AFTER, LINE_EVERY } from '../src/mood.js';

const base = { idleSeconds: 0, locked: false, pairError: '', recording: true, justSent: false, now: 10_000, lastActiveAt: 9_000, activeSince: 9_000 };

test('the mood follows what the tracker already knows', () => {
  assert.equal(moodFor(base), 'working');
  assert.equal(moodFor({ ...base, idleSeconds: 200 }), 'sleep', 'three minutes without a hand: dozing');
  assert.equal(moodFor({ ...base, locked: true }), 'sleep');
  assert.equal(moodFor({ ...base, pairError: 'This PC is not paired with Reem' }), 'alert', 'unpaired: it wants attention');
  assert.equal(moodFor({ ...base, justSent: true }), 'happy', 'the day went to Reem: a little wave');
  assert.equal(moodFor({ ...base, recording: false }), 'think', 'not consented yet: waiting');
});

test('a stretch nudge comes after two hours without a break, then not again for two hours', () => {
  assert.equal(STRETCH_AFTER, 2 * 3600);
  assert.equal(nudgeDue({ activeSince: 0, now: 7199, lastNudgeAt: null }), false);
  assert.equal(nudgeDue({ activeSince: 0, now: 7200, lastNudgeAt: null }), true);
  assert.equal(nudgeDue({ activeSince: 0, now: 9000, lastNudgeAt: 7200 }), false, 'already nudged this stretch');
  assert.equal(nudgeDue({ activeSince: 0, now: 14400, lastNudgeAt: 7200 }), true, 'two more hours: again');
});

test('lines are short, fixed, and never more often than once an hour', () => {
  assert.equal(LINE_EVERY, 3600);
  assert.ok(LINES.working.length >= 5 && LINES.sleep.length >= 3 && LINES.alert.length >= 1 && LINES.happy.length >= 1);
  for (const list of Object.values(LINES)) for (const l of list) assert.ok(l.length <= 60, l);
  const pick = (seed) => lineFor('working', { now: 10_000, lastLineAt: 0, rng: () => seed });
  assert.equal(pick(0), LINES.working[0]);
  assert.equal(pick(0.999), LINES.working.at(-1));
  assert.equal(lineFor('working', { now: 10_000, lastLineAt: 10_000 - 3599, rng: () => 0 }), null, 'too soon');
  assert.equal(lineFor('alert', { now: 1, lastLineAt: 0, rng: () => 0 }), LINES.alert[0], 'an alert line is never held back');
  assert.equal(lineFor('working', { now: 10_000, lastLineAt: 0, rng: () => 0, bubbles: false }), null, 'bubbles off: silence');
});

test('the pet stays on a screen when dragged or when the screen changes', () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  assert.deepEqual(clampToScreen({ x: 100, y: 100 }, { width: 140, height: 160 }, screens), { x: 100, y: 100 });
  assert.deepEqual(clampToScreen({ x: 1900, y: 1030 }, { width: 140, height: 160 }, screens), { x: 1780, y: 880 }, 'pulled back inside');
  assert.deepEqual(clampToScreen({ x: -50, y: -20 }, { width: 140, height: 160 }, screens), { x: 0, y: 0 });
  const two = [...screens, { x: 1920, y: 0, width: 1280, height: 720 }];
  assert.deepEqual(clampToScreen({ x: 2500, y: 100 }, { width: 140, height: 160 }, two), { x: 2500, y: 100 }, 'on the second screen is fine');
  assert.deepEqual(clampToScreen({ x: 2500, y: 100 }, { width: 140, height: 160 }, screens), { x: 1780, y: 100 }, 'the second screen was unplugged: back to the first');
  assert.deepEqual(clampToScreen(null, { width: 140, height: 160 }, screens), { x: 1920 - 140 - 24, y: 1040 - 160 - 24 }, 'first time: bottom right corner');
});
