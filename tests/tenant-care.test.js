import './helpers/push-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { saveSubscription } from '../server/push.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.SAIFSYS_API_KEY = ''; // the saifsys test must fail without reaching the real one
const { encrypt } = await import('../server/secrets.js');
const { whatsMissing, isAutomatic, ownWords, buildingNames, replyText, look, sendAsk } = await import('../server/tenantCare.js');

test.after(() => closeDb());

const posted = [];
webpush.sendNotification = async (sub, payload) => { posted.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); return { statusCode: 201 }; };

const dir = {
  buildings: [
    { name: 'Ayla Residence', units: ['507', '101', 'A-12'] },
    { name: 'Park Place Tower', units: ['1203', '305'] },
  ],
  tenants: new Set(['known@tenant.com']),
};
const ask = (subject, text = '', from = 'someone@gmail.com') => whatsMissing({ from, subject, text }, dir);
const headers = (o = {}) => new Map(Object.entries(o));

test('a building is found by its short name, and a unit by its number', () => {
  assert.deepEqual(buildingNames('Ayla Residence'), ['ayla residence', 'ayla']);
  assert.equal(ask('Ayla 507 – AC not working'), null);
  assert.equal(ask('AC issue', 'Hi, I am in Park Place Tower flat 1203.'), null);
  assert.equal(ask('Water leak', 'Unit A-12 in ayla, please help'), null);
});

test('what is left out is what gets asked for', () => {
  assert.equal(ask('AC not working', 'Please send someone.'), 'both');
  assert.equal(ask('AC not working in 507'), 'building');
  assert.equal(ask('Ayla – AC not working'), 'unit');
  assert.equal(ask('Leak', 'Apartment no. 44 has a leak'), 'building', 'a unit written as "apartment 44" counts even if saifsys has no 44');
});

test('a phone number in a signature is not a unit', () => {
  assert.equal(ask('AC not working', 'Please help.\n\nManagement\n+971 56 243 6573\nAin Al Reem Properties LLC'), 'both');
  assert.equal(ask('AC not working', 'Call me on 050-101 5070'), 'both');
  assert.equal(ask('Ayla 507', 'call 0501234567'), null);
});

test('a tenant saifsys knows is never asked', () => {
  assert.equal(ask('AC not working', '', 'Known@Tenant.com'), null);
});

test('the building and unit in a quoted old message do not count', () => {
  const text = 'Still broken!\n\nOn Mon, 1 Sep 2026, Tenant Care wrote:\n> Ayla 507 noted';
  assert.equal(ownWords(text).trim(), 'Still broken!');
  assert.equal(ask('Re: AC', text), 'both');
});

test('newsletters, alerts and out-of-office replies are left alone', () => {
  assert.ok(isAutomatic('noreply@bank.com', headers()));
  assert.ok(isAutomatic('a@b.com', headers({ 'auto-submitted': 'auto-replied' })));
  assert.ok(isAutomatic('a@b.com', headers({ 'list-unsubscribe': '<mailto:x>' })));
  assert.ok(isAutomatic('a@b.com', headers({ precedence: 'bulk' })));
  assert.ok(!isAutomatic('a@b.com', headers({ 'auto-submitted': 'no' })));
});

test('the reply asks only for what is missing', () => {
  assert.match(replyText('both'), /Thank you for reaching out\.[\s\S]*- Building name:\n- Unit \/ flat number:/);
  assert.match(replyText('unit'), /- Unit \/ flat number:/);
  assert.doesNotMatch(replyText('unit'), /Building/);
});

async function connected() {
  await reset();
  const boss = await makeUser('Boss');
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss);
  const saba = await makeUser('Saba');
  await db.prepare('INSERT INTO tenant_inbox_members (user_id) VALUES (?)').run(saba);
  await db.prepare(`INSERT INTO tenant_inbox (id, email, host, port, username, password_enc, smtp_host, smtp_port, smtp_secure, last_uid, uid_validity)
    VALUES (1, 'care@ainalreempro.com', 'imap.titan.email', 993, 'care@ainalreempro.com', ?, 'smtp.titan.email', 465, true, 10, 1)`).run(encrypt('pw'));
  return { boss, saba };
}
const mail = (uid, o) => ({ uid, headers: headers(), name: '', messageId: `<m${uid}@x>`, refs: `<m${uid}@x>`, at: 1, subject: '', text: '', ...o });

test('one look writes an ask for each email that needs one, and moves on', async () => {
  await connected();
  const read = async () => ({
    uidValidity: 1, lastUid: 15, mail: [
      mail(11, { from: 'tenant@gmail.com', subject: 'AC broken' }),
      mail(12, { from: 'other@gmail.com', subject: 'Ayla 507 AC broken' }),
      mail(13, { from: 'noreply@dewa.gov.ae', subject: 'Your bill' }),
      mail(14, { from: 'jessa@ainalreempro.com', subject: 'fyi' }),
      mail(15, { from: 'tenant@gmail.com', subject: 'Hello??' }),
    ],
  });
  const sent = [];
  const send = async (acc, pw, m) => { sent.push(m); };
  const file = async () => {};
  assert.equal(await look({ read, dir, send, file }), 1, 'only the first: the rest say where, are robots, are staff, or were already asked');
  const asks = await db.prepare('SELECT * FROM tenant_asks').all();
  assert.equal(asks[0].from_addr, 'tenant@gmail.com');
  assert.equal(asks[0].missing, 'both');
  assert.equal(asks[0].ref, '1:11');
  assert.equal(asks[0].status, 'sent', 'sent by itself, nobody tapped anything');
  assert.equal(asks[0].decided_by, null);
  assert.equal(sent.length, 1);
  assert.match(sent[0].raw.toString(), /To: tenant@gmail\.com/);
  assert.equal((await db.prepare('SELECT last_uid FROM tenant_inbox').get()).last_uid, 15);
  assert.equal(await look({ read, dir, send, file }), 0, 'reading the same emails again asks nothing twice');
  assert.equal(sent.length, 1);
});

test('a reply that cannot go out waits on the page and buzzes the people looking after it', async () => {
  const { saba } = await connected();
  await saveSubscription(saba, { endpoint: 'https://push.example.com/saba', keys: { p256dh: 'p', auth: 'a' } }, 'phone');
  posted.length = 0;
  const read = async () => ({ uidValidity: 1, lastUid: 11, mail: [mail(11, { from: 'tenant@gmail.com', subject: 'AC broken' })] });
  const send = async () => { throw Object.assign(new Error('nope'), { code: 'EAUTH' }); };
  assert.equal(await look({ read, dir, send, file: async () => {} }), 1);
  const a = await db.prepare('SELECT * FROM tenant_asks').get();
  assert.equal(a.status, 'failed');
  assert.match(a.error, /password/);
  await new Promise((r) => setTimeout(r, 50)); // the buzz is sent off without waiting
  assert.equal(posted.length, 1);
  assert.equal(posted[0].endpoint, 'https://push.example.com/saba');
  assert.match(posted[0].body, /could not be sent/);
  assert.equal(posted[0].url, '/?tenantcare=1');
});

test('without saifsys nothing is judged and nothing is skipped over', async () => {
  await connected();
  const out = await look({ read: async () => assert.fail('must not read'), dir: undefined }).catch((e) => e);
  assert.equal(out, 0);
  const row = await db.prepare('SELECT last_uid, error FROM tenant_inbox').get();
  assert.equal(row.last_uid, 10);
  assert.match(row.error, /saifsys/);
});

test('Send goes out once, threaded, and a failure can be tried again', async () => {
  const { saba } = await connected();
  await db.prepare(`INSERT INTO tenant_asks (ref, message_id, refs, from_addr, subject, missing, reply)
    VALUES ('1:11', '<m11@x>', '<m11@x>', 'tenant@gmail.com', 'AC broken', 'both', 'x')`).run();
  const sent = [];
  let fail = true;
  const send = async (acc, pw, m) => { if (fail) throw Object.assign(new Error('nope'), { code: 'ETIMEDOUT' }); sent.push({ acc, pw, m }); };
  const file = async () => {};
  await assert.rejects(sendAsk({ id: saba }, 1, 'Which unit?', { send, file }), /Couldn't reach/);
  assert.equal((await db.prepare('SELECT status FROM tenant_asks').get()).status, 'failed');
  fail = false;
  const out = await sendAsk({ id: saba }, 1, 'Which unit?', { send, file });
  assert.equal(out.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pw, 'pw');
  const raw = sent[0].m.raw.toString();
  assert.match(raw, /In-Reply-To: <m11@x>/);
  assert.match(raw, /Subject: Re: AC broken/);
  assert.match(raw, /To: tenant@gmail\.com/);
  await assert.rejects(sendAsk({ id: saba }, 1, 'again', { send, file }), /already sent/);
});
