import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { keysFor, hasKey, loadKeys, setKey, removeKey, keysOf, keyFailed, isKeyError, seal, unseal } from '../server/aiKeys.js';

test.after(() => closeDb());

const CLAUDE = (n) => `sk-ant-api03-${String(n).repeat(30)}`;
const OPENAI = (n) => `sk-proj-${String(n).repeat(30)}`;
const sources = (provider, userId) => keysFor(provider, userId).map((k) => k.source);

async function setup() {
  await reset();
  delete process.env.CLAUDE_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
  const master = await makeUser('Boss');
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(master);
  const rona = await makeUser('Rona');
  const said = await makeUser('Said');
  await loadKeys();
  return { master: { id: master }, rona, said };
}

test('sealed keys come back only with the same secret', () => {
  const s = seal('sk-ant-secret');
  assert.ok(!s.includes('sk-ant'));
  assert.equal(unseal(s), 'sk-ant-secret');
  assert.equal(unseal('bad.data.here'), null);
});

test("a person's own key wins, then the company key, then .env", async () => {
  const { master, rona, said } = await setup();
  process.env.CLAUDE_API_KEY = CLAUDE(9);
  assert.deepEqual(sources('anthropic', rona), ['server']);

  await setKey(master, 'company', 'anthropic', CLAUDE(1), { check: false });
  assert.deepEqual(sources('anthropic', rona), ['company', 'server']);

  await setKey(master, rona, 'anthropic', CLAUDE(2), { check: false });
  assert.deepEqual(sources('anthropic', rona), ['own', 'company', 'server']);
  assert.equal(keysFor('anthropic', rona)[0].key, CLAUDE(2));
  assert.deepEqual(sources('anthropic', said), ['company', 'server'], "Rona's key is hers alone");
  assert.deepEqual(sources('anthropic', null), ['company', 'server'], 'background work starts at the company key');

  await removeKey(rona, 'anthropic');
  assert.deepEqual(sources('anthropic', rona), ['company', 'server']);
  assert.equal(process.env.CLAUDE_API_KEY, CLAUDE(9), '.env is never touched');
});

test('the same key twice is tried once, and voice needs some OpenAI key', async () => {
  const { master, rona } = await setup();
  assert.equal(hasKey('openai', rona), false);
  process.env.OPENAI_API_KEY = OPENAI(5);
  await setKey(master, 'company', 'openai', OPENAI(5), { check: false });
  assert.deepEqual(sources('openai', rona), ['company']);
  assert.equal(hasKey('openai', rona), true);
});

test('a key turned down moves to the back and the failure is shown', async () => {
  const { master, rona } = await setup();
  process.env.CLAUDE_API_KEY = CLAUDE(9);
  await setKey(master, rona, 'anthropic', CLAUDE(2), { check: false });
  const [own] = keysFor('anthropic', rona);
  keyFailed(own, Object.assign(new Error('invalid x-api-key'), { status: 401 }));
  assert.deepEqual(sources('anthropic', rona), ['server', 'own']);
  await new Promise((r) => setTimeout(r, 50));
  const shown = await keysOf(rona);
  assert.equal(shown.anthropic.key.failedReason, 'invalid x-api-key');
  // Saving it again clears the note
  await setKey(master, rona, 'anthropic', CLAUDE(2), { check: false });
  assert.equal((await keysOf(rona)).anthropic.key.failedAt, null);
  assert.deepEqual(sources('anthropic', rona), ['own', 'server']);
});

test('which errors count as the key itself being turned down', () => {
  assert.ok(isKeyError({ status: 401 }));
  assert.ok(isKeyError({ status: 400, message: 'Your credit balance is too low to access the Anthropic API.' }));
  assert.ok(isKeyError({ status: 429, code: 'insufficient_quota' }));
  assert.ok(!isKeyError({ status: 429, message: 'rate limited' }), 'busy is not broken');
  assert.ok(!isKeyError({ status: 400, message: 'max_tokens too large' }));
  assert.ok(!isKeyError(new Error('network')));
});

test('the screen sees only the last four characters, and what it falls back on', async () => {
  const { master, rona } = await setup();
  process.env.OPENAI_API_KEY = OPENAI(7);
  await setKey(master, 'company', 'anthropic', CLAUDE(1), { check: false });
  const shown = await keysOf(rona);
  assert.equal(shown.anthropic.key, null);
  assert.deepEqual(shown.anthropic.fallback, { source: 'company', last4: '1111' });
  assert.deepEqual(shown.openai.fallback, { source: 'server', last4: '7777' });
  const company = await keysOf('company');
  assert.equal(company.anthropic.key.last4, '1111');
  assert.ok(!JSON.stringify(company).includes(CLAUDE(1)));
  const row = await db.prepare('SELECT secret FROM ai_keys').get();
  assert.ok(!row.secret.includes('sk-ant'), 'stored encrypted');
});

test('wrong-looking keys and the master as a person are refused', async () => {
  const { master, rona } = await setup();
  await assert.rejects(setKey(master, rona, 'anthropic', OPENAI(1), { check: false }), /sk-ant-/);
  await assert.rejects(setKey(master, rona, 'openai', CLAUDE(1), { check: false }), /OpenAI key/);
  await assert.rejects(setKey(master, rona, 'anthropic', 'short', { check: false }), /does not look/);
  await assert.rejects(setKey(master, master.id, 'anthropic', CLAUDE(1), { check: false }), /company keys/);
  await assert.rejects(setKey(master, 99999, 'anthropic', CLAUDE(1), { check: false }), /not found/);
  await assert.rejects(setKey(master, rona, 'gemini', CLAUDE(1), { check: false }), /Unknown provider/);
});

test("the master's own calls use the company key, not a stray personal one", async () => {
  const { master } = await setup();
  await db.prepare('INSERT INTO ai_keys (owner_id, provider, secret, last4) VALUES (?, ?, ?, ?)').run(master.id, 'anthropic', seal(CLAUDE(3)), '3333');
  await setKey(master, 'company', 'anthropic', CLAUDE(1), { check: false });
  assert.deepEqual(sources('anthropic', master.id), ['company']);
});

test('a call on a turned-down key is made again on the next one, and billed to that key', async () => {
  const { master, rona } = await setup();
  const { claude } = await import('../server/ai.js');
  const { billAs } = await import('../server/billing.js');
  process.env.CLAUDE_API_KEY = CLAUDE(9);
  await setKey(master, rona, 'anthropic', CLAUDE(2), { check: false });
  const tried = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const key = new Headers(init.headers).get('x-api-key');
    tried.push(key);
    if (key === CLAUDE(2)) return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = await billAs({ userId: rona, job: 'chat' }, () => claude.messages.create({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(res.content[0].text, 'hi');
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(tried, [CLAUDE(2), CLAUDE(9)]);
  await new Promise((r) => setTimeout(r, 50));
  const cost = await db.prepare('SELECT user_id, key_source FROM ai_costs').get();
  assert.deepEqual(cost, { user_id: rona, key_source: 'server' });
});
