import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { listApps, setApp, newLink, removeApp, loginFor, fromLoopback } from '../server/apps.js';

test.after(() => closeDb());

async function setup() {
  await reset();
  const master = await makeUser('Boss');
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(master);
  return { id: master };
}
const tokenOf = (apps) => apps.find((a) => a.key === 'aol').account.link.split('/').pop();

test('nothing is connected at first', async () => {
  await setup();
  const [aol] = await listApps();
  assert.equal(aol.key, 'aol');
  assert.equal(aol.account, null);
});

test('a saved login gives a link that opens it, and the password never comes back to the screen', async () => {
  const master = await setup();
  const apps = await setApp(master, 'aol', { email: ' Me@AOL.com ', password: 'abcd efgh ijkl mnop' }, { check: false });
  const aol = apps.find((a) => a.key === 'aol');
  assert.equal(aol.account.email, 'me@aol.com');
  assert.match(aol.account.link, /^\/aol-mcp\/[\w-]{20,}$/);
  assert.ok(!JSON.stringify(apps).includes('abcdefghijklmnop'));

  const stored = await db.prepare('SELECT secret FROM app_connectors').get();
  assert.ok(!stored.secret.includes('abcdefgh'), 'stored sealed');

  assert.deepEqual(await loginFor('aol', tokenOf(apps)), { email: 'me@aol.com', password: 'abcdefghijklmnop' });
  assert.equal(await loginFor('aol', 'wrong-token'), null);
  assert.equal(await loginFor('aol', ''), null);
  assert.equal(await loginFor('gmail', tokenOf(apps)), null);
});

test('changing the login keeps the link; New link kills the old one', async () => {
  const master = await setup();
  const first = tokenOf(await setApp(master, 'aol', { email: 'me@aol.com', password: 'password1' }, { check: false }));
  const same = tokenOf(await setApp(master, 'aol', { email: 'me@aol.com', password: 'password2' }, { check: false }));
  assert.equal(same, first);
  assert.equal((await loginFor('aol', first)).password, 'password2');

  const fresh = tokenOf(await newLink('aol'));
  assert.notEqual(fresh, first);
  assert.equal(await loginFor('aol', first), null);
  assert.equal((await loginFor('aol', fresh)).email, 'me@aol.com');
});

test('removing the login closes the link', async () => {
  const master = await setup();
  const token = tokenOf(await setApp(master, 'aol', { email: 'me@aol.com', password: 'password1' }, { check: false }));
  await removeApp('aol');
  assert.equal(await loginFor('aol', token), null);
  await assert.rejects(newLink('aol'), /Connect the mailbox first/);
});

test('bad input and unknown apps are refused', async () => {
  const master = await setup();
  await assert.rejects(setApp(master, 'aol', { email: 'not-an-email', password: 'password1' }, { check: false }), /not an email/);
  await assert.rejects(setApp(master, 'aol', { email: 'me@aol.com', password: '' }, { check: false }), /app password/);
  await assert.rejects(setApp(master, 'gmail', { email: 'me@aol.com', password: 'password1' }, { check: false }), /Unknown app/);
});

test("the connector's door opens only on this machine and not through nginx", () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(fromLoopback(req('127.0.0.1')), true);
  assert.equal(fromLoopback(req('::ffff:127.0.0.1')), true);
  assert.equal(fromLoopback(req('127.0.0.1', { 'x-forwarded-for': '5.6.7.8' })), false); // came in through nginx
  assert.equal(fromLoopback(req('5.6.7.8')), false);
});
