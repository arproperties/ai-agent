import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { setShared } from '../server/files.js';
import { retrievalScope, indexChunks } from '../server/knowledge.js';
import { shelfIds } from '../server/access.js';

test.after(() => closeDb());

const assign = (agentId, userId, mode = 'chat') =>
  db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(agentId, userId, mode);

async function makeFile(userId, agentId, name) {
  const { id } = await db.prepare(`INSERT INTO documents (user_id, agent_id, name, title, status)
    VALUES (?, ?, ?, ?, 'ready') RETURNING id`).run(userId, agentId, name, name);
  await db.prepare('INSERT INTO chunks (user_id, agent_id, document_id, text) VALUES (?, ?, ?, ?)')
    .run(userId, agentId, id, `contents of ${name}`);
  return id;
}

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  const saraId = await makeUser('Sara');
  const sara = await db.prepare('SELECT * FROM users WHERE id = ?').get(saraId);
  const hr = await makeAgent(masterId, 'HR');
  const legal = await makeAgent(masterId, 'Legal');
  return { master, sara, hr, legal };
}

const state = (docId) => db.prepare(`SELECT d.shared doc, c.shared chunk
  FROM documents d JOIN chunks c ON c.document_id = d.id WHERE d.id = ?`).get(docId);

test('sharing a file marks the document and its chunks together', async () => {
  const { master, hr } = await fixture();
  const id = await makeFile(master.id, hr, 'handbook.pdf');

  await setShared(master, id, true);

  assert.deepEqual(await state(id), { doc: true, chunk: true },
    'chunks.shared is denormalised, so it must move with the document');
});

test('unsharing a file clears both again', async () => {
  const { master, hr } = await fixture();
  const id = await makeFile(master.id, hr, 'handbook.pdf');
  await setShared(master, id, true);

  await setShared(master, id, false);

  assert.deepEqual(await state(id), { doc: false, chunk: false });
});

test('a normal user cannot share their own file', async () => {
  const { sara, hr } = await fixture();
  const id = await makeFile(sara.id, hr, 'sara-payslip.pdf');

  await assert.rejects(() => setShared(sara, id, true), /not allowed/i);
  assert.deepEqual(await state(id), { doc: false, chunk: false }, 'a user\'s uploads are always private');
});

test('master cannot share a file that is not theirs', async () => {
  const { master, sara, hr } = await fixture();
  const id = await makeFile(sara.id, hr, 'sara-payslip.pdf');

  await assert.rejects(() => setShared(master, id, true), /not found/i);
  assert.deepEqual(await state(id), { doc: false, chunk: false });
});

test('re-indexing a shared document keeps its chunks shared', async () => {
  const { master, hr } = await fixture();
  const id = await makeFile(master.id, hr, 'handbook.pdf');
  await setShared(master, id, true);
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);

  // indexChunks replaces every chunk of the document, so it has to carry the flag over
  // or sharing would silently lapse the next time the file is processed.
  await indexChunks(doc, 'Notice period is 30 days for permanent staff.');

  const rows = await db.prepare('SELECT shared FROM chunks WHERE document_id = ?').all(id);
  assert.ok(rows.length, 'the document should have been re-chunked');
  assert.ok(rows.every((r) => r.shared === true), 'every rewritten chunk must stay shared');
});

// ---------- what sharing actually does for retrieval ----------

async function visibleTo(user) {
  const scope = retrievalScope(user.id, await shelfIds(user));
  const rows = await db.prepare(`SELECT t.text FROM chunks t WHERE ${scope.sql} ORDER BY t.id`).all(...scope.params);
  return rows.map((r) => r.text);
}

test('sharing a shelf file reaches the users assigned that shelf', async () => {
  const { master, sara, hr } = await fixture();
  await assign(hr, sara.id);
  const id = await makeFile(master.id, hr, 'handbook.pdf');
  assert.deepEqual(await visibleTo(sara), [], 'private by default');

  await setShared(master, id, true);

  assert.deepEqual(await visibleTo(sara), ['contents of handbook.pdf']);
});

test('sharing a shelf file does not reach users without that shelf', async () => {
  const { master, sara, hr, legal } = await fixture();
  await assign(legal, sara.id); // Sara has Legal, never HR
  const id = await makeFile(master.id, hr, 'handbook.pdf');

  await setShared(master, id, true);

  assert.deepEqual(await visibleTo(sara), [], 'the shelf filter is the boundary');
});

test('sharing a library file with no shelf reaches everyone', async () => {
  const { master, sara } = await fixture();
  const id = await makeFile(master.id, null, 'holiday-calendar.pdf');

  await setShared(master, id, true);

  assert.deepEqual(await visibleTo(sara), ['contents of holiday-calendar.pdf'],
    'no shelf means no shelf filter - this is the wide one the UI must label clearly');
});
