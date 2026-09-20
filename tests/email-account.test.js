import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { applySmtp } from '../server/imap.js';

test.after(() => closeDb());

test('nothing chosen means the provider default', () => {
  assert.deepEqual(applySmtp({}, 'imap.titan.email'),
    { smtp_host: 'smtp.titan.email', smtp_port: 465, smtp_secure: true });
});

test('a port on its own decides the security', () => {
  assert.deepEqual(applySmtp({ smtpPort: 587 }, 'imap.titan.email'),
    { smtp_host: 'smtp.titan.email', smtp_port: 587, smtp_secure: false });
  assert.deepEqual(applySmtp({ smtpPort: 465 }, 'imap.titan.email'),
    { smtp_host: 'smtp.titan.email', smtp_port: 465, smtp_secure: true });
});

test('an explicit choice beats the port convention', () => {
  assert.deepEqual(applySmtp({ smtpPort: 587, smtpSecure: true }, 'imap.titan.email'),
    { smtp_host: 'smtp.titan.email', smtp_port: 587, smtp_secure: true });
});

test('a typed server is used as typed', () => {
  assert.deepEqual(applySmtp({ smtpHost: ' MAIL.acme.ae ' }, 'imap.titan.email'),
    { smtp_host: 'mail.acme.ae', smtp_port: 465, smtp_secure: true });
});

test('a server name that could be a command is refused', () => {
  assert.throws(() => applySmtp({ smtpHost: 'mail.acme.ae; rm -rf /' }, 'imap.titan.email'), /server name looks wrong/);
});

test('a mailbox connected before today is read-only, and stays that way until asked', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await db.prepare(`INSERT INTO imap_accounts (user_id, email, host, username, password_enc)
    VALUES (?, ?, ?, ?, ?)`).run(userId, 'sara@acme.ae', 'imap.titan.email', 'sara@acme.ae', 'enc');

  let acc = await db.prepare('SELECT * FROM imap_accounts WHERE user_id = ?').get(userId);
  assert.equal(acc.can_write, false);

  await db.prepare('UPDATE imap_accounts SET can_write = true WHERE user_id = ?').run(userId);
  acc = await db.prepare('SELECT * FROM imap_accounts WHERE user_id = ?').get(userId);
  assert.equal(acc.can_write, true, 'and turning it on is the only way it becomes true');
});
