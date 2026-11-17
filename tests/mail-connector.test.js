import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { encrypt } from '../server/secrets.js';
import { myConnector, makeLink, removeLink, listConnected, loginFor } from '../server/mailConnector.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');

test.after(() => closeDb());

const give = (id) => db.prepare(`INSERT INTO module_access (user_id, module) VALUES (?, 'claude_mail')`).run(id);
const mailbox = (id, { canWrite = false } = {}) => db.prepare(`INSERT INTO imap_accounts
  (user_id, email, host, port, username, password_enc, smtp_host, smtp_port, smtp_secure, can_write)
  VALUES (?, ?, 'imap.titan.email', 993, ?, ?, 'smtp.titan.email', 465, true, ?)`)
  .run(id, `p${id}@ainalreempro.com`, `p${id}@ainalreempro.com`, encrypt('secret-pass'), canWrite);
const tokenOf = (c) => c.link.split('/').pop();

async function person({ withMailbox = true, canWrite = false } = {}) {
  const id = await makeUser('Rona');
  await give(id);
  if (withMailbox) await mailbox(id, { canWrite });
  return id;
}

test('no link until the person asks, and none without a mailbox under Email', async () => {
  await reset();
  const id = await person({ withMailbox: false });
  assert.deepEqual(await myConnector(id), { mailbox: null, link: null, madeAt: null });
  await assert.rejects(makeLink(id), /under Email first/);
});

test('a link opens that person\'s mailbox, and the password never reaches the screen', async () => {
  await reset();
  const id = await person();
  const c = await makeLink(id);
  assert.match(c.link, /^\/mail-mcp\/[\w-]{20,}$/);
  assert.equal(c.mailbox.email, `p${id}@ainalreempro.com`);
  assert.ok(!JSON.stringify(c).includes('secret-pass'));

  const login = await loginFor(tokenOf(c));
  assert.equal(login.email, `p${id}@ainalreempro.com`);
  assert.equal(login.password, 'secret-pass');
  assert.deepEqual(login.imap, { host: 'imap.titan.email', port: 993, username: `p${id}@ainalreempro.com` });
  assert.equal(login.smtp, null, 'no sending while "Allow sending" is off');
  assert.equal(await loginFor('wrong'), null);
  assert.equal(await loginFor(''), null);
});

test('sending is offered only when the person allowed it under Email', async () => {
  await reset();
  const id = await person({ canWrite: true });
  const c = await makeLink(id);
  assert.equal(c.mailbox.canSend, true);
  assert.deepEqual((await loginFor(tokenOf(c))).smtp, { host: 'smtp.titan.email', port: 465, secure: true });
});

test('each person gets their own link to their own mailbox', async () => {
  await reset();
  const a = await person();
  const b = await person();
  const ta = tokenOf(await makeLink(a));
  const tb = tokenOf(await makeLink(b));
  assert.notEqual(ta, tb);
  assert.equal((await loginFor(ta)).email, `p${a}@ainalreempro.com`);
  assert.equal((await loginFor(tb)).email, `p${b}@ainalreempro.com`);
});

test('a new link kills the old one; removing it closes it', async () => {
  await reset();
  const id = await person();
  const first = tokenOf(await makeLink(id));
  const second = tokenOf(await makeLink(id));
  assert.notEqual(first, second);
  assert.equal(await loginFor(first), null);
  assert.ok(await loginFor(second));
  await removeLink(id);
  assert.equal(await loginFor(second), null);
  assert.equal((await myConnector(id)).link, null);
});

test('the link stops when the master unticks the module, switches the person off or makes them external', async () => {
  await reset();
  const id = await person();
  const token = tokenOf(await makeLink(id));
  assert.ok(await loginFor(token));

  await db.prepare(`DELETE FROM module_access WHERE user_id = ? AND module = 'claude_mail'`).run(id);
  assert.equal(await loginFor(token), null, 'module taken away');
  await give(id);

  await db.prepare('UPDATE users SET disabled = true WHERE id = ?').run(id);
  assert.equal(await loginFor(token), null, 'switched off');
  await db.prepare('UPDATE users SET disabled = false, external = true WHERE id = ?').run(id);
  assert.equal(await loginFor(token), null, 'external');
});

test('the link stops when the mailbox under Email is disconnected', async () => {
  await reset();
  const id = await person();
  const token = tokenOf(await makeLink(id));
  await db.prepare('DELETE FROM imap_accounts WHERE user_id = ?').run(id);
  assert.equal(await loginFor(token), null);
});

test('the master sees who has a link and can switch one off', async () => {
  await reset();
  const id = await person();
  await makeLink(id);
  const list = await listConnected();
  assert.equal(list.length, 1);
  assert.equal(list[0].userId, id);
  assert.equal(list[0].email, `p${id}@ainalreempro.com`);
  assert.ok(!JSON.stringify(list).includes('mail-mcp'), 'the master list does not show the links themselves');
  await removeLink(id);
  assert.deepEqual(await listConnected(), []);
});
