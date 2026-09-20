import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { createUser, setAssignments, listUsers, listAssignments } from '../server/admin.js';

test.after(() => closeDb());

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  const lawyer = await makeAgent(masterId, 'Lawyer');
  const hr = await makeAgent(masterId, 'HR');
  return { master, lawyer, hr };
}

test('createUser makes a normal, enabled account recorded against its creator', async () => {
  const { master } = await fixture();
  const u = await createUser(master, { name: 'Sara', email: 'SARA@Example.com ', password: 'hunter2hunter2' });
  assert.equal(u.email, 'sara@example.com', 'email is normalised');
  assert.equal(u.role, 'user');

  const row = await db.prepare('SELECT role, disabled, created_by, password_hash FROM users WHERE id = ?').get(u.id);
  assert.equal(row.disabled, false);
  assert.equal(row.created_by, master.id);
  assert.match(row.password_hash, /^scrypt\$/, 'the password must be hashed');
});

test('createUser rejects a duplicate email', async () => {
  const { master } = await fixture();
  await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  await assert.rejects(
    () => createUser(master, { name: 'Other', email: 'sara@example.com', password: 'hunter2hunter2' }),
    /already exists/
  );
});

test('createUser rejects a short password', async () => {
  const { master } = await fixture();
  await assert.rejects(
    () => createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'short' }),
    /at least 8/
  );
});

test('setAssignments replaces the whole set', async () => {
  const { master, lawyer, hr } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });

  await setAssignments(master, sara.id, [{ agentId: lawyer, mode: 'chat', primary: true }]);
  await setAssignments(master, sara.id, [
    { agentId: lawyer, mode: 'chat' },
    { agentId: hr, mode: 'knowledge' },
  ]);

  const rows = await db.prepare('SELECT agent_id, mode FROM agent_assignments WHERE user_id = ? ORDER BY agent_id').all(sara.id);
  assert.deepEqual(rows, [{ agent_id: lawyer, mode: 'chat' }, { agent_id: hr, mode: 'knowledge' }].sort((a, b) => a.agent_id - b.agent_id));
});

test('setAssignments refuses an agent the master does not own', async () => {
  const { master } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  const strayOwner = await makeUser('Stray');
  const stray = await makeAgent(strayOwner, 'Stray');

  await assert.rejects(() => setAssignments(master, sara.id, [{ agentId: stray, mode: 'chat' }]), /not found/i);
});

test('setAssignments rejects an unknown mode', async () => {
  const { master, lawyer } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  await assert.rejects(() => setAssignments(master, sara.id, [{ agentId: lawyer, mode: 'root' }]), /mode/i);
});

// Losing a shelf must not mean losing what you filed on it. The files move into the
// user's own library, which also lets the master finally delete a retired agent -
// DELETE /api/agents/:id refuses while anyone else's material is still attached.
test('unassigning a shelf detaches that user\'s files from it, keeping them', async () => {
  const { master, lawyer, hr } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  await setAssignments(master, sara.id, [{ agentId: lawyer }, { agentId: hr }]);
  await db.prepare("INSERT INTO documents (user_id, agent_id, name, title, status) VALUES (?, ?, 'case.pdf', 'Case', 'ready')").run(sara.id, lawyer);
  await db.prepare('INSERT INTO chunks (user_id, agent_id, text) VALUES (?, ?, ?)').run(sara.id, lawyer, 'case notes');

  await setAssignments(master, sara.id, [{ agentId: hr }]); // Lawyer taken away

  const doc = await db.prepare('SELECT name, agent_id FROM documents WHERE user_id = ?').get(sara.id);
  assert.deepEqual(doc, { name: 'case.pdf', agent_id: null }, 'the file stays, in her own library');
  const chunk = await db.prepare('SELECT agent_id FROM chunks WHERE user_id = ?').get(sara.id);
  assert.equal(chunk.agent_id, null, 'its chunks follow the document off the shelf');
});

test('a shelf the user keeps leaves their files exactly where they are', async () => {
  const { master, lawyer, hr } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  await setAssignments(master, sara.id, [{ agentId: lawyer }, { agentId: hr }]);
  await db.prepare("INSERT INTO documents (user_id, agent_id, name, title, status) VALUES (?, ?, 'case.pdf', 'Case', 'ready')").run(sara.id, lawyer);

  await setAssignments(master, sara.id, [{ agentId: lawyer }]); // only HR taken away

  const doc = await db.prepare('SELECT agent_id FROM documents WHERE user_id = ?').get(sara.id);
  assert.equal(doc.agent_id, lawyer, 'she still has Lawyer, so the file stays on that shelf');
});

test("unassigning one user never moves another user's files", async () => {
  const { master, lawyer } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  const tom = await createUser(master, { name: 'Tom', email: 'tom@example.com', password: 'hunter2hunter2' });
  await setAssignments(master, sara.id, [{ agentId: lawyer }]);
  await setAssignments(master, tom.id, [{ agentId: lawyer }]);
  await db.prepare("INSERT INTO documents (user_id, agent_id, name, title, status) VALUES (?, ?, 'tom.pdf', 'Tom', 'ready')").run(tom.id, lawyer);

  await setAssignments(master, sara.id, []);

  const doc = await db.prepare('SELECT agent_id FROM documents WHERE user_id = ?').get(tom.id);
  assert.equal(doc.agent_id, lawyer, "Tom still has Lawyer; Sara's change must not touch his files");
});

// setAssignments replaces the whole set, so the admin screen has to be able to read
// the current one back before it can offer a checkbox per agent.
test('listAssignments reads back what was assigned', async () => {
  const { master, lawyer, hr } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  await setAssignments(master, sara.id, [
    { agentId: hr, mode: 'knowledge' },
    { agentId: lawyer, mode: 'chat', primary: true },
  ]);

  assert.deepEqual(await listAssignments(sara.id), [
    { agent_id: lawyer, mode: 'chat', is_primary: true },
    { agent_id: hr, mode: 'knowledge', is_primary: false },
  ], 'ordered by agent id, with the mode and primary flag the screen needs');
});

test('listAssignments is empty for a user with nothing assigned', async () => {
  const { master } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  assert.deepEqual(await listAssignments(sara.id), []);
});

test('listUsers reports each user with their assignment count and never a password', async () => {
  const { master, lawyer } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  await setAssignments(master, sara.id, [{ agentId: lawyer, mode: 'chat' }]);

  const users = await listUsers();
  const row = users.find((u) => u.id === sara.id);
  assert.equal(row.agents, 1);
  assert.ok(!('password_hash' in row), 'never expose the hash');
});
