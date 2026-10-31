import './helpers/db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unbacked, claimNote } from '../server/claims.js';

const none = new Set();

test('a draft said to be ready with no draft written is caught', () => {
  assert.deepEqual(unbacked('Draft is ready for your approval — to Rona (cc Legal).', none), ['an email draft']);
  assert.deepEqual(unbacked('Draft updated — to Rona, **cc HR (hr@ainalreempro.com)**, legal removed.', none), ['an email draft']);
  assert.deepEqual(unbacked('Reply drafted to Rona — approving Stephen and Boniface.', none), ['an email draft']);
});

test('a draft that a tool wrote passes', () => {
  assert.deepEqual(unbacked('Draft is ready for your approval.', new Set(['reply_email'])), []);
  assert.deepEqual(unbacked('Draft updated — cc HR.', new Set(['create_draft'])), []);
});

test('a to-do and a reminder card are checked too', () => {
  assert.deepEqual(unbacked('Done — it is on your to-do list (#346).', none), ['a to-do']);
  assert.deepEqual(unbacked('Added to your to-do list.', new Set(['add_todo'])), []);
  assert.deepEqual(unbacked('Ready for Francisca — tap **Send** on the card to deliver it.', none), ['a reminder card']);
});

test('an answer that claims nothing is left alone', () => {
  assert.deepEqual(unbacked('None of the three has replied. I searched all folders.', none), []);
  assert.deepEqual(unbacked('Shall I draft a reply to Antonius with your number?', none), []);
});

test('the note names what is missing and lets an earlier one stand', () => {
  const note = claimNote(['an email draft']);
  assert.match(note, /an email draft/);
  assert.match(note, /reply with nothing at all/);
});
