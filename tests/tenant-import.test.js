import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db } from './helpers/db.js';
import { addTenant, listTenants, createBooking } from '../server/leasing.js';
import { create } from '../server/properties.js';
import { cleanRow, planImport, importTenants, undoImport, readTenantFiles, parseRows } from '../server/tenantImport.js';

test.after(() => closeDb());

const row = (tenant, contacts = tenant, account = '1', extra = {}) => ({ tenant, contacts, account, cut: false, company: false, ...extra });
const one = (r, existing = []) => planImport([r], existing)[0];

test('Rent Manager tags come out of the name and are kept in the notes', () => {
  const c = cleanRow(row('FRANK ROY M2M', 'FRANK ROY M2M', '4146'));
  assert.equal(c.name, 'FRANK ROY', 'kept in the capitals Rent Manager writes');
  assert.match(c.notes, /M2M/);
  assert.equal(cleanRow(row('KIARA M2M HUD LAN', 'KIARA LANDRY')).name, 'KIARA LANDRY', 'a cut-off name is finished from Contacts');
  assert.equal(cleanRow(row('Jennifer ABP/75 Barnd', 'Jennifer Barndt')).name, 'Jennifer Barndt');
  assert.equal(cleanRow(row('Leondrea (LEGACY) S', 'Leondrea Simien')).name, 'Leondrea Simien');
  assert.equal(cleanRow(row('BRET (THIRD) NAZW', 'BRET NAZWORTH')).name, 'BRET NAZWORTH');
  assert.equal(cleanRow(row('Holly Campbell  WDC', 'Holly Campbell')).name, 'Holly Campbell');
  assert.equal(cleanRow(row('Edward M2M Lapoint', 'Edward Lapoint JR')).name, 'Edward Lapoint JR');
  assert.equal(cleanRow(row('ANDREW MCBRIDE')).name, 'ANDREW MCBRIDE');
  assert.match(cleanRow(row('Lillian (HUD) Ortiz', 'Lillian Ortiz')).notes, /HUD/);
});

test('a name cut off in the list is finished from Contacts, even where the last letter was misread', () => {
  assert.equal(cleanRow(row('ANGELIQUE WAHLBE...', 'ANGELIQUE WAHLBERG, J...')).name, 'ANGELIQUE WAHLBERG');
  assert.equal(cleanRow(row('ANDREW M2M BEESI', 'ANDREW BEESLEY')).name, 'ANDREW BEESLEY', 'the column is full, so BEESI is BEESL cut off');
  assert.equal(one(row('ANDREW M2M BEESI', 'ANDREW BEESLEY')).status, 'new');
  assert.equal(one(row('JAMES HENDRIX', 'JAMES HENDRICKS')).status, 'check', 'a short name was not cut off, so a different spelling is a question');
  assert.equal(one(row('Hannah Jurek', 'Cody Sammy Jurek, Hannah...')).status, 'new', 'she is the second contact');
  const co = one(row('DIRECTIONAL SERVI...', 'DIRECTIONAL SERVICE SO...', '5172', { company: true }));
  assert.deepEqual([co.name, co.status], ['DIRECTIONAL SERVICE SO', 'check'], 'both columns cut off');
  assert.equal(one(row('GUSTAVO FF ABP/75', 'ELTON BARRERA, GUSTAV')).status, 'check', 'a person with no surname is looked at, not skipped');
  assert.equal(one(row('Tyler Wooten', 'Brittany Wooten, Tyler Woote...', '5804', { cut: true })).status, 'new', 'the name is whole in the Tenant column');
  assert.equal(cleanRow(row('Jarimish James (Lega', 'Jarimish James')).name, 'Jarimish James', 'a tag cut off by the column');
  assert.equal(cleanRow(row('Edward M2M Lapoint.', 'Edward Lapoint JR')).name, 'Edward Lapoint JR');
  assert.deepEqual(parseRows('[["COLTON FOUNTAIN","Colton Fountain","GSL 109 4950",0,0]]')[0].account, '4950', 'the unit read into the account cell is dropped');
});

test('the Tenant column is the name; other people in Contacts go to the notes', () => {
  const c = cleanRow(row('Victoria Biddle', 'Brittany Middleton, Victoria Bi'));
  assert.equal(c.name, 'Victoria Biddle');
  assert.match(c.notes, /Brittany Middleton/);
  assert.doesNotMatch(c.notes, /Victoria/);
});

test('rows that are not a person are skipped, unclear ones are checked', () => {
  for (const n of ['AIRBNB 1', 'AIRBNB NIGHTLY', 'FF', 'ARTURO EMP', 'FRANK EMPLOYEE', 'NOAH AIRBNB', 'JEREMY - MAINTAINCE']) {
    assert.equal(one(row(n, n)).status, 'skip', n);
  }
  assert.equal(one(row('Latricia West', 'Latricia Gail')).status, 'check', 'the two columns disagree');
  assert.equal(one(row('JAMES HENDRIX', 'JAMES HENDRICKS')).status, 'check');
  assert.equal(one(row('Lennord *SEE NOTE*', 'Nathan Randal')).status, 'check');
  assert.equal(one(row('Alexis Boyett - Balance', 'Alexis Boyett - Balance')).status, 'check');
  assert.equal(one(row('BRANDON KORENEK', '', '7023', { cut: true })).status, 'check', 'the reader saw it cut off');
  const ok = one(row('CHRIS ROBSON', 'CHRIS ROBSON', '4033'));
  assert.deepEqual([ok.status, ok.pick, ok.name, ok.accounts], ['new', true, 'CHRIS ROBSON', ['4033']]);
  assert.equal(one(row('Seth Wells')).pick, true);
  assert.equal(one(row('Latricia West', 'Latricia Gail')).pick, false, 'only clear new rows start ticked');
});

test('the same person on several accounts is one tenant; companies are companies', () => {
  const plan = planImport([
    row('BRET (THIRD) NAZW', 'BRET NAZWORTH', '4240'), row('BRET (PRIMARY) NA', 'BRET NAZWORTH', '4241'),
    row('Chelsie Biano', 'Chelsie Biano', '5828'), row('Chelsie Biano', 'Chelsie Biano', '6274'),
    row('DIRECTIONAL SERVI', 'DIRECTIONAL SERVICE SO', '5172', { company: true }), row('DIRECTIONAL SERVI', 'DIRECTIONAL SERVICE SO', '5173', { company: true }),
  ], []);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan[0].accounts, ['4240', '4241']);
  assert.deepEqual(plan[1].accounts, ['5828', '6274']);
  assert.equal(plan[2].kind, 'company');
  assert.deepEqual(plan[2].accounts, ['5172', '5173']);
});

test('a tenant already on file is not added again, by account number or by name', () => {
  const existing = [{ id: 7, full_name: 'Chris Robson', old_account: null }, { id: 8, full_name: 'Someone Else', old_account: '4034' }];
  assert.deepEqual([one(row('CHRIS ROBSON', 'CHRIS ROBSON', '4033'), existing).status, one(row('CHRIS ROBSON', 'CHRIS ROBSON', '4033'), existing).tenant_id], ['exists', 7]);
  assert.equal(one(row('JOSHUA MAY', 'JOSHUA MAY', '4034'), existing).status, 'exists');
});

test('the reader\'s reply is taken apart safely', () => {
  assert.deepEqual(parseRows('here {"rows":[["CHRIS ROBSON","CHRIS ROBSON","4033",0,0],["", "", "", 0, 0],["DIRECTIONAL SERVI","DIRECTIONAL SERVICE SO",5172,1,1]]}'),
    [row('CHRIS ROBSON', 'CHRIS ROBSON', '4033'), row('DIRECTIONAL SERVI', 'DIRECTIONAL SERVICE SO', '5172', { cut: true, company: true })]);
  assert.deepEqual(parseRows('nonsense'), []);
});

test('every file is read, and one that fails says so without losing the others', async () => {
  const files = [
    { buffer: Buffer.from('a'), mimetype: 'image/png', originalname: 'p1.png' },
    { buffer: Buffer.from('b'), mimetype: 'image/png', originalname: 'p2.png' },
    { buffer: Buffer.from('Tenant,Contacts,Account #\nJOSHUA MAY,JOSHUA MAY,4034\n'), mimetype: 'text/csv', originalname: 'list.csv' },
    { buffer: Buffer.from('x'), mimetype: 'application/zip', originalname: 'x.zip' },
  ];
  let calls = 0;
  const read = async (content) => {
    calls += 1;
    if (content.some((b) => b.type === 'text' && b.text.includes('JOSHUA MAY'))) return '{"rows":[["JOSHUA MAY","JOSHUA MAY","4034",0,0]]}';
    if (content[0].source.data === Buffer.from('b').toString('base64')) throw new Error('boom');
    return '{"rows":[["CHRIS ROBSON","CHRIS ROBSON","4033",0,0]]}';
  };
  const kept = new Map();
  const saved = { get: async (h) => kept.get(h), set: async (h, rows) => { kept.set(h, rows); } };
  const got = await readTenantFiles(files, { read, saved });
  assert.equal(calls, 3, 'a zip is not sent to be read');
  assert.deepEqual(got.rows.map((r) => r.tenant), ['CHRIS ROBSON', 'JOSHUA MAY']);
  assert.deepEqual(got.failed.sort(), ['p2.png', 'x.zip']);

  // The same files again: what was read is not read (or paid for) twice; the one that failed is tried again.
  const again = await readTenantFiles(files, { read, saved });
  assert.equal(calls, 4, 'only p2.png is sent again');
  assert.deepEqual(again.rows.map((r) => r.tenant), ['CHRIS ROBSON', 'JOSHUA MAY']);
});

test('a reading is kept in the database, so the same file is not paid for after a restart', async () => {
  await reset();
  const file = { buffer: Buffer.from('page one'), mimetype: 'image/png', originalname: 'p1.png' };
  let calls = 0;
  const read = async () => { calls += 1; return '{"rows":[["CHRIS ROBSON","CHRIS ROBSON","4033",0,0]]}'; };
  await readTenantFiles([file], { read });
  const second = await readTenantFiles([{ ...file, originalname: 'renamed.png' }], { read });
  assert.equal(calls, 1, 'the same picture under another name is the same file');
  assert.equal(second.rows[0].account, '4033');
  await readTenantFiles([{ ...file, buffer: Buffer.from('page two') }], { read });
  assert.equal(calls, 2, 'a different file is read');
});

test('importing saves the ticked tenants with their account numbers, and undo takes back only that batch', async () => {
  await reset();
  const before = await addTenant({ full_name: 'Kept Tenant' });
  const plan = planImport([row('CHRIS ROBSON', 'CHRIS ROBSON', '4033'), row('BRET (THIRD) NAZW', 'BRET NAZWORTH', '4240'), row('BRET (PRIMARY) NA', 'BRET NAZWORTH', '4241'),
    row('DIRECTIONAL SERVI', 'DIRECTIONAL SERVICE SO', '5172', { company: true })], await listTenants());
  const r = await importTenants(plan.map((p) => ({ ...p, name: p.name === 'CHRIS ROBSON' ? 'Christopher Robson' : p.name })), null);
  assert.equal(r.added, 3);
  const t = await listTenants();
  const chris = t.find((x) => x.full_name === 'Christopher Robson');
  assert.equal(chris.old_account, '4033', 'a name fixed in the preview is the one saved');
  assert.equal(t.find((x) => x.full_name === 'BRET NAZWORTH').old_account, '4240, 4241');
  assert.equal(t.find((x) => x.kind === 'company').full_name, 'DIRECTIONAL SERVICE SO');
  assert.equal((await listTenants('4241')).length, 1, 'the old account number can be searched');
  await importTenants(planImport([row('Leondrea (LEGACY) S', 'Leondrea Simien', '5299')], await listTenants()), null);
  assert.deepEqual((await listTenants('legacy')).map((x) => x.full_name), ['Leondrea Simien'], 'a Rent Manager tag finds its tenants, through the notes');
  await db.prepare("DELETE FROM lease_tenants WHERE full_name = 'Leondrea Simien'").run();

  const again = await importTenants(plan, null);
  assert.deepEqual([again.added, again.skipped], [0, 3], 'importing the same list twice adds no one');

  // A tenant who has a lease by now is kept on undo.
  const c = await create('company', { name: 'A' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  await createBooking({ unit_id: u.id, tenant_id: chris.id, start_date: '2026-11-01', end_date: '2026-11-30', rent_amount: 900 });
  const undone = await undoImport(r.batch);
  assert.deepEqual([undone.removed, undone.kept], [2, 1]);
  assert.deepEqual((await listTenants()).map((x) => x.full_name).sort(), ['Christopher Robson', 'Kept Tenant']);
  assert.ok(before.id);
  assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM lease_tenants').get()).n), 2);
});
