import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, screenText } from '../server/voiceCommand.js';

// Voice control presses what the model names. These cover the one promise that keeps it
// from being anything more than a finger: whatever comes back, only what is on the screen
// it was shown, and only the handful of things a screen can do, is let through.

test('the screen is shown as numbered lines, with a box\'s kind and what is in it', () => {
  const { count, text } = screenText({ title: 'Leasing', items: [
    { k: 'button', l: 'New lease' },
    { k: 'field', t: 'date', l: 'Start date', v: '2026-01-01' },
    { k: 'tab', l: 'Calendar', on: true },
  ] });
  assert.equal(count, 3);
  assert.equal(text, 'Screen: Leasing\n0 button "New lease"\n1 field(date) "Start date" = "2026-01-01"\n2 tab "Calendar" [on]');
});

test('a screen longer than the limit is cut, and a press past the cut is refused', () => {
  const { count } = screenText({ items: Array.from({ length: 500 }, (_, i) => ({ k: 'button', l: `b${i}` })) });
  assert.equal(count, 160);
  assert.deepEqual(parse('{"actions":[{"do":"click","i":160}]}', count).actions, []);
});

test('presses, fills, keys and scrolls come through as they were given', () => {
  const got = parse('Sure: {"say":"Done","actions":[{"do":"click","i":0},{"do":"fill","i":1,"value":5000},{"do":"key","key":"Enter"},{"do":"scroll","dir":"down"},{"do":"back"}],"more":true}', 2);
  assert.equal(got.say, 'Done');
  assert.equal(got.more, true);
  assert.deepEqual(got.actions, [
    { do: 'click', i: 0 }, { do: 'fill', i: 1, value: '5000' }, { do: 'key', key: 'Enter' }, { do: 'scroll', dir: 'down' }, { do: 'back' },
  ]);
});

test('an item that is not on the screen is never pressed', () => {
  const got = parse('{"actions":[{"do":"click","i":7},{"do":"click","i":-1},{"do":"click","i":"0"},{"do":"fill","i":9,"value":"x"}]}', 3);
  assert.deepEqual(got.actions, []);
});

test('anything that is not one of the known actions is dropped', () => {
  const got = parse('{"actions":[{"do":"eval","code":"x"},{"do":"key","key":"F5"},{"do":"scroll","dir":"sideways"},{"do":"riley","text":"  "},null,"click"],"more":true}', 3);
  assert.deepEqual(got.actions, []);
  assert.equal(got.more, false); // nothing was done, so there is nothing to go on from
});

test('words for Riley are passed as they were spoken', () => {
  assert.deepEqual(parse('{"actions":[{"do":"riley","text":"how much rent is overdue?"}]}', 0).actions, [{ do: 'riley', text: 'how much rent is overdue?' }]);
});

test('a reply that is not JSON does nothing', () => {
  assert.deepEqual(parse('I cannot help with that.', 5), { say: '', actions: [], more: false });
  assert.deepEqual(parse('{"actions": [', 5), { say: '', actions: [], more: false });
});
