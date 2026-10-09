import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, updateBooking, bookingPayments, recordPayment, renewBooking, listBookings, monthlyRent, money, total } from '../server/leasing.js';
import { receiptRow, renderReceipt } from '../server/leasingReceipt.js';
import { report } from '../server/leasingReports.js';
import { importBookings } from '../server/leasingImport.js';
import { leasingKit } from '../server/leasingKit.js';
import { saveRegion, region } from '../server/leasingRegion.js';

test.after(() => closeDb());

const AT = '2026-10-10';

async function tower() {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE', trn: '100200300' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u1 = await create('unit', { unit_no: '101' }, b.id);
  return { staff, c, b, u1 };
}
const sara = (unit_id, extra = {}) => ({ unit_id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, status: 'confirmed',
  tenant: { full_name: 'Sara', phone: '050 123 4567', email: 'sara@example.com' }, ...extra });
const lines = async (id) => (await bookingPayments(id, AT)).map((r) => [r.name, r.amount, r.tax]);

test('a discount, in percent or as an amount, lowers every rent payment and nothing else', async () => {
  const { staff, u1 } = await tower();
  const bk = await createBooking(sara(u1.id, { security_deposit: 5000, fees: [{ label: 'Admin fee', amount: 500 }], discount_type: 'percent', discount_value: 10, discount_note: 'Early bird' }), staff);
  assert.deepEqual([bk.discount_type, bk.discount_value, bk.discount_note, bk.tax_percent], ['percent', 10, 'Early bird', null]);
  assert.deepEqual(await lines(bk.id), [['Security deposit', 5000, 0], ['Admin fee', 500, 0], ['Rent', 4050, 0], ['Rent', 4050, 0]]);
  assert.equal(monthlyRent(bk), 4050, 'the rent roll shows the rent as it is charged');
  assert.equal(monthlyRent({ rent_amount: 60000, rent_period: 'year', discount_type: 'amount', discount_value: 6000 }), 4500, 'an amount comes off the rent as it was entered: here, off the year');

  await updateBooking(bk.id, { discount_type: 'amount', discount_value: 500 }, staff);
  assert.deepEqual((await lines(bk.id)).slice(2), [['Rent', 4000, 0], ['Rent', 4000, 0]]);
  const none = await updateBooking(bk.id, { discount_value: '' }, staff);
  assert.deepEqual([none.discount_type, none.discount_value], [null, null]);
  assert.deepEqual((await lines(bk.id)).slice(2), [['Rent', 4500, 0], ['Rent', 4500, 0]]);

  await assert.rejects(updateBooking(bk.id, { discount_type: 'percent', discount_value: 100 }, staff), /below 100/);
  await assert.rejects(updateBooking(bk.id, { discount_type: 'amount', discount_value: 4500 }, staff), /less than the rent/);
  await assert.rejects(updateBooking(bk.id, { discount_type: 'half', discount_value: 5 }, staff), /percent or an amount/);
  await updateBooking(bk.id, { discount_type: 'amount', discount_value: 500 }, staff);
  await assert.rejects(updateBooking(bk.id, { rent_amount: 400 }, staff), /less than the rent/, 'a rent lowered beneath its discount');
});

test('tax is charged on the rent and the other charges, never on the deposit; a booking can have none', async () => {
  const { staff, u1 } = await tower();
  const bk = await createBooking(sara(u1.id, { security_deposit: 5000, fees: [{ label: 'Admin fee', amount: 500 }], tax_percent: 5 }), staff);
  assert.equal(bk.tax_percent, 5);
  assert.deepEqual(await lines(bk.id), [['Security deposit', 5000, 0], ['Admin fee', 525, 25], ['Rent', 4725, 225], ['Rent', 4725, 225]]);

  // The tax is on the rent after its discount.
  await updateBooking(bk.id, { discount_type: 'percent', discount_value: 10 }, staff);
  assert.deepEqual((await lines(bk.id)).slice(2), [['Rent', 4252.5, 202.5], ['Rent', 4252.5, 202.5]]);

  const off = await updateBooking(bk.id, { tax_percent: 0 }, staff);
  assert.equal(off.tax_percent, null, 'no tax is no tax, however it is written');
  assert.deepEqual(await lines(bk.id), [['Security deposit', 5000, 0], ['Admin fee', 500, 0], ['Rent', 4050, 0], ['Rent', 4050, 0]]);
  await assert.rejects(updateBooking(bk.id, { tax_percent: 150 }, staff), /from 0 to 100/);
  await assert.rejects(updateBooking(bk.id, { tax_percent: 'five' }, staff), /from 0 to 100/);
});

test('a yearly rent that does not divide still adds up, with its discount and its tax', async () => {
  const { staff, u1 } = await tower();
  const bk = await createBooking(sara(u1.id, { start_date: '2026-03-16', end_date: '2027-03-15', rent_amount: 62000, rent_period: 'year', discount_type: 'percent', discount_value: 3, tax_percent: 5 }), staff);
  const rows = await bookingPayments(bk.id, AT);
  assert.equal(rows.length, 12);
  assert.equal(total(rows, (r) => r.amount - r.tax), 60140, 'the rent before tax is the year less 3%, to the fils');
  for (const r of rows) assert.equal(r.tax, money((r.amount - r.tax) * 0.05));
  assert.equal(total(rows), money(60140 + total(rows, (r) => r.tax)));
});

test('once money is in, the discount and the tax stay; the receipt and the collections say how much was tax', async () => {
  const { staff, u1 } = await tower();
  const bk = await createBooking(sara(u1.id, { discount_type: 'percent', discount_value: 10, tax_percent: 5 }), staff);
  const [sep] = await bookingPayments(bk.id, AT);
  const pay = await recordPayment(sep.id, { amount: 2126.25, method: 'cash', received_on: '2026-10-05' }, staff, AT);

  await assert.rejects(updateBooking(bk.id, { tax_percent: '' }, staff), /Payments are recorded/);
  await assert.rejects(updateBooking(bk.id, { discount_type: 'percent', discount_value: 5 }, staff), /Payments are recorded/);
  await updateBooking(bk.id, { notes: 'Called', tax_percent: 5, discount_type: 'percent', discount_value: 10 }, staff); // the same terms again change nothing

  const slip = await receiptRow(pay.id);
  assert.deepEqual([Number(slip.tax), Number(slip.tax_percent), Number(slip.due_amount)], [202.5, 5, 4252.5]);
  if (await import('pdf-lib').catch(() => null)) assert.equal((await renderReceipt(slip)).bytes.subarray(0, 5).toString(), '%PDF-');

  const got = await report('collections', { from: '2026-10-01', to: AT }, AT);
  assert.deepEqual([got.rows[0].amount, got.rows[0].tax], [2126.25, 101.25], 'half of the payment due is half of its tax');
  assert.equal(got.summary.find((s) => s.label === 'VAT collected').value, 101.25);
  assert.ok(got.columns.some((c) => c.key === 'tax'));

  const next = await renewBooking(bk.id, staff);
  assert.deepEqual([next.tax_percent, next.discount_type, next.discount_value], [5, null, null], 'a renewal keeps the tax; a discount is agreed again');
});

test('collections without any tax say nothing about it', async () => {
  const { staff, u1 } = await tower();
  const bk = await createBooking(sara(u1.id), staff);
  const [sep] = await bookingPayments(bk.id, AT);
  await recordPayment(sep.id, { amount: 4500, method: 'cash', received_on: '2026-10-05' }, staff, AT);
  const got = await report('collections', { from: '2026-10-01', to: AT }, AT);
  assert.deepEqual([got.columns.some((c) => c.key === 'tax'), got.summary.some((s) => /collected$/.test(s.label) && s.label !== 'Collected')], [false, false]);
});

test('the usual tax and what it is called are part of the region', async () => {
  await reset();
  assert.deepEqual([region().tax_percent, region().tax_name], [5, 'VAT']);
  try {
    await assert.rejects(saveRegion({ tax_percent: 150 }), /from 0 to 100/);
    await assert.rejects(saveRegion({ tax_name: ' ' }), /what the tax is called/);
    const r = await saveRegion({ tax_percent: '8.25', tax_name: 'Sales tax' });
    assert.deepEqual([r.tax_percent, r.tax_name], [8.25, 'Sales tax']);
    assert.equal((await saveRegion({ tax_percent: '' })).tax_percent, 0, 'left empty: bookings start with no tax');
  } finally {
    await saveRegion({ tax_percent: 5, tax_name: 'VAT' }); // the setting is kept in memory: put it back for the tests that follow
  }
});

test('the import sheet and Riley can both set a discount and the tax', async () => {
  const { staff, c } = await tower();
  const row = { company: 'ace', building: 'Tower', unit_no: '201', tenant_name: 'Omar', phone: '0501112222', start_date: '2026-09-01', end_date: '2026-10-31', rent_amount: '4,000', discount: '10%', tax_percent: '5' };
  const done = await importBookings([row, { ...row, unit_no: '202', discount: '500', tax_percent: '' }], { commit: true, by: staff, today: AT });
  assert.deepEqual([done.imported, done.failed], [true, 0], JSON.stringify(done.results));
  const [a, b] = (await listBookings({ company_id: c.id })).sort((x, y) => x.id - y.id);
  assert.deepEqual([a.discount_type, a.discount_value, a.tax_percent, b.discount_type, b.discount_value, b.tax_percent], ['percent', 10, 5, 'amount', 500, null]);
  assert.deepEqual((await lines(a.id))[0], ['Rent', 3780, 180]);

  const boss = await makeUser('Boss');
  const kit = leasingKit({ id: boss, role: 'master' });
  const ask = (name, input) => kit.run({ id: 't', name, input });
  const made = await ask('leasing_add_booking', { building: 'Tower', unit_no: '101', tenant: 'Omar', start_date: '2026-11-01', end_date: '2026-12-31', rent_amount: 4500,
    discount_percent: 10, discount_note: 'Second unit', tax_percent: 5, confirm: true });
  assert.ok(!made.is_error, made.content);
  assert.match(made.content, /AED 4,500 per month, paid monthly, discount 10% \(Second unit\), VAT 5%\.\nPayment schedule: 2 payments, AED 8,505 in all/);
  const changed = await ask('leasing_change_booking', { booking: made.content.match(/LS-\d+-\d+/)[0], discount_amount: 500, tax_percent: 0 });
  assert.ok(!changed.is_error, changed.content);
  assert.match(changed.content, /discount AED 500 \(Second unit\); VAT none\.\nPayment schedule: 2 payments, AED 8,000 in all/);
});
