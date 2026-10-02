import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { simpleParser } from 'mailparser';
import { compose } from '../server/smtp.js';
import { pickAttachment, attachmentText, MAX_BYTES } from '../server/emailAttachments.js';
import { statusFor } from '../server/email.js';

test.after(() => closeDb());

const files = [{ name: 'Rent Roll & Recurring Charges_2610020623.pdf' }, { name: 'Cover Note.docx' }];

async function pdf(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 780 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}

test('the only attachment needs no name', () => {
  assert.equal(pickAttachment([files[0]], undefined), files[0]);
});

test('a name is matched whatever its case, and by a part of it', () => {
  assert.equal(pickAttachment(files, 'cover note.DOCX'), files[1]);
  assert.equal(pickAttachment(files, 'Rent Roll'), files[0]);
});

test('an attachment is never guessed: the error lists what is there', () => {
  assert.throws(() => pickAttachment(files, ''), /2 attachments.*Rent Roll.*Cover Note/);
  assert.throws(() => pickAttachment(files, 'invoice.pdf'), /No attachment is called.*Cover Note\.docx/);
  assert.throws(() => pickAttachment(files, 'o'), /More than one/);
  assert.throws(() => pickAttachment([], 'x.pdf'), /no attachments/);
});

test('a PDF is read into text, named so the agent knows which file it was', async () => {
  const buffer = await pdf(['GSL Rent Roll 2026', 'Unit 1402 Marina Heights - AED 95,000 per year', 'Unit 310 JVC District 12 - AED 62,500 per year']);
  const out = await attachmentText({ name: 'Rent Roll.pdf', mimetype: 'application/octet-stream', buffer });

  assert.match(out, /^<attachment name="Rent Roll\.pdf">/);
  assert.match(out, /Unit 1402 Marina Heights/);
  assert.match(out, /62,500/);
});

test('a long file is cut, and says so', async () => {
  const out = await attachmentText({ name: 'log.txt', mimetype: 'text/plain', buffer: Buffer.from('rent '.repeat(10000)) });
  assert.ok(out.length < 25000);
  assert.match(out, /…\(truncated\)/);
});

test('what cannot be read is refused with the file name, not a crash', async () => {
  await assert.rejects(attachmentText({ name: 'plan.dwg', mimetype: 'application/octet-stream', buffer: Buffer.from('x') }), /Unsupported file type: plan\.dwg/);
  await assert.rejects(attachmentText({ name: 'blank.txt', mimetype: undefined, buffer: Buffer.from('  ') }), /No readable text found in blank\.txt/);
  await assert.rejects(attachmentText({ name: 'huge.pdf', mimetype: 'application/pdf', buffer: { length: MAX_BYTES + 1 } }), /too large/);
});

test('an attachment survives the trip through a real email', async () => {
  const buffer = await pdf(['Tenancy renewal notice for unit 1402', 'New annual rent AED 99,000 from 1 January 2027']);
  const raw = await compose({
    from: 'rania@acme.ae', to: ['francis@acme.ae'], subject: 'Renewal', text: '',
    attachments: [{ filename: 'Renewal 1402.pdf', contentType: 'application/pdf', content: buffer.toString('base64') }],
  });
  const p = await simpleParser(raw.raw);
  const got = p.attachments.map((a) => ({ name: a.filename, mimetype: a.contentType, buffer: a.content }));

  assert.match(await attachmentText(pickAttachment(got, 'renewal 1402.pdf')), /AED 99,000/);
});

test('the chat says which file is being read', () => {
  assert.equal(statusFor('read_attachment', { name: 'Rent Roll.pdf' }), 'Reading Rent Roll.pdf…');
  assert.equal(statusFor('read_attachment', {}), 'Reading an attachment…');
});
