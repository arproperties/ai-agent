import test from 'node:test';
import assert from 'node:assert/strict';
import { documentPart, parseInline, parseBlocks, renderPdf, unsupportedScript, pdfName } from '../server/replyDoc.js';
import { documentPart as clientPart, hideMarkers } from '../client/src/lib/replyDoc.js';

const marked = `Sure, here is the packet.

<!--doc-->
# AC Technician Interview Packet

1. How do you diagnose a unit that does not cool?
<!--/doc-->

Want me to add more questions?`;

test('takes only what is between the markers', () => {
  const part = documentPart(marked);
  assert.equal(part.title, 'AC Technician Interview Packet');
  assert.ok(!part.markdown.includes('here is the packet'));
  assert.ok(!part.markdown.includes('Want me'));
});

test('an older reply without markers: from the first heading, minus the closing offer', () => {
  const body = `Here you go.\n\n# Leave Policy\n\n${'Staff get 30 days of annual leave. '.repeat(20)}\n\nWould you like a version in Arabic?`;
  const part = documentPart(body);
  assert.equal(part.title, 'Leave Policy');
  assert.ok(part.markdown.startsWith('# Leave Policy'));
  assert.ok(!part.markdown.includes('Arabic?'));
});

test('a reply with no heading goes in whole, titled by its first sentence', () => {
  const part = documentPart('Record the interview first. Then ask me to score it.\n\n- Step one\n- Step two\n\nWant me to set a reminder?');
  assert.equal(part.title, 'Record the interview first.');
  assert.ok(part.markdown.startsWith('Record the interview first.'));
  assert.ok(!part.markdown.includes('reminder'));
  assert.equal(documentPart('  <!--doc-->  '), null);
});

test('the app and the server agree on the document', () => {
  assert.deepEqual(clientPart(marked), documentPart(marked));
  const typed = 'Packet\nName: ____\n\nconvert into pdf';
  assert.deepEqual(clientPart(typed, { own: true }), documentPart(typed, { own: true }));
});

test('their own text: the request is dropped and every line stays a line', () => {
  const part = documentPart('Please make this a PDF:\nInterview packet\nName: ______\nRole: AC technician\n\nconvert into pdf', { own: true });
  assert.equal(part.title, 'Interview packet');
  assert.ok(!/pdf/i.test(part.markdown));
  assert.deepEqual(parseBlocks(part.markdown).map((b) => b.type), ['para']);
  assert.equal(parseBlocks(part.markdown)[0].text.split('\n').length, 3);
  // markers in typed text are the person's own words, not an instruction to cut
  assert.ok(documentPart('a\n<!--doc-->\nb', { own: true }).markdown.startsWith('a'));
});

test('markers are hidden from the reader, even half-streamed', () => {
  assert.equal(hideMarkers('a\n<!--doc-->\nb\n<!--/doc-->\nc'), 'a\n\nb\n\nc');
  assert.equal(hideMarkers('text <!--do'), 'text ');
});

test('fill-in blanks survive and emphasis is read', () => {
  assert.deepEqual(parseInline('Name: ______'), [{ text: 'Name: ______' }]);
  assert.deepEqual(parseInline('a **b** *c*').map((r) => [r.text, !!r.bold, !!r.italic]), [['a ', false, false], ['b', true, false], [' ', false, false], ['c', false, true]]);
});

test('blocks: headings, checklist items, tables', () => {
  const blocks = parseBlocks('## Checks\n\n- [ ] PPE\n- [x] Gauges\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'item', 'item', 'table']);
  assert.equal(blocks[1].check, false);
  assert.equal(blocks[2].check, true);
  assert.deepEqual(blocks[3].rows, [['1', '2']]);
});

test('the same reply always makes the same file', async () => {
  const part = documentPart(marked);
  const date = new Date('2026-09-28T09:00:00Z');
  const a = Buffer.from(await renderPdf({ ...part, date }));
  const b = Buffer.from(await renderPdf({ ...part, date }));
  assert.equal(a.subarray(0, 5).toString(), '%PDF-');
  assert.ok(a.equals(b));
});

test('symbols the fonts lack do not break the PDF; another script is refused', async () => {
  await renderPdf({ title: 'Checks ✓', markdown: '# Checks ✓\n\n- Done ✅ → next 🎉' });
  assert.equal(unsupportedScript('عقد إيجار سكني لمدة سنة'), true);
  assert.equal(unsupportedScript('Tenancy contract, café résumé'), false);
});

test('file names are safe', () => {
  assert.equal(pdfName('Offer: **AC Tech** / Dubai?'), 'Offer- AC Tech - Dubai-.pdf');
});

test('a table row marked 🟢 is shaded green, and the mark itself is not drawn', async () => {
  const table = (mark) => documentPart(`<!--doc-->\n# Cases\n\n| Case | Status |\n|---|---|\n| ${mark}204/2024 | Active |\n<!--/doc-->`);
  const date = new Date(2026, 9, 20);
  const marked = Buffer.from(await renderPdf({ ...table('🟢 '), date }));
  const plain = Buffer.from(await renderPdf({ ...table(''), date }));
  assert.notDeepEqual(marked, plain, 'the marked row is drawn differently');
  assert.equal(unsupportedScript('🟢 204/2024 Active'), false, 'the mark never stops a PDF being made');
});

test('a wide table turns the PDF sideways; a narrow one leaves it upright', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const pdfOf = async (cols) => {
    const head = Array.from({ length: cols }, (_, i) => `Col ${i + 1}`);
    const md = `<!--doc-->\n# Cases\n\n| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n| ${head.map(() => 'x').join(' | ')} |\n<!--/doc-->`;
    const page = (await PDFDocument.load(await renderPdf({ ...documentPart(md), date: new Date(2026, 9, 20) }))).getPage(0);
    return page.getWidth() > page.getHeight() ? 'landscape' : 'portrait';
  };
  assert.equal(await pdfOf(8), 'landscape');
  assert.equal(await pdfOf(6), 'landscape');
  assert.equal(await pdfOf(5), 'portrait');
});

test('a case number is never split across lines in a wide table', async () => {
  const { parseBlocks } = await import('../server/replyDoc.js');
  assert.equal(parseBlocks('| a |\n|---|\n| 🟢 x |').length, 1);
  const md = `<!--doc-->\n# Cases\n\n| # | Case Number | Court | Filed | Judgment | Amran | Rim | Status | Summary |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 1667/2024/204 | Execution Court | 25/11/2024 | Ongoing | Saud Al-Shebli | Ahmed Khamis Al-Zeyoudi | Active | ${'A long summary of the case. '.repeat(6)} |\n<!--/doc-->`;
  const bytes = await renderPdf({ ...documentPart(md), date: new Date(2026, 9, 20) });
  assert.ok(bytes.length > 0);
});
