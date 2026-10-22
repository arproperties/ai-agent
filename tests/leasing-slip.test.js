import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, bookingPayments, recordPayment, payBooking, attachPaymentFile } from '../server/leasing.js';
import { readSlip, slipFrom, useAsk } from '../server/slipReader.js';

test.after(() => closeDb());

const AT = '2026-10-10';
const slip = (text) => ({ buffer: Buffer.from(text), mimetype: 'application/pdf', originalname: 'slip.pdf', size: text.length });

// Sara: two months in 101 from 15 September at 4,500 a month, with a 5,000 deposit. Nothing paid yet.
async function tower() {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  const bk = await createBooking({ unit_id: u.id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, security_deposit: 5000, status: 'confirmed',
    tenant: { full_name: 'Sara', phone: '050 123 4567' } }, staff);
  return { staff, bk };
}

test('what is read off a slip: only a real amount, date, method and reference', () => {
  assert.deepEqual(slipFrom('Here: {"amount": "USD 1,110.00", "received_on": "2026-10-02", "method": "online", "reference": "Web Pay VISA 88123"}'),
    { amount: 1110, received_on: '2026-10-02', method: 'online', reference: 'Web Pay VISA 88123' });
  assert.deepEqual(slipFrom('{"amount": 0, "received_on": "02/10/2026", "method": "crypto"}'), {});
  assert.deepEqual(slipFrom('I cannot read this'), {});
});

test('a slip is read once: saving uses the reading made when it was attached', async () => {
  let asked = 0;
  useAsk(async () => { asked++; return '{"amount": 200}'; });
  assert.deepEqual(await readSlip(slip('one')), { amount: 200 });
  assert.deepEqual(await readSlip(slip('one')), { amount: 200 });
  assert.equal(asked, 1);
  assert.deepEqual(await readSlip({ buffer: Buffer.from('x'), mimetype: 'text/plain' }), {}); // not a PDF or a photo
});

test('no more can be recorded with a slip than the slip shows', async () => {
  const { staff, bk } = await tower();
  useAsk(async () => '{"amount": 4000, "received_on": "2026-10-02", "method": "transfer"}');
  const rent = (await bookingPayments(bk.id, AT)).find((r) => r.kind === 'rent');
  await assert.rejects(recordPayment(rent.id, { amount: 4500, method: 'transfer' }, staff, AT, slip('a')), /The slip shows USD 4,000/);
  await assert.rejects(payBooking(bk.id, { amount: 9500, method: 'transfer' }, staff, AT, slip('a')), /The slip shows USD 4,000/);
  await recordPayment(rent.id, { amount: 4000, method: 'transfer' }, staff, AT, slip('a'));

  // Attached afterwards: the slip has to cover the whole payment, all the rows it was spread over.
  const made = await payBooking(bk.id, { amount: 5500, method: 'cash' }, staff, AT);
  useAsk(async () => '{"amount": 5000}');
  await assert.rejects(attachPaymentFile(made[0].id, slip('b'), staff), /The slip shows USD 5,000/);
  useAsk(async () => '{"amount": 5500}');
  await attachPaymentFile(made[0].id, slip('c'), staff);

  // A slip that cannot be read limits nothing.
  useAsk(async () => { throw new Error('down'); });
  const next = (await bookingPayments(bk.id, AT)).find((r) => r.kind === 'rent' && r.left > 0);
  await recordPayment(next.id, { amount: 1, method: 'cash' }, staff, AT, slip('d'));
});
