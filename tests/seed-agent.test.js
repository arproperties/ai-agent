import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/seed-agent.js', import.meta.url));

test.after(() => closeDb());

// The script is run as a child process rather than imported: it is a top-level script
// that ends in process.exit, and what is being tested is exactly what a deploy runs.
const seed = (name, ...flags) => run(process.execPath, [script, name, ...flags], {
  env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
});

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const jarvis = await makeAgent(masterId, 'Jarvis');

  // A normal account set up the way the People screen leaves one: a single agent they
  // talk to, everything else lending a shelf.
  const userId = await makeUser('Sara');
  await db.prepare(`INSERT INTO agent_assignments (agent_id, user_id, mode, is_primary)
    VALUES (?, ?, 'chat', true)`).run(jarvis, userId);
  return { masterId, userId, jarvis };
}

const assignments = (userId) => db.prepare(`SELECT a.name, aa.mode, aa.is_primary
  FROM agent_assignments aa JOIN agents a ON a.id = aa.agent_id
  WHERE aa.user_id = ? ORDER BY a.name`).all(userId);

test('a seeded agent reaches other accounts as a shelf, never as a second sidebar agent', async () => {
  const { userId } = await fixture();
  await seed('Operations Manager', '--apply');

  const rows = await assignments(userId);
  assert.deepEqual(rows, [
    { name: 'Jarvis', mode: 'chat', is_primary: true },
    { name: 'Operations Manager', mode: 'knowledge', is_primary: false },
  ], 'their chat agent is untouched and the new one only lends its shelf');
});

test('the master owns the seeded agent and gets no assignment row', async () => {
  const { masterId } = await fixture();
  await seed('Operations Manager', '--apply');

  const owned = await db.prepare('SELECT name, icon, color FROM agents WHERE user_id = ? AND name = ?')
    .get(masterId, 'Operations Manager');
  assert.ok(owned, 'the agent is created under the master');
  assert.equal(owned.icon, 'rocket');

  // The master reaches their own agents by ownership (access.js chatAgents), so a row
  // here would be duplicate bookkeeping that later counts as "somebody is using it".
  assert.deepEqual(await assignments(masterId), []);
});

test('a dry run writes nothing', async () => {
  const { userId } = await fixture();
  const { stdout } = await seed('Operations Manager');

  assert.match(stdout, /Dry run/);
  assert.equal(await db.prepare("SELECT COUNT(*)::int n FROM agents WHERE name = 'Operations Manager'").get()
    .then((r) => r.n), 0);
  assert.equal((await assignments(userId)).length, 1);
});

test('running it twice changes nothing the second time', async () => {
  const { userId } = await fixture();
  await seed('Operations Manager', '--apply');
  const before = await assignments(userId);

  const { stdout } = await seed('Operations Manager', '--apply');
  assert.match(stdout, /already exists/);
  assert.equal(await db.prepare("SELECT COUNT(*)::int n FROM agents WHERE name = 'Operations Manager'").get()
    .then((r) => r.n), 1, 'no duplicate agent');
  assert.deepEqual(await assignments(userId), before);
});

test('an unknown name is refused and names what it does know', async () => {
  await fixture();
  await assert.rejects(() => seed('Chief Vibes Officer', '--apply'), (e) => {
    assert.match(e.stderr, /Unknown agent: Chief Vibes Officer/);
    assert.match(e.stderr, /Operations Manager/);
    return true;
  });
});
