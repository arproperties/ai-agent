import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { emailHandlers } from '../server/emailRoutes.js';
import { createDraft, getDraft, decideDraft, PER_HOUR } from '../server/drafts.js';

test.after(() => closeDb());

// The HTTP boundary, not the module behind it: approving is the one door a draft leaves
// 'pending' by, and it is the door the safety model rests on. Minimal express double, the
// same shape as tests/auth-guards.test.js — the router wraps each handler so a throw
// becomes next(err) rather than a response, so the double catches it the same way.
async function call(handler, { user, params = {}, query = {} } = {}) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let failed = null;
  await Promise.resolve(handler({ user, params, query }, res, (e) => { failed = e; }))
    .catch((e) => { failed = e; });
  if (failed) return { status: failed.status || 500, body: { error: failed.message } };
  return { status: res.statusCode, body: res.body };
}

/**
 * Approving kicks the outbox, which is not awaited, so a drain would otherwise be changing
 * the row while the test reads it. A full send quota holds the queue where it is: the
 * route's own behaviour is what is under test here, not the queue's.
 */
async function holdTheQueue(userId) {
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < PER_HOUR; i++) {
    await db.prepare(`INSERT INTO email_action_log (user_id, action, ok, created_at) VALUES (?, 'send', true, ?)`).run(userId, now - 60);
  }
}

test('the owner approving their own draft gets it back approved', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await holdTheQueue(userId);
  const d = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });

  const r = await call(emailHandlers.approve, { user: { id: userId }, params: { id: String(d.id) } });

  assert.equal(r.status, 200);
  assert.equal(r.body.draft.status, 'approved');
  assert.equal((await getDraft(userId, d.id)).status, 'approved');
});

test('someone else cannot approve your draft, and it stays pending', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const tom = await makeUser('Tom');
  const d = await createDraft(sara, { to: ['bob@example.com'], body: 'hi' });

  const r = await call(emailHandlers.approve, { user: { id: tom }, params: { id: String(d.id) } });

  assert.equal(r.status, 404, 'not 403: whose drafts exist is not his business either');
  assert.equal((await getDraft(sara, d.id)).status, 'pending');
});

test('rejecting a draft that is already rejected is refused', async () => {
  await reset();
  const userId = await makeUser('Sara');
  const d = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });
  await decideDraft(userId, d.id, false);

  const r = await call(emailHandlers.reject, { user: { id: userId }, params: { id: String(d.id) } });

  assert.equal(r.status, 409);
  assert.equal((await getDraft(userId, d.id)).status, 'rejected');
});

test('a draft can be asked what became of it, but only by its owner', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const tom = await makeUser('Tom');
  const d = await createDraft(sara, { to: ['bob@example.com'], body: 'hi' });

  const hers = await call(emailHandlers.getDraft, { user: { id: sara }, params: { id: String(d.id) } });
  assert.equal(hers.status, 200);
  assert.equal(hers.body.draft.status, 'pending');

  const his = await call(emailHandlers.getDraft, { user: { id: tom }, params: { id: String(d.id) } });
  assert.equal(his.status, 404);
  assert.equal(his.body.draft, undefined, 'and not a body someone else could read');
});
