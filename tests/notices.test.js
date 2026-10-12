import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const { encrypt } = await import('../server/secrets.js');
const { userModules, listModuleAccess, setModuleAccess, needsModule } = await import('../server/modules.js');
const { places, tenantsOf, noticeText, noticeSubject, createNotice, resendNotice, listNotices, deleteNotice } = await import('../server/notices.js');

test.after(() => closeDb());

const dir = {
  buildings: [
    { name: 'Ayla Residence', units: ['101', '507'] },
    { name: 'Park Place Tower', units: ['1203'] },
  ],
  tenants: new Set(['a@tenant.com', 'b@tenant.com', 'c@tenant.com']),
  leases: [
    { email: 'a@tenant.com', building: 'Ayla Residence', unit: '507' },
    { email: 'b@tenant.com', building: 'Ayla Residence', unit: '507' },
    { email: 'c@tenant.com', building: 'Park Place Tower', unit: '1203' },
  ],
};
const jpg = (name = 'p.jpg') => ({ originalname: name, mimetype: 'image/jpeg', buffer: Buffer.from('not really a picture') });

async function people() {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  const watch = { id: await makeUser('Watch'), role: 'user' };
  const other = { id: await makeUser('Other'), role: 'user' };
  return { boss, watch, other };
}
async function connected() {
  const who = await people();
  await db.prepare(`INSERT INTO tenant_inbox (id, email, host, port, username, password_enc, smtp_host, smtp_port, smtp_secure, last_uid, uid_validity)
    VALUES (1, 'care@ainalreempro.com', 'imap.titan.email', 993, 'care@ainalreempro.com', ?, 'smtp.titan.email', 465, true, 10, 1)`).run(encrypt('pw'));
  return who;
}
const outbox = () => {
  const sent = [];
  return { sent, send: async (acc, pw, m) => { sent.push(m); }, file: async () => {} };
};

// ---------- modules ----------

test('a module is the master\'s by right and anyone else\'s by a tick', async () => {
  const { boss, watch } = await people();
  assert.deepEqual(await userModules(boss), ['notices']);
  assert.deepEqual(await userModules(watch), []);
  assert.equal(await setModuleAccess(watch.id, ['notices']), 1);
  assert.deepEqual(await userModules(watch), ['notices']);
  const list = await listModuleAccess(watch.id);
  assert.equal(list.master, false);
  assert.deepEqual(list.modules.map((m) => [m.key, m.on]), [['notices', true]]);
  assert.equal(await setModuleAccess(watch.id, []), 0, 'the caller sends the end state, so an empty list takes it away');
  assert.deepEqual(await userModules(watch), []);
});

test('a module nobody has heard of is refused, and so is a person who is not there', async () => {
  const { watch } = await people();
  await assert.rejects(setModuleAccess(watch.id, ['payroll']), /Unknown module/);
  await assert.rejects(setModuleAccess(9999, ['notices']), /User not found/);
  await assert.rejects(listModuleAccess(9999), /User not found/);
});

test('the routes of a module are closed to anyone without it', async () => {
  const { boss, watch } = await people();
  const knock = (user) => new Promise((done) => {
    needsModule('notices')({ user }, { status: (code) => ({ json: () => done(code) }) }, () => done('in'));
  });
  assert.equal(await knock(watch), 403);
  assert.equal(await knock(boss), 'in');
  await setModuleAccess(watch.id, ['notices']);
  assert.equal(await knock(watch), 'in');
});

// ---------- the buildings and units ----------

test('the buildings and units are saifsys\'s, and say only whether a tenant email is there', () => {
  assert.deepEqual(places(dir), [
    { name: 'Ayla Residence', units: [{ number: '101', tenant: false }, { number: '507', tenant: true }] },
    { name: 'Park Place Tower', units: [{ number: '1203', tenant: true }] },
  ]);
  assert.doesNotMatch(JSON.stringify(places(dir)), /@/, 'never the email itself');
  assert.deepEqual(tenantsOf(dir, 'ayla residence', '507'), ['a@tenant.com', 'b@tenant.com']);
  assert.deepEqual(tenantsOf(dir, 'Park Place Tower', '507'), [], 'the same unit number in another building is another tenant');
});

// ---------- sending ----------

test('a notice is emailed to the unit\'s tenants there and then, with its photos', async () => {
  const { watch } = await connected();
  const { sent, send, file } = outbox();
  const n = await createNotice(watch, { building: 'Ayla Residence', unit: '507', description: ' Rubbish left outside the door. ', files: [jpg(), jpg()] }, { dir, send, file });
  assert.equal(n.status, 'sent');
  assert.equal(n.description, 'Rubbish left outside the door.');
  assert.equal(n.photos.length, 2);
  assert.equal(n.to, undefined, 'where it went is not the watchman\'s to see');
  assert.equal(sent.length, 1);
  const raw = sent[0].raw.toString();
  assert.match(raw, /From: "?Tenant Care"? <care@ainalreempro\.com>/);
  assert.match(raw, /To: a@tenant\.com, b@tenant\.com/);
  assert.match(raw, /Subject: Notice: Ayla Residence, Unit 507/);
  assert.match(raw, /photo-1\.jpg/);
  assert.match(raw, /photo-2\.jpg/);
  const row = await db.prepare('SELECT * FROM tenant_notices').get();
  assert.equal(row.to_addrs, 'a@tenant.com,b@tenant.com');
  assert.ok(row.sent_at);
  for (const p of await db.prepare('SELECT path FROM tenant_notice_photos').all()) assert.ok(existsSync(p.path));
  await deleteNotice({ id: 1, role: 'master' }, n.id); // takes its pictures off the disk again
});

test('the email is the watchman\'s own words in a fixed letter', () => {
  const n = { building: 'Ayla Residence', unit: '507', description: 'Rubbish left outside the door.', created_at: 1791800000 };
  assert.equal(noticeSubject(n), 'Notice: Ayla Residence, Unit 507');
  const text = noticeText(n, 2);
  assert.match(text, /^Dear Tenant,\n\nThis is a notice from the building management about Ayla Residence, Unit 507\.\n\nRubbish left outside the door\.\n\nReported on /);
  assert.match(text, /2 photos are attached\./);
  assert.match(noticeText(n, 1), /A photo is attached\./);
  assert.doesNotMatch(noticeText(n, 0), /attached/);
});

test('a unit with no tenant email is saved and sent once saifsys has one', async () => {
  const { watch } = await connected();
  const { sent, send, file } = outbox();
  const n = await createNotice(watch, { building: 'Ayla Residence', unit: '101', description: 'Door left open.' }, { dir, send, file });
  assert.equal(n.status, 'no_email');
  assert.equal(sent.length, 0);
  const later = { ...dir, leases: [...dir.leases, { email: 'new@tenant.com', building: 'Ayla Residence', unit: '101' }] };
  const again = await resendNotice(watch, n.id, { dir: later, send, file });
  assert.equal(again.status, 'sent');
  assert.match(sent[0].raw.toString(), /To: new@tenant\.com/);
  await assert.rejects(resendNotice(watch, n.id, { dir: later, send, file }), /already sent/);
  assert.equal(sent.length, 1, 'a second tap does not send it twice');
});

test('a notice that cannot go out is kept, says why, and can be tried again', async () => {
  const { watch } = await connected();
  const refuse = async () => { throw Object.assign(new Error('nope'), { code: 'EAUTH' }); };
  const n = await createNotice(watch, { building: 'Park Place Tower', unit: '1203', description: 'Car in the wrong bay.' }, { dir, send: refuse, file: async () => {} });
  assert.equal(n.status, 'failed');
  assert.match(n.error, /password/);
  const { sent, send, file } = outbox();
  assert.equal((await resendNotice(watch, n.id, { dir, send, file })).status, 'sent');
  assert.equal(sent.length, 1);
});

test('with no Tenant care inbox there is nothing to send from, and the notice says so', async () => {
  const { watch } = await people();
  const { sent, send, file } = outbox();
  const n = await createNotice(watch, { building: 'Ayla Residence', unit: '507', description: 'Noise after midnight.' }, { dir, send, file });
  assert.equal(n.status, 'failed');
  assert.match(n.error, /Tenant care inbox is not connected/);
  assert.equal(sent.length, 0);
});

test('a notice needs a real building, a real unit, some words, and pictures that are pictures', async () => {
  const { watch } = await connected();
  const { sent, send, file } = outbox();
  const make = (o) => createNotice(watch, { building: 'Ayla Residence', unit: '507', description: 'x', ...o }, { dir, send, file });
  await assert.rejects(make({ description: '   ' }), /what you saw/);
  await assert.rejects(make({ building: 'Nowhere Tower' }), /pick a building/);
  await assert.rejects(make({ unit: '1203' }), /pick a unit/, 'a unit of another building is not a unit of this one');
  await assert.rejects(make({ files: [{ mimetype: 'application/pdf', buffer: Buffer.from('x') }] }), /JPG or PNG/);
  await assert.rejects(make({ files: Array.from({ length: 6 }, () => jpg()) }), /At most 5 photos/);
  assert.equal(sent.length, 0);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM tenant_notices').get()).n, 0, 'nothing refused is left behind');
});

// ---------- who sees what ----------

test('a watchman sees his own notices; the master sees everyone\'s and where they went', async () => {
  const { boss, watch, other } = await connected();
  const { send, file } = outbox();
  const mine = await createNotice(watch, { building: 'Ayla Residence', unit: '507', description: 'Mine.' }, { dir, send, file });
  await createNotice(other, { building: 'Park Place Tower', unit: '1203', description: 'Theirs.' }, { dir, send, file });
  assert.deepEqual((await listNotices(watch)).map((n) => n.description), ['Mine.']);
  const all = await listNotices(boss);
  assert.deepEqual(all.map((n) => [n.description, n.by]), [['Theirs.', 'Other'], ['Mine.', 'Watch']]);
  assert.deepEqual(all[1].to, ['a@tenant.com', 'b@tenant.com']);
  await assert.rejects(resendNotice(other, mine.id, { dir, send, file }), /not found/, 'somebody else\'s notice is not theirs to send');
  await assert.rejects(deleteNotice(watch, mine.id), /Only the master/);
  await deleteNotice(boss, mine.id);
  assert.deepEqual(await listNotices(watch), []);
});
