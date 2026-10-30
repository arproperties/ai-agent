import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reset, closeDb, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, bookingPayments } from '../server/leasing.js';
import * as names from '../server/chargeNames.js'; // the form imports these

test.after(() => closeDb());

// The lease form's summary (client plan(), fromLines()) is worked out apart from the server's schedule:
// both read from the same lines here must come to the same money, row for row, as the Payments → Schedule tab shows it.
const src = readFileSync(new URL('../client/src/components/Leasing.jsx', import.meta.url), 'utf8');
const pick = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const client = new Function(...Object.keys(names), `${pick('const STEP =', '/** Two or three choices')}; return { plan, chargeLines, fromLines };`)(...Object.values(names));

// Bethany's lease: 30 Sep 2022 to 30 Sep 2023, Tenant 3 + HUD 828, a water charge and a deposit.
const BASE = [
  { label: 'Rent', amount: '3', repeats: true },
  { label: 'Rent – HUD/Agency', amount: '828', repeats: true },
  { label: 'Water/Trash PKG', amount: '40', repeats: true },
  { label: 'Security deposit', amount: '150', on: '2022-09-28' },
];
const CASES = {
  'HUD split, prorated from the first month': { fees: BASE, prorate: 'first' },
  'HUD split, prorated from the second month': { fees: BASE, prorate: 'second' },
  'HUD changes on 1 March': {
    prorate: 'first',
    fees: [
      { label: 'Rent', amount: '3', repeats: true, until: '2023-02-28' },
      { label: 'Rent – HUD/Agency', amount: '828', repeats: true, until: '2023-02-28' },
      { label: 'Rent', amount: '50', repeats: true, from: '2023-03-01' },
      { label: 'Rent – HUD/Agency', amount: '781', repeats: true, from: '2023-03-01' },
      ...BASE.slice(2),
    ],
  },
  'one rent, starting on the 1st, a one-time charge later': {
    start_date: '2022-10-01', end_date: '2023-09-30', prorate: 'first',
    fees: [{ label: 'Rent', amount: '900', repeats: true }, { label: 'Pet fee', amount: '200', on: '2022-11-15' }],
  },
};

for (const [name, c] of Object.entries(CASES)) {
  test(`form summary = Schedule tab: ${name}`, async () => {
    await reset();
    const staff = await makeUser('Staff');
    const co = await create('company', { name: 'ACE' });
    const bl = await create('building', { name: 'Gates' }, co.id);
    const u = await create('unit', { unit_no: '304' }, bl.id);
    const v = { start_date: '2022-09-30', end_date: '2023-09-30', rent_period: 'month', payment_frequency: 'monthly', discounts: [], tax_percent: '', part_month_amount: '', ...c };
    const lease = client.fromLines(v);
    const sum = client.plan(lease);
    const bk = await createBooking({ ...lease, unit_id: u.id, status: 'confirmed', tenant: { full_name: 'Bethany', phone: '050 123 4567' } }, staff);
    const rows = await bookingPayments(bk.id, v.start_date);
    const money = (list) => Math.round(list.reduce((t, r) => t + r.amount, 0) * 100) / 100;
    const r2 = (n) => Math.round(n * 100) / 100;
    const notDeposit = rows.filter((r) => r.kind !== 'deposit');
    assert.equal(money(notDeposit), r2(sum.total), 'whole stay');
    assert.equal(money(rows.filter((r) => r.due_date <= v.start_date)), r2(sum.first), 'to collect on the first day (a deposit charged before it too)');
    assert.equal(money(rows.filter((r) => r.kind === 'deposit')), sum.deposit, 'deposit');
    if (sum.second) assert.equal(money(rows.filter((r) => r.kind === 'rent' && r.due_date === sum.second.due)), r2(sum.second.amount), 'prorated rent on the next 1st');
    // The form opened again shows the lines it was saved with.
    const back = client.chargeLines(bk).map((f) => [f.label, Number(f.amount), f.from || f.on || '', f.until || '']);
    const typed = c.fees.map((f) => [f.label, Number(f.amount), f.from || f.on || '', f.until || '']);
    assert.deepEqual(back.sort(), typed.sort(), 'reopened');
  });
}
