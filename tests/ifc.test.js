import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { TINY_IFC } from './helpers/ifc.js';
import { readableDocument } from '../server/files.js';
import { extractText } from '../server/knowledge.js';
import { uploadLimitMB } from '../server/dwg.js';
import { ifcHeader, REVIT_HELP } from '../server/ifc.js';

test.after(() => closeDb());

const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

test('an IFC model may be up to 45 MB, under the 50 MB nginx takes', () => {
  assert.equal(uploadLimitMB('School.IFC'), 45);
  assert.equal(uploadLimitMB('plan.dwg'), 35);
});

test('an IFC file is accepted and named from its header', () => {
  const text = ifcHeader(Buffer.from(TINY_IFC), 'tiny.ifc');
  assert.match(text, /IFC building model: tiny\.ifc/);
  assert.match(text, /IFC version: IFC4/);
  assert.match(text, /View in 3D/);
  assert.throws(() => ifcHeader(Buffer.from('PK\u0003\u0004zip'), 'model.ifczip.ifc'), /not a readable IFC model/);
});

test('a Revit file is refused in plain words, pointing to an IFC export', async () => {
  await assert.rejects(
    extractText({ buffer: Buffer.from('not really revit'), mimetype: 'application/octet-stream', originalname: 'Tower.rvt' }),
    (e) => e.message === `Tower.rvt: ${REVIT_HELP}`,
  );
  assert.match(REVIT_HELP, /File → Export → IFC/);
});

test("another person cannot fetch someone's IFC model for the 3D viewer", async () => {
  await reset();
  const owner = await user(await makeUser('Owner'));
  const other = await user(await makeUser('Other'));
  // The viewer downloads the model through /api/documents/:id/file, which opens only what
  // readableDocument returns for the person asking.
  const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, status, path, mime)
    VALUES (?, 'school.ifc', 'school.ifc', 'ready', '/nowhere/school.ifc', 'application/octet-stream') RETURNING id`).run(owner.id);
  assert.ok(await readableDocument(owner, id), 'the owner opens it');
  assert.equal(await readableDocument(other, id), undefined, 'nobody else does');
});
