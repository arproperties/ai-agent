import { db, reset, makeUser, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_PATTERN } from '../server/caseMatch.js';
import { saveUpload } from '../server/files.js';
import {
  getPattern, setPattern, discover, propose, getCard, cardsFor, decide, refresh,
} from '../server/caseFolders.js';

// Case folders: an external user's case emails become one folder on their Shelf. Stub
// mailboxes and a stub AI only: nothing here reaches a real inbox or Claude.

test.after(() => closeDb());

const mail = (o) => ({ messageId: null, from: 'a@x.com', to: 'b@x.com', text: '', attachments: [], ...o, at: new Date(o.at) });

const CASE = [
  mail({ key: 'INBOX:1', messageId: '<1@x>', at: '2026-10-01T09:00:00Z', subject: 'Soutex E - 205791 filing', text: 'Ahmed Ali vs Gulf Trading LLC. We filed today.' }),
  mail({ key: 'Sent:2', messageId: '<2@x>', at: '2026-10-03T09:00:00Z', subject: 'Re: Soutex E-205791', text: 'Hearing is on the 20th.' }),
];
const SUMMARY = '## Parties\nAhmed Ali / Gulf Trading LLC\n## What has happened\n- filed\n## Latest position\nHearing set\n## Pending / awaiting reply\nNone';

// The mailbox: every case's mails are in `mails`; collectCase does the filtering, as on live.
function stubBox(mails) {
  const box = {
    mails: [...mails], calls: 0, kind: 'imap', address: 'jeff@x.com', canSend: false,
    matching: async () => { box.calls++; return box.mails; },
    recent: async () => { box.calls++; return box.mails; },
  };
  return box;
}

// The AI: one answer per job, told apart by its system prompt.
function stubAsk({ identify: who = { case_number: 'Soutex E - 205791', party_a: 'Ahmed Ali', party_b: 'Gulf Trading LLC' }, cases = [] } = {}) {
  const ask = async (prompt, { system }) => {
    ask.prompts.push({ prompt, system });
    if (/summarise a legal case/.test(system)) return SUMMARY;
    if (/list the case/i.test(system)) return `Here you go:\n${JSON.stringify(cases)}`;
    return `\`\`\`json\n${JSON.stringify(who)}\n\`\`\``;
  };
  ask.prompts = [];
  return ask;
}

let jeff; let staff; let conv; let box; let deps;
test.beforeEach(async () => {
  await reset();
  const id = await makeUser('Jeff');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(id);
  jeff = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  staff = await db.prepare('SELECT * FROM users WHERE id = ?').get(await makeUser('Staff'));
  conv = (await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(jeff.id, 'Cases')).id;
  box = stubBox(CASE);
  deps = { mailbox: async () => box, ask: stubAsk() };
});

const count = async (sql, ...p) => (await db.prepare(sql).get(...p)).n;

test('a named case becomes one card with its parties from the first email', async () => {
  const [card] = await propose(jeff, { case_number: 'soutex e-205791' }, { conversationId: conv }, deps);
  assert.equal(card.name, 'Case - Soutex E - 205791 - Ahmed Ali vs Gulf Trading LLC');
  assert.equal(card.count, 2);
  assert.equal(card.question, 'Save all info as PDF into the Shelf?');
  assert.equal(card.status, 'pending');
  assert.deepEqual(card.emails.map((e) => e.mail_key), ['INBOX:1', 'Sent:2']);
  assert.equal(card.from, CASE[0].at.getTime() / 1000);
  assert.equal(card.to, CASE[1].at.getTime() / 1000);
  // The AI read the oldest mail, and was told it is data.
  assert.ok(deps.ask.prompts[0].prompt.includes('Soutex E - 205791 filing'));
  assert.deepEqual((await getCard(jeff, card.id)).id, card.id);
  assert.deepEqual((await cardsFor(jeff, conv)).map((c) => c.id), [card.id]);
});

test('party names and case numbers from the AI are cleaned', async () => {
  deps.ask = stubAsk({ identify: { case_number: 'Soutex E - 205791', party_a: 'Ahmed\n<b>Ali</b>', party_b: 'x'.repeat(300) } });
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  assert.equal(card.party_a, 'Ahmed bAli/b');
  assert.equal(card.party_b.length, 120);
});

test('an unreadable AI answer is a 422', async () => {
  deps.ask = async () => 'Sorry, I cannot help with that.';
  await assert.rejects(propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps), { status: 422, message: 'Could not read the case from the email' });
});

test('no mailbox, or no matching email, is said plainly', async () => {
  await assert.rejects(propose(jeff, { case_number: '205791' }, {}, { ...deps, mailbox: async () => null }), { status: 400, message: 'Connect your mailbox first' });
  await assert.rejects(propose(jeff, { case_number: 'X 999' }, {}, deps), { status: 404, message: 'No emails mention X 999' });
});

test('nothing is saved until Save, and Save twice makes one folder', async () => {
  const [card] = await propose(jeff, { case_number: 'Soutex E - 205791' }, { conversationId: conv }, deps);
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_folders'), 0);
  const saved = await decide(jeff, card.id, { save: true }, deps);
  assert.equal(saved.status, 'saved');
  await assert.rejects(decide(jeff, card.id, { save: true }, deps), { status: 409 });
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_folders'), 1);
  const folder = await db.prepare('SELECT * FROM case_folders').get();
  assert.equal(saved.folder_id, folder.id);
  assert.equal(folder.case_key, 'soutexe205791');
  // The case PDF is on jeff's Shelf, in the folder, on no agent's shelf, titled by its name.
  const pdf = await db.prepare('SELECT * FROM documents WHERE id = ?').get(folder.summary_doc_id);
  assert.equal(pdf.case_folder_id, folder.id);
  assert.equal(pdf.agent_id, null);
  assert.equal(pdf.user_id, jeff.id);
  assert.equal(pdf.title, `${folder.name}.pdf`);
  assert.equal(pdf.status, 'ready');
  const rows = await db.prepare('SELECT * FROM case_emails ORDER BY at').all();
  assert.deepEqual(rows.map((r) => [r.mail_key, r.message_id, r.sender, r.recipients]), [['INBOX:1', '<1@x>', 'a@x.com', 'b@x.com'], ['Sent:2', '<2@x>', 'a@x.com', 'b@x.com']]);
  assert.equal(Number(rows[0].at), CASE[0].at.getTime() / 1000);
  assert.equal(rows[1].body, 'Hearing is on the 20th.');
});

test('Cancel saves nothing', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  assert.equal((await decide(jeff, card.id, { save: false }, deps)).status, 'cancelled');
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_folders'), 0);
});

test('the edited name and unticked emails are respected', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true, name: 'Soutex – urgent', exclude: ['Sent:2'] }, deps);
  const folder = await db.prepare('SELECT * FROM case_folders').get();
  assert.equal(folder.name, 'Soutex – urgent');
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_emails'), 1);
  assert.ok(!(await db.prepare('SELECT text FROM document_texts WHERE document_id = ?').get(folder.summary_doc_id)).text.includes('Hearing is on the 20th'));
});

test('at least one of the full PDF or per-email PDFs is needed', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await assert.rejects(decide(jeff, card.id, { save: true, full_pdf: false, per_email: false }, deps), { status: 400 });
  assert.equal((await getCard(jeff, card.id)).status, 'pending');
});

test('per-email PDFs are made only when ticked', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true, per_email: true }, deps);
  const folder = await db.prepare('SELECT * FROM case_folders').get();
  assert.equal(await count('SELECT COUNT(*)::int n FROM documents WHERE case_folder_id = ?', folder.id), 1 + CASE.length);
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_emails WHERE doc_id IS NOT NULL'), CASE.length);
});

test('attachments are saved as they are, and one jeff already has is linked, not copied', async () => {
  const have = Buffer.from('the lease he uploaded himself');
  const { doc: old } = await saveUpload(jeff.id, null, { buffer: have, originalname: 'lease.txt', mimetype: 'text/plain', size: have.length });
  const kept = Buffer.from('Statement of claim, Soutex E - 205791');
  box.mails[0] = { ...CASE[0], attachments: [{ name: 'claim.txt', mimetype: 'text/plain', buffer: kept }, { name: 'lease copy.txt', mimetype: 'text/plain', buffer: have }] };
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true }, deps);
  const folder = await db.prepare('SELECT * FROM case_folders').get();
  const docs = await db.prepare('SELECT * FROM documents WHERE case_folder_id = ? ORDER BY id').all(folder.id);
  assert.deepEqual(docs.map((d) => d.title), ['lease.txt', `${folder.name}.pdf`, 'claim.txt']);
  assert.equal(docs[0].id, old.id); // the same row, now in the case
  assert.equal(await count('SELECT COUNT(*)::int n FROM documents WHERE user_id = ?', jeff.id), 3);
});

test('a new email updates the same case PDF, not a copy', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true }, deps);
  const before = await db.prepare('SELECT * FROM case_folders').get();
  const pdfBefore = await db.prepare('SELECT * FROM documents WHERE id = ?').get(before.summary_doc_id);
  const docsBefore = await count('SELECT COUNT(*)::int n FROM documents WHERE case_folder_id = ?', before.id);

  box.mails.push(mail({ key: 'INBOX:7', messageId: '<7@x>', at: '2026-10-10T09:00:00Z', subject: 'Soutex E 205791 judgment', text: 'Judgment for the claimant.' }));
  assert.deepEqual(await refresh(jeff, before.id, deps), { added: 1 });

  const after = await db.prepare('SELECT * FROM case_folders').get();
  assert.equal(after.summary_doc_id, before.summary_doc_id);
  assert.equal(after.new_count, 1);
  assert.ok(Number(after.last_checked_at) > 0);
  assert.equal(await count('SELECT COUNT(*)::int n FROM documents WHERE case_folder_id = ?', before.id), docsBefore);
  const pdf = await db.prepare('SELECT * FROM documents WHERE id = ?').get(before.summary_doc_id);
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(pdf.path);
  assert.equal(pdf.hash, createHash('sha256').update(bytes).digest('hex'));
  assert.notEqual(pdf.hash, pdfBefore.hash);
  assert.equal(pdf.size, bytes.length);
  assert.equal(pdf.title, pdfBefore.title);
  assert.ok((await db.prepare('SELECT text FROM document_texts WHERE document_id = ?').get(pdf.id)).text.includes('Judgment for the claimant'));
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_emails'), 3);

  // Nothing new: nothing added, the count stays.
  assert.deepEqual(await refresh(jeff, before.id, deps), { added: 0 });
  assert.equal((await db.prepare('SELECT new_count FROM case_folders').get()).new_count, 1);
});

test('refresh looks back from a day before the last check', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true }, deps);
  await db.prepare('UPDATE case_folders SET last_checked_at = 1760000000').run();
  let since;
  box.matching = async (opts) => { since = opts.since; return box.mails; };
  await refresh(jeff, 1, deps);
  assert.equal(since.getTime(), (1760000000 - 86400) * 1000);
});

test('a refresh that fails writes down why', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true }, deps);
  box.matching = async () => { throw new Error('IMAP is down'); };
  await assert.rejects(refresh(jeff, 1, deps), /IMAP is down/);
  assert.equal((await db.prepare('SELECT last_error FROM case_folders').get()).last_error, 'IMAP is down');
});

test('pulling the same case again refreshes it instead of a second card', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true }, deps);
  const again = await propose(jeff, { case_number: 'SoutexE205791' }, { conversationId: conv }, deps);
  assert.equal(again.length, 1);
  assert.ok(again[0].refreshed);
  assert.equal(again[0].refreshed.id, 1);
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_folders'), 1);
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_proposals'), 1);
});

test('no number given: up to 5 cards from the last 30 days', async () => {
  const mails = [];
  const cases = [];
  for (let i = 1; i <= 7; i++) {
    mails.push(mail({ key: `INBOX:${i}`, messageId: `<${i}@x>`, at: `2026-10-${String(10 + i).padStart(2, '0')}T09:00:00Z`, subject: `Case AB ${1000 + i} update`, text: 'news' }));
    cases.push({ case_number: `AB ${1000 + i}`, party_a: `A${i}`, party_b: `B${i}` });
  }
  cases.push({ case_number: 'no digits here', party_a: 'x', party_b: 'y' }); // dropped: not a case number
  cases.push({ case_number: 'ZZ 4242', party_a: 'x', party_b: 'y' }); // dropped: in no email
  box = stubBox(mails);
  deps = { mailbox: async () => box, ask: stubAsk({ cases }) };
  const found = await discover(jeff.id, deps);
  assert.equal(found.length, 5);
  assert.deepEqual(found.map((c) => c.case_number), ['AB 1007', 'AB 1006', 'AB 1005', 'AB 1004', 'AB 1003']);
  const cards = await propose(jeff, {}, { conversationId: conv }, deps);
  assert.equal(cards.length, 5);
  assert.equal(cards[0].name, 'Case - AB 1007 - A7 vs B7');
  assert.equal(cards[0].count, 1);
});

test('a stopped folder is not refreshed', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true }, deps);
  await db.prepare('UPDATE case_folders SET tracking = false').run();
  box.calls = 0;
  let asked = 0;
  assert.deepEqual(await refresh(jeff, 1, { ...deps, mailbox: async () => { asked++; return box; } }), { added: 0 });
  assert.equal(asked, 0);
  assert.equal(box.calls, 0);
});

test('the name pattern is per user and needs the case number', async () => {
  assert.equal(await getPattern(jeff.id), DEFAULT_PATTERN);
  await assert.rejects(setPattern(jeff.id, '[Party A] v [Party B]'), { status: 400, message: 'The pattern needs [Case Number]' });
  assert.equal(await setPattern(jeff.id, '[Case Number] – [Party A] v [Party B]'), '[Case Number] – [Party A] v [Party B]');
  assert.equal(await getPattern(jeff.id), '[Case Number] – [Party A] v [Party B]');
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  assert.equal(card.name, 'Soutex E - 205791 – Ahmed Ali v Gulf Trading LLC');
  assert.equal(await setPattern(jeff.id, ''), DEFAULT_PATTERN);
  assert.equal(await getPattern(jeff.id), DEFAULT_PATTERN);
});

test('the AI reads the oldest mail, its subject and the first 6,000 characters', async () => {
  box.mails = [
    mail({ key: 'k2', at: '2026-10-09', subject: 'later 205791', text: 'later' }),
    mail({ key: 'k1', at: '2026-10-01', subject: 'first one 205791', text: 'y'.repeat(7000) }),
  ];
  await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  const { prompt } = deps.ask.prompts[0];
  assert.ok(prompt.includes('first one') && !prompt.includes('later'));
  assert.ok(prompt.includes('y'.repeat(6000)) && !prompt.includes('y'.repeat(6001)));
});

test('an unticked email never comes back, not even under another key', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true, exclude: ['Sent:2'] }, deps);
  const folder = await db.prepare('SELECT * FROM case_folders').get();
  assert.deepEqual(folder.excluded_keys, [{ mail_key: 'Sent:2', message_id: '<2@x>' }]);
  assert.deepEqual(await refresh(jeff, folder.id, deps), { added: 0 });
  box.mails.push({ ...CASE[1], key: 'All:2' }); // the same email seen in All Mail
  assert.deepEqual(await refresh(jeff, folder.id, deps), { added: 0 });
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_emails'), 1);
});

test('a refresh that fails part way takes back what it added, and the next one files it all', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true, per_email: true }, deps);
  const folder = await db.prepare('SELECT * FROM case_folders').get();
  const docsBefore = await count('SELECT COUNT(*)::int n FROM documents WHERE case_folder_id = ?', folder.id);
  let reads = 0;
  const flaky = { name: 'judgment.txt', mimetype: 'text/plain', get buffer() { if (!reads++) throw new Error('attachment unreadable'); return Buffer.from('Judgment text'); } };
  box.mails.push(mail({ key: 'INBOX:7', messageId: '<7@x>', at: '2026-10-10T09:00:00Z', subject: 'Soutex E 205791 judgment', text: 'Judgment.', attachments: [flaky] }));

  await assert.rejects(refresh(jeff, folder.id, deps), /attachment unreadable/);
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_emails'), 2);
  assert.equal(await count('SELECT COUNT(*)::int n FROM documents WHERE case_folder_id = ?', folder.id), docsBefore);
  assert.equal(await count('SELECT COUNT(*)::int n FROM documents'), docsBefore); // the per-email PDF it made is gone too
  assert.equal((await db.prepare('SELECT new_count FROM case_folders').get()).new_count, 0);

  assert.deepEqual(await refresh(jeff, folder.id, deps), { added: 1 });
  assert.equal(await count('SELECT COUNT(*)::int n FROM documents WHERE case_folder_id = ?', folder.id), docsBefore + 2); // its PDF and the attachment
  assert.ok(await db.prepare("SELECT 1 FROM documents WHERE title = 'judgment.txt' AND case_folder_id = ?").get(folder.id));
  assert.equal((await db.prepare('SELECT last_error FROM case_folders').get()).last_error, null);
});

test('a double tap on Save makes one folder', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  const got = await Promise.allSettled([decide(jeff, card.id, { save: true }, deps), decide(jeff, card.id, { save: true }, deps)]);
  assert.deepEqual(got.map((g) => g.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(got.find((g) => g.status === 'rejected').reason.status, 409);
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_folders'), 1);
});

test('two cards of the same case: the second Save is told the case has a folder', async () => {
  const [one] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  const [two] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  const got = await Promise.allSettled([decide(jeff, one.id, { save: true }, deps), decide(jeff, two.id, { save: true }, deps)]);
  const lost = got.find((g) => g.status === 'rejected');
  assert.ok(lost, 'one Save must lose');
  assert.equal(lost.reason.status, 409);
  assert.equal(lost.reason.message, 'This case already has a folder');
  assert.equal(await count('SELECT COUNT(*)::int n FROM case_folders'), 1);
  assert.equal(await count("SELECT COUNT(*)::int n FROM case_proposals WHERE status = 'pending'"), 1);
  await assert.rejects(decide(jeff, (got[0].status === 'rejected' ? one : two).id, { save: true }, deps), { status: 409, message: 'This case already has a folder' });
});

test('an edited name is taken as typed, not as a pattern', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true, name: 'Soutex: [Party A]\n/ urgent' }, deps);
  assert.equal((await db.prepare('SELECT name FROM case_folders').get()).name, 'Soutex [Party A] urgent');
});

test('someone who is not external gets nothing', async () => {
  await assert.rejects(propose(staff, { case_number: '205791' }, { conversationId: conv }, deps), { status: 404 });
  assert.deepEqual(await cardsFor(staff, conv), []);
  await assert.rejects(getPattern(staff.id), { status: 404 });
  await assert.rejects(setPattern(staff.id, ''), { status: 404 });
  await assert.rejects(discover(staff.id, deps), { status: 404 });
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await assert.rejects(getCard(staff, card.id), { status: 404 });
  await assert.rejects(decide(staff, card.id, { save: true }, deps), { status: 404 });
  await decide(jeff, card.id, { save: true }, deps);
  await assert.rejects(refresh(staff, 1, deps), { status: 404 });
});
