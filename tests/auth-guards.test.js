import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { createHash } from 'node:crypto';
import { requireMaster, sessionHash } from '../server/auth.js';

test.after(() => closeDb());

// Minimal express double: requireMaster only touches req.user, res.status/json, next.
function runGuard(user) {
  return new Promise((resolve) => {
    const req = { user };
    const res = {
      statusCode: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, passed: false }); },
    };
    requireMaster(req, res, () => resolve({ status: null, body: null, passed: true }));
  });
}

test('requireMaster lets the master through', async () => {
  assert.deepEqual(await runGuard({ id: 1, role: 'master' }), { status: null, body: null, passed: true });
});

test('requireMaster rejects a normal user with 403', async () => {
  const r = await runGuard({ id: 2, role: 'user' });
  assert.equal(r.passed, false);
  assert.equal(r.status, 403);
});

test('requireMaster rejects a missing user', async () => {
  const r = await runGuard(undefined);
  assert.equal(r.passed, false);
  assert.equal(r.status, 403);
});

// The master changing their own password clears every session but the one they are
// sitting in, which only works if this is the very hash stored in `sessions`.
test('sessionHash reads the session cookie and hashes it the way sessions are stored', () => {
  const token = 'a-session-token';
  const req = { headers: { cookie: `other=1; jarvis_sid=${encodeURIComponent(token)}; more=2` } };
  assert.equal(sessionHash(req), createHash('sha256').update(token).digest('hex'));
});

test('sessionHash is null when there is no cookie at all', () => {
  assert.equal(sessionHash({ headers: {} }), null);
  assert.equal(sessionHash({ headers: { cookie: 'unrelated=1' } }), null);
});
