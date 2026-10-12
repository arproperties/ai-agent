import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { setShared, setSharedMany, readableDocuments, readableDocument, docOut, deleteDocument, expiringDocuments } from '../server/files.js';
import { retrievalScope, indexChunks } from '../server/knowledge.js';

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
  const scope = retrievalScope(user.id);
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

test('sharing a shelf file reaches users without that shelf too', async () => {
  const { master, sara, hr, legal } = await fixture();
  await assign(legal, sara.id); // Sara has Legal, never HR
  const id = await makeFile(master.id, hr, 'handbook.pdf');
  assert.deepEqual(await visibleTo(sara), [], 'private by default');

  await setShared(master, id, true);

  assert.deepEqual(await visibleTo(sara), ['contents of handbook.pdf'], 'shared means every user, whichever shelf');
});

test('sharing a library file with no shelf reaches everyone', async () => {
  const { master, sara } = await fixture();
  const id = await makeFile(master.id, null, 'holiday-calendar.pdf');

  await setShared(master, id, true);

  assert.deepEqual(await visibleTo(sara), ['contents of holiday-calendar.pdf'],
    'no shelf means no shelf filter - this is the wide one the UI must label clearly');
});

// ---------- sharing a whole company or folder at once ----------

test('bulk sharing marks every listed file and its chunks', async () => {
  const { master, hr } = await fixture();
  const a = await makeFile(master.id, hr, 'handbook.pdf');
  const b = await makeFile(master.id, null, 'licence.pdf');

  assert.equal(await setSharedMany(master, [a, b], true), 2);
  assert.deepEqual(await state(a), { doc: true, chunk: true });
  assert.deepEqual(await state(b), { doc: true, chunk: true });

  assert.equal(await setSharedMany(master, [a, b], false), 2);
  assert.deepEqual(await state(a), { doc: false, chunk: false });
});

test('bulk sharing counts only files that actually changed', async () => {
  const { master, hr } = await fixture();
  const a = await makeFile(master.id, hr, 'handbook.pdf');
  const b = await makeFile(master.id, hr, 'policy.pdf');
  await setShared(master, a, true);

  assert.equal(await setSharedMany(master, [a, b], true), 1);
});

test('bulk sharing skips files that are not the master\'s', async () => {
  const { master, sara, hr } = await fixture();
  const mine = await makeFile(master.id, hr, 'handbook.pdf');
  const hers = await makeFile(sara.id, hr, 'sara-payslip.pdf');

  assert.equal(await setSharedMany(master, [mine, hers], true), 1);
  assert.deepEqual(await state(hers), { doc: false, chunk: false });
});

test('a normal user cannot bulk share', async () => {
  const { sara, hr } = await fixture();
  const id = await makeFile(sara.id, hr, 'sara-payslip.pdf');

  await assert.rejects(() => setSharedMany(sara, [id], true), /not allowed/i);
  assert.deepEqual(await state(id), { doc: false, chunk: false });
});

test('bulk sharing ignores junk ids', async () => {
  const { master } = await fixture();
  assert.equal(await setSharedMany(master, ['x', null, 1.5], true), 0);
  assert.equal(await setSharedMany(master, 'nope', true), 0);
});

// ---------- a shared file on the reader's own Shelf ----------

const names = (rows) => rows.map((r) => r.name).sort();

test('a shared shelf file is listed on the Shelf of the people given that shelf', async () => {
  const { master, sara, hr } = await fixture();
  await assign(hr, sara.id);
  const id = await makeFile(master.id, hr, 'handbook.pdf');
  await makeFile(sara.id, null, 'sara-payslip.pdf');
  assert.deepEqual(names(await readableDocuments(sara)), ['sara-payslip.pdf'], 'private by default');

  await setShared(master, id, true);

  assert.deepEqual(names(await readableDocuments(sara)), ['handbook.pdf', 'sara-payslip.pdf']);
  assert.deepEqual(names(await readableDocuments(sara, hr)), ['handbook.pdf'], 'and inside that agent\'s own shelf');
});

test('a shared shelf file is listed for someone without that shelf too', async () => {
  const { master, sara, hr, legal } = await fixture();
  await assign(legal, sara.id);
  await setShared(master, await makeFile(master.id, hr, 'handbook.pdf'), true);

  assert.deepEqual(names(await readableDocuments(sara)), ['handbook.pdf']);
});

test('a shared library file is listed for everyone, and leaves again when unshared', async () => {
  const { master, sara } = await fixture();
  const id = await makeFile(master.id, null, 'holiday-calendar.pdf');
  await setShared(master, id, true);
  assert.deepEqual(names(await readableDocuments(sara)), ['holiday-calendar.pdf']);

  await setShared(master, id, false);

  assert.deepEqual(await readableDocuments(sara), []);
});

test('one file can be opened by its reader, and by nobody it was not shared with', async () => {
  const { master, sara, hr } = await fixture();
  const id = await makeFile(master.id, hr, 'handbook.pdf');
  assert.equal(await readableDocument(sara, id), undefined, 'still private');

  await setShared(master, id, true);

  assert.equal((await readableDocument(sara, id)).name, 'handbook.pdf', 'Sara was never given HR, and reads it anyway');
  assert.equal((await readableDocument(master, id)).name, 'handbook.pdf');
});

test('a reader is told the file is not theirs, and not which chat it came from', async () => {
  const { master, sara } = await fixture();
  const { id: chat } = await db.prepare("INSERT INTO conversations (user_id, title) VALUES (?, 'Salary review') RETURNING id").run(master.id);
  const id = await makeFile(master.id, null, 'policy.pdf');
  await db.prepare('UPDATE documents SET conversation_id = ?, origin_conversation_id = ? WHERE id = ?').run(chat, chat, id);
  await setShared(master, id, true);

  const hers = docOut(await readableDocument(sara, id), sara.id);
  assert.equal(hers.mine, false);
  assert.equal(hers.owner_name, 'Master');
  assert.equal(hers.conversation_id, null);
  assert.equal(hers.conversation_title, null, 'the master\'s chat titles are not part of what was shared');
  assert.equal(hers.origin_conversation_id, null);
  assert.ok(!('path' in hers) && !('user_id' in hers));

  const his = docOut(await readableDocument(master, id), master.id);
  assert.equal(his.mine, true);
  assert.equal(his.conversation_title, 'Salary review');
});

test('a reader cannot delete a file that was shared with them', async () => {
  const { master, sara } = await fixture();
  const id = await makeFile(master.id, null, 'policy.pdf');
  await setShared(master, id, true);

  await deleteDocument(sara.id, id);

  assert.deepEqual(await state(id), { doc: true, chunk: true });
});

test('a shared file that is running out is on the reader\'s expiry list too', async () => {
  const { master, sara, hr } = await fixture();
  const soon = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  const lib = await makeFile(master.id, null, 'trade-licence.pdf');
  const filed = await makeFile(master.id, hr, 'visa.pdf');
  await db.prepare('UPDATE documents SET expires_on = ? WHERE id IN (?, ?)').run(soon, lib, filed);
  assert.deepEqual(await expiringDocuments(sara, 30), [], 'private by default');

  await setSharedMany(master, [lib, filed], true);

  assert.deepEqual(names(await expiringDocuments(sara, 30)), ['trade-licence.pdf', 'visa.pdf'], 'Sara has no HR shelf, and is told about both');
});
