import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { scrambledArabic, readPdfPages, readPages } from '../server/knowledge.js';
import { shelfKit, splitParts, fullText } from '../server/shelf.js';
import { keepText, likeness } from '../server/copies.js';
import { whatWasRead, lastRound, OUT_OF_ROUNDS } from '../server/chat.js';

test.after(() => closeDb());

async function pdfOf(n) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([100 + i, 100]); // widths tell the pages apart
  return Buffer.from(await doc.save());
}
const widths = async (buf) => (await PDFDocument.load(buf)).getPages().map((p) => p.getWidth());

// A stand-in for Claude: says which pages it was handed, and runs out of room when told to.
function fakeReader({ fullUpTo = Infinity } = {}) {
  const calls = [];
  const read = async (pdf, prompt) => {
    const pages = (await widths(pdf)).map((w) => w - 99);
    calls.push(pages);
    return { text: pages.map((p) => `--- Page ${p} ---\nwords of page ${p}`).join('\n'), full: pages.length <= fullUpTo, prompt };
  };
  return { read, calls };
}

// ---------- which PDFs are read from the page ----------

test('court Arabic written as display shapes is recognised as jumbled', () => {
  const court = 'ﺍﻟﺤﻜﻢ ﺍﻻﺑﺘﺪﺍﺋﻲ ﺭﻗﻢ '.repeat(20); // presentation forms, the way court PDFs store it
  const plain = 'الحكم الابتدائي رقم '.repeat(20); // ordinary Arabic text
  assert.equal(scrambledArabic(court), true);
  assert.equal(scrambledArabic(plain), false);
  assert.equal(scrambledArabic('An English contract with no Arabic at all. '.repeat(20)), false);
});

// ---------- long scans are read a few pages at a time ----------

test('every page of a long document is read, in order, each under its page number', async () => {
  const { read, calls } = fakeReader();
  const text = await readPdfPages(await pdfOf(10), 10, { read });
  assert.deepEqual(calls, [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]);
  for (let p = 1; p <= 10; p++) assert.match(text, new RegExp(`--- Page ${p} ---\\nwords of page ${p}`));
});

test('a reading that runs out of room is done again a page at a time, so no page is lost', async () => {
  const { read, calls } = fakeReader({ fullUpTo: 1 });
  const text = await readPages(await pdfOf(3), 0, 3, 3, { read });
  assert.deepEqual(calls, [[1, 2, 3], [1], [2], [3]]);
  assert.match(text, /words of page 3/);
});

test('a single page too long to read says so instead of ending quietly', async () => {
  const { read } = fakeReader({ fullUpTo: 0 });
  const text = await readPages(await pdfOf(1), 0, 1, 1, { read });
  assert.match(text, /rest of page 1 could not be read/);
});

test('progress is reported as the pages go', async () => {
  const { read } = fakeReader();
  const seen = [];
  await readPdfPages(await pdfOf(9), 9, { read, name: 'verdict.pdf', onProgress: (l) => seen.push(l) });
  assert.deepEqual(seen, ['Reading verdict.pdf, page 1-4 of 9…', 'Reading verdict.pdf, page 5-8 of 9…', 'Reading verdict.pdf, page 9-9 of 9…']);
});

// ---------- read_file reads all of a file, in parts ----------

async function fixture() {
  await reset();
  const id = await makeUser('Amran');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
const fileWith = async (user, title, text) => {
  const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, status) VALUES (?, ?, ?, 'ready') RETURNING id`)
    .run(user.id, `${title}.pdf`, title);
  if (text != null) await db.prepare('INSERT INTO document_texts (document_id, text) VALUES (?, ?)').run(id, text);
  return id;
};

test('a long file comes in parts, says which part is next, and every line is in one of them', async () => {
  const user = await fixture();
  const lines = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1}: the court orders item ${i + 1}.`);
  const id = await fileWith(user, '962 verdict', lines.join('\n'));
  const reads = [];
  const kit = shelfKit(user, { onRead: (r) => reads.push(r) });

  const first = await kit.run({ id: 'a', name: 'read_file', input: { id } });
  const total = Number(/Part 1 of (\d+)/.exec(first.content)[1]);
  assert.ok(total > 1);
  assert.match(first.content, new RegExp(`read part 2 next \\(read_file id ${id}, part 2\\)`));

  let all = first.content;
  for (let n = 2; n <= total; n++) all += (await kit.run({ id: 'b', name: 'read_file', input: { id, part: n } })).content;
  for (const l of lines) assert.ok(all.includes(l), `${l} was read`);
  assert.match(all, new RegExp(`Part ${total} of ${total}\\. This is the last part`));
  assert.deepEqual(reads.map((r) => r.part), Array.from({ length: total }, (_, i) => i + 1));
});

test('a file filed before the text was kept is stitched from its pieces without repeating itself', async () => {
  const user = await fixture();
  const id = await fileWith(user, 'Old judgment', null);
  // indexChunks' pieces: 1500 long, overlapping by 200, each labelled with the title.
  const text = Array.from({ length: 400 }, (_, i) => `Sentence ${i} of the judgment.`).join(' ');
  for (let i = 0; i < text.length; i += 1300) {
    await db.prepare('INSERT INTO chunks (user_id, document_id, text) VALUES (?, ?, ?)').run(user.id, id, `[Old judgment] ${text.slice(i, i + 1500)}`);
  }
  const stitched = await fullText(id);
  assert.equal(stitched.match(/Sentence 57 of/g).length, 1, 'no line twice');
  assert.match(stitched, /Sentence 399 of the judgment\./);
});

test('parts break at a line, and nothing is lost between them', () => {
  const text = Array.from({ length: 500 }, (_, i) => `row ${i}`).join('\n');
  const parts = splitParts(text, 1000);
  assert.ok(parts.length > 1);
  assert.equal(parts.join('\n'), text);
  assert.ok(parts.every((p) => p.startsWith('row ')));
});

// ---------- copies of one document ----------

const judgment = Array.from({ length: 120 }, (_, i) => `The defendant shall deliver ${i + 2} kilograms of gold under order ${i}.`).join(' ');

test('the same document filed twice is marked as a copy of the first', async () => {
  const user = await fixture();
  const a = await fileWith(user, '962 verdict', null);
  await keepText({ id: a, user_id: user.id }, judgment);
  const b = await fileWith(user, 'Screenshot 2024-10-14', null);
  // A second reading of the same pages: page marks and the odd word differ.
  const again = `--- Page 1 ---\n${judgment.replace('order 7.', 'order 7 [stamp].')}`;
  assert.equal(await keepText({ id: b, user_id: user.id }, again), a);

  const read = await shelfKit(user).run({ id: 't', name: 'read_file', input: { id: b } });
  assert.match(read.content, new RegExp(`another copy of file #${a}`));
});

test('an appeal that quotes the judgment at length is a different document, not a copy', async () => {
  const user = await fixture();
  const a = await fileWith(user, 'First instance', null);
  await keepText({ id: a, user_id: user.id }, judgment);
  const appeal = `${judgment.slice(0, judgment.length / 2)} ${Array.from({ length: 60 }, (_, i) => `The appeal court finds ground ${i} unfounded and reasons ${i * 3}.`).join(' ')}`;
  const b = await fileWith(user, 'Appeal', null);
  assert.ok(likeness(judgment, appeal) < 0.5);
  assert.equal(await keepText({ id: b, user_id: user.id }, appeal), null);
});

test('someone else\'s file is never taken for a copy', async () => {
  const user = await fixture();
  const other = await db.prepare('SELECT * FROM users WHERE id = ?').get(await makeUser('Rona'));
  const theirs = await fileWith(other, 'Their verdict', null);
  await keepText({ id: theirs, user_id: other.id }, judgment);
  const mine = await fileWith(user, 'My verdict', null);
  assert.equal(await keepText({ id: mine, user_id: user.id }, judgment), null);
});

// ---------- the "Read:" line ----------

test('the Read line says what was read, and when not all of it was', () => {
  const opened = new Map([
    [1, { title: '962 verdict', parts: new Set([1, 2, 3]), total: 3, searched: [] }],
    [2, { title: 'Appeal 135', parts: new Set([1]), total: 4, searched: [] }],
    [3, { title: 'Expert report', parts: new Set(), total: 0, searched: ['karat'] }],
  ]);
  const line = whatWasRead([{ kind: 'doc', docId: 9, name: 'Gold decision.pdf', whole: true }, { kind: 'doc', docId: 8, name: 'Long.pdf', whole: false }], opened);
  assert.equal(line, '*Read: Gold decision.pdf (whole file) · 962 verdict (all 3 parts) · Appeal 135 (part 1 of 4 - not all of it) · Expert report (only the bits about "karat")*');
  assert.equal(whatWasRead([], new Map()), '');
});

test('the part shown with a file sent in chat counts, so reading the rest reads it all', () => {
  const opened = new Map([[7, { title: 'Cassation 135/2025', parts: new Set([2]), total: 2, searched: [] }]]);
  const sent = [{ kind: 'doc', docId: 7, name: 'التمييز.pdf', whole: false, firstPart: true }];
  assert.equal(whatWasRead(sent, opened), '*Read: Cassation 135/2025 (all 2 parts)*');
});

// ---------- running out of steps ----------

test('on the last step the agent is told it cannot read more, after the tool results', () => {
  const results = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'file text' }] };
  const convo = [{ role: 'user', content: 'make the case table' }, { role: 'assistant', content: [] }, results];
  const out = lastRound(convo);
  assert.deepEqual(out.at(-1).content.map((b) => b.type), ['tool_result', 'text']);
  assert.equal(out.at(-1).content[1].text, OUT_OF_ROUNDS);
  assert.match(OUT_OF_ROUNDS, /which files, or which parts of them, you have not read yet/);
  assert.equal(convo.at(-1).content.length, 1, 'the conversation itself is left as it was');
});

test('a turn that ends with the agent\'s own words is left alone', () => {
  const convo = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'searching' }] }];
  assert.equal(lastRound(convo), convo);
});
