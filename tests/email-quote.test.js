import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { simpleParser } from 'mailparser';
import { createDraft, decideDraft, getDraft } from '../server/drafts.js';
import { deliver } from '../server/outbox.js';
import { encrypt } from '../server/secrets.js';
import { quoteOf, innerBody, sentLine } from '../server/emailQuote.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');
test.after(() => closeDb());

async function mailbox() {
  const userId = await makeUser('Francis');
  await db.prepare(`INSERT INTO imap_accounts (user_id, email, host, username, password_enc, smtp_host, smtp_port, smtp_secure, can_write)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, 'francis@reem.ae', 'imap.titan.email', 'francis@reem.ae', encrypt('pw'), 'smtp.titan.email', 465, true, true);
  return userId;
}

// Alex's email as it sits in the inbox: HTML with a pasted screenshot, Cc'd to two people.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
async function alexEmail() {
  // compose has no inline-image input of its own, so the picture is added the way Outlook sends it.
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await t.sendMail({
    from: 'Alex Paul <alex@snp.ae>', to: 'francis@reem.ae', cc: 'Peesto David <peesto@snp.ae>',
    subject: 'Software Related Additional Requirements', date: new Date('2026-11-11T12:48:00Z'),
    text: 'Dear Francis, please review the PDC flow.',
    html: '<html><head><style>p{}</style></head><body><p>Dear Francis, please review the <b>PDC</b> flow.</p><img src="cid:ledger@snp"></body></html>',
    attachments: [{ filename: 'ledger.png', content: PNG, cid: 'ledger@snp' }],
  });
  return simpleParser(info.message, { keepCidLinks: true }); // as imap.js parsedOriginal reads it
}

test('the date under a reply reads in Dubai time, the way Outlook writes it', () => {
  assert.equal(sentLine(new Date('2026-11-11T12:48:00Z')), 'Wednesday, November 11, 2026 4:48 PM');
});

test('only the inside of the original <body> is quoted', () => {
  assert.equal(innerBody('<html><head><title>x</title></head><body class="a"><p>Hi</p></body></html>'), '<p>Hi</p>');
  assert.equal(innerBody('<p>Hi</p>'), '<p>Hi</p>');
});

test('a sent reply carries the email it answers underneath, picture and all', async () => {
  await reset();
  const userId = await mailbox();
  const d = await createDraft(userId, {
    to: ['alex@snp.ae'], cc: ['peesto@snp.ae'], subject: 'Re: Software Related Additional Requirements',
    body: 'Hi Alex, this is done.', inReplyTo: '<orig@snp.ae>', refs: '<orig@snp.ae>', replyToId: 'INBOX:7',
  });
  await decideDraft(userId, d.id, true);
  const p = await alexEmail();
  const sent = [];
  const asked = [];
  await deliver(await getDraft(userId, d.id), {
    send: async (acc, pw, built) => sent.push(built.raw),
    append: async () => {},
    original: async (uid, id) => { asked.push(id); return p; },
  });

  assert.deepEqual(asked, ['INBOX:7']);
  const out = await simpleParser(sent[0]);
  // The new lines first, then the history.
  assert.match(out.text, /^Hi Alex, this is done\.[\s\S]*From: Alex Paul <alex@snp\.ae>[\s\S]*Sent: Wednesday, November 11, 2026 4:48 PM[\s\S]*Cc: Peesto David <peesto@snp\.ae>[\s\S]*please review the PDC flow/);
  assert.ok(out.html.indexOf('this is done') < out.html.indexOf('please review the <b>PDC</b> flow'));
  assert.match(out.html, /<b>Subject:<\/b> Software Related Additional Requirements/);
  assert.doesNotMatch(out.html, /<head>|<style>p\{\}/, 'the original page shell is left out');
  // The screenshot travels with it, so it shows in the quoted email instead of an empty box.
  const pic = out.attachments.find((a) => a.cid === 'ledger@snp');
  assert.ok(pic, 'the picture is attached inline');
  assert.ok(pic.content.equals(PNG));
  assert.equal(out.inReplyTo, '<orig@snp.ae>');
});

test('an answered email that can no longer be read costs the history, not the reply', async () => {
  await reset();
  const userId = await mailbox();
  const d = await createDraft(userId, { to: ['alex@snp.ae'], subject: 'Re: X', body: 'Done.', inReplyTo: '<o@snp.ae>', replyToId: 'INBOX:9' });
  await decideDraft(userId, d.id, true);
  const sent = [];
  await deliver(await getDraft(userId, d.id), {
    send: async (acc, pw, built) => sent.push(built.raw), append: async () => {},
    original: async () => { throw new Error('That email no longer exists'); },
  });
  assert.equal(sent.length, 1);
  assert.equal((await simpleParser(sent[0])).text.trim(), 'Done.');
  assert.equal((await getDraft(userId, d.id)).status, 'sent');
});

test('a new email (not a reply) never asks for an original', async () => {
  await reset();
  const userId = await mailbox();
  const d = await createDraft(userId, { to: ['bob@example.com'], subject: 'Hi', body: 'Hello' });
  await decideDraft(userId, d.id, true);
  let asked = false;
  await deliver(await getDraft(userId, d.id), {
    send: async () => {}, append: async () => {}, original: async () => { asked = true; },
  });
  assert.equal(asked, false);
});

test('a text-only original is quoted as text in both parts', () => {
  const q = quoteOf({ from: { value: [{ address: 'a@b.ae' }] }, subject: 'S', date: new Date(), text: 'line one <tag>' });
  assert.match(q.text, /From: a@b\.ae[\s\S]*line one <tag>/);
  assert.match(q.html, /line one &lt;tag&gt;/);
  assert.deepEqual(q.inline, []);
});
