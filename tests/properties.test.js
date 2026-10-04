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

test('a company has a logo and a building a photo: one each, replaced, and gone with it', async () => {
  const { existsSync } = await import('node:fs');
  const { setPhoto, getPhoto, removePhoto, listCompanies, listBuildings, remove: drop } = await import('../server/properties.js');
  await reset();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const jpg = (text) => ({ buffer: Buffer.from(text), originalname: 'p.jpg', mimetype: 'image/jpeg' });
  assert.equal((await listCompanies())[0].photo_at, null);

  await assert.rejects(setPhoto('company', c.id, { buffer: Buffer.from('x'), originalname: 'a.pdf', mimetype: 'application/pdf' }), /not a picture/);
  await assert.rejects(setPhoto('building', 999, jpg('x')), /Not found/);
  await assert.rejects(setPhoto('company', c.id, null), /Choose a picture/);
  await setPhoto('company', c.id, jpg('logo'));
  assert.ok((await listCompanies())[0].photo_at);
  assert.equal((await listBuildings(c.id))[0].photo_at, null, 'the company\'s logo is not the building\'s photo');

  await setPhoto('building', b.id, jpg('one'));
  const first = (await getPhoto('building', b.id)).file_path;
  await setPhoto('building', b.id, jpg('two'));
  const second = (await getPhoto('building', b.id)).file_path;
  assert.deepEqual([existsSync(first), existsSync(second), !!(await listBuildings(c.id))[0].photo_at], [false, true, true]);

  await drop('building', b.id);
  assert.equal(existsSync(second), false);
  await assert.rejects(getPhoto('building', b.id), /Not found/);
  const logo = (await getPhoto('company', c.id)).file_path;
  await removePhoto('company', c.id);
  await removePhoto('company', c.id);
  assert.deepEqual([existsSync(logo), (await listCompanies())[0].photo_at], [false, null]);
});

test('a unit has several photos, in the order they were added, and they go with it', async () => {
  const { existsSync } = await import('node:fs');
  const { addUnitPhoto, getUnitPhoto, removeUnitPhoto, remove: drop } = await import('../server/properties.js');
  await reset();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  await create('unit', { unit_no: '102' }, b.id);
  const jpg = (text) => ({ buffer: Buffer.from(text), originalname: 'p.jpg', mimetype: 'image/jpeg' });

  const one = await addUnitPhoto(u.id, jpg('living room'));
  const two = await addUnitPhoto(u.id, jpg('kitchen'));
  assert.deepEqual((await listUnits(b.id)).map((x) => [x.unit_no, x.photos]), [['101', [one.id, two.id]], ['102', []]]);
  await assert.rejects(addUnitPhoto(u.id, { buffer: Buffer.from('x'), originalname: 'a.pdf', mimetype: 'application/pdf' }), /not a picture/);
  await assert.rejects(addUnitPhoto(999, jpg('x')), /Not found/);

  const gone = (await getUnitPhoto(one.id)).file_path;
  await removeUnitPhoto(one.id);
  assert.deepEqual([existsSync(gone), (await listUnits(b.id))[0].photos], [false, [two.id]]);
  for (let i = 0; i < 11; i++) await addUnitPhoto(u.id, jpg(`more ${i}`));
  await assert.rejects(addUnitPhoto(u.id, jpg('one too many')), /can have 12 photos/);

  const kept = (await getUnitPhoto(two.id)).file_path;
  await drop('unit', u.id);
  assert.equal(existsSync(kept), false);
  await assert.rejects(getUnitPhoto(two.id), /Not found/);
});
