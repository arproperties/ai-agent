import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb } from './helpers/db.js';
import { create, update, remove, listCompanies, listBuildings, listUnits } from '../server/properties.js';

test.after(() => closeDb());

test('company → building → unit, with counts and no duplicates', async () => {
  await reset();
  const me = await makeUser('Owner');
  const c = await create('company', { name: ' ACE Real Estate ', trn: '100' }, null, me);
  assert.equal(c.name, 'ACE Real Estate');
  await assert.rejects(create('company', { name: 'ACE Real Estate' }), /already exists/);
  await assert.rejects(create('company', { name: '  ' }), /Name is required/);

  const b = await create('building', { name: 'Park Place', emirate: 'Dubai' }, c.id);
  await assert.rejects(create('building', { name: 'X' }, 999), /Not found/);
  for (const [unit_no, floor] of [['101', '1'], ['12', 'G'], ['201', '2'], ['102', '1']]) await create('unit', { unit_no, floor, size_sqft: '750' }, b.id);
  await assert.rejects(create('unit', { unit_no: '101' }, b.id), /already exists in this building/);
  await assert.rejects(create('unit', { unit_no: '9', size_sqft: 'abc' }, b.id), /must be a number/);

  assert.deepEqual((await listUnits(b.id)).map((u) => u.unit_no), ['12', '101', '102', '201'], 'ground floor first, then by number');
  const [row] = await listCompanies();
  assert.equal(row.buildings, 1);
  assert.equal(row.units, 4);
  assert.equal((await listBuildings(c.id))[0].units, 4);
});

test('edit, and removal only once emptied', async () => {
  await reset();
  const c = await create('company', { name: 'A' });
  const b = await create('building', { name: 'B' }, c.id);
  const u = await create('unit', { unit_no: '1' }, b.id);

  assert.equal((await update('unit', u.id, { furnished: true, size_sqft: 900 })).furnished, true);
  await assert.rejects(update('unit', 999, { floor: '1' }), /Not found/);
  await assert.rejects(remove('company', c.id), /Remove its buildings first/);
  await assert.rejects(remove('building', b.id), /Remove its units first/);
  await remove('unit', u.id);
  await remove('building', b.id);
  await remove('company', c.id);
  assert.equal((await listCompanies()).length, 0);
});

test('company documents: named freely, and the newest under one name decides', async () => {
  const { docStatus, docBoard, companyDocs, addDoc, updateDoc, removeDoc } = await import('../server/properties.js');
  assert.equal(docStatus({ expiry_date: null }, '2026-10-02'), 'on_file');
  assert.equal(docStatus({ expiry_date: '2026-10-01' }, '2026-10-02'), 'expired');
  assert.equal(docStatus({ expiry_date: '2026-11-01' }, '2026-10-02'), 'due');
  assert.equal(docStatus({ expiry_date: '2026-11-02' }, '2026-10-02'), 'valid');

  await reset();
  const c = await create('company', { name: 'A' });
  await addDoc(c.id, { title: 'Trade License', number: 'TL1', expiry_date: '2026-04-26' });
  const renewed = await addDoc(c.id, { title: ' Trade License ', number: 'TL2', expiry_date: '2027-09-17' });
  await addDoc(c.id, { title: 'MOA' });
  await addDoc(c.id, { title: 'Ejari', expiry_date: '2026-10-20' });
  await assert.rejects(addDoc(c.id, {}), /Give the document a name/);
  await assert.rejects(addDoc(c.id, { title: 'X', expiry_date: '2026-13-45x' }), /not a date/);
  await assert.rejects(updateDoc(renewed.id, { title: '' }), /Give the document a name/);

  let [card] = await docBoard('2026-10-02');
  assert.deepEqual(card.docs.map((g) => g.title), ['Ejari', 'MOA', 'Trade License']);
  const tl = card.docs.find((g) => g.title === 'Trade License');
  assert.equal(tl.count, 2, 'the same name again is the same document, renewed');
  assert.equal(tl.doc.number, 'TL2');
  assert.equal(tl.status, 'valid');
  assert.equal(card.due, 1);
  assert.equal((await companyDocs(c.id, 'TRADE LICENSE')).length, 2);

  await updateDoc(renewed.id, { expiry_date: '2026-09-01' });
  [card] = await docBoard('2026-10-02');
  assert.equal(card.expired, 1, 'the renewed one is now the newest, and expired');
  await removeDoc(renewed.id);
  await remove('company', c.id); // documents go with the company
});
