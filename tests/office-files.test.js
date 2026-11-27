import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import archiver from 'archiver';
import * as XLSX from 'xlsx';
import { extractText } from '../server/knowledge.js';
import { attachmentText } from '../server/emailAttachments.js';
import { rtfText, isOffice, isHeic, jpegName } from '../server/officeFiles.js';

test.after(() => closeDb());

const read = (buffer, originalname, mimetype = '') => extractText({ buffer, mimetype, originalname });

/** A ZIP made in memory from { name: text }. */
function zip(files) {
  return new Promise((resolve, reject) => {
    const a = archiver('zip');
    const parts = [];
    a.on('data', (c) => parts.push(c));
    a.on('end', () => resolve(Buffer.concat(parts)));
    a.on('error', reject);
    for (const [name, body] of Object.entries(files)) a.append(Buffer.isBuffer(body) ? body : Buffer.from(body), { name });
    a.finalize();
  });
}

function book(bookType) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Unit', 'Tenant', 'Rent'], ['101', 'محمد', 85000], ['102', 'Sara', 92000]]), 'Rent roll');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Total', 177000]]), 'Summary');
  return XLSX.write(wb, { type: 'buffer', bookType });
}

for (const [ext, bookType] of [['xlsx', 'xlsx'], ['xlsm', 'xlsm'], ['xls', 'biff8'], ['ods', 'ods']]) {
  test(`a .${ext} spreadsheet reads as every sheet's rows, Arabic kept`, async () => {
    const text = await read(book(bookType), `Rent roll.${ext}`);
    assert.match(text, /## Sheet: Rent roll\nUnit,Tenant,Rent\n101,محمد,85000\n102,Sara,92000/);
    assert.match(text, /## Sheet: Summary\nTotal,177000/);
  });
}

test('a PowerPoint reads slide by slide, in order, with its speaker notes', async () => {
  const slide = (...paras) => `<p:sld><p:txBody>${paras.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sld>`;
  const buf = await zip({
    'ppt/slides/slide10.xml': slide('Last slide'),
    'ppt/slides/slide2.xml': slide('Rents up 5%', 'Tom &amp; Jerry'),
    'ppt/slides/slide1.xml': slide('Q3 review'),
    'ppt/notesSlides/notesSlide2.xml': slide('Say the RERA index first', '2'),
  });
  const text = await read(buf, 'Board.pptx');
  assert.equal(text, '## Slide 1\nQ3 review\n\n## Slide 2\nRents up 5%\nTom & Jerry\n\nSpeaker notes:\nSay the RERA index first\n\n## Slide 10\nLast slide');
});

test('an OpenDocument text file reads paragraph by paragraph', async () => {
  const buf = await zip({ 'mimetype': 'application/vnd.oasis.opendocument.text', 'content.xml': '<office:text><text:h>Notice</text:h><text:p>Rent due<text:s/>on 1 Dec</text:p></office:text>' });
  assert.equal(await read(buf, 'notice.odt'), 'Notice\nRent due on 1 Dec');
});

test('RTF: plain words, \\u Arabic and code-page 1256 bytes all come out as text', () => {
  // Backslashes doubled by hand: String.raw would still turn the \u escapes into characters.
  const rtf = '{\\rtf1\\ansi\\ansicpg1256{\\fonttbl{\\f0 Arial;}}{\\*\\generator Word;}Lease \\b renewal\\b0\\par ' +
    '\\u1605?\\u1581?\\u1605?\\u1583? \\\'e3\\\'cd\\\'e3\\\'cf\\par}';
  assert.equal(rtfText(Buffer.from(rtf, 'latin1')), 'Lease renewal\nمحمد محمد');
});

test('a saved email reads who, the message and its attachments', async () => {
  const eml = [
    'From: Rona <rona@example.com>', 'To: accounts@example.com', 'Subject: March rent roll', 'Date: Mon, 2 Mar 2026 09:00:00 +0400',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'Please see the rent roll.', '',
    '--b', 'Content-Type: text/csv; name="roll.csv"', 'Content-Disposition: attachment; filename="roll.csv"', '', 'unit,rent', '101,85000', '--b--', '',
  ].join('\r\n');
  const text = await read(Buffer.from(eml), 'fwd.eml');
  assert.match(text, /From: Rona <rona@example\.com>/);
  assert.match(text, /Subject: March rent roll/);
  assert.match(text, /Please see the rent roll\./);
  assert.match(text, /### roll\.csv\nunit,rent\n101,85000/);
});

test('a ZIP lists its files and reads each one; one that will not read is named, not fatal', async () => {
  const buf = await zip({ 'a/notes.txt': 'Key with security', 'a/roll.xlsx': book('xlsx'), 'b/odd.bin': 'xx', '__MACOSX/a/._notes.txt': 'junk' });
  const text = await read(buf, 'bundle.zip');
  assert.match(text, /Files in this ZIP:\n- a\/notes\.txt\n- a\/roll\.xlsx\n- b\/odd\.bin/);
  assert.match(text, /### a\/notes\.txt\nKey with security/);
  assert.match(text, /### a\/roll\.xlsx\n## Sheet: Rent roll/);
  assert.match(text, /### b\/odd\.bin\n\(not read: Unsupported file type/);
  assert.doesNotMatch(text, /MACOSX/);
});

test('an email attachment that is a spreadsheet is read like one dropped into the chat', async () => {
  const out = await attachmentText({ name: 'Rent roll.xlsx', mimetype: 'application/octet-stream', buffer: book('xlsx') });
  assert.match(out, /^<attachment name="Rent roll\.xlsx">\n## Sheet: Rent roll/);
});

test('names: which files are office files and which are iPhone photos', () => {
  for (const n of ['a.XLSX', 'b.pptx', 'c.odt', 'd.rtf', 'e.eml', 'f.msg', 'g.zip']) assert.ok(isOffice(n), n);
  assert.ok(!isOffice('a.docx'));
  assert.ok(isHeic('IMG_1.HEIC') && isHeic('x', 'image/heif') && !isHeic('a.jpg', 'image/jpeg'));
  assert.equal(jpegName('IMG_1.HEIC'), 'IMG_1.jpg');
});
