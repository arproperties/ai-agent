import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { withCacheMark, toClaude, toolNote } from '../server/chat.js';

test.after(() => closeDb());

const mark = { type: 'ephemeral' };

test('marks the last block of a tool-result round, leaving the original untouched', () => {
  const convo = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search_email', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }, { type: 'tool_result', tool_use_id: 't2', content: 'b' }] },
  ];
  const out = withCacheMark(convo);
  assert.deepEqual(out.at(-1).content[1].cache_control, mark);
  assert.equal(out.at(-1).content[0].cache_control, undefined);
  assert.equal(convo.at(-1).content[1].cache_control, undefined, 'the mark must not build up round after round');
});

test('leaves an assistant turn (it can end in thinking) and plain-text turns alone', () => {
  const paused = [{ role: 'user', content: [{ type: 'text', text: 'q' }] }, { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] }];
  assert.equal(withCacheMark(paused), paused);
  const plain = [{ role: 'user', content: 'q' }];
  assert.equal(withCacheMark(plain), plain);
});

test('an earlier reply that used tools is replayed with its tool calls, so a past action never reads as words alone', () => {
  const rows = [
    { role: 'user', content: 'book 101 for Francis', files: '[]', tools: '[]' },
    { role: 'assistant', content: 'BK-2026-0001 saved as a draft.', files: '[]',
      tools: JSON.stringify([{ id: 't1', name: 'leasing_add_booking', input: { unit_no: '101' }, result: 'Booking BK-2026-0001 saved as a DRAFT', error: false }]) },
    { role: 'user', content: 'confirmed', files: '[]', tools: '[]' },
    { role: 'assistant', content: 'Which one?', files: '[]', tools: '[]' },
  ];
  assert.deepEqual(toClaude(rows), [
    { role: 'user', content: 'book 101 for Francis' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'leasing_add_booking', input: { unit_no: '101' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Booking BK-2026-0001 saved as a DRAFT', is_error: false }] },
    { role: 'assistant', content: 'BK-2026-0001 saved as a draft.' },
    { role: 'user', content: 'confirmed' },
    { role: 'assistant', content: 'Which one?' },
  ]);
});

test('a tool call is kept short for the replay: a long answer is cut, an oversized input dropped', () => {
  const big = toolNote({ id: 't2', name: 'create_draft', input: { body: 'x'.repeat(5000) } }, { content: 'y'.repeat(5000), is_error: true });
  assert.deepEqual(big.input, {});
  assert.equal(big.result.length, 801);
  assert.equal(big.error, true);
  assert.equal(toolNote({ id: 't3', name: 'list_todos', input: {} }, { content: [{ type: 'text', text: 'two' }] }).result, 'two');
});
