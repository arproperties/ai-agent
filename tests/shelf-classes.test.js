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
  assert.doesNotMatch(await search(reader, 'Ahmed Khan'), new RegExp(`#(${passport}|${visa}) `), 'search_files finds neither');
  assert.equal((await libraryCatalog(reader)).total, 0, 'not in the catalogue either');
});

test('a chunk written after the file was given a category is hidden too', async () => {
  const { boss } = await office();
  const reader = await userRow(await makeUser('Reader'));
  const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, shared, status)
    VALUES (?, 'v.pdf', 'Visa Sara', true, 'ready') RETURNING id`).run(boss.id);
  await file(id, 'Residence Visa');
  await db.prepare('INSERT INTO chunks (user_id, document_id, text, shared) VALUES (?, ?, ?, true)').run(boss.id, id, '[Visa Sara] Residence visa of Sara Lopez');
  assert.doesNotMatch(await search(reader, 'Sara Lopez visa'), new RegExp(`#${id} `));
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
  assert.doesNotMatch(await search(hr, 'Jeff passport'), new RegExp(`#${own} `));
});

test('master sees all', async () => {
  const { boss, staff } = await office();
  const passport = await fileWith(staff.id, 'Passport Ahmed Khan', 'Passport number P1234567 of Ahmed Khan');
  await file(passport, 'Passport');
  assert.equal((await sees(boss, passport)).open, true);
  assert.match(await search(boss, 'Ahmed passport'), new RegExp(`#${passport} `));
});

// ---------- Task 3: AI fills category, type and employee on upload ----------

const { classify, filingKinds, pickEmployee, fileAs } = await import('../server/files.js');

const ROSTER = [
  { id: 11, code: 'E-0042', name: 'Ahmed Khan', nickname: 'Ahmed' },
  { id: 12, code: 'E-0077', name: 'Sara Lopez', nickname: '' },
];
const hrApi = (calls = { n: 0 }) => async (module, action, params) => {
  calls.n++;
  assert.equal(module, 'hr');
  assert.equal(action, 'employees');
  assert.equal(params.status, 'current');
  return { ok: true, employees: ROSTER };
};
// The model's reply, as the classifier would get it.
const model = (reply, seen = {}) => async (prompt, { system }) => {
  seen.system = system;
  return JSON.stringify({ title: 'T', folder: 'Other', summary: '', tags: [], company: null, date: null, expires: '2027-01-31', ...reply });
};
const typeId = async (label) => (await db.prepare('SELECT id FROM document_types WHERE label = ?').get(label)).id;

test('visa photo gets Residence Visa and the employee code', async () => {
  const { hr } = await office();
  const kinds = await filingKinds(hr, hrApi());
  const visa = await typeId('Residence Visa');
  const c = await classify('visa.jpg', 'UAE residence visa Ahmed Khan', [], [], { kinds, ask: model({ type_id: visa, employee_code: 'E-0042' }) });
  assert.equal(c.typeId, visa);
  assert.equal(c.categoryId, (await db.prepare('SELECT category_id FROM document_types WHERE id = ?').get(visa)).category_id);
  assert.deepEqual(c.employee, { code: 'E-0042', name: 'Ahmed Khan' });
  assert.equal(c.subject, null, 'an employee category keeps no subject');
});

test('unknown code is dropped', async () => {
  const { hr } = await office();
  const kinds = await filingKinds(hr, hrApi());
  const c = await classify('visa.jpg', 'visa', [], [], { kinds, ask: model({ type_id: await typeId('Residence Visa'), employee_code: 'E-9999' }) });
  assert.equal(c.employee, null);
  assert.equal(pickEmployee(' e-0042 ', ROSTER).code, 'E-0042', 'case and spaces do not matter');
  assert.equal(pickEmployee('Ahmed Khan', ROSTER), null, 'a name is not a code');
});

test('unknown or retired type_id is dropped', async () => {
  const { boss, hr } = await office();
  const passport = await typeId('Passport');
  await cats.updateType(boss, passport, { active: false });
  const kinds = await filingKinds(hr, hrApi());
  for (const raw of [passport, 9999, 'Passport', null]) {
    const c = await classify('p.pdf', 'passport', [], [], { kinds, ask: model({ type_id: raw, employee_code: 'E-0042' }) });
    assert.equal(c.typeId, null, `${raw} is not a type on offer`);
    assert.equal(c.categoryId, null);
    assert.equal(c.employee, null, 'no category, nothing to link');
  }
});

test('category follows the type', async () => {
  const { hr } = await office();
  const kinds = await filingKinds(hr, hrApi());
  const licence = await typeId('Trade Licence');
  const c = await classify('tl.pdf', 'trade licence', [], [], {
    kinds, ask: model({ type_id: String(licence), category_id: 1, employee_code: 'E-0042', subject: '  Ain Al Reem Properties LLC ' }),
  });
  const t = await cats.typeById(licence);
  assert.equal(c.categoryId, t.category.id, 'from the type, not from what the model said');
  assert.equal(c.employee, null, 'a subject category keeps no employee');
  assert.equal(c.subject, 'Ain Al Reem Properties LLC');
});

test('a type added later is offered to the model', async () => {
  const { boss, hr } = await office();
  const vid = await cats.addCategory(boss, { label: 'Vehicle Documents', private: false, links_to: 'subject' });
  const mulkiya = await cats.addType(boss, vid, { label: 'Car Mulkiya' });
  const seen = {};
  const kinds = await filingKinds(hr, hrApi());
  const c = await classify('m.pdf', 'mulkiya', [], [], { kinds, ask: model({ type_id: mulkiya, subject: 'Dubai A 12345' }, seen) });
  assert.match(seen.system, new RegExp(`${mulkiya} · Vehicle Documents › Car Mulkiya`));
  assert.equal(c.categoryId, vid);
  assert.equal(c.subject, 'Dubai A 12345');
});

test('the roster goes only to the master and module holders', async () => {
  const { boss, hr, staff } = await office();
  const calls = { n: 0 };
  assert.equal((await filingKinds(staff, hrApi(calls))).roster, null, 'staff: no names of colleagues in their prompt');
  assert.equal(calls.n, 0, 'saifsys is not even asked');
  assert.ok((await filingKinds(staff, hrApi())).types.length, 'types are still offered');
  assert.equal((await filingKinds(hr, hrApi())).roster.length, 2);
  assert.equal((await filingKinds(boss, hrApi())).roster.length, 2);
  const seen = {};
  await classify('v.jpg', 'visa', [], [], { kinds: await filingKinds(staff, hrApi()), ask: model({}, seen) });
  assert.doesNotMatch(seen.system, /E-0042|Ahmed Khan/);
});

test('an external person files nothing into a category', async () => {
  await office();
  const extId = await makeUser('Jeff');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(extId);
  const kinds = await filingKinds(await userRow(extId), hrApi());
  assert.deepEqual(kinds, { types: [], roster: null });
  const c = await classify('p.pdf', 'passport', [], [], { kinds, ask: model({ type_id: await typeId('Passport') }) });
  assert.equal(c.typeId, null);
});

test('employee link is unconfirmed until a person confirms', async () => {
  const { hr, staff } = await office();
  const kinds = await filingKinds(hr, hrApi());
  const c = await classify('visa.jpg', 'visa', [], [], { kinds, ask: model({ type_id: await typeId('Residence Visa'), employee_code: 'E-0042' }) });
  const doc = await makeDoc(staff.id, null, 'visa.jpg');
  await fileAs(doc, c);
  const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(doc);
  assert.equal(row.type_id, c.typeId);
  assert.equal(row.category_id, c.categoryId);
  assert.equal(row.employee_code, 'E-0042');
  assert.equal(row.employee_name, 'Ahmed Khan');
  assert.equal(row.link_confirmed_at, null);
  assert.equal(row.expiry_confirmed_at, null);
});

test('filing again does not undo what a person set', async () => {
  const { hr, staff } = await office();
  const kinds = await filingKinds(hr, hrApi());
  const doc = await makeDoc(staff.id, null, 'visa.jpg');
  const passport = await typeId('Passport');
  await db.prepare(`UPDATE documents SET type_id = ?, category_id = (SELECT category_id FROM document_types WHERE id = ?),
    employee_code = 'E-0077', employee_name = 'Sara Lopez', link_confirmed_at = 1 WHERE id = ?`).run(passport, passport, doc);
  const c = await classify('visa.jpg', 'visa', [], [], { kinds, ask: model({ type_id: await typeId('Residence Visa'), employee_code: 'E-0042' }) });
  await fileAs(doc, c);
  const row = await db.prepare('SELECT type_id, employee_code FROM documents WHERE id = ?').get(doc);
  assert.deepEqual(row, { type_id: passport, employee_code: 'E-0077' });
});

test('saifsys down still files the document', async () => {
  const { hr } = await office();
  const down = async () => { throw Object.assign(new Error('saifsys did not answer'), { status: 502 }); };
  const kinds = await filingKinds(hr, down);
  assert.equal(kinds.roster, null);
  const c = await classify('visa.jpg', 'visa', [], [], { kinds, ask: model({ type_id: await typeId('Residence Visa'), employee_code: 'E-0042' }) });
  assert.equal(c.typeId, await typeId('Residence Visa'));
  assert.equal(c.employee, null);
});

// ---------- Task 4: correct and confirm on the Shelf ----------

const { editDocumentKind } = await import('../server/files.js');
// saifsys hr/employee, as lookupCode() asks it.
const hrOne = async (module, action, { q }) => {
  const e = ROSTER.find((r) => r.code === q);
  return { ok: true, employee: e ? { ...e, position: 'Clerk', company: 'AAR', status: 'active' } : null };
};
async function passportOf(ownerId, { code = 'E-0042', expires = '2027-03-01' } = {}) {
  const id = await makeDoc(ownerId, null, 'passport.pdf');
  const t = await typeId('Passport');
  await db.prepare(`UPDATE documents SET type_id = ?, category_id = (SELECT category_id FROM document_types WHERE id = ?),
    employee_code = ?, employee_name = 'Ahmed Khan', expires_on = ? WHERE id = ?`).run(t, t, code, expires, id);
  return id;
}
const row = (id) => db.prepare('SELECT * FROM documents WHERE id = ?').get(id);

test('module holder confirms a date on someone else\'s file', async () => {
  const { hr, staff } = await office();
  const id = await passportOf(staff.id);
  await editDocumentKind(hr, id, { confirm_expiry: true, confirm_link: true }, hrOne);
  const r = await row(id);
  assert.equal(r.expiry_confirmed_by, hr.id);
  assert.ok(r.expiry_confirmed_at > 0);
  assert.equal(r.link_confirmed_by, hr.id);
});

test('changing the date clears the confirmation', async () => {
  const { hr, staff } = await office();
  const id = await passportOf(staff.id);
  await editDocumentKind(hr, id, { confirm_expiry: true }, hrOne);
  await editDocumentKind(hr, id, { expires_on: '2028-03-01' }, hrOne);
  const r = await row(id);
  assert.equal(r.expires_on, '2028-03-01');
  assert.equal(r.expiry_confirmed_at, null);
  await editDocumentKind(hr, id, { expires_on: '2028-03-01', confirm_expiry: true }, hrOne);
  assert.ok((await row(id)).expiry_confirmed_at, 'a corrected date can be confirmed in the same step');
});

test('a date that is not there cannot be confirmed', async () => {
  const { hr, staff } = await office();
  const id = await passportOf(staff.id, { expires: null });
  await assert.rejects(editDocumentKind(hr, id, { confirm_expiry: true }, hrOne), (e) => e.status === 400);
});

test('a wrong employee code is refused with HR\'s message', async () => {
  const { hr, staff } = await office();
  const id = await passportOf(staff.id);
  await editDocumentKind(hr, id, { confirm_link: true }, hrOne);
  await assert.rejects(editDocumentKind(hr, id, { employee_code: 'E-9999' }, hrOne), /HR has no employee with code E-9999/);
  await editDocumentKind(hr, id, { employee_code: 'E-0077' }, hrOne);
  const r = await row(id);
  assert.equal(r.employee_code, 'E-0077');
  assert.equal(r.employee_name, 'Sara Lopez');
  assert.equal(r.link_confirmed_at, null, 'a new employee is unconfirmed');
});

test('person without the module cannot change category fields', async () => {
  const { staff, boss } = await office();
  const other = await userRow(await makeUser('Other'));
  const id = await passportOf(staff.id);
  await setOwners(boss, other.id, [staff.id]); // even with file_access to the owner
  await assert.rejects(editDocumentKind(other, id, { confirm_expiry: true }, hrOne), (e) => e.status === 404);
  const licence = await makeDoc(boss.id, null, 'licence.pdf');
  await assert.rejects(editDocumentKind(other, licence, { type_id: await typeId('Trade Licence') }, hrOne), (e) => e.status === 404);
});

test('a holder cannot file someone\'s personal file into a category', async () => {
  const { hr, staff } = await office();
  const personal = await makeDoc(staff.id, null, 'notes.pdf');
  await assert.rejects(editDocumentKind(hr, personal, { type_id: await typeId('Passport') }, hrOne), (e) => e.status === 404);
});

test('the owner and the master set and clear the type', async () => {
  const { boss, staff } = await office();
  const id = await makeDoc(staff.id, null, 'tl.pdf');
  const licence = await typeId('Trade Licence');
  await editDocumentKind(staff, id, { type_id: licence, subject: ' Ain Al Reem LLC ' }, hrOne);
  let r = await row(id);
  assert.equal(r.type_id, licence);
  assert.equal(r.category_id, (await cats.typeById(licence)).category.id);
  assert.equal(r.subject, 'Ain Al Reem LLC');
  // Moved to an employee type: the subject goes, and the link is now unconfirmed.
  await editDocumentKind(boss, id, { type_id: await typeId('Passport'), employee_code: 'E-0042' }, hrOne);
  r = await row(id);
  assert.equal(r.subject, null);
  assert.equal(r.employee_code, 'E-0042');
  await editDocumentKind(boss, id, { type_id: null }, hrOne);
  r = await row(id);
  assert.deepEqual([r.type_id, r.category_id, r.employee_code, r.subject], [null, null, null, null]);
});

test('a retired type cannot be picked, but a file keeps the one it has', async () => {
  const { boss, staff } = await office();
  const id = await passportOf(staff.id);
  await cats.updateType(boss, await typeId('Passport'), { active: false });
  await editDocumentKind(boss, id, { type_id: await typeId('Passport'), confirm_expiry: true }, hrOne); // unchanged: fine
  const other = await makeDoc(staff.id, null, 'p2.pdf');
  await assert.rejects(editDocumentKind(boss, other, { type_id: await typeId('Passport') }, hrOne), (e) => e.status === 400);
});

test('an employee code on a company file is refused', async () => {
  const { boss } = await office();
  const id = await makeDoc(boss.id, null, 'tl.pdf');
  await editDocumentKind(boss, id, { type_id: await typeId('Trade Licence') }, hrOne);
  await assert.rejects(editDocumentKind(boss, id, { employee_code: 'E-0042' }, hrOne), (e) => e.status === 400);
});

test('not renewing is recorded and can be taken back', async () => {
  const { hr, staff } = await office();
  const id = await passportOf(staff.id);
  await editDocumentKind(hr, id, { not_renewing: { note: 'Left the company' } }, hrOne);
  let r = await row(id);
  assert.ok(r.not_renewing_at > 0);
  assert.equal(r.not_renewing_note, 'Left the company');
  await editDocumentKind(hr, id, { not_renewing: null }, hrOne);
  r = await row(id);
  assert.equal(r.not_renewing_at, null);
});

test('the uploader still sees their own categorised file', async () => {
  const { staff } = await office();
  const passport = await fileWith(staff.id, 'Passport Ahmed Khan', 'Passport number P1234567 of Ahmed Khan');
  await file(passport, 'Passport');
  const s = await sees(staff, passport);
  assert.equal(s.list && s.open, true);
});
