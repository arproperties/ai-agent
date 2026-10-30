import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, bookingPayments, payBooking } from '../server/leasing.js';
import { setUp, setEnabled, authenticate, sendRequestXML, receiveResponseXML } from '../server/quickbooks.js';
import { saveSettings, plan } from '../server/qbSync.js';
import { parseReport, payoutsFrom, readReport, recordReport, listPayouts, getPayout, nameKey, amountOf, dateOf } from '../server/zego.js';
import { actionFor } from '../server/actions.js';

test.after(() => closeDb());

const TODAY = '2026-10-30';

// Zego's report as it prints it: the headings once, a payout line (bank, date, total), and its
// payments under it, each cell a few short lines. The names are made up.
const HEAD = [['Bank', 35], ['Date', 85], ['Total', 144], ['Trans #', 178], ['Resident', 235], ['Property', 317], ['Unit', 370], ['Init', 401], ['Type', 435], ['Bill', 493], ['Amount', 544]];
const PAGES = [
  [
    { payout: ['#1468', '10-01-2026', '$5,700.00'] },
    { trans: ['559000001', 'Sara Lee', '09-25-2026', 'Visa', '$4,500.00'] },
    { trans: ['559000002', 'TOM BAKER', '09-26-2026', 'Bank Account', '$1,200.00'] },
  ],
  [
    { payout: ['#1468', '10-02-2026', '$1,300.00'] },
    { trans: ['559000003', 'Crystal HUD Charles', '10-01-2026', 'Visa', '$1,000.00'] },
    { trans: ['559000004', 'Annie Pryce', '10-01-2026', 'Mastercard', '$300.00'] },
  ],
];

async function reportPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const put = (page, s, x, y) => page.drawText(s, { x, y, size: 8, font });
  // A cell's text wrapped the way Zego wraps it: a date in three parts, a long name in two.
  const stack = (page, parts, x, y) => parts.forEach((s, k) => put(page, s, x, y - k * 11));
  PAGES.forEach((rows, n) => {
    const page = pdf.addPage([612, 792]);
    let y = 749;
    if (n === 0) {
      for (const [s, x] of HEAD) put(page, s, x, y);
      put(page, 'Account', 35, 738); put(page, 'Date', 401, 738); put(page, 'Type', 493, 738);
      y -= 34;
    }
    for (const r of rows) {
      if (r.payout) {
        const [bank, date, total] = r.payout;
        put(page, bank, 35, y);
        stack(page, date.match(/\d+-|\d{4}/g), 85, y);
        put(page, total, 125, y);
      } else {
        const [no, name, init, type, amount] = r.trans;
        put(page, no, 178, y);
        stack(page, name.split(' ').length > 2 ? [name.split(' ').slice(0, 2).join(' '), name.split(' ').slice(2).join(' ')] : [name], 235, y);
        stack(page, ['1001', 'Gates at', 'Sour', 'Lake'], 317, y);
        stack(page, init.match(/\d+-|\d{4}/g), 401, y);
        stack(page, type.split(' '), 435, y);
        put(page, 'Custom', 493, y);
        put(page, amount, 537, y);
      }
      y -= 55;
    }
  });
  return { buffer: Buffer.from(await pdf.save()), originalname: 'ZEGO OCT.pdf', mimetype: 'application/pdf' };
}

const csv = (text, name = 'zego.csv') => ({ buffer: Buffer.from(text), originalname: name, mimetype: 'text/csv' });

async function leases() {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'HCI' });
  const b = await create('building', { name: 'GSL' }, c.id);
  const lease = async (unit_no, full_name, extra = {}) => createBooking({
    unit_id: (await create('unit', { unit_no }, b.id)).id, start_date: '2026-09-01', end_date: '2027-08-31', rent_amount: 4500, security_deposit: 0, status: 'confirmed',
    tenant: { full_name, phone: `409 555 0${unit_no}`, email: `${unit_no}@example.com` }, ...extra,
  }, staff);
  return {
    staff,
    sara: await lease('101', 'Sara Lee'),
    tom: await lease('102', 'Tom Baker'),
    crystal: await lease('103', 'Crystal Charles'),
    ann: await lease('104', 'Ann Price'),
  };
}

const paid = async (bk) => (await bookingPayments(bk.id, TODAY)).flatMap((r) => r.payments);

test('amounts, dates and names as Zego writes them', () => {
  assert.equal(amountOf('$1,465.00'), 1465);
  assert.equal(amountOf('$347.15'), 347.15);
  assert.equal(amountOf('($20.00)'), -20);
  assert.equal(amountOf('Visa'), null);
  assert.equal(dateOf('10-01-2026'), '2026-10-01');
  assert.equal(dateOf('9/5/2026'), '2026-09-05');
  assert.equal(dateOf('02-30-2026'), null);
  assert.equal(nameKey('Lennord SEE NOTE Randall'), 'lennord randall');
  assert.equal(nameKey('Kayle Irving MTM'), 'kayle irving');
  assert.equal(nameKey('Crystal HUD Charles'), 'crystal charles');
});

test('the PDF is read column by column into payouts and their payments, across pages', async () => {
  const payouts = await parseReport(await reportPdf());
  assert.equal(payouts.length, 2);
  assert.deepEqual(payouts.map((p) => [p.bank, p.paid_on, p.total, p.warning]), [['#1468', '2026-10-01', 5700, undefined], ['#1468', '2026-10-02', 1300, undefined]]);
  assert.deepEqual(payouts[0].transactions[1], {
    trans_no: '559000002', resident: 'TOM BAKER', property: '1001 Gates at Sour Lake', unit: null, init_date: '2026-09-26', pay_type: 'Bank Account', amount: 1200,
  });
  assert.equal(payouts[1].transactions[0].resident, 'Crystal HUD Charles', 'a name wrapped over two lines is one name');
});

test('a CSV is read too: with payout lines as in the PDF, or with the payout date on each payment', async () => {
  const nested = await parseReport(csv(`Bank Account,Date,Total,Trans #,Resident,Property,Unit,Init Date,Type,Bill Type,Amount
#1468,10-01-2026,"$1,500.00",,,,,,,,
,,,559000001,Sara Lee,1001 Gates at Sour Lake,,09-25-2026,Visa,Custom,"$1,000.00"
,,,559000002,Tom Baker,1001 Gates at Sour Lake,,09-26-2026,Visa,Custom,$400.00
`));
  assert.equal(nested.length, 1);
  assert.equal(nested[0].transactions.length, 2);
  assert.match(nested[0].warning, /add up to 1400.00, not the 1500.00/);

  const flat = await parseReport(csv(`Date,Trans #,Resident,Init Date,Amount
10-01-2026,1,Sara Lee,09-25-2026,$10.00
10-02-2026,2,Tom Baker,09-26-2026,$20.00
10-01-2026,3,Ann Price,09-26-2026,$5.00
`));
  assert.deepEqual(flat.map((p) => [p.paid_on, p.total, p.transactions.length]), [['2026-10-01', 15, 2], ['2026-10-02', 20, 1]]);

  await assert.rejects(parseReport(csv('Name,Amount\nSara,1\n')), /does not look like a Zego payments report/);
  await assert.rejects(parseReport({ buffer: Buffer.from('hello'), originalname: 'x.docx', mimetype: 'application/msword' }), /PDF or a CSV/);
  assert.throws(() => payoutsFrom([{ trans: '1', resident: 'A', init: '10-01-2026', amount: '$1.00' }]), /not under a payout/);
});

test('reading matches each payment to its tenant\'s lease and changes nothing', async () => {
  const l = await leases();
  const read = await readReport(await reportPdf());
  const by = Object.fromEntries(read.payouts.flatMap((p) => p.transactions).map((t) => [t.trans_no, t]));
  assert.equal(by['559000001'].booking_id, l.sara.id);
  assert.equal(by['559000002'].booking_id, l.tom.id, 'capitals do not matter');
  assert.equal(by['559000003'].booking_id, l.crystal.id, 'HUD written into the name does not matter');
  assert.equal(by['559000004'].booking_id, null, 'a name not like any tenant\'s is left for a person');
  assert.deepEqual(by['559000004'].suggest, [], 'no word of "Annie Pryce" is in a tenant\'s name');
  assert.ok(read.leases.some((x) => x.id === l.sara.id));
  assert.equal((await paid(l.sara)).length, 0);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM zego_payouts').get()).n, 0);
});

test('a payment already typed in by hand is not ticked, and a tenant with no lease yet is told apart from an unknown name', async () => {
  const l = await leases();
  await payBooking(l.sara.id, { amount: 4500, method: 'card', received_on: '2026-09-27' }, l.staff, TODAY);
  await db.prepare("INSERT INTO lease_tenants (full_name) VALUES ('Annie Pryce')").run();
  const read = await readReport(await reportPdf());
  const by = Object.fromEntries(read.payouts.flatMap((p) => p.transactions).map((t) => [t.trans_no, t]));
  assert.equal(by['559000001'].booking_id, null);
  assert.deepEqual(by['559000001'].suggest, [l.sara.id]);
  assert.deepEqual(by['559000001'].duplicate, { received_on: '2026-09-27', amount: 4500, method: 'card' });
  assert.equal(by['559000004'].no_lease, 'Annie Pryce');
  const out = await recordReport({ token: read.token }, l.staff.id, TODAY);
  assert.deepEqual([out.recorded, out.skipped], [2, 2], 'left alone unless a person ticks it');
  assert.equal((await paid(l.sara)).length, 1);
});

test('recording puts each payment on its lease as Zego, once; a name picked by hand is remembered', async () => {
  const l = await leases();
  const { token } = await readReport(await reportPdf());
  const out = await recordReport({ token, picks: { 559000004: l.ann.id } }, l.staff.id, TODAY);
  assert.deepEqual(out, { recorded: 4, already: 0, skipped: 0, failed: [] });

  const [p] = await paid(l.sara);
  assert.equal(p.amount, 4500);
  assert.equal(p.method, 'zego');
  assert.equal(p.received_on, '2026-09-25', 'on the day the tenant paid');
  assert.equal(p.reference, 'Zego 559000001');
  assert.equal((await paid(l.ann))[0].amount, 300);

  // The same report again: nothing twice.
  const again = await readReport(await reportPdf());
  assert.ok(again.payouts.every((x) => x.transactions.every((t) => t.recorded)));
  assert.deepEqual(await recordReport({ token: again.token }, l.staff.id, TODAY), { recorded: 0, already: 4, skipped: 0, failed: [] });
  assert.equal((await paid(l.sara)).length, 1);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM zego_payouts').get()).n, 2);

  // Next month the same name is matched by itself.
  const next = await readReport(csv(`Bank Account,Date,Total,Trans #,Resident,Init Date,Amount
#1468,11-02-2026,$300.00,,,,
,,,560000009,Annie Pryce,10-30-2026,$300.00
`));
  const t = next.payouts[0].transactions[0];
  assert.deepEqual([t.booking_id, t.how], [l.ann.id, 'remembered']);

  const list = await listPayouts();
  assert.deepEqual(list.map((x) => [x.paid_on, x.total, x.payments, x.on_leases]), [['2026-10-02', 1300, 2, 2], ['2026-10-01', 5700, 2, 2]]);
  const one = await getPayout(list[1].id);
  assert.deepEqual(one.transactions.map((x) => [x.trans_no, x.tenant, x.unit_no]), [['559000001', 'Sara Lee', '101'], ['559000002', 'Tom Baker', '102']]);
});

test('a payment left off, or refused by its lease, waits on no lease and can be recorded later', async () => {
  const l = await leases();
  await db.prepare('UPDATE lease_bookings SET no_payments = true WHERE id = ?').run(l.tom.id);
  const { token } = await readReport(await reportPdf());
  const out = await recordReport({ token, picks: { 559000004: null } }, l.staff.id, TODAY);
  assert.equal(out.recorded, 2);
  assert.equal(out.skipped, 1);
  assert.deepEqual(out.failed.map((f) => f.trans_no), ['559000002']);
  assert.match(out.failed[0].error, /not to take payments/);
  assert.equal((await paid(l.tom)).length, 0);

  // Later: the lease takes payments again, and Annie is picked.
  await db.prepare('UPDATE lease_bookings SET no_payments = false WHERE id = ?').run(l.tom.id);
  const again = await readReport(await reportPdf());
  assert.deepEqual(await recordReport({ token: again.token, picks: { 559000004: l.ann.id } }, l.staff.id, TODAY), { recorded: 2, already: 2, skipped: 0, failed: [] });
  assert.equal((await paid(l.tom))[0].amount, 1200);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM zego_payouts').get()).n, 2, 'the same payouts, not new ones');

  await assert.rejects(recordReport({ token: 'nope' }, l.staff.id, TODAY), /Upload the report again/);
});

test('each payout goes to QuickBooks as one deposit on its day for its whole total; its payments are not in the day\'s own deposit', async () => {
  const l = await leases();
  await db.prepare("INSERT INTO qb_lists (kind, list_id, name, full_name, type) VALUES ('Account', 'B1', 'HCI - 1468', 'HCI - 1468', 'Bank'), ('Account', 'I1', 'Rental Income', 'Rental Income', 'Income')").run();
  const { password } = await setUp();
  await setEnabled(true);
  await saveSettings({ start_date: '2026-09-01', bank_account: 'B1', rent_account: 'I1' });
  const { token } = await readReport(await reportPdf());
  await recordReport({ token, picks: { 559000004: null } }, l.staff.id, TODAY);

  assert.equal(await plan(TODAY), 2, 'two payouts, and no day deposits for their payments');
  const [ticket] = await authenticate('leaseapp', password);
  const sent = [await sendRequestXML(ticket, 'x.qbw')];
  const ok = (id) => `<?xml version="1.0" ?>\n<QBXML><QBXMLMsgsRs><DepositAddRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK"><DepositRet><TxnID>${id}</TxnID><EditSequence>1</EditSequence></DepositRet></DepositAddRs></QBXMLMsgsRs></QBXML>`;
  await receiveResponseXML(ticket, ok('T1'), '', '');
  sent.push(await sendRequestXML(ticket, 'x.qbw'));
  await receiveResponseXML(ticket, ok('T2'), '', '');
  const first = sent.find((x) => x.includes('<TxnDate>2026-10-01</TxnDate>'));
  const second = sent.find((x) => x.includes('<TxnDate>2026-10-02</TxnDate>'));
  assert.match(first, /<Memo>Lease app: Zego payout 2026-10-01, 2 payments<\/Memo>/);
  assert.match(first, /<Memo>Rent<\/Memo><Amount>5700.00<\/Amount>/);
  assert.match(second, /<Memo>Rent, Zego, not on a lease<\/Memo><Amount>1300.00<\/Amount>/, 'Annie, on no lease, is still in what the bank got');
  assert.equal(await plan(TODAY), 0);
});

test('reading the report is not an add; recording is', () => {
  assert.equal(actionFor('POST', '/accounts/zego/read'), null);
  assert.equal(actionFor('POST', '/accounts/zego/record'), 'add');
});
