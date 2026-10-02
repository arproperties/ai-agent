import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { engine, saveVoice, createMeeting, addPart, finishMeeting, getMeeting, settled } from '../server/meetings.js';
import { meetingShareRoutes, meetingMarkdown, meetingText } from '../server/meetingShare.js';
import { getDraft } from '../server/drafts.js';
import { deliver } from '../server/outbox.js';
import { encrypt } from '../server/secrets.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');
test.after(() => closeDb());

const SAMPLE = `data:audio/webm;base64,${'A'.repeat(6000)}`;

async function readyMeeting() {
  await reset();
  engine.transcribe = async () => ({
    duration: 20,
    segments: [
      { start: 0, end: 4, speaker: 'Boss', text: 'We need the report by Thursday.' },
      { start: 5, end: 8, speaker: null, text: 'Sounds good.' },
    ],
  });
  engine.summarize = async () => JSON.stringify({
    title: 'Q4 rent review', summary: 'They agreed the rent review.',
    decisions: ['Raise rent 5%'], actions: [{ who: 'Boss', what: 'Send the report', when: 'Thursday' }],
  });
  const user = await makeUser('Boss');
  const boss = await saveVoice(user, { name: 'Boss', sample: SAMPLE });
  const m = await createMeeting(user, { title: '', speakers: [boss.id] });
  await addPart(user, m.id, { seq: 0, offset: 0, buffer: Buffer.from('x'), mimetype: 'audio/webm' });
  await finishMeeting(user, m.id, { duration: 20 });
  await settled();
  return { user, m: await getMeeting(user, m.id) };
}

async function serve(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'user' }; next(); });
  app.use('/m', meetingShareRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  return { url: `http://127.0.0.1:${server.address().port}/m`, close: () => server.close() };
}

test('the PDF has the summary, and the transcript only when asked for', async () => {
  const { m } = await readyMeeting();
  const md = meetingMarkdown(m);
  assert.match(md, /^# Q4 rent review/);
  assert.match(md, /## Decisions\n\n- Raise rent 5%/);
  assert.match(md, /\*\*Boss:\*\* Send the report \(Thursday\)/);
  assert.doesNotMatch(md, /Transcript/);
  const full = meetingMarkdown(m, { transcript: true });
  assert.match(full, /## Transcript/);
  assert.match(full, /\*\*Someone else\*\*/);
  assert.match(meetingText(m), /Action items:\n- Boss: Send the report/);
});

test('download gives a PDF; someone else cannot have it', async () => {
  const { user, m } = await readyMeeting();
  const other = await makeUser('Other');
  const s = await serve(user);
  try {
    const res = await fetch(`${s.url}/${m.id}/pdf?transcript=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /Q4%20rent%20review%20\(with%20transcript\)\.pdf/);
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  } finally { s.close(); }
  const o = await serve(other);
  try { assert.equal((await fetch(`${o.url}/${m.id}/pdf`)).status, 404); } finally { o.close(); }
});

test('emailing needs a mailbox, then goes out with the PDF attached', async () => {
  const { user, m } = await readyMeeting();
  const s = await serve(user);
  const post = (body) => fetch(`${s.url}/${m.id}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ to: 'bob@example.com' })).status, 400, 'no mailbox yet');
    await db.prepare(`INSERT INTO imap_accounts (user_id, email, host, username, password_enc, smtp_host, smtp_port, smtp_secure, can_write)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user, 'boss@acme.ae', 'imap.titan.email', 'boss@acme.ae', encrypt('pw'), 'smtp.titan.email', 465, true, true);
    const res = await post({ to: 'bob@example.com', subject: 'Notes', body: 'See attached.' });
    const out = await res.json();
    assert.equal(res.status, 200, out.error);
    assert.equal(out.attached, true);
    assert.deepEqual(out.draft.attachments, ['Q4 rent review.pdf']);

    // Deliver it to a stand-in mail server and look at what would have gone.
    await db.prepare(`UPDATE email_drafts SET status = 'sending' WHERE id = ?`).run(out.draft.id);
    let raw = '';
    await deliver(await getDraft(user, out.draft.id), { send: async (a, p, built) => { raw = built.raw.toString(); }, append: async () => {} });
    assert.match(raw, /Subject: Notes/);
    assert.match(raw, /See attached\./);
    assert.match(raw, /Content-Type: application\/pdf; name="Q4 rent review.pdf"/);
  } finally { s.close(); }
});
