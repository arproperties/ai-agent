import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { shelfKit, spellingMatch } from '../server/shelf.js';
import { libraryCatalog } from '../server/files.js';

test.after(() => closeDb());

const doc = async (userId, title, { name = `${title}.pdf`, kind = 'doc', shared = false, text = '' } = {}) => {
  const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, kind, shared, status)
    VALUES (?, ?, ?, ?, ?, 'ready') RETURNING id`).run(userId, name, title, kind, shared);
  // No embedding: these rows are found by words alone, which is all the tests need.
  for (const t of [].concat(text || [])) {
    await db.prepare('INSERT INTO chunks (user_id, document_id, text, shared) VALUES (?, ?, ?, ?)').run(userId, id, `[${title}] ${t}`, shared);
  }
  return id;
};

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  const rona = await db.prepare('SELECT * FROM users WHERE id = ?').get(await makeUser('Rona'));
  return { master, rona };
}

const call = async (user, name, input) => (await shelfKit(user).run({ id: 't', name, input }));

test('an old file is found by its title, however many newer ones there are', async () => {
  const { master } = await fixture();
  const contract = await doc(master.id, 'JVC School – Concrete Structure Contract AED 26.2M');
  for (let i = 0; i < 60; i++) await doc(master.id, `Site photo ${i}`, { kind: 'image' });

  const catalog = await libraryCatalog(master);
  assert.ok(!catalog.files.some((l) => l.includes('Structure Contract')), 'it has fallen off the newest-files list');

  const found = await call(master, 'search_files', { query: 'structure contract' });
  assert.match(found.content, new RegExp(`#${contract} JVC School – Concrete Structure Contract`));
});

test('a name spelt the way it was heard still finds the file', async () => {
  const { master } = await fixture();
  const receipt = await doc(master.id, 'Transfer receipt – AED 600,000 to AL ADEEB');
  await doc(master.id, 'Trade licence renewal 2026');

  for (const heard of ['Aladeb', 'Aladeep', 'al adeeb']) {
    const found = await call(master, 'search_files', { query: `${heard} receipt` });
    assert.match(found.content, new RegExp(`#${receipt} `), `"${heard}" finds it`);
  }
  assert.ok(spellingMatch('aladeb', 'aladeeb') > 0.6);
  assert.equal(spellingMatch('licence', 'invoice') > 0.6, false, 'different words stay different');
});

test('a file is found by what is written inside it', async () => {
  const { master } = await fixture();
  const verdict = await doc(master.id, 'Eviction verdict – Park Place F201', { text: 'The tenant Haley Morgan is ordered to vacate unit F201.' });
  await doc(master.id, 'Chiller maintenance quotation', { text: 'Annual maintenance of two chillers.' });

  const found = await call(master, 'search_files', { query: 'Haley case' });
  assert.match(found.content, new RegExp(`#${verdict} Eviction verdict`));
  assert.match(found.content, /Haley Morgan is ordered to vacate/, 'with the lines that matched');
});

test('a name that is only in the summary of a file finds it, spelt as it was heard', async () => {
  const { master } = await fixture();
  const verdict = await doc(master.id, 'Eviction verdict – Park Place F201, non-payment', { text: 'The defendant is ordered to vacate unit F201.' });
  await db.prepare('UPDATE documents SET summary = ? WHERE id = ?').run('Eviction of the tenant Hailey from Park Place F201 for unpaid rent.', verdict);
  await doc(master.id, 'Chiller maintenance quotation', { text: 'Annual maintenance of two chillers.' });

  const found = await call(master, 'search_files', { query: 'Haley case' });
  assert.match(found.content.split('\n')[1], new RegExp(`^#${verdict} `), 'first in the list');
  assert.match(found.content, /About: Eviction of the tenant Hailey/, 'with what the file is about');
});

test('nobody finds or opens a file that is not theirs and not shared', async () => {
  const { master, rona } = await fixture();
  const priv = await doc(master.id, 'Salary sheet October', { text: 'Salaries for October.' });
  const pub = await doc(master.id, 'Leave policy handbook', { shared: true, text: 'Annual leave is 30 days.' });

  const none = await call(rona, 'search_files', { query: 'salary sheet' });
  assert.doesNotMatch(none.content, /Salary sheet/);
  assert.match(none.content, /No saved file matches/);
  assert.equal((await call(rona, 'read_file', { id: priv })).is_error, true);

  assert.match((await call(rona, 'search_files', { query: 'leave policy' })).content, new RegExp(`#${pub} `));
  assert.match((await call(rona, 'read_file', { id: pub })).content, /Annual leave is 30 days\./);
});

test('the master finds and opens what a team member uploaded, private files too, and by who uploaded them', async () => {
  const { master, rona } = await fixture();
  const said = await db.prepare('SELECT * FROM users WHERE id = ?').get(await makeUser('Said'));
  const tax = await doc(said.id, 'Tax Invoice 1363 – Black Sand Supply', { text: 'Black sand 20 tonnes, AED 4,200.' });
  const memo = await doc(said.id, 'Cash memo – vehicle recovery 250 AED');
  const other = await doc(rona.id, 'Tax Invoice – ABEL Hardware');
  // An invoice that only mentions the name is not one he uploaded.
  const mention = await doc(master.id, 'Invoice to customer Gul Said', { text: 'Bill to: Gul Said.' });

  const all = await call(master, 'search_files', { uploaded_by: 'said' });
  assert.match(all.content, /^2 saved files uploaded by Said/);
  assert.match(all.content, new RegExp(`#${memo} Cash memo[^\\n]*uploaded by Said on \\d{4}-\\d{2}-\\d{2}`));
  assert.match(all.content, new RegExp(`#${tax} `));
  for (const id of [other, mention]) assert.doesNotMatch(all.content, new RegExp(`#${id} `));

  const byEmail = await call(master, 'search_files', { query: 'black sand', uploaded_by: said.email });
  assert.match(byEmail.content, new RegExp(`#${tax} `));
  assert.doesNotMatch(byEmail.content, new RegExp(`#${memo} `));

  assert.match((await call(master, 'search_files', { query: 'ABEL hardware' })).content, new RegExp(`#${other} [^\\n]*uploaded by Rona`), 'private files of anyone, for the master');
  assert.match((await call(master, 'read_file', { id: tax })).content, /AED 4,200/);
  assert.match((await call(master, 'search_files', { uploaded_by: 'Nobodyhere' })).content, /Nobody called "Nobodyhere"/);

  // Nobody else gets the same view.
  assert.match((await call(rona, 'search_files', { uploaded_by: 'Said' })).content, /No saved file uploaded by Said/);
  assert.equal((await call(rona, 'read_file', { id: tax })).is_error, true);
});

test('show_files hangs the files themselves on the reply, and only ones the person may open', async () => {
  const { master, rona } = await fixture();
  const said = await makeUser('Said');
  const bill = await doc(said, 'Tax Invoice 1363 – Black Sand Supply', { name: 'bill.jpg', kind: 'image' });
  const mine = await doc(rona.id, 'Rona receipt');

  const shown = [];
  const res = await shelfKit(master, { onShow: (f) => shown.push(...f) }).run({ id: 't', name: 'show_files', input: { ids: [bill, mine, 999999] } });
  assert.deepEqual(shown.map((f) => f.docId), [bill, mine], 'the master gets anyone\'s, in the order asked');
  assert.equal(shown[0].name, 'bill.jpg');
  assert.equal(shown[0].kind, 'image');
  assert.match(res.content, /Shown under your reply: #\d+ Tax Invoice 1363/);
  assert.match(res.content, /No saved file has the number #999999/);

  const hers = [];
  await shelfKit(rona, { onShow: (f) => hers.push(...f) }).run({ id: 't', name: 'show_files', input: { ids: [bill, mine] } });
  assert.deepEqual(hers.map((f) => f.docId), [mine], 'nobody else is shown a file that is not theirs');

  const { readableDocument } = await import('../server/files.js');
  assert.ok(await readableDocument(master, bill), 'so the master can open it from the chat');
  assert.equal(await readableDocument(rona, bill), undefined);
});

test('read_file gives the words of the file, and only the matching part when asked', async () => {
  const { master } = await fixture();
  const id = await doc(master.id, 'MEP Works Sub-Contract', {
    text: ['Clause 1. The contractor supplies all ducting.', 'Clause 9. NOCs are obtained by the main contractor.'],
  });

  const whole = await call(master, 'read_file', { id });
  assert.match(whole.content, /Clause 1\./);
  assert.match(whole.content, /Clause 9\./);
  assert.doesNotMatch(whole.content, /\[MEP Works Sub-Contract\] Clause/, 'the search label is not part of the file');

  const part = await call(master, 'read_file', { id, search: 'NOCs' });
  assert.match(part.content, /Clause 9\./);
  assert.doesNotMatch(part.content, /Clause 1\./);
});

test('the newest-files list leaves captured facts out and says how many files there are', async () => {
  const { master } = await fixture();
  await doc(master.id, 'Trade licence 2026');
  for (let i = 0; i < 45; i++) await doc(master.id, `Notice period is ${i} days`, { kind: 'fact' });

  const catalog = await libraryCatalog(master);
  assert.equal(catalog.total, 1, 'facts are not files');
  assert.equal(catalog.files.length, 1);
  assert.match(catalog.files[0], /Trade licence 2026/);
});
