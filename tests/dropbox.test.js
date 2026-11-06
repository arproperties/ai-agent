import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import archiver from 'archiver';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { dropboxLink, kindOf, estimate, matchCase, startDropbox, dropboxProgress, dropboxKit, skippedSummary, PRICE } from '../server/dropbox.js';
import { announceFinished, finishedText } from '../server/imports.js';
import { readPages } from '../server/knowledge.js';

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
  assert.equal(kindOf('a/DTI Study.zip'), 'zip');
  assert.equal(kindOf('a/scan.dcm'), null);
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

test('skippedSummary sums up many files of a kind, and names a few', () => {
  const many = Array.from({ length: 8030 }, (_, i) => `05. IMAGING/DTI/SER1/IMG${i}.dcm`);
  assert.deepEqual(skippedSummary([...many, 'a/model.xyz']), ['8,030 .dcm files', 'model.xyz']);
  assert.deepEqual(skippedSummary([]), []);
});

// ---------- what the chat is told ----------

test('finishedText: plain words, the case, and what could not be read', () => {
  const t = finishedText({ name: 'Dropbox: Frazier records', total: 10, failed: 1, failedNames: ['bad.pdf'], skippedNames: ['8,030 .dcm files'], caseName: 'Case - B-0210947' });
  assert.match(t, /^Your Dropbox files are ready: I've read 9 files from "Frazier records" and saved them in your case folder "Case - B-0210947"/);
  assert.match(t, /1 file could not be read: bad\.pdf/);
  assert.match(t, /Some files are a kind I can't open, so I left them out: 8,030 \.dcm files\./);
  assert.doesNotMatch(t, /AED|\$|cost|scan(ned)? pages/i);
});

test('finishedText: a link that failed, and a folder already on the Shelf', () => {
  assert.match(finishedText({ name: 'Dropbox', error: 'Dropbox says this link does not exist or was deleted' }), /^I couldn't open that Dropbox link: Dropbox says/);
  assert.match(finishedText({ name: 'Dropbox: Frazier', total: 0, duplicates: 12 }), /already on your Shelf/);
});

// ---------- start, read, tell: against the database ----------

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

function zipOf(entries) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const zip = archiver('zip');
    zip.on('data', (c) => chunks.push(c));
    zip.on('end', () => resolve(Buffer.concat(chunks)));
    zip.on('error', reject);
    for (const [path, body] of Object.entries(entries)) zip.append(body, { name: path });
    zip.finalize();
  });
}

/** A stand-in for Dropbox: writes a zip of `entries` where the real download would. Nothing is read by Claude. */
const fakeDropbox = (entries, name = 'Frazier.zip', extra = {}) => ({
  download: async (link, dir) => {
    const file = join(dir, 'download');
    const buf = await zipOf(entries);
    await new Promise((resolve, reject) => { const out = createWriteStream(file); out.on('close', resolve); out.on('error', reject); out.end(buf); });
    return { file, name, zip: true };
  },
  videoSeconds: async () => 120,
  kick: () => {},
  wait: true,
  ...extra,
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

async function chatOf(userId) {
  const { id } = await db.prepare("INSERT INTO conversations (user_id, title) VALUES (?, 'Frazier') RETURNING id").run(userId);
  return id;
}

test('a folder goes straight into the queue, into the case its papers name, zips inside opened', async () => {
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
    '09. Imaging/DTI.zip': await zipOf({ 'report.pdf': await pdf({ text: 'DTI tractography report for the patient, findings and impression.' }), 'IM0001.dcm': Buffer.from('dicom') }),
    '__MACOSX/._scan.pdf': Buffer.from('x'),
  });
  const conv = await chatOf(jeff.id);
  const imp = await startDropbox(jeff, LINK, { conversationId: conv }, deps);

  const docs = await db.prepare('SELECT name, status, case_folder_id, import_id FROM documents WHERE user_id = ? ORDER BY id').all(jeff.id);
  assert.deepEqual(docs.map((d) => d.name).sort(), ['Index.pdf', 'bike.jpg', 'clip.mov', 'report.pdf', 'scan.pdf']);
  assert.ok(docs.every((d) => d.status === 'queued' && d.case_folder_id === frazier && d.import_id === imp.id));
  const row = await db.prepare('SELECT name, uploaded, added, duplicates, skipped_names, case_folder_id FROM imports WHERE id = ?').get(imp.id);
  assert.equal(row.name, 'Dropbox: Frazier');
  assert.equal(row.uploaded, true);
  assert.equal(row.added, 5);
  assert.equal(row.duplicates, 1);
  assert.deepEqual(JSON.parse(row.skipped_names), ['IM0001.dcm']);
  assert.equal(row.case_folder_id, frazier);
});

test('the case the chat is about wins over the papers', async () => {
  await reset();
  const jeff = await external('Jeff');
  const mitchell = await caseFolder(jeff.id, 'E-205791', 'Case - E-205791 - Akhtar vs Mitchell');
  await caseFolder(jeff.id, 'B-0210947', 'Case - B-0210947 - Frazier vs Akhtar');
  const imp = await startDropbox(jeff, LINK, { conversationId: await chatOf(jeff.id), caseNumber: 'E 205791' }, fakeDropbox({ 'a.pdf': await pdf({ text: INDEX }) }));
  assert.equal((await db.prepare('SELECT case_folder_id FROM imports WHERE id = ?').get(imp.id)).case_folder_id, mitchell);
});

test('another person\'s case is never used', async () => {
  await reset();
  const jeff = await external('Jeff');
  const other = await external('Other');
  await caseFolder(other.id, 'B-0210947', 'Not Jeff\'s');
  const imp = await startDropbox(jeff, LINK, { conversationId: await chatOf(jeff.id), caseNumber: 'B-0210947' }, fakeDropbox({ 'a.pdf': await pdf({ text: INDEX }) }));
  assert.equal((await db.prepare('SELECT case_folder_id FROM imports WHERE id = ?').get(imp.id)).case_folder_id, null);
});

test('the chat is told once, when the last file is read, and the phone buzzes', async () => {
  await reset();
  const jeff = await external('Jeff');
  const conv = await chatOf(jeff.id);
  const pushed = [];
  const imp = await startDropbox(jeff, LINK, { conversationId: conv }, fakeDropbox({ 'a.pdf': await pdf({ text: INDEX }), 'b.pdf': await pdf({ text: `${INDEX} page two` }) }));
  const push = async (ids, n) => { pushed.push({ ids, ...n }); };

  assert.equal(await announceFinished({ push }), 0); // still queued: nothing said yet
  assert.match(await dropboxProgress(jeff.id), /0 of 2 files read so far/);
  await db.prepare("UPDATE documents SET status = 'ready' WHERE import_id = ?").run(imp.id);
  assert.match(await dropboxProgress(jeff.id), /finished, all 2 files read/);
  assert.equal(await announceFinished({ push }), 1);
  assert.equal(await announceFinished({ push }), 0); // once only

  const msgs = await db.prepare('SELECT role, content FROM messages WHERE conversation_id = ?').all(conv);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].content, /^Your Dropbox files are ready: I've read 2 files from "Frazier"/);
  assert.deepEqual(pushed.map((p) => [p.ids, p.url]), [[[jeff.id], `/?chat=${conv}`]]);
});

test('a link that cannot be fetched tells its chat why', async () => {
  await reset();
  const jeff = await external('Jeff');
  const conv = await chatOf(jeff.id);
  await startDropbox(jeff, LINK, { conversationId: conv }, fakeDropbox({}, 'x', { download: async () => { throw new Error('Dropbox says this link does not exist or was deleted'); } }));
  await announceFinished({ push: async () => {} });
  const msg = await db.prepare('SELECT content FROM messages WHERE conversation_id = ?').get(conv);
  assert.match(msg.content, /^I couldn't open that Dropbox link: Dropbox says this link does not exist/);
});

test('files already on the Shelf are not read again', async () => {
  await reset();
  const jeff = await external('Jeff');
  const deps = fakeDropbox({ 'a.pdf': await pdf({ text: INDEX }), 'b.pdf': await pdf({ pages: 2 }) });
  await startDropbox(jeff, LINK, { conversationId: await chatOf(jeff.id) }, deps);
  const again = await startDropbox(jeff, LINK, { conversationId: await chatOf(jeff.id) }, deps);
  const row = await db.prepare('SELECT added, duplicates FROM imports WHERE id = ?').get(again.id);
  assert.deepEqual(row, { added: 0, duplicates: 2 });
  assert.equal((await db.prepare('SELECT count(*)::int n FROM documents').get()).n, 2);
});

test('the Dropbox tools are only there for someone given the Dropbox links module', async () => {
  await reset();
  const jeff = await external('Jeff');
  const noneId = await makeUser('ShelfOnly');
  await db.prepare("INSERT INTO module_access (user_id, module) VALUES (?, 'shelf')").run(noneId);
  const none = await db.prepare('SELECT * FROM users WHERE id = ?').get(noneId);
  assert.deepEqual((await dropboxKit(jeff)).definitions.map((d) => d.name), ['read_dropbox_link', 'dropbox_progress']);
  assert.deepEqual((await dropboxKit(none)).definitions, []);
  const r = await (await dropboxKit(jeff)).run({ id: 't1', name: 'read_dropbox_link', input: { url: 'https://example.com/x' } });
  assert.equal(r.is_error, true);
  assert.match(r.content, /not a Dropbox/);
});

// ---------- a page Claude refuses to copy out ----------

test('a refused reading is tried a page at a time, and only the refused page is lost', async () => {
  const buf = await pdf({ pages: 3 });
  const calls = [];
  const read = async (pages, prompt) => {
    const span = /These are (pages? [\d-]+)/.exec(prompt)[1];
    calls.push(span);
    if (span === 'pages 1-3' || span === 'page 2') throw new Error('400 Output blocked by content filtering policy');
    return { text: `--- Page ${span.split(' ')[1]} ---\nwords`, full: true };
  };
  const text = await readPages(buf, 0, 3, 3, { read });
  assert.deepEqual(calls, ['pages 1-3', 'page 1', 'page 2', 'page 3']);
  assert.match(text, /--- Page 1 ---\nwords/);
  assert.match(text, /--- Page 2 ---\n\[This page could not be read\.\]/);
  assert.match(text, /--- Page 3 ---\nwords/);
});

test('other errors from a reading still stop it', async () => {
  const buf = await pdf({ pages: 2 });
  await assert.rejects(readPages(buf, 0, 2, 2, { read: async () => { throw new Error('529 overloaded'); } }), /overloaded/);
});
