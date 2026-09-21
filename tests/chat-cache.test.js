import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { withCacheMark } from '../server/chat.js';

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
