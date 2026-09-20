import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { agentOut } from '../server/agents.js';

test.after(() => closeDb());

const master = { id: 1, role: 'master' };
const plain = { id: 2, role: 'user' };

const row = {
  id: 7, user_id: 1, name: 'Lawyer', icon: 'scale', color: 'violet',
  persona: 'You are a lawyer. Internal routing rules follow…',
  model: 'claude-opus-5', voice: 'alloy', starters: '["Draft a notice"]',
};

test('master sees the full agent', () => {
  const out = agentOut(row, master);
  assert.equal(out.persona, row.persona);
  assert.equal(out.model, 'claude-opus-5');
  assert.deepEqual(out.starters, ['Draft a notice']);
});

test('a normal user does not receive persona or model', () => {
  const out = agentOut(row, plain);
  assert.equal(out.name, 'Lawyer');
  assert.deepEqual(out.starters, ['Draft a notice']);
  assert.ok(!('persona' in out), 'persona is master-authored and must not be exposed');
  assert.ok(!('model' in out), 'model choice is master-only');
});

test('agentOut tolerates a missing starters value', () => {
  assert.deepEqual(agentOut({ ...row, starters: null }, master).starters, []);
});
