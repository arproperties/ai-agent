import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { readableDocuments, readableDocument, deleteDocument } from '../server/files.js';
import { searchFiles } from '../server/shelf.js';
import { ownersFor, setOwners } from '../server/fileAccess.js';

test.after(() => closeDb());

const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const makeFile = async (userId, name) => (await db.prepare(`INSERT INTO documents (user_id, name, title, status)
  VALUES (?, ?, ?, 'ready') RETURNING id`).run(userId, name, name)).id;

test("the master lets Rona see Said's files: she reads them, never changes them", async () => {
  await reset();
  const master = await user(await makeUser('Master'));
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master.id);
  const rona = await user(await makeUser('Rona'));
  const said = await user(await makeUser('Said'));
  const other = await user(await makeUser('Other'));
  const bill = await makeFile(said.id, 'bill 5440.jpg');
  const kept = await makeFile(other.id, 'other.pdf');

  assert.equal(await readableDocument(rona, bill), undefined, 'private before');
  assert.equal((await setOwners(master, rona.id, [said.id, rona.id])).length, 1, 'herself is skipped');
  assert.deepEqual((await ownersFor(rona.id)).map((o) => o.name), ['Said']);

  assert.ok(await readableDocument(rona, bill));
  assert.equal(await readableDocument(rona, kept), undefined, 'only the people ticked');
  assert.deepEqual((await readableDocuments(rona)).map((d) => d.id), [bill]);
  assert.match(await searchFiles(rona, '', 'Said'), /bill 5440/);
  assert.equal(await readableDocument(said, (await makeFile(rona.id, 'mine.pdf'))), undefined, 'it does not go both ways');
  assert.equal(await deleteDocument(rona.id, bill), false, "she cannot delete it");

  await setOwners(master, rona.id, []);
  assert.equal(await readableDocument(rona, bill), undefined, 'taken back');
});
