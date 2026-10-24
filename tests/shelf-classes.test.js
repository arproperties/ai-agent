import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const { MODULES, userModules, setModuleAccess } = await import('../server/modules.js');
const cats = await import('../server/docCategories.js');

test.after(() => closeDb());

async function people() {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  const hr = { id: await makeUser('Hr'), role: 'user' };
  const staff = { id: await makeUser('Staff'), role: 'user' };
  return { boss, hr, staff };
}

// ---------- Task 1: categories, types and the module ----------

test('modules list document_renewals', async () => {
  const m = MODULES.find((x) => x.key === 'document_renewals');
  assert.ok(m, 'the module is listed');
  assert.equal(m.label, 'Document Renewals');
  assert.equal(m.company, true, 'never given to an external person');
  const { hr } = await people();
  await setModuleAccess(hr.id, ['document_renewals']);
  assert.deepEqual(await userModules(hr), ['document_renewals']);
});

test('seed creates the two categories once', async () => {
  await people();
  await cats.seedCategories();
  await cats.seedCategories();
  const list = await cats.listCategories();
  assert.deepEqual(list.map((c) => c.label), ['Employee Documents', 'Company Documents']);
  const [emp, co] = list;
  assert.equal(emp.private, true);
  assert.equal(emp.links_to, 'employee');
  assert.equal(co.private, false);
  assert.equal(co.links_to, 'subject');
  assert.ok(emp.types.some((t) => t.label === 'Passport'));
  assert.deepEqual(emp.types.filter((t) => t.opens_case).map((t) => t.label), ['Labour Contract'], 'only the contract opens a case');
  assert.ok(co.types.some((t) => t.label === 'Trade Licence'));
  assert.equal(co.types.filter((t) => t.opens_case).length, 0);
});

test('seed leaves a list the master has already changed alone', async () => {
  const { boss } = await people();
  await cats.seedCategories();
  const [emp] = await cats.listCategories();
  await cats.updateCategory(boss, emp.id, { label: 'Staff Papers' });
  await cats.seedCategories();
  assert.deepEqual((await cats.listCategories()).map((c) => c.label), ['Staff Papers', 'Company Documents']);
});

test('only the master adds a category or type', async () => {
  const { boss, hr } = await people();
  await setModuleAccess(hr.id, ['document_renewals']);
  await assert.rejects(cats.addCategory(hr, { label: 'Vehicle Documents', private: false, links_to: 'subject' }), (e) => e.status === 403);
  const id = await cats.addCategory(boss, { label: 'Vehicle Documents', private: false, links_to: 'subject' });
  await assert.rejects(cats.addType(hr, id, { label: 'Mulkiya' }), (e) => e.status === 403);
  const typeId = await cats.addType(boss, id, { label: 'Mulkiya', opens_case: false });
  const t = await cats.typeById(typeId);
  assert.equal(t.label, 'Mulkiya');
  assert.equal(t.category.label, 'Vehicle Documents');
  assert.equal(t.category.links_to, 'subject');
  await assert.rejects(cats.updateType(hr, typeId, { label: 'X' }), (e) => e.status === 403);
  await assert.rejects(cats.updateCategory(hr, id, { label: 'X' }), (e) => e.status === 403);
});

test('a category needs a label and a known links_to, and labels are unique', async () => {
  const { boss } = await people();
  await assert.rejects(cats.addCategory(boss, { label: '  ', private: false, links_to: 'subject' }), (e) => e.status === 400);
  await assert.rejects(cats.addCategory(boss, { label: 'Odd', private: false, links_to: 'building' }), (e) => e.status === 400);
  await cats.addCategory(boss, { label: 'Vehicle Documents', private: false, links_to: 'subject' });
  await assert.rejects(cats.addCategory(boss, { label: 'vehicle documents', private: false, links_to: 'subject' }), (e) => e.status === 400);
});

test('retired category keeps its files', async () => {
  const { boss, staff } = await people();
  await cats.seedCategories();
  const [, co] = await cats.listCategories();
  const doc = await makeDoc(staff.id, null, 'licence.pdf');
  await db.prepare('UPDATE documents SET category_id = ?, type_id = ? WHERE id = ?').run(co.id, co.types[0].id, doc);
  await cats.updateCategory(boss, co.id, { active: false });
  assert.deepEqual((await cats.listCategories()).map((c) => c.label), ['Employee Documents'], 'hidden from new files');
  assert.ok((await cats.listCategories({ includeRetired: true })).some((c) => c.id === co.id && !c.active), 'still there for the master');
  const row = await db.prepare('SELECT category_id, type_id FROM documents WHERE id = ?').get(doc);
  assert.equal(row.category_id, co.id);
  assert.equal(row.type_id, co.types[0].id);
});

test('a retired type is hidden from new files', async () => {
  const { boss } = await people();
  await cats.seedCategories();
  const [emp] = await cats.listCategories();
  const passport = emp.types.find((t) => t.label === 'Passport');
  await cats.updateType(boss, passport.id, { active: false });
  const [after] = await cats.listCategories();
  assert.ok(!after.types.some((t) => t.id === passport.id));
  assert.equal((await cats.typeById(passport.id)).active, false, 'still found by id, for the files that have it');
});

test('private cannot change once files exist', async () => {
  const { boss, staff } = await people();
  const id = await cats.addCategory(boss, { label: 'Vehicle Documents', private: false, links_to: 'subject' });
  await cats.updateCategory(boss, id, { private: true }); // no files yet: allowed
  assert.equal((await cats.listCategories()).find((c) => c.id === id).private, true);
  const typeId = await cats.addType(boss, id, { label: 'Mulkiya' });
  const doc = await makeDoc(staff.id, null, 'mulkiya.pdf');
  await db.prepare('UPDATE documents SET category_id = ?, type_id = ? WHERE id = ?').run(id, typeId, doc);
  await assert.rejects(cats.updateCategory(boss, id, { private: false }), (e) => e.status === 400);
  await assert.rejects(cats.updateCategory(boss, id, { links_to: 'employee' }), (e) => e.status === 400);
  await cats.updateCategory(boss, id, { label: 'Cars' }); // a rename is still fine
});

// ---------- Task 2: the visibility rule ----------

const { readableDocuments, readableDocument, libraryCatalog } = await import('../server/files.js');
const { shelfKit } = await import('../server/shelf.js');
const { setOwners } = await import('../server/fileAccess.js');

// A file with words in it, found by search_files without embeddings (as in shelf.test.js).
async function fileWith(userId, title, text, { shared = false } = {}) {
  const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, shared, status)
    VALUES (?, ?, ?, ?, 'ready') RETURNING id`).run(userId, `${title}.pdf`, title, shared);
  await db.prepare('INSERT INTO chunks (user_id, document_id, text, shared) VALUES (?, ?, ?, ?)').run(userId, id, `[${title}] ${text}`, shared);
  return id;
}
async function file(docId, typeLabel) {
  const t = await db.prepare('SELECT id, category_id FROM document_types WHERE label = ?').get(typeLabel);
  await db.prepare('UPDATE documents SET type_id = ?, category_id = ? WHERE id = ?').run(t.id, t.category_id, docId);
}
const search = async (user, query) => (await shelfKit(user).run({ id: 't', name: 'search_files', input: { query } })).content;
const sees = async (user, docId) => ({
  list: (await readableDocuments(user)).some((d) => d.id === docId),
  open: !!(await readableDocument(user, docId)),
  catalog: (await libraryCatalog(user)).total,
});
const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

async function office() {
  const who = await people();
  await cats.seedCategories();
  await setModuleAccess(who.hr.id, ['document_renewals']);
  return { boss: await userRow(who.boss.id), hr: await userRow(who.hr.id), staff: await userRow(who.staff.id) };
}

test('module holder sees employee files of others', async () => {
  const { hr, staff } = await office();
  const passport = await fileWith(staff.id, 'Passport Ahmed Khan', 'Passport number P1234567 of Ahmed Khan');
  await file(passport, 'Passport');
  const s = await sees(hr, passport);
  assert.equal(s.list, true, 'on their Shelf');
  assert.equal(s.open, true, 'opens');
  assert.match(await search(hr, 'Ahmed passport'), new RegExp(`#${passport} `), 'search_files finds it');
});

test('employee file ignores shared and file_access', async () => {
  const { boss, staff } = await office();
  const reader = await userRow(await makeUser('Reader'));
  // Staff's passport, and a visa the master published to everyone.
  const passport = await fileWith(staff.id, 'Passport Ahmed Khan', 'Passport number P1234567 of Ahmed Khan');
  await file(passport, 'Passport');
  const visa = await fileWith(boss.id, 'Residence Visa Ahmed Khan', 'Residence visa of Ahmed Khan', { shared: true });
  await file(visa, 'Residence Visa');
  await setOwners(boss, reader.id, [staff.id]); // the reader may see Staff's files
  for (const id of [passport, visa]) {
    const s = await sees(reader, id);
    assert.equal(s.list, false, `#${id} not on the Shelf`);
    assert.equal(s.open, false, `#${id} does not open`);
  }
  assert.doesNotMatch(await search(reader, 'Ahmed Khan'), /Ahmed Khan/, 'search_files finds neither');
  assert.equal((await libraryCatalog(reader)).total, 0, 'not in the catalogue either');
});

test('a chunk written after the file was given a category is hidden too', async () => {
  const { boss } = await office();
  const reader = await userRow(await makeUser('Reader'));
  const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, shared, status)
    VALUES (?, 'v.pdf', 'Visa Sara', true, 'ready') RETURNING id`).run(boss.id);
  await file(id, 'Residence Visa');
  await db.prepare('INSERT INTO chunks (user_id, document_id, text, shared) VALUES (?, ?, ?, true)').run(boss.id, id, '[Visa Sara] Residence visa of Sara Lopez');
  assert.doesNotMatch(await search(reader, 'Sara Lopez visa'), /Sara Lopez/);
});

test('company file still follows shared and file_access', async () => {
  const { boss, staff } = await office();
  const reader = await userRow(await makeUser('Reader'));
  const licence = await fileWith(boss.id, 'Trade Licence 2026', 'Trade licence of Ain Al Reem', { shared: true });
  await file(licence, 'Trade Licence');
  const policy = await fileWith(staff.id, 'Insurance Policy Building', 'Insurance policy for the building');
  await file(policy, 'Insurance Policy');
  const hidden = await fileWith(boss.id, 'Establishment Card', 'Establishment card');
  await file(hidden, 'Establishment Card');
  await setOwners(boss, reader.id, [staff.id]);
  assert.equal((await sees(reader, licence)).open, true, 'shared by the master');
  assert.equal((await sees(reader, policy)).open, true, 'file_access to Staff');
  assert.equal((await sees(reader, hidden)).open, false, 'neither: still private to the master');
});

test('external person never sees categorised files', async () => {
  const { staff } = await office();
  const extId = await makeUser('Jeff');
  // A tick left from before they were made external.
  await db.prepare("INSERT INTO module_access (user_id, module) VALUES (?, 'document_renewals')").run(extId);
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(extId);
  const ext = await userRow(extId);
  const passport = await fileWith(staff.id, 'Passport Ahmed Khan', 'Passport number P1234567 of Ahmed Khan');
  await file(passport, 'Passport');
  const licence = await fileWith(staff.id, 'Trade Licence 2026', 'Trade licence of Ain Al Reem');
  await file(licence, 'Trade Licence');
  for (const id of [passport, licence]) assert.deepEqual(await sees(ext, id), { list: false, open: false, catalog: 0 });
  assert.doesNotMatch(await search(ext, 'Ahmed licence'), /#\d+ /);
});

test('a module holder does not see an external person\'s categorised file', async () => {
  const { hr } = await office();
  const ext = await makeUser('Jeff');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(ext);
  const own = await fileWith(ext, 'Passport Jeff', 'Passport of Jeff');
  await file(own, 'Passport');
  assert.equal((await sees(hr, own)).open, false);
  assert.doesNotMatch(await search(hr, 'Jeff passport'), /Passport of Jeff/);
});

test('master sees all', async () => {
  const { boss, staff } = await office();
  const passport = await fileWith(staff.id, 'Passport Ahmed Khan', 'Passport number P1234567 of Ahmed Khan');
  await file(passport, 'Passport');
  assert.equal((await sees(boss, passport)).open, true);
  assert.match(await search(boss, 'Ahmed passport'), new RegExp(`#${passport} `));
});

test('the uploader still sees their own categorised file', async () => {
  const { staff } = await office();
  const passport = await fileWith(staff.id, 'Passport Ahmed Khan', 'Passport number P1234567 of Ahmed Khan');
  await file(passport, 'Passport');
  const s = await sees(staff, passport);
  assert.equal(s.list && s.open, true);
});
