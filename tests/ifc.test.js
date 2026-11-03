import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { TINY_IFC } from './helpers/ifc.js';
import { readableDocument } from '../server/files.js';
import { extractText } from '../server/knowledge.js';
import { uploadLimitMB } from '../server/dwg.js';
import { ifcHeader, readIfc, REVIT_HELP } from '../server/ifc.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// ---------- Reem reading a model for chats and the Shelf ----------

test('a model is read as storeys, quantity totals, door sizes and counts per storey', async () => {
  const text = await readIfc(Buffer.from(TINY_IFC), 'tiny.ifc');
  assert.match(text, /Project: Tiny project\. Site: Tiny site\. Building: Tiny school\./);
  assert.match(text, /drawn in millimetres; every length below is given in metres/);
  // Measured numbers come before the counts.
  assert.ok(text.indexOf('## Quantity totals') < text.indexOf('## Elements by storey'));
  assert.match(text, /Walls \(2\): Length 4 m \(from 1 of 2\); NetSideArea 12 m² \(from 1 of 2\); NetVolume 2\.4 m³ \(from 1 of 2\)/);
  assert.match(text, /Doors: 1 in all; sizes \(width × height\): 900 × 2100 mm \(×1\)/);
  assert.match(text, /- Ground floor: level \+0\.00 m\n- First floor: level \+3\.50 m/);
  assert.match(text, /Ground floor: Door 1, Wall 1/);
  assert.match(text, /First floor: Wall 1/);
  // What the file lacks is said, never filled in.
  assert.match(text, /## Not in the file[\s\S]*Walls: 1 of 2 has no quantities at all/);
});

test('a model exported without quantities says so and asks for a re-export', async () => {
  const bare = TINY_IFC.split('\n').filter((l) => !/^#10[0-4]=/.test(l)).join('\n');
  const text = await readIfc(Buffer.from(bare), 'bare.ifc');
  assert.match(text, /no quantity sets at all/);
  assert.match(text, /Export base quantities/);
  assert.doesNotMatch(text, /Length \d/);
});

test('a damaged model is still kept, described from its header', async () => {
  const broken = TINY_IFC.slice(0, TINY_IFC.indexOf('#30='));
  const text = await readIfc(Buffer.from(broken), 'broken.ifc');
  assert.match(text, /IFC building model: broken\.ifc/);
  assert.match(text, /could not be read here .* It can still be opened in 3D/);
});

test('an IFC goes through the same reader as PDFs and drawings', async () => {
  const text = await extractText({ buffer: Buffer.from(TINY_IFC), mimetype: 'application/octet-stream', originalname: 'tiny.ifc' });
  assert.match(text, /Walls \(2\): Length 4 m/);
});

// buildingSMART's own sample house (CC BY 4.0), fetched at test time so no model is kept
// in this public repo. Skipped when there is no internet.
const SAMPLE = 'https://raw.githubusercontent.com/buildingSMART/Sample-Test-Files/main/IFC%204.0.2.1%20(IFC%204%20ADD2%20TC1)/Simple-Scene/Building-Architecture.ifc';
test('the buildingSMART sample house reads with its own wall and slab quantities', async (t) => {
  let buffer;
  try {
    const res = await fetch(SAMPLE, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(String(res.status));
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return t.skip(`sample not downloaded: ${e.message}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'reem-ifc-'));
  try {
    writeFileSync(join(dir, 'Building-Architecture.ifc'), buffer); // as the brief asks: a temp folder, never the repo
    const text = await readIfc(readFileSync(join(dir, 'Building-Architecture.ifc')), 'Building-Architecture.ifc');
    assert.match(text, /- 00 groundfloor: level \+0\.00 m/);
    assert.match(text, /Walls \(4\): Length 15\.8 m; NetSideArea 43\.29 m²; NetVolume 7\.45 m³/);
    assert.match(text, /Slabs & roofs \(4\): NetArea 79\.36 m² \(from 3 of 4\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
