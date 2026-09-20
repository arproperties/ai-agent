import test from 'node:test';
import assert from 'node:assert/strict';
import { smtpDefaults, compose } from '../server/smtp.js';
import { encrypt, decrypt } from '../server/secrets.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');

test('Titan gets its documented server and the SSL port', () => {
  assert.deepEqual(smtpDefaults('imap.titan.email'), { host: 'smtp.titan.email', port: 465, secure: true });
});

test('the imap. host of any provider implies the smtp. one', () => {
  assert.deepEqual(smtpDefaults('imap.gmail.com'), { host: 'smtp.gmail.com', port: 465, secure: true });
  assert.deepEqual(smtpDefaults('imap.zoho.com'), { host: 'smtp.zoho.com', port: 465, secure: true });
  assert.deepEqual(smtpDefaults('imap.mail.yahoo.com'), { host: 'smtp.mail.yahoo.com', port: 465, secure: true });
  assert.deepEqual(smtpDefaults('imap.hosting.example.ae'), { host: 'smtp.hosting.example.ae', port: 465, secure: true });
});

test('the providers that break that rule are listed explicitly', () => {
  assert.deepEqual(smtpDefaults('outlook.office365.com'), { host: 'smtp.office365.com', port: 587, secure: false });
  assert.deepEqual(smtpDefaults('imap.mail.me.com'), { host: 'smtp.mail.me.com', port: 587, secure: false });
  assert.deepEqual(smtpDefaults('imap.secureserver.net'), { host: 'smtpout.secureserver.net', port: 465, secure: true });
});

test('an unknown host is left alone rather than guessed at', () => {
  assert.deepEqual(smtpDefaults('mail.example.com'), { host: 'mail.example.com', port: 465, secure: true });
  assert.deepEqual(smtpDefaults(''), { host: '', port: 465, secure: true });
});

test('a composed message carries its threading headers and one Message-ID', async () => {
  const built = await compose({
    from: 'sara@example.com',
    to: ['bob@example.com'],
    cc: ['jo@example.com'],
    subject: 'Re: Invoice 42',
    text: 'Attached, thanks.',
    inReplyTo: '<orig@example.com>',
    references: '<first@example.com> <orig@example.com>',
  });
  const raw = built.raw.toString();

  assert.match(raw, /^In-Reply-To: <orig@example\.com>$/m);
  assert.match(raw, /^References: <first@example\.com> <orig@example\.com>$/m);
  assert.match(raw, /^Subject: Re: Invoice 42$/m);
  assert.match(raw, /^Cc: jo@example\.com$/m);
  assert.ok(built.messageId.startsWith('<'), 'nodemailer generates the Message-ID');
  assert.ok(raw.includes(built.messageId), 'and the bytes we file in Sent contain that same id');
  assert.deepEqual(built.envelope.to, ['bob@example.com', 'jo@example.com']);
});

test('a plain message has no threading headers at all', async () => {
  const built = await compose({ from: 'sara@example.com', to: ['bob@example.com'], subject: 'Hi', text: 'Hello' });
  const raw = built.raw.toString();
  assert.doesNotMatch(raw, /^In-Reply-To:/m);
  assert.doesNotMatch(raw, /^References:/m);
});

test('the mailbox password round-trips and never looks like itself', () => {
  const stored = encrypt('hunter2');
  assert.notEqual(stored, 'hunter2');
  assert.equal(stored.split('.').length, 3, 'iv.tag.ciphertext');
  assert.equal(decrypt(stored), 'hunter2');
  assert.notEqual(encrypt('hunter2'), stored, 'a fresh iv every time');
});
