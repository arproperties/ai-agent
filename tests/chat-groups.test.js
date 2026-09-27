// The sidebar's chat list is grouped the way ChatGPT's is: Today, Yesterday, then
// widening buckets. The grouping is pure arithmetic on timestamps, so it is tested
// here rather than through the component.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupChats } from '../client/src/lib/chatGroups.js';

// A fixed "now" so the tests do not drift: 2026-09-27 18:00 local.
const NOW = new Date(2026, 8, 27, 18, 0, 0).getTime();
const at = (d, h = 12) => Math.floor(new Date(2026, 8, d, h, 0, 0).getTime() / 1000);
const labels = (groups) => groups.map((g) => g.label);

test('no chats produces no groups', () => {
  assert.deepEqual(groupChats([], NOW), []);
});

test('a chat from earlier the same day is Today', () => {
  const g = groupChats([{ id: 1, updated_at: at(27, 9) }], NOW);
  assert.deepEqual(labels(g), ['Today']);
  assert.deepEqual(g[0].items.map((c) => c.id), [1]);
});

// Midnight is the boundary, not 24 hours: something from 11pm last night is
// Yesterday at 1am, which is what a person means by the word.
test('a chat from before midnight is Yesterday, not Today', () => {
  const g = groupChats([{ id: 1, updated_at: at(26, 23) }], new Date(2026, 8, 27, 1, 0, 0).getTime());
  assert.deepEqual(labels(g), ['Yesterday']);
});

test('chats two to seven days back are Previous 7 days', () => {
  const g = groupChats([{ id: 1, updated_at: at(24) }, { id: 2, updated_at: at(21) }], NOW);
  assert.deepEqual(labels(g), ['Previous 7 days']);
  assert.deepEqual(g[0].items.map((c) => c.id), [1, 2]);
});

test('chats up to thirty days back are Previous 30 days', () => {
  const g = groupChats([{ id: 1, updated_at: Math.floor((NOW - 20 * 86400000) / 1000) }], NOW);
  assert.deepEqual(labels(g), ['Previous 30 days']);
});

test('anything older falls into Older', () => {
  const g = groupChats([{ id: 1, updated_at: Math.floor((NOW - 200 * 86400000) / 1000) }], NOW);
  assert.deepEqual(labels(g), ['Older']);
});

test('groups come back newest first and skip the empty ones', () => {
  const g = groupChats([
    { id: 1, updated_at: at(27, 9) },
    { id: 2, updated_at: at(26, 10) },
    { id: 3, updated_at: Math.floor((NOW - 100 * 86400000) / 1000) },
  ], NOW);
  assert.deepEqual(labels(g), ['Today', 'Yesterday', 'Older']);
});

test('the order chats arrive in is kept inside a group', () => {
  const g = groupChats([
    { id: 1, updated_at: at(27, 17) },
    { id: 2, updated_at: at(27, 8) },
    { id: 3, updated_at: at(27, 11) },
  ], NOW);
  assert.deepEqual(g[0].items.map((c) => c.id), [1, 2, 3]);
});

// A row with no timestamp should still be reachable rather than silently dropped.
test('a chat with no timestamp is Older rather than missing', () => {
  const g = groupChats([{ id: 1 }], NOW);
  assert.deepEqual(labels(g), ['Older']);
  assert.deepEqual(g[0].items.map((c) => c.id), [1]);
});
