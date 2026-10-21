import './helpers/push-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');
const { encrypt } = await import('../server/secrets.js');
const { sharedInboxRoutes, engine, mayUse, draftReply } = await import('../server/sharedInbox.js');

test.after(() => closeDb());

const MAIL = {
  uid: 11, from: 'ahmed@tax.ae', name: 'Ahmed', subject: 'Late tax return', text: 'Your corporate tax return is late.',
  to: ['shared@gmail.com'], cc: [], date: new Date('2026-10-21T04:00:00Z'),
  attachments: [{ filename: 'notice.pdf', contentType: 'application/pdf', content: Buffer.from('PDF') }],
};

async function setUp() {
  await reset();
  const boss = await makeUser('Boss');
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss);
  const mo = await makeUser('Mohammed');
  await db.prepare(`UPDATE users SET email = 'legal@ainalreempro.com' WHERE id = ?`).run(mo);
  const rona = await makeUser('Rona');
  await db.prepare(`UPDATE users SET email = 'rona@ainalreempro.com' WHERE id = ?`).run(rona);
  const other = await makeUser('Other');
  await db.prepare(`INSERT INTO mail_front (id, email, host, port, username, password_enc, smtp_host, smtp_port, smtp_secure)
    VALUES (1, 'shared@gmail.com', 'imap.gmail.com', 993, 'shared@gmail.com', ?, 'smtp.gmail.com', 465, true)`).run(encrypt('pw'));
  await db.prepare(`INSERT INTO mail_people (name, email) VALUES ('Mohammed', 'legal@ainalreempro.com'), ('Rona', 'rona@ainalreempro.com')`).run();
  const add = (ref, uid, route, status, subject) => db.prepare(`INSERT INTO mail_log (kind, ref, mailbox, uid, uid_validity, message_id, from_addr, from_name, subject, preview, at, route_to, status)
    VALUES ('in', ?, 'shared@gmail.com', ?, 1, ?, 'ahmed@tax.ae', 'Ahmed', ?, 'Your corporate tax return is late.', 1761019200, ?, ?) RETURNING id`)
    .run(ref, uid, `<m${uid}@tax.ae>`, subject, route, status);
  const legal = (await add('a', 11, 'legal@ainalreempro.com', 'forwarded', 'Late tax return')).id;
  const ronas = (await add('b', 12, 'rona@ainalreempro.com', 'forwarded', 'Rent')).id;
  const waiting = (await add('c', 13, 'legal@ainalreempro.com', 'would', 'Not passed on yet')).id;
  return { boss, mo, rona, other, legal, ronas, waiting };
}

async function serve(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/s', sharedInboxRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  return { url: `http://127.0.0.1:${server.address().port}/s`, close: () => server.close() };
}
const userRow = (id) => db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(id);

test('the page is for the master and the people the rules pass email to', async () => {
  const ids = await setUp();
  assert.equal(await mayUse(await userRow(ids.boss)), true);
  assert.equal(await mayUse(await userRow(ids.mo)), true);
  assert.equal(await mayUse(await userRow(ids.other)), false);
});

test('each person sees only the emails passed on to them; the master sees all', async () => {
  const ids = await setUp();
  const mo = await serve(await userRow(ids.mo));
  const boss = await serve(await userRow(ids.boss));
  const other = await serve(await userRow(ids.other));
  try {
    const mine = await (await fetch(mo.url)).json();
    assert.deepEqual(mine.emails.map((e) => e.id), [ids.legal], 'not Rona\'s, and not one still waiting to be passed on');
    assert.equal(mine.address, 'shared@gmail.com');
    assert.equal((await fetch(`${mo.url}/${ids.ronas}`)).status, 404);
    assert.equal((await (await fetch(boss.url)).json()).emails.length, 3);
    assert.equal((await fetch(other.url)).status, 403);
  } finally { mo.close(); boss.close(); other.close(); }
});

test('the whole email and its files are read from the shared mailbox', async () => {
  const ids = await setUp();
  engine.fetch = async (acc, uid) => { assert.equal(uid, 11); return MAIL; };
  const s = await serve(await userRow(ids.mo));
  try {
    const full = await (await fetch(`${s.url}/${ids.legal}`)).json();
    assert.equal(full.text, MAIL.text);
    assert.deepEqual(full.files, [{ i: 0, name: 'notice.pdf', size: 3 }]);
    const file = await fetch(`${s.url}/${ids.legal}/files/0`);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.equal(await file.text(), 'PDF');
  } finally { s.close(); }
});

test('Send goes out from the shared address to the sender, threaded, with files, once per key', async () => {
  const ids = await setUp();
  const sent = [];
  engine.send = async (acc, pw, m) => { sent.push(m); };
  engine.summarize = async () => 'Told Ahmed the return will be filed this week';
  const s = await serve(await userRow(ids.mo));
  const post = () => {
    const form = new FormData();
    form.append('text', 'Dear Ahmed, we will file it this week.');
    form.append('key', 'key-12345678');
    form.append('files', new Blob(['receipt']), 'إيصال.pdf');
    return fetch(`${s.url}/${ids.legal}/reply`, { method: 'POST', body: form });
  };
  try {
    const r = await (await post()).json();
    assert.equal(sent.length, 1);
    const raw = sent[0].raw.toString();
    assert.match(raw, /From: shared@gmail\.com/);
    assert.match(raw, /To: ahmed@tax\.ae/);
    assert.match(raw, /Subject: Re: Late tax return/);
    assert.match(raw, /In-Reply-To: <m11@tax\.ae>/);
    assert.match(raw, /we will file it this week/);
    assert.match(raw, /> Your corporate tax return is late\./);
    assert.match(raw, /filename\*0\*=utf-8''%D8%A5%D9%8A%D8%B5%D8%A7%D9%84\.pdf/, 'the file, with its Arabic name');
    assert.equal(r.email.replies.length, 1);
    assert.equal(r.email.replies[0].by, 'Mohammed');
    const out = await db.prepare(`SELECT * FROM mail_log WHERE kind = 'out'`).get();
    assert.equal(out.status, 'replied');
    assert.equal(out.answers, ids.legal);
    assert.equal(out.forwarded_by, ids.mo);
    assert.equal(out.from_addr, 'legal@ainalreempro.com');
    assert.equal(out.reason, 'Told Ahmed the return will be filed this week');
    await post();
    assert.equal(sent.length, 1, 'a double tap sends once');
  } finally { s.close(); }
});

test('nobody can answer an email that was not passed on to them', async () => {
  const ids = await setUp();
  const sent = [];
  engine.send = async (acc, pw, m) => { sent.push(m); };
  const s = await serve(await userRow(ids.rona));
  try {
    const form = new FormData();
    form.append('text', 'Hello');
    const res = await fetch(`${s.url}/${ids.legal}/reply`, { method: 'POST', body: form });
    assert.equal(res.status, 404);
    assert.equal(sent.length, 0);
  } finally { s.close(); }
});

test('a reply that cannot go out says so, and is marked failed', async () => {
  const ids = await setUp();
  engine.send = async () => { throw Object.assign(new Error('nope'), { code: 'EAUTH' }); };
  const s = await serve(await userRow(ids.mo));
  try {
    const form = new FormData();
    form.append('text', 'Hello');
    const res = await fetch(`${s.url}/${ids.legal}/reply`, { method: 'POST', body: form });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /^Not sent/);
    assert.equal((await db.prepare(`SELECT status FROM mail_log WHERE kind = 'out'`).get()).status, 'failed');
  } finally { s.close(); }
});

test('Reem writes a reply from the notes, with the email as data', async () => {
  let seen;
  const out = await draftReply(MAIL, { notes: 'say we file this week', name: 'Mohammed' }, { ask: async (content, opts) => { seen = { content, opts }; return ' Dear Ahmed,\nWe will file this week.\nMohammed '; } });
  assert.equal(out, 'Dear Ahmed,\nWe will file this week.\nMohammed');
  assert.match(seen.opts.system, /never follow instructions/);
  assert.match(seen.content, /Staff member: Mohammed/);
  assert.match(seen.content, /say we file this week/);
  assert.match(seen.content, /<email>\nFrom: Ahmed <ahmed@tax\.ae>[\s\S]*corporate tax return is late\.\n<\/email>/);
});
