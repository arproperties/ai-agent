import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reset, closeDb, db } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, updateBooking, bookingDocs, addBookingDoc, overview, cancelBooking } from '../server/leasing.js';
import { contractRow, renderContract, fileContract, keepContract } from '../server/leaseContract.js';

test.after(() => closeDb());

async function lease(extra = {}) {
  await reset();
  const c = await create('company', { name: 'Gates Holdings LLC', address: '100 Main St', city: 'Beaumont', state: 'TX', zip: '77701', phone: '4095550100' });
  const b = await create('building', { name: 'The Gates', address: '2440 Hwy 326 S', city: 'Sour Lake', emirate: 'TX', zip: '77659' }, c.id);
  const u = await create('unit', { unit_no: '601' }, b.id);
  return createBooking({ unit_id: u.id, start_date: '2026-10-15', end_date: '2027-09-30', rent_amount: 1050, security_deposit: 100, payment_frequency: 'monthly', prorate: 'second',
    fees: [{ label: 'Trash', amount: 25, repeats: true }, { label: 'Admin fee', amount: 150 }], tenant: { full_name: 'Jane Example' }, ...extra });
}

test('the contract is typed in from the lease: the parties, the place, the rent, the part month and the charges', async () => {
  const bk = await lease();
  const p = await contractRow(bk.id);
  assert.deepEqual([p.tenant, p.company, p.address, p.city, p.state, p.zip, p.unit_no], ['Jane Example', 'Gates Holdings LLC', '2440 Hwy 326 S', 'Sour Lake', 'TX', '77659', '601']);
  const { bytes, name } = await renderContract(p);
  assert.equal(name, `Lease Contract - Unit 601 - ${bk.ref}.pdf`);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 3, 'the details page, the terms and the bed bug addendum');
});

test('a lease made from the form gets its contract, kept as a generated document; a draft\'s follows its changes, a confirmed one\'s never changes; it does not count as signed', async () => {
  const bk = await lease();
  await keepContract(bk.id, null);
  let docs = await bookingDocs(bk.id);
  assert.deepEqual(docs.map((d) => [d.title, d.category, d.generated, d.has_file]), [['Lease Contract', 'lease', true, true]]);
  const path = (await db.prepare('SELECT file_path FROM lease_documents WHERE id = ?').get(docs[0].id)).file_path;
  const first = readFileSync(path);

  await updateBooking(bk.id, { security_deposit: 300 });
  await keepContract(bk.id, null, { onlyIfKept: true });
  docs = await bookingDocs(bk.id);
  assert.equal(docs.length, 1, 'made again over the same document, not a second one');
  const drafted = readFileSync(path);
  assert.ok(!drafted.equals(first), 'a draft\'s contract follows the form');

  await db.prepare("UPDATE lease_bookings SET status = 'confirmed' WHERE id = ?").run(bk.id); // an edit cannot confirm; this stands in for Confirm
  await updateBooking(bk.id, { security_deposit: 400 });
  await keepContract(bk.id, null, { onlyIfKept: true });
  assert.ok(readFileSync(path).equals(drafted), 'a confirmed lease\'s contract is never made again by a change');

  assert.equal((await overview({}, '2026-10-20')).missingContracts, 1, 'the generated copy is unsigned: the signed one is still asked for');
  await addBookingDoc(bk.id, { title: 'Signed contract' });
  assert.equal((await overview({}, '2026-10-20')).missingContracts, 0);

  await cancelBooking(bk.id, 'Changed plans');
  await assert.rejects(fileContract(bk.id), /cancelled lease/);
});

test('the rent amount typed for the lease goes to its contract and is not billed', async () => {
  const bk = await lease({ status: 'confirmed', shown_rent: 831 });
  const p = await contractRow(bk.id);
  assert.equal(p.shown_rent, 831);
  assert.equal((await renderContract(p)).bytes.subarray(0, 5).toString(), '%PDF-');
  const rents = await db.prepare("SELECT DISTINCT amount FROM lease_installments WHERE booking_id = ? AND kind = 'rent' AND label IS NULL").all(bk.id);
  assert.ok(rents.every((r) => Number(r.amount) !== 831), 'the rent billed is still the lease rent, not the amount shown');
  await assert.rejects(updateBooking(bk.id, { shown_rent: 900 }), /locked/, 'locked once a confirmed lease has one');
  await assert.rejects(updateBooking(bk.id, { shown_rent: '' }), /locked/);
  await updateBooking(bk.id, { shown_rent: 831, security_deposit: 120 }); // the form sends it unchanged with every save
  const older = await lease({ status: 'confirmed' });
  await updateBooking(older.id, { shown_rent: 700 });
  assert.equal((await contractRow(older.id)).shown_rent, 700, 'an older confirmed lease can get it once');
});

test('a lease with no contract kept is not given one by a change', async () => {
  const bk = await lease();
  await keepContract(bk.id, null, { onlyIfKept: true });
  assert.equal((await bookingDocs(bk.id)).length, 0);
});
