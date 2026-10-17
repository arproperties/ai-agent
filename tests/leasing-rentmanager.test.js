import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { addTenant, createBooking, getBooking, updateBooking, bookingPayments, payBooking, recordPayment, addCharge, removeCharge, ledger,
  addBookingDoc, bookingDocs, applyLateFees, depositState } from '../server/leasing.js';
import { saveSettings } from '../server/leasingAlerts.js';

test.after(() => closeDb());

// GSL 101 as Rent Manager has it (screenshots of 2026-10-17): James Dickerson, lease signed and started
// 08/11/2026, moved in 08/17, ends 01/31/2027. A full month's rent at the start, the part month
// ($804, typed as Rent Manager charged it) on 09/01, then $1,100 on each 1st. Water/trash $48 a month,
// a $50 application fee and a $99 deposit at the start. Balance due on 10/17: $1,360.00.
const AT = '2026-10-17';

async function gsl101() {
  await reset();
  const staff = await makeUser('Diana');
  const c = await create('company', { name: 'J&R' });
  const bl = await create('building', { name: 'The Gates at Sour Lake' }, c.id);
  const u = await create('unit', { unit_no: 'GSL 101' }, bl.id);
  const t = await addTenant({ full_name: 'James Dickerson', phone: '(205) 913-7626' });
  const bk = await createBooking({
    unit_id: u.id, tenant_id: t.id, start_date: '2026-08-11', end_date: '2027-01-31', rent_amount: 1100, rent_period: 'month',
    payment_frequency: 'monthly', prorate: 'second', part_month_amount: 804, security_deposit: 99,
    fees: [{ label: 'Application Fee', amount: 50 }, { label: 'Water/Trash PKG', amount: 48, repeats: true }],
    lease_sign_date: '2026-08-11', move_in_date: '2026-08-17', leasing_agent: 'Diana Gomez', status: 'confirmed',
  }, staff);
  return { staff, u, t, bk };
}

test('the General tab: lease sign, move-in, notice and expected move-out dates, the leasing agent and the five ticks', async () => {
  const { staff, bk } = await gsl101();
  const b = await getBooking(bk.id);
  assert.deepEqual([b.lease_sign_date, b.start_date, b.move_in_date, b.end_date, b.leasing_agent], ['2026-08-11', '2026-08-11', '2026-08-17', '2027-01-31', 'Diana Gomez']);
  assert.deepEqual([b.notice_date, b.expected_move_out], [null, null]);
  assert.deepEqual([b.no_late_fees, b.no_checks, b.no_partial_payments, b.no_payments, b.no_twa], [false, false, false, false, false]);

  const now = await updateBooking(bk.id, { notice_date: '2026-10-06', expected_move_out: '2026-11-30', no_checks: true, no_twa: true }, staff);
  assert.deepEqual([now.notice_date, now.expected_move_out, now.no_checks, now.no_twa], ['2026-10-06', '2026-11-30', true, true]);
  // Emptied, a date goes back to none.
  assert.equal((await updateBooking(bk.id, { notice_date: '' }, staff)).notice_date, null);
  await assert.rejects(updateBooking(bk.id, { move_in_date: '17/08/2026' }, staff), /Move-in date is not a date/);
  // These change nothing about the money, so they can be changed after payments too.
  await payBooking(bk.id, { amount: 100, method: 'money_order', received_on: '2026-08-12' }, staff, AT);
  assert.equal((await updateBooking(bk.id, { leasing_agent: 'Elena' }, staff)).leasing_agent, 'Elena');
});

test('the part month is the amount typed, as Rent Manager charged it', async () => {
  const { bk } = await gsl101();
  const rent = (await bookingPayments(bk.id, AT)).filter((r) => r.kind === 'rent').map((r) => [r.due_date, r.amount]);
  assert.deepEqual(rent.slice(0, 3), [['2026-08-11', 1100], ['2026-09-01', 804], ['2026-10-01', 1100]]);
  assert.equal((await getBooking(bk.id)).part_month_amount, 804);
});

test('a charge on any date: added to a running lease, owed like the rest, taken off again while unpaid', async () => {
  const { staff, bk } = await gsl101();
  const key = await addCharge(bk.id, { label: 'Mail Box Key Deposit', due_date: '2026-09-04', amount: 28 }, staff);
  await addCharge(bk.id, { label: 'Late Charge', due_date: '2026-10-06', amount: 50 }, staff);
  await addCharge(bk.id, { label: 'Late Charge', due_date: '2026-10-12', amount: 30 }, staff);
  await addCharge(bk.id, { label: 'Court Cost', due_date: '2026-10-15', amount: 204 }, staff);
  await assert.rejects(addCharge(bk.id, { label: '', due_date: '2026-10-15', amount: 5 }, staff), /Give the charge a name/);
  await assert.rejects(addCharge(bk.id, { label: 'X', due_date: '2026-10-15', amount: 0 }, staff), /amount above zero/);
  await assert.rejects(addCharge(bk.id, { label: 'X', due_date: 'soon', amount: 5 }, staff), /date/);
  await assert.rejects(addCharge(bk.id, { label: 'Court Cost', due_date: '2026-10-15', amount: 9 }, staff), /already/);

  const rows = await bookingPayments(bk.id, AT);
  assert.deepEqual(rows.filter((r) => r.kind === 'charge').map((r) => [r.name, r.due_date, r.amount, r.status]),
    [['Mail Box Key Deposit', '2026-09-04', 28, 'overdue'], ['Late Charge', '2026-10-06', 50, 'overdue'], ['Late Charge', '2026-10-12', 30, 'overdue'], ['Court Cost', '2026-10-15', 204, 'overdue']]);

  // Changing the lease rebuilds its schedule; the charges added by hand stay.
  await updateBooking(bk.id, { end_date: '2027-02-28' }, staff);
  assert.equal((await bookingPayments(bk.id, AT)).filter((r) => r.kind === 'charge').length, 4);

  await removeCharge(key.id, staff);
  assert.equal((await bookingPayments(bk.id, AT)).filter((r) => r.kind === 'charge').length, 3);
  // Once money is against it, it stays.
  const court = (await bookingPayments(bk.id, AT)).find((r) => r.name === 'Court Cost');
  await recordPayment(court.id, { amount: 4, method: 'cash', received_on: AT }, staff, AT);
  await assert.rejects(removeCharge(court.id, staff), /payment/);
  // Only a charge added by hand can be taken off this way.
  const rent = (await bookingPayments(bk.id, AT)).find((r) => r.kind === 'rent');
  await assert.rejects(removeCharge(rent.id, staff), /Only a charge added by hand/);
});

test('money orders and online card payments', async () => {
  const { staff, bk } = await gsl101();
  await payBooking(bk.id, { amount: 100, method: 'money_order', reference: 'AC MO 19-839593601', received_on: '2026-08-12' }, staff, AT);
  await payBooking(bk.id, { amount: 197, method: 'online', reference: 'ePay VISA', received_on: '2026-08-17' }, staff, AT);
  await assert.rejects(payBooking(bk.id, { amount: 5, method: 'bitcoin' }, staff, AT), /Choose how it was paid/);
});

test('GSL 101 entered by hand: the transactions list ends at Rent Manager\'s balance', async () => {
  const { staff, bk } = await gsl101();
  await addCharge(bk.id, { label: 'Mail Box Key Deposit', due_date: '2026-09-04', amount: 28 }, staff);
  await addCharge(bk.id, { label: 'Late Charge', due_date: '2026-10-06', amount: 50 }, staff);
  await addCharge(bk.id, { label: 'Late Charge', due_date: '2026-10-12', amount: 30 }, staff);
  await addCharge(bk.id, { label: 'Court Cost', due_date: '2026-10-15', amount: 204 }, staff);
  await payBooking(bk.id, { amount: 100, method: 'money_order', reference: 'AC MO 19-839593601', received_on: '2026-08-12' }, staff, AT);
  await payBooking(bk.id, { amount: 1000, method: 'money_order', reference: 'AC MO 19-839593600', received_on: '2026-08-12' }, staff, AT);
  await payBooking(bk.id, { amount: 197, method: 'online', reference: 'ePay VISA', received_on: '2026-08-17' }, staff, AT);
  await payBooking(bk.id, { amount: 852, method: 'online', reference: 'Web Pay VISA', received_on: '2026-09-04' }, staff, AT);
  await payBooking(bk.id, { amount: 100, method: 'online', reference: 'Web Pay VISA', received_on: '2026-09-28' }, staff, AT);

  const l = await ledger(bk.id, AT);
  // One line per charge posted by today and one per payment as it was received (not one per row it paid).
  assert.deepEqual(l.rows.map((r) => [r.date, r.description, r.amount]), [
    ['2026-08-11', 'Security deposit', 99],
    ['2026-08-11', 'Application Fee', 50],
    ['2026-08-11', 'Water/Trash PKG', 48],
    ['2026-08-11', 'Rent', 1100],
    ['2026-08-12', 'Payment · Money order · AC MO 19-839593601', -100],
    ['2026-08-12', 'Payment · Money order · AC MO 19-839593600', -1000],
    ['2026-08-17', 'Payment · Online card · ePay VISA', -197],
    ['2026-09-01', 'Water/Trash PKG', 48],
    ['2026-09-01', 'Rent', 804],
    ['2026-09-04', 'Mail Box Key Deposit', 28],
    ['2026-09-04', 'Payment · Online card · Web Pay VISA', -852],
    ['2026-09-28', 'Payment · Online card · Web Pay VISA', -100],
    ['2026-10-01', 'Water/Trash PKG', 48],
    ['2026-10-01', 'Rent', 1100],
    ['2026-10-06', 'Late Charge', 50],
    ['2026-10-12', 'Late Charge', 30],
    ['2026-10-15', 'Court Cost', 204],
  ]);
  assert.equal(l.rows[3].balance, 1297);
  assert.equal(l.rows[6].balance, 0);
  // Rent Manager's balance due, to the cent: the water is billed in full on the part month too.
  assert.equal(l.balance, 1360);
  assert.equal(l.rows.at(-1).balance, l.balance);
  // What is still open, as on Rent Manager's Payments tab: money goes on the rent first on its day.
  assert.deepEqual((await bookingPayments(bk.id, AT)).filter((r) => r.left > 0 && r.due_date <= AT).map((r) => [r.due_date, r.name, r.paid, r.left]), [
    ['2026-10-01', 'Water/Trash PKG', 0, 48], ['2026-10-01', 'Rent', 72, 1028],
    ['2026-10-06', 'Late Charge', 0, 50], ['2026-10-12', 'Late Charge', 0, 30], ['2026-10-15', 'Court Cost', 0, 204],
  ]);
});

test('the ticks: no late fees, no payments, no part payments', async () => {
  const { staff, bk } = await gsl101();
  await saveSettings({ latefee: { on: true, days: 5, amount: 50 } }, '2026-08-01');
  await updateBooking(bk.id, { no_late_fees: true }, staff);
  await applyLateFees(AT);
  assert.equal((await bookingPayments(bk.id, AT)).filter((r) => r.kind === 'late').length, 0);
  await updateBooking(bk.id, { no_late_fees: false }, staff);
  await applyLateFees(AT);
  assert.ok((await bookingPayments(bk.id, AT)).filter((r) => r.kind === 'late').length > 0);

  await updateBooking(bk.id, { no_payments: true }, staff);
  await assert.rejects(payBooking(bk.id, { amount: 10, method: 'cash', received_on: AT }, staff, AT), /not to take payments/);
  const first = (await bookingPayments(bk.id, AT))[0];
  await assert.rejects(recordPayment(first.id, { amount: 10, method: 'cash', received_on: AT }, staff, AT), /not to take payments/);

  await updateBooking(bk.id, { no_payments: false, no_partial_payments: true }, staff);
  // What is due by the day it was received has to be paid in full: on 08/11, 50 + 99 + 48 + 1,100.
  await assert.rejects(payBooking(bk.id, { amount: 100, method: 'cash', received_on: '2026-08-11' }, staff, AT), /in full.*1,297/);
  await payBooking(bk.id, { amount: 1297, method: 'cash', received_on: '2026-08-11' }, staff, AT);
  const sep = (await bookingPayments(bk.id, AT)).find((r) => r.kind === 'rent' && r.due_date === '2026-09-01');
  await assert.rejects(recordPayment(sep.id, { amount: 10, method: 'cash', received_on: AT }, staff, AT), /in full/);
});

// GSL 102 as Rent Manager has it: the deposit was charged and paid on 10/11/24, three weeks before the lease started on 11/01/24.
test('the deposit is charged on its own date when it was not the lease start, and moves without doubling once paid', async () => {
  const { staff, u, t } = await gsl101();
  const bk = await createBooking({
    unit_id: u.id, tenant_id: t.id, start_date: '2024-11-01', end_date: '2025-10-31', rent_amount: 1075, rent_period: 'month',
    payment_frequency: 'monthly', security_deposit: 150, deposit_due: '2024-10-11', status: 'confirmed',
  }, staff);
  assert.equal(bk.deposit_due, '2024-10-11');
  const dep = async () => (await bookingPayments(bk.id, AT)).filter((r) => r.kind === 'deposit').map((r) => [r.due_date, r.amount, r.paid]);
  assert.deepEqual(await dep(), [['2024-10-11', 150, 0]]);

  await payBooking(bk.id, { amount: 150, method: 'online', reference: 'ePay VISA', received_on: '2024-10-11' }, staff, AT);
  const l = await ledger(bk.id, AT);
  assert.deepEqual(l.rows.slice(0, 2).map((r) => [r.date, r.description, r.amount, r.balance]),
    [['2024-10-11', 'Security deposit', 150, 150], ['2024-10-11', 'Payment · Online card · ePay VISA', -150, 0]]);

  // Moved after it was paid: the one deposit row moves with its payment, no second deposit is owed.
  await updateBooking(bk.id, { deposit_due: '2024-10-04' }, staff);
  assert.deepEqual(await dep(), [['2024-10-04', 150, 150]]);
  // Emptied: due on the lease start again.
  assert.equal((await updateBooking(bk.id, { deposit_due: '' }, staff)).deposit_due, null);
  assert.deepEqual(await dep(), [['2024-11-01', 150, 150]]);
  await assert.rejects(updateBooking(bk.id, { deposit_due: '11/10/2024' }, staff), /Deposit date is not a date/);
});

// GSL 103 as Rent Manager has it: a $99 deposit and a $300 non-refundable pet fee, both charged at move-in; Held: 399.00.
test('a charge held with the deposit counts in what is held, as Rent Manager counts it', async () => {
  const { staff, bk } = await gsl101();
  const pet = await addCharge(bk.id, { label: 'Pet Fee Non Refundable', due_date: '2026-08-11', amount: 300, held: true }, staff);
  assert.equal(pet.held, true);
  await addCharge(bk.id, { label: 'Court Cost', due_date: '2026-08-11', amount: 204 }, staff); // an ordinary charge is not
  assert.deepEqual(await depositState(bk.id).then((d) => [d.amount, d.held, d.status]), [399, 0, 'unpaid']);
  await payBooking(bk.id, { amount: 2000, method: 'online', received_on: '2026-08-12' }, staff, AT);
  assert.deepEqual(await depositState(bk.id).then((d) => [d.amount, d.held, d.status]), [399, 399, 'held']);
  assert.equal((await bookingPayments(bk.id, AT)).find((r) => r.id === pet.id).held, true);
});

// GSL 102 with late fees left out: the tenant paid $945 more than the lease charges, and the lease has nothing left to bill.
// Rent Manager carries that on the account as a credit (a minus balance); so does the lease.
test('money paid beyond what is owed is kept on the lease as a credit, when asked', async () => {
  const { staff, bk } = await gsl101();
  const owed = (await ledger(bk.id, '2027-12-31')).balance;
  await assert.rejects(payBooking(bk.id, { amount: owed + 945, method: 'online', received_on: '2026-10-07' }, staff, AT), /still owed/);
  const made = await payBooking(bk.id, { amount: owed + 945, method: 'online', received_on: '2026-10-07', keep_credit: true }, staff, AT);
  assert.equal(made.at(-1).amount, 945);
  const l = await ledger(bk.id, '2027-12-31');
  assert.equal(l.balance, -945);
  assert.equal(l.rows.filter((r) => r.kind === 'payment').length, 1); // one payment line, as received
  const credit = (await bookingPayments(bk.id, AT)).find((r) => r.kind === 'credit');
  assert.deepEqual([credit.name, credit.amount, credit.paid, credit.left, credit.status], ['Credit (paid ahead)', 0, 945, 0, 'paid']);
  // A rebuilt schedule keeps it.
  await updateBooking(bk.id, { notes: 'x' }, staff);
  assert.equal((await ledger(bk.id, '2027-12-31')).balance, -945);
  // Only the excess is kept: with nothing owed, the whole amount is the credit.
  await payBooking(bk.id, { amount: 5, method: 'cash', received_on: '2026-10-08', keep_credit: true }, staff, AT);
  assert.equal((await ledger(bk.id, '2027-12-31')).balance, -950);
});

test('a note or file has a category, as on Rent Manager\'s History / Notes', async () => {
  const { staff, bk } = await gsl101();
  await addBookingDoc(bk.id, { title: '101 LEASE.pdf', category: 'lease' }, null, staff);
  await addBookingDoc(bk.id, { title: '101 N.pdf', category: 'notice' }, null, staff);
  await addBookingDoc(bk.id, { title: 'Called about the AC' }, null, staff);
  await assert.rejects(addBookingDoc(bk.id, { title: 'X', category: 'gossip' }, null, staff), /category/);
  assert.deepEqual((await bookingDocs(bk.id)).map((d) => [d.title, d.category]),
    [['101 LEASE.pdf', 'lease'], ['101 N.pdf', 'notice'], ['Called about the AC', null]]);
});
