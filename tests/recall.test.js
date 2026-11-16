import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { retrievalScope } from '../server/knowledge.js';

test.after(() => closeDb());

// Exercises the scope as SQL against real rows, which is the only way to know the
// clause is right. Uses chunks directly rather than going through embeddings.
async function chunkIds(user, agentId) {
  const scope = retrievalScope(user.id);
  const rows = await db.prepare(`SELECT t.id, t.text FROM chunks t WHERE ${scope.sql} ORDER BY t.id`).all(...scope.params);
  return rows.map((r) => r.text);
}

const chunk = (userId, agentId, text, shared = false) =>
  db.prepare('INSERT INTO chunks (user_id, agent_id, text, shared) VALUES (?, ?, ?, ?)').run(userId, agentId, text, shared);

const assign = (agentId, userId, mode = 'chat') =>
  db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(agentId, userId, mode);

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  const saraId = await makeUser('Sara');
  const sara = await db.prepare('SELECT * FROM users WHERE id = ?').get(saraId);
  const lawyer = await makeAgent(masterId, 'Lawyer');
  const hr = await makeAgent(masterId, 'HR');
  return { master, sara, lawyer, hr };
}

test('a user reads all of their own chunks regardless of agent', async () => {
  const { sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(sara.id, lawyer, 'sara lawyer note');
  await chunk(sara.id, hr, 'sara hr note');          // not assigned, but still hers
  await chunk(sara.id, null, 'sara library note');

  const texts = await chunkIds(sara, lawyer);
  assert.deepEqual(texts.sort(), ['sara hr note', 'sara lawyer note', 'sara library note'].sort());
});

test("a user never reads another user's chunks", async () => {
  const { master, sara, lawyer } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, lawyer, 'master private note');   // shared = false
  await chunk(sara.id, lawyer, 'sara note');

  const texts = await chunkIds(sara, lawyer);
  assert.deepEqual(texts, ['sara note'], 'master\'s private chunk must not be visible');
});

test('a user reads shared chunks on shelves they were assigned', async () => {
  const { master, sara, lawyer } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, lawyer, 'legal shelf policy', true);

  assert.ok((await chunkIds(sara, lawyer)).includes('legal shelf policy'));
});

test('a user reads shared chunks on shelves they were not assigned too', async () => {
  const { master, sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, hr, 'hr payroll policy', true);
  await chunk(master.id, hr, 'hr private note', false);

  const seen = await chunkIds(sara, lawyer);
  assert.ok(seen.includes('hr payroll policy'), 'shared means every user, whichever shelf');
  assert.ok(!seen.includes('hr private note'), 'and what is not shared stays with its owner');
});

test('a knowledge-mode assignment grants shelf access without the agent', async () => {
  const { master, sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id, 'chat');
  await assign(hr, sara.id, 'knowledge');
  await chunk(master.id, hr, 'hr handbook notice period', true);

  assert.ok((await chunkIds(sara, lawyer)).includes('hr handbook notice period'));
});

test('a shared chunk with no agent reaches everyone', async () => {
  const { master, sara, lawyer } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, null, 'company holiday calendar', true);

  assert.ok((await chunkIds(sara, lawyer)).includes('company holiday calendar'));
});

test('master reads all of their own chunks, shared or not', async () => {
  const { master, lawyer, hr } = await fixture();
  await chunk(master.id, lawyer, 'master private', false);
  await chunk(master.id, hr, 'master shared', true);

  const texts = await chunkIds(master, lawyer);
  assert.deepEqual(texts.sort(), ['master private', 'master shared'].sort());
});

test("master does not read a user's private chunks through recall", async () => {
  const { master, sara, lawyer } = await fixture();
  await chunk(sara.id, lawyer, 'sara private diary');

  assert.ok(!(await chunkIds(master, lawyer)).includes('sara private diary'),
    'master oversight is the admin router, not a widening of recall');
});

// ---------- the lean way (what goes with a message unasked) ----------

test('a reply too short to be a question looks nothing up; a real question does', async () => {
  const { worthLooking } = await import('../server/knowledge.js');
  for (const said of ['yes', 'Ok', 'continue', 'yes please go ahead', 'thank you', '', 'ok, done']) assert.equal(worthLooking(said), false, said);
  for (const said of ['Where is the boys camp?', 'trade licence expiry', 'please prepare the payment voucher for the painters']) assert.equal(worthLooking(said), true, said);
});

test('lean keeps only file pieces that match strongly, three at most, and the facts that match', async () => {
  const { pickStrong, STRONG_DIST } = await import('../server/knowledge.js');
  const rows = [
    { text: 'answers it', dist: 0.09, fact: false },
    { text: 'a rule that matches', dist: 0.2, fact: true }, // a fact needs only the ordinary match
    { text: 'close', dist: 0.12, fact: false },
    { text: 'also close', dist: 0.15, fact: false },
    { text: 'a fourth', dist: 0.16, fact: false },
    { text: 'shares a word, not the meaning', dist: STRONG_DIST + 0.01, fact: false },
    { text: 'an unrelated rule', dist: 0.3, fact: true },
  ];
  assert.deepEqual(pickStrong(rows), ['answers it', 'close', 'also close', 'a rule that matches']);
  assert.deepEqual(pickStrong([]), []);
});

test('the file list sent with a message can be cut to the newest few, still saying how many there are', async () => {
  const { master } = await fixture();
  const { libraryCatalog } = await import('../server/files.js');
  await db.prepare(`INSERT INTO documents (user_id, name, title, kind, shared, status)
    SELECT ?, 'f' || g || '.pdf', 'File ' || g, 'doc', false, 'ready' FROM generate_series(1, 12) g`).run(master.id);
  const lean = await libraryCatalog(master, 5);
  assert.equal(lean.files.length, 5);
  assert.equal(lean.total, 12);
  assert.match(lean.files[0], /File 12/, 'newest first');
  assert.equal((await libraryCatalog(master)).files.length, 12, 'forty when not asked otherwise');
});
