import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { existsSync } from 'node:fs';
import { simpleParser } from 'mailparser';
import { connectedMailbox, EMAIL_WRITE_TOOLS } from '../server/email.js';
import { getDraft, listDrafts, decideDraft, draftOut } from '../server/drafts.js';
import { deliver } from '../server/outbox.js';
import { emailHandlers } from '../server/emailRoutes.js';
import { saveUpload } from '../server/files.js';
import { gather, discard, MAX_FILES } from '../server/draftFiles.js';
import { encrypt } from '../server/secrets.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');
test.after(() => closeDb());

async function mailbox(name = 'Sara') {
  const userId = await makeUser(name);
  await db.prepare(`INSERT INTO imap_accounts (user_id, email, host, username, password_enc, smtp_host, smtp_port, smtp_secure, can_write)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, `${name.toLowerCase()}@acme.ae`, 'imap.titan.email', `${name.toLowerCase()}@acme.ae`, encrypt('hunter2'), 'smtp.titan.email', 465, true, true);
  return userId;
}

// A file on the Shelf, the way an upload or a file dropped into the chat lands there.
const shelve = async (userId, name, text) => {
  const buffer = Buffer.from(text);
  return (await saveUpload(userId, null, { buffer, originalname: name, mimetype: 'text/plain', size: buffer.length })).doc;
};

const stored = (d) => JSON.parse(d.attachments);
const draft = (m, input) => m.run({ id: 'tu1', name: 'create_draft', input: { to: ['bob@example.com'], subject: 'Lease', body: 'Attached.', ...input } });

test('both drafting tools take attachments', () => {
  for (const name of ['create_draft', 'reply_email']) {
    assert.ok(EMAIL_WRITE_TOOLS.find((t) => t.name === name).input_schema.properties.attachments, name);
  }
});

test('a Shelf file is attached by its name, shown on the card, and arrives with the email', async () => {
  await reset();
  const userId = await mailbox();
  await shelve(userId, 'Tenancy 1402.txt', 'Annual rent AED 95,000');
  const seen = [];
  const m = await connectedMailbox(userId, { onDraft: (d) => seen.push(d) });

  const out = await draft(m, { attachments: [{ name: 'tenancy 1402.TXT' }] });

  assert.equal(out.is_error, undefined, out.content);
  assert.match(out.content, /Attached: Tenancy 1402\.txt/);
  assert.deepEqual(seen[0].attachments, ['Tenancy 1402.txt'], 'the card names the file before anyone approves');
  const [d] = await listDrafts(userId, {});
  const [file] = stored(d);
  assert.equal(file.content, undefined, 'the row keeps a path, not the bytes');
  assert.ok(existsSync(file.path));

  await decideDraft(userId, d.id, true);
  const sent = [];
  await deliver(await getDraft(userId, d.id), { send: async (acc, pw, built) => sent.push(built.raw), append: async () => {} });

  const mail = await simpleParser(sent[0]);
  assert.equal(mail.attachments[0].filename, 'Tenancy 1402.txt');
  assert.equal(mail.attachments[0].content.toString(), 'Annual rent AED 95,000');
  assert.equal(existsSync(file.path), false, 'the copy goes once the email has');
  assert.deepEqual(draftOut(await getDraft(userId, d.id)).attachments, ['Tenancy 1402.txt'], 'and the sent card still says what went');
});

test('the draft keeps its own copy: deleting the Shelf file later does not change the email', async () => {
  await reset();
  const userId = await mailbox();
  const doc = await shelve(userId, 'Quote.txt', 'AED 12,000');
  const m = await connectedMailbox(userId, {});
  await draft(m, { attachments: [{ name: 'Quote.txt' }] });
  const [d] = await listDrafts(userId, {});

  assert.notEqual(stored(d)[0].path, doc.path);
  discard(d);
});

test('a file that cannot be found fails the draft instead of sending an email with nothing on it', async () => {
  await reset();
  const userId = await mailbox();
  const m = await connectedMailbox(userId, {});

  const out = await draft(m, { attachments: [{ name: 'Missing.pdf' }] });

  assert.equal(out.is_error, true);
  assert.match(out.content, /no saved file called “Missing\.pdf”/);
  assert.equal((await listDrafts(userId, {})).length, 0);
});

test("someone else's file cannot be attached", async () => {
  await reset();
  const sara = await mailbox('Sara');
  const tom = await mailbox('Tom');
  await shelve(tom, 'Salaries.txt', 'private');
  const m = await connectedMailbox(sara, {});

  assert.equal((await draft(m, { attachments: [{ name: 'Salaries.txt' }] })).is_error, true);
});

test('a vague name is not guessed, but the same name twice means the newest', async () => {
  await reset();
  const userId = await mailbox();
  await shelve(userId, 'Lease A.txt', 'a');
  await shelve(userId, 'Lease B.txt', 'b');
  await assert.rejects(gather(userId, [{ name: 'lease' }]), /More than one saved file matches.*Lease B\.txt, Lease A\.txt/);

  const [one] = await gather(userId, [{ name: 'Lease B' }]);
  assert.equal(one.filename, 'Lease B.txt');
  discard({ attachments: JSON.stringify([one]) });
  await assert.rejects(gather(userId, Array.from({ length: MAX_FILES + 1 }, () => ({ name: 'Lease A.txt' }))), /Too many attachments/);
});

test('a refused draft leaves no copies behind, and neither does a rejected or deleted one', async () => {
  await reset();
  const userId = await mailbox();
  await shelve(userId, 'Plan.txt', 'plan');
  const m = await connectedMailbox(userId, {});

  assert.equal((await draft(m, { to: ['not-an-address'], attachments: [{ name: 'Plan.txt' }] })).is_error, true);
  assert.equal((await listDrafts(userId, {})).length, 0);

  await draft(m, { attachments: [{ name: 'Plan.txt' }] });
  const [d] = await listDrafts(userId, {});
  const { path } = stored(d)[0];
  const res = { json() {}, status() { return this; } };
  await emailHandlers.reject({ user: { id: userId }, params: { id: d.id } }, res);
  assert.equal(existsSync(path), false);
  await emailHandlers.remove({ user: { id: userId }, params: { id: d.id } }, res);
  assert.equal(await getDraft(userId, d.id), undefined);
});
