import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { tooSpecificToShare, saveFact, retrievalScope } from '../server/knowledge.js';
import { shelfIds } from '../server/access.js';

test.after(() => closeDb());

// ---------- the deterministic block ----------
// The model is asked for general rules only, but it is the last thing deciding, and a
// captured fact is one click from being published. This refuses anything that reads as
// being about a particular person, sum or document, whatever the model thought.

test('a general rule is shareable', () => {
  for (const f of [
    'Notice period is 30 days for permanent staff',
    'Invoices are paid on the 25th of each month',
    'Trade licence renews every December',
  ]) assert.equal(tooSpecificToShare(f), false, `${f} should be allowed`);
});

test('anything with a money amount is refused', () => {
  for (const f of [
    'Rahul earns AED 14,000 per month',
    'The deposit was 4,750 AED',
    'Annual rent is $95,000',
  ]) assert.equal(tooSpecificToShare(f), true, `${f} should be refused`);
});

test('anything with an id-like number is refused', () => {
  for (const f of [
    'The Ejari number is 1234567890',
    'Trade licence 987654 expires in December',
    'Passport Z1234567 belongs to the new hire',
  ]) assert.equal(tooSpecificToShare(f), true, `${f} should be refused`);
});

test('a full name is refused', () => {
  for (const f of [
    'Rahul Menon is serving his notice',
    'The lease is signed with Al Fattan Properties',
  ]) assert.equal(tooSpecificToShare(f), true, `${f} should be refused`);
});

// Recorded deliberately, because it is the limit of what a regex can do here and the
// reason facts are captured switched off rather than published straight away: a bare
// first name is indistinguishable in shape from any other capitalised word, so this
// sentence gets through the block and is caught only by the prompt, or by the master
// reading it in their Shelf before ticking it.
test('a bare first name is NOT caught - the review step is what covers this', () => {
  assert.equal(tooSpecificToShare('Sara handles the Dubai office'), false);
});

test('the block does not trip on ordinary capitalised words', () => {
  for (const f of [
    'Notice period is 30 days for permanent staff',
    'Ejari registration is required for every tenancy',
    'UAE labour law sets the minimum annual leave',
  ]) assert.equal(tooSpecificToShare(f), false, `${f} should be allowed`);
});

// ---------- saveFact: captured, but switched off ----------

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  const saraId = await makeUser('Sara');
  const sara = await db.prepare('SELECT * FROM users WHERE id = ?').get(saraId);
  const hr = await makeAgent(masterId, 'HR');
  await db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(hr, saraId, 'chat');
  const { id: conv } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(masterId, 'HR questions');
  return { master, sara, hr, conv };
}

test('a captured fact lands on the shelf switched off', async () => {
  const { master, hr, conv } = await fixture();

  const doc = await saveFact(master, hr, conv, 'Notice period is 30 days for permanent staff');

  assert.equal(doc.kind, 'fact');
  assert.equal(doc.agent_id, hr);
  assert.equal(doc.shared, false, 'nothing reaches anyone until it is ticked');
  assert.equal(doc.origin_conversation_id, conv, 'so a wrong one can be traced back');
  assert.equal(doc.user_id, master.id);
});

test('a captured fact is searchable, so it works the moment it is published', async () => {
  const { master, hr, conv } = await fixture();
  const doc = await saveFact(master, hr, conv, 'Notice period is 30 days for permanent staff');

  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM chunks WHERE document_id = ?').get(doc.id);
  assert.ok(n > 0, 'indexed at capture, not at publication');
  const chunk = await db.prepare('SELECT shared, agent_id FROM chunks WHERE document_id = ?').get(doc.id);
  assert.deepEqual(chunk, { shared: false, agent_id: hr }, 'and its chunks are switched off too');
});

test('an unpublished fact reaches nobody', async () => {
  const { master, sara, hr, conv } = await fixture();
  await saveFact(master, hr, conv, 'Notice period is 30 days for permanent staff');

  const scope = retrievalScope(sara.id, await shelfIds(sara));
  const seen = await db.prepare(`SELECT t.text FROM chunks t WHERE ${scope.sql}`).all(...scope.params);
  assert.deepEqual(seen, [], 'Sara has the HR shelf, but the fact is not shared yet');
});

test('publishing it is the ordinary Private/Shared toggle', async () => {
  const { master, sara, hr, conv } = await fixture();
  const doc = await saveFact(master, hr, conv, 'Notice period is 30 days for permanent staff');
  const { setShared } = await import('../server/files.js');

  await setShared(master, doc.id, true);

  const scope = retrievalScope(sara.id, await shelfIds(sara));
  const seen = await db.prepare(`SELECT t.text FROM chunks t WHERE ${scope.sql}`).all(...scope.params);
  assert.equal(seen.length, 1, 'now it reaches the people with that shelf');
  assert.match(seen[0].text, /Notice period is 30 days/);
});

test('the same fact is not captured twice', async () => {
  const { master, hr, conv } = await fixture();
  await saveFact(master, hr, conv, 'Notice period is 30 days');
  await saveFact(master, hr, conv, 'Notice period is 30 days');

  const { n } = await db.prepare("SELECT COUNT(*)::int n FROM documents WHERE kind = 'fact'").get();
  assert.equal(n, 1);
});
