import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import archiver from 'archiver';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { dropboxLink, kindOf, estimate, matchCase, lookText, lookDropbox, saveDropbox, dropboxKit, PRICE } from '../server/dropbox.js';

test.after(() => closeDb());

// ---------- the link ----------

test('a shared folder link becomes its zip download, keeping its key', () => {
  const l = dropboxLink('https://www.dropbox.com/scl/fo/rezq6/AKUa0?rlkey=cd7d&st=qg1n&e=1&dl=0');
  assert.equal(l.folder, true);
  const u = new URL(l.url);
  assert.equal(u.searchParams.get('dl'), '1');
  assert.equal(u.searchParams.get('rlkey'), 'cd7d');
});

test('a shared file link is a file, old /s/ links too', () => {
  assert.equal(dropboxLink('https://www.dropbox.com/scl/fi/abc/report.pdf?rlkey=x&dl=0').folder, false);
  assert.equal(new URL(dropboxLink('https://dropbox.com/s/abc/report.pdf').url).searchParams.get('dl'), '1');
});

test('anything that is not a Dropbox share link is refused', () => {
  for (const u of ['https://evil.com/scl/fo/x', 'http://www.dropbox.com/scl/fo/x', 'https://www.dropbox.com/home', 'https://dropbox.com.evil.com/s/x', 'not a link', '']) {
    assert.equal(dropboxLink(u), null, u);
  }
});

// ---------- what Reem reads ----------

test('kindOf sorts what Reem can read and drops the rest', () => {
  assert.equal(kindOf('01. Plans/LCP.PDF'), 'pdf');
  assert.equal(kindOf('08/Bike.JPG'), 'image');
  assert.equal(kindOf('07/clip.MOV'), 'video');
  assert.equal(kindOf('a/notes.docx'), 'doc');
  assert.equal(kindOf('a/model.xyz'), null);
  assert.equal(kindOf('__MACOSX/a/._LCP.pdf'), null);
  assert.equal(kindOf('a/.DS_Store'), null);
});

test('estimate: scanned pages cost, text pages do not', () => {
  assert.equal(estimate({ files: 1 }), PRICE.file);
  assert.ok(Math.abs(estimate({ files: 10, scannedPages: 100 }) - (10 * PRICE.file + 100 * PRICE.scannedPage)) < 1e-9);
  assert.equal(estimate({}), 0);
});

// ---------- which case ----------

const F = [{ id: 1, name: 'Case - E-205791 - Akhtar vs Mitchell', case_number: 'E-205791' },
  { id: 4, name: 'Case - B-0210947 - Frazier vs Akhtar', case_number: 'B-0210947' }];

test('matchCase picks the case whose number turns up most', () => {
  assert.equal(matchCase(F, ['Frazier v. Akhtar, Cause No. B-0210947', 'B 0210947 index', 'E-205791 mentioned once']).id, 4);
});

test('matchCase gives no case when none turns up, or two tie', () => {
  assert.equal(matchCase(F, ['nothing here']), null);
  assert.equal(matchCase(F, ['B-0210947', 'E-205791']), null);
  assert.equal(matchCase([], ['B-0210947']), null);
});

test('lookText says it is not saved and offers the cases when none matched', () => {
  const t = lookText({ id: 'abc', name: 'Frazier', count: { files: 3, pages: 10, scannedPages: 4, images: 1, videos: 0, videoMinutes: 0, duplicates: 1, skipped: ['x.xyz'] }, usd: 0.5, match: null, folders: F });
  assert.match(t, /Look id: abc/);
  assert.match(t, /NOT saved/);
  assert.match(t, /id 4 "Case - B-0210947/);
  assert.match(t, /1 file\(s\) Reem cannot read/);
});

// ---------- look and save, against the database ----------

async function pdf({ text = '', pages = 1 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage();
    if (text) p.drawText(text, { x: 20, y: 700, size: 10, font });
  }
  return Buffer.from(await doc.save());
}

const INDEX = 'Brian Frazier v. Javied Jeff Akhtar, Cause No. B-0210947, 60th Judicial District Court, Jefferson County, Texas';

/** A stand-in for Dropbox: writes a zip of `entries` where the real download would. */
const fakeDropbox = (entries, name = 'Frazier.zip') => ({
  download: async (link, dir) => {
    const file = join(dir, 'download');
    await new Promise((resolve, reject) => {
      const out = createWriteStream(file);
      const zip = archiver('zip');
      out.on('close', resolve);
      zip.on('error', reject);
      zip.pipe(out);
      for (const [path, body] of Object.entries(entries)) zip.append(body, { name: path });
      zip.finalize();
    });
    return { file, name, zip: true };
  },
  videoSeconds: async () => 120,
  kick: () => {},
});

const LINK = 'https://www.dropbox.com/scl/fo/abc/def?rlkey=k&dl=0';

async function external(name) {
  const id = await makeUser(name);
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(id);
  await db.prepare("INSERT INTO module_access (user_id, module) VALUES (?, 'shelf'), (?, 'dropbox')").run(id, id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

async function caseFolder(userId, number, name) {
  const { id } = await db.prepare('INSERT INTO case_folders (user_id, name, case_number, case_key) VALUES (?, ?, ?, ?) RETURNING id')
    .run(userId, name, number, number.toLowerCase().replace(/[^a-z0-9]/g, ''));
  return id;
}

test('a folder is counted, priced and matched to its case, and nothing is filed yet', async () => {
  await reset();
  const jeff = await external('Jeff');
  await caseFolder(jeff.id, 'E-205791', 'Case - E-205791 - Akhtar vs Mitchell');
  const frazier = await caseFolder(jeff.id, 'B-0210947', 'Case - B-0210947 - Frazier vs Akhtar');
  const index = await pdf({ text: INDEX });
  const deps = fakeDropbox({
    '00. INDEX/Index.pdf': index,
    '03. Medical/scan.pdf': await pdf({ pages: 3 }),
    '03. Medical/copy of index.pdf': index,
    '08. Photo/bike.jpg': Buffer.from('not really a jpeg'),
    '07. Videos/clip.mov': Buffer.from('not really a video'),
    '07. Videos/model.xyz': Buffer.from('x'),
    '__MACOSX/._scan.pdf': Buffer.from('x'),
  });
  const l = await lookDropbox(jeff, LINK, deps);
  assert.equal(l.name, 'Frazier');
  assert.equal(l.count.files, 4); // index, scan, photo, video: the copy is a duplicate
  assert.equal(l.count.duplicates, 1);
  assert.equal(l.count.scannedPages, 3);
  assert.equal(l.count.pages, 4);
  assert.deepEqual(l.count.skipped, ['07. Videos/model.xyz']);
  assert.equal(l.match.id, frazier);
  assert.ok(l.usd > 0);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM documents').get()).n, 0);

  const s = await saveDropbox(jeff, l.id, l.match.id, deps);
  assert.equal(s.added, 4);
  assert.equal(s.duplicates, 1);
  const docs = await db.prepare('SELECT name, status, case_folder_id, import_id FROM documents WHERE user_id = ? ORDER BY id').all(jeff.id);
  assert.deepEqual(docs.map((d) => d.name), ['Index.pdf', 'scan.pdf', 'bike.jpg', 'clip.mov']);
  assert.ok(docs.every((d) => d.status === 'queued' && d.case_folder_id === frazier && d.import_id === s.importId));
  const imp = await db.prepare('SELECT name, uploaded, added FROM imports WHERE id = ?').get(s.importId);
  assert.deepEqual(imp, { name: 'Dropbox: Frazier', uploaded: true, added: 4 });
});

test('a look is saved once, only by its own person, only into their own case', async () => {
  await reset();
  const jeff = await external('Jeff');
  const other = await external('Other');
  const theirs = await caseFolder(other.id, 'B-0210947', 'Not Jeff\'s');
  const deps = fakeDropbox({ 'a.pdf': await pdf({ text: INDEX }) });

  const l = await lookDropbox(jeff, LINK, deps);
  await assert.rejects(saveDropbox(other, l.id, null, deps), /expired/);
  await assert.rejects(saveDropbox(jeff, l.id, theirs, deps), /not one of theirs/);
  assert.equal(l.match, null); // the other person's case is never matched for Jeff
  await saveDropbox(jeff, l.id, null, deps);
  await assert.rejects(saveDropbox(jeff, l.id, null, deps), /expired/);
});

test('files already on the Shelf are skipped and not priced', async () => {
  await reset();
  const jeff = await external('Jeff');
  const deps = fakeDropbox({ 'a.pdf': await pdf({ text: INDEX }), 'b.pdf': await pdf({ pages: 2 }) });
  await saveDropbox(jeff, (await lookDropbox(jeff, LINK, deps)).id, null, deps);
  const again = await lookDropbox(jeff, LINK, deps);
  assert.equal(again.count.files, 0);
  assert.equal(again.count.duplicates, 2);
  assert.equal(again.usd, 0);
});

test('the Dropbox tools are only there for someone given the Dropbox links module', async () => {
  await reset();
  const jeff = await external('Jeff');
  const noneId = await makeUser('ShelfOnly');
  await db.prepare("INSERT INTO module_access (user_id, module) VALUES (?, 'shelf')").run(noneId);
  const none = await db.prepare('SELECT * FROM users WHERE id = ?').get(noneId);
  assert.deepEqual((await dropboxKit(jeff)).definitions.map((d) => d.name), ['look_at_dropbox_link', 'save_dropbox_link']);
  assert.deepEqual((await dropboxKit(none)).definitions, []);
  const kit = await dropboxKit(jeff);
  const r = await kit.run({ id: 't1', name: 'look_at_dropbox_link', input: { url: 'https://example.com/x' } });
  assert.equal(r.is_error, true);
  assert.match(r.content, /not a Dropbox/);
});
