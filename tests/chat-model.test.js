import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { chatModel } from '../server/chat.js';
import { AUTO_MODEL, MASTER_MODEL } from '../server/config.js';

test.after(() => closeDb());

const master = { id: 1, role: 'master' };
const staff = { id: 2, role: 'user' };

test('Auto for staff: the cheap model, with the advisor', () => {
  assert.deepEqual(chatModel(staff, { model: 'auto' }), { model: AUTO_MODEL, auto: true });
});

test('Auto for the master: the stronger model writes the answer, no advisor', () => {
  assert.deepEqual(chatModel(master, { model: 'auto' }), { model: MASTER_MODEL, auto: false });
  assert.notEqual(MASTER_MODEL, AUTO_MODEL);
});

test('a model picked on the agent is used as it is, for everyone', () => {
  for (const user of [master, staff]) {
    assert.deepEqual(chatModel(user, { model: 'claude-opus-5' }), { model: 'claude-opus-5', auto: false });
  }
});
