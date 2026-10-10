import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, closeDb, db } from './helpers/db.js';
import { create, remove, docStatus, addDoc, addDocument, updateDoc, register, docHistory, places } from '../server/properties.js';

test.after(() => closeDb());

const AT = '2026-10-10';

async function tower() {
  await reset();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  return { c, b, u };
}

test('a document is due once inside its own renewal window, three months unless it says otherwise', () => {
  assert.equal(docStatus({ expiry_date: null }, AT), 'on_file');
  assert.equal(docStatus({ expiry_date: '2027-01-08' }, AT), 'due', '90 days left');
  assert.equal(docStatus({ expiry_date: '2027-01-09' }, AT), 'valid', '91 days left');
  assert.equal(docStatus({ expiry_date: '2027-01-08', renew_days: 30 }, AT), 'valid');
  assert.equal(docStatus({ expiry_date: AT, renew_days: 0 }, AT), 'due', 'the day itself');
  assert.equal(docStatus({ expiry_date: '2026-10-09' }, AT), 'expired');
});

test('a document belongs to one company, one building or one unit, and the register lists them all', async () => {
  const { c, b, u } = await tower();

  const policy = await addDocument({ building_id: b.id, title: ' Fire insurance ', expiry_date: '2027-01-08', renew_by: 'quotes',
    details: JSON.stringify({ insurer: 'Orient', premium: 'USD 4,200', junk: 'x' }) });
  assert.deepEqual([policy.title, policy.building_id, policy.company_id, policy.renew_days, policy.renew_by, policy.details],
    ['Fire insurance', b.id, null, 90, 'quotes', { insurer: 'Orient', premium: 'USD 4,200' }]);
  // As a form sends it: text for the id, and empty text for the owners not chosen.
  const pest = await addDocument({ unit_id: String(u.id), company_id: '', building_id: '', title: 'Pest control', renew_days: '30' });
  assert.deepEqual([pest.unit_id, pest.renew_days], [u.id, 30]);
  await addDoc(c.id, { title: 'Trade License', expiry_date: '2026-09-01' });

  await assert.rejects(addDocument({ title: 'X' }), /one company, one building or one unit/);
  await assert.rejects(addDocument({ title: 'X', company_id: c.id, building_id: b.id }), /one company, one building or one unit/);
  await assert.rejects(addDocument({ title: 'X', building_id: 999 }), /Not found/);
  await assert.rejects(addDocument({ building_id: b.id }), /Give the document a name/);
  await assert.rejects(addDocument({ building_id: b.id, title: 'X', renew_days: 400 }), /0 to 365/);
  await assert.rejects(addDocument({ building_id: b.id, title: 'X', renew_days: '1.5' }), /0 to 365/);
  await assert.rejects(addDocument({ building_id: b.id, title: 'X', renew_by: 'magic' }), /a reminder or by quotes/);
  await assert.rejects(addDocument({ building_id: b.id, title: 'X', details: '{not json' }), /details/);
  await assert.rejects(db.prepare('INSERT INTO prop_documents (title) VALUES (?)').run('Nobody'), /prop_documents_one_owner/);

  assert.deepEqual((await register({}, AT)).map((d) => [d.title, d.owner, d.where, d.status, d.days_left, d.count]), [
    ['Trade License', 'company', 'ACE', 'expired', -39, 1],
    ['Fire insurance', 'building', 'Tower', 'due', 90, 1],
    ['Pest control', 'unit', 'Unit 101, Tower', 'on_file', null, 1],
  ]);
  assert.deepEqual((await register({ building_id: b.id }, AT)).map((d) => d.title), ['Fire insurance', 'Pest control'], "a building's own and its units', not its company's");
  assert.deepEqual((await register({ company_id: c.id, status: 'expired' }, AT)).map((d) => d.title), ['Trade License']);
  assert.equal((await register({ company_id: c.id + 1 }, AT)).length, 0);
  assert.equal((await register({}, '2026-10-09'))[1].status, 'valid', 'the day before its window opens');

  // The same name again under the same owner is its renewal; under another owner it is another document.
  const renewed = await addDocument({ building_id: b.id, title: 'fire insurance', expiry_date: '2028-01-08' });
  const [row] = await register({ building_id: b.id }, AT);
  assert.deepEqual([row.id, row.count, row.status], [renewed.id, 2, 'valid']);
  await addDoc(c.id, { title: 'Fire insurance' });
  assert.deepEqual((await docHistory(policy.id, AT)).map((d) => d.id), [renewed.id, policy.id]);
  assert.equal((await register({}, AT)).filter((d) => d.title.toLowerCase() === 'fire insurance').length, 2);
  await assert.rejects(docHistory(999), /Not found/);

  const edited = await updateDoc(renewed.id, { renew_days: '120', renew_by: 'remind', details: { cover: 'The building' } });
  assert.deepEqual([edited.renew_days, edited.renew_by, edited.details, edited.building_id], [120, 'remind', { cover: 'The building' }, b.id]);
  assert.equal((await updateDoc(renewed.id, { renew_days: '', notes: 'checked' })).renew_days, 120, 'an emptied window is left as it was');

  assert.deepEqual(await places(), { companies: [{ id: c.id, name: 'ACE' }], buildings: [{ id: b.id, name: 'Tower', company_id: c.id }], units: [{ id: u.id, unit_no: '101', building_id: b.id }] });
});

test("a building's and a unit's documents, and their files, go with them", async () => {
  const { b, u } = await tower();
  const pdf = { buffer: Buffer.from('%PDF'), originalname: 'policy.pdf', mimetype: 'application/pdf' };
  const one = await addDocument({ building_id: b.id, title: 'Insurance' }, pdf);
  const two = await addDocument({ unit_id: u.id, title: 'Gas certificate' }, pdf);
  const path = async (id) => (await db.prepare('SELECT file_path FROM prop_documents WHERE id = ?').get(id)).file_path;
  const [p1, p2] = [await path(one.id), await path(two.id)];
  assert.deepEqual([one.has_file, existsSync(p1), existsSync(p2)], [true, true, true]);

  await remove('unit', u.id);
  assert.deepEqual([existsSync(p1), existsSync(p2)], [true, false]);
  await remove('building', b.id);
  assert.equal(existsSync(p1), false);
  assert.equal((await register()).length, 0);
});
