import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, payBooking, removePayment, bookingPayments, settleDeposit } from '../server/leasing.js';
import { setUp, setEnabled, authenticate, sendRequestXML, receiveResponseXML, retryFailed, status } from '../server/quickbooks.js';
import { saveSettings, plan, syncStates } from '../server/qbSync.js';
import { createExpense, updateExpense, removeExpense, getExpense, listExpenses, choices, createRepeat, runRepeats, listRepeats, receiptFrom, readReceipt, useAsk } from '../server/expenses.js';

test.after(() => closeDb());

const FILE = 'D:\\Francis\\qb-test\\HCI-TEST.qbw';
const answer = (rs) => `<?xml version="1.0" ?>\n<QBXML><QBXMLMsgsRs>${rs}</QBXMLMsgsRs></QBXML>`;
const made = (type, txnId, seq, how = 'Add') => answer(`<${type}${how}Rs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK"><${type}Ret><TxnID>${txnId}</TxnID><EditSequence>${seq}</EditSequence></${type}Ret></${type}${how}Rs>`);
const gone = (type, txnId) => answer(`<TxnDelRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK"><TxnDelType>${type}</TxnDelType><TxnID>${txnId}</TxnID></TxnDelRs>`);
const failed = (name, code, msg) => answer(`<${name}Rs requestID="1" statusCode="${code}" statusSeverity="Error" statusMessage="${msg}" />`);

// QuickBooks' lists as the company file has them: one bank, a card, income, a deposits liability, expenses, a vendor.
const LISTS = [
  ['Account', 'B1', 'HCI - 1468', 'Bank'], ['Account', 'C1', 'XALLE-CC-1518', 'CreditCard'], ['Account', 'I1', 'Rental Income', 'Income'],
  ['Account', 'I2', 'Security Deposit', 'Income'], ['Account', 'L1', 'Tenant Security Deposits Held', 'OtherCurrentLiability'],
  ['Account', 'E1', 'Utilities:Electric', 'Expense'], ['Account', 'E2', 'Material:Plumbing', 'Expense'], ['Account', 'AR', 'Accounts Receivable', 'AccountsReceivable'],
  ['Vendor', 'V1', 'Entergy', null],
];

let password;
async function books() {
  await reset();
  for (const [kind, id, name, type] of LISTS) await db.prepare('INSERT INTO qb_lists (kind, list_id, name, full_name, type) VALUES (?, ?, ?, ?, ?)').run(kind, id, name.split(':').pop(), name, type);
  ({ password } = await setUp());
  await setEnabled(true);
  await db.prepare('UPDATE qb_connection SET company_file = ? WHERE id = 1').run(FILE);
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'HCI' });
  const b = await create('building', { name: 'GSL' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  const bk = await createBooking({ unit_id: u.id, start_date: '2026-09-15', end_date: '2027-09-14', rent_amount: 4500, security_deposit: 5000, status: 'confirmed',
    tenant: { full_name: 'Sara Lee', phone: '409 555 0101', email: 'sara@example.com' } }, staff);
  return { staff, bk, building: b, unit: u };
}

/** One Web Connector run, a request at a time. */
async function run() {
  const [ticket, file] = await authenticate('leaseapp', password);
  return {
    file,
    next: () => sendRequestXML(ticket, FILE),
    reply: (xml) => receiveResponseXML(ticket, xml, '', ''),
  };
}

test('nothing is sent until the start date and the accounts are chosen', async () => {
  const { staff, bk } = await books();
  await payBooking(bk.id, { amount: 4500, method: 'transfer', received_on: '2026-10-08' }, staff, '2026-10-10');
  assert.equal(await plan(), 0);
  await assert.rejects(saveSettings({ bank_account: 'I1' }), /not a bank account/);
  await assert.rejects(saveSettings({ rent_account: 'ZZ' }), /not in QuickBooks' list/);
  await assert.rejects(saveSettings({ start_date: 'soon' }), /not a date/);
  await saveSettings({ start_date: '2026-10-09', bank_account: 'B1', rent_account: 'I1' });
  assert.equal(await plan(), 0, 'a day before the start date is the bookkeeper\'s, already in QuickBooks');
});

test('a day\'s rent and charges go as one bank deposit, a line per account; changes follow it, and an emptied day is taken out', async () => {
  const { staff, bk } = await books();
  await saveSettings({ start_date: '2026-10-01', bank_account: 'B1', rent_account: 'I1', deposit_account: 'L1' });
  await payBooking(bk.id, { amount: 12000, method: 'transfer', received_on: '2026-10-08' }, staff, '2026-10-10'); // 5,000 deposit, 4,500 + 2,500 rent

  let r = await run();
  let rq = await r.next();
  assert.match(rq, /<DepositAddRq requestID="\d+"><DepositAdd><TxnDate>2026-10-08<\/TxnDate><DepositToAccountRef><ListID>B1<\/ListID><\/DepositToAccountRef><Memo>Lease app: rent and charges received 2026-10-08<\/Memo>/);
  assert.match(rq, /<DepositLineAdd><AccountRef><ListID>I1<\/ListID><\/AccountRef><Memo>Rent<\/Memo><Amount>7000.00<\/Amount><\/DepositLineAdd><DepositLineAdd><AccountRef><ListID>L1<\/ListID><\/AccountRef><Memo>Security deposits<\/Memo><Amount>5000.00<\/Amount><\/DepositLineAdd>/);
  assert.equal(await r.reply(made('Deposit', 'T1', '100')), 100);
  assert.deepEqual(await syncStates(['deposit:2026-10-08']), { 'deposit:2026-10-08': { state: 'sent' } });
  assert.equal(await plan(), 0, 'sent as it is: nothing more to do');

  // A payment taken off: the same deposit is changed, not a second one made.
  const second = (await bookingPayments(bk.id, '2026-10-10')).flatMap((x) => x.payments).find((p) => p.amount === 2500);
  await removePayment(second.id, staff);
  r = await run();
  rq = await r.next();
  assert.match(rq, /<DepositModRq requestID="\d+"><DepositMod><TxnID>T1<\/TxnID><EditSequence>100<\/EditSequence>/);
  assert.match(rq, /<DepositLineMod><TxnLineID>-1<\/TxnLineID><AccountRef><ListID>I1<\/ListID><\/AccountRef><Memo>Rent<\/Memo><Amount>4500.00<\/Amount><\/DepositLineMod>/);
  await r.reply(made('Deposit', 'T1', '101', 'Mod'));
  assert.equal((await db.prepare("SELECT edit_seq FROM qb_sync WHERE key = 'deposit:2026-10-08'").get()).edit_seq, '101');

  // Every payment of the day gone: the deposit is taken out of QuickBooks.
  for (const p of (await bookingPayments(bk.id, '2026-10-10')).flatMap((x) => x.payments)) await removePayment(p.id, staff);
  r = await run();
  assert.match(await r.next(), /<TxnDelRq requestID="\d+"><TxnDelType>Deposit<\/TxnDelType><TxnID>T1<\/TxnID><\/TxnDelRq>/);
  await r.reply(gone('Deposit', 'T1'));
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM qb_sync').get()).n, 0);
  assert.deepEqual((await status()).queue.failed, 0);
});

test('today\'s rent waits for the day to end, so it goes whole', async () => {
  const { staff, bk } = await books();
  await saveSettings({ start_date: '2026-10-01', bank_account: 'B1', rent_account: 'I1' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  await db.prepare("INSERT INTO lease_payments (installment_id, amount, method, received_on) SELECT id, 100, 'cash', ? FROM lease_installments WHERE booking_id = ? AND kind = 'rent' LIMIT 1").run(today, bk.id);
  await db.prepare("INSERT INTO lease_payments (installment_id, amount, method, received_on) SELECT id, 100, 'cash', ? FROM lease_installments WHERE booking_id = ? AND kind = 'rent' LIMIT 1").run(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), bk.id);
  assert.equal(await plan(), 0);
});

test('a deposit given back is a check from the bank, and what was kept moves from the liability to income', async () => {
  const { staff, bk } = await books();
  await saveSettings({ start_date: '2026-10-01', bank_account: 'B1', rent_account: 'I1', deposit_account: 'L1', kept_account: 'I2' });
  await payBooking(bk.id, { amount: 5000, method: 'transfer', received_on: '2026-09-20' }, staff, '2026-10-10'); // before the start date
  await settleDeposit(bk.id, { refunded: 4000, note: 'Cleaning and a broken blind' }, staff, '2026-10-12');

  const r = await run();
  const one = await r.next();
  await r.reply(/CheckAdd/.test(one) ? made('Check', 'C9', '1') : made('JournalEntry', 'J9', '1'));
  const two = await r.next();
  await r.reply(/CheckAdd/.test(two) ? made('Check', 'C9', '1') : made('JournalEntry', 'J9', '1'));
  const check = [one, two].find((x) => /CheckAdd/.test(x));
  const journal = [one, two].find((x) => /JournalEntryAdd/.test(x));
  assert.match(check, /<CheckAdd><AccountRef><ListID>B1<\/ListID><\/AccountRef><TxnDate>2026-10-12<\/TxnDate><Memo>Lease app: security deposit refund, LS-2026-0001, Sara Lee<\/Memo><ExpenseLineAdd><AccountRef><ListID>L1<\/ListID><\/AccountRef><Amount>4000.00<\/Amount>/);
  assert.match(journal, /<JournalDebitLine><AccountRef><ListID>L1<\/ListID><\/AccountRef><Amount>1000.00<\/Amount>.*<JournalCreditLine><AccountRef><ListID>I2<\/ListID><\/AccountRef><Amount>1000.00<\/Amount>/);

  // Booked as income, a deposit kept needs no moving.
  await saveSettings({ deposit_account: 'I2' });
  assert.equal(await plan(), 2, 'the refund changes account, and the journal entry is taken out');
});

test('an expense goes as a check to its vendor; a new vendor is made first; a card payment is a card charge; edits and deletes follow', async () => {
  const { staff, building } = await books();
  await saveSettings({ start_date: '2026-10-01', bank_account: 'B1', rent_account: 'I1' });
  await assert.rejects(createExpense({ paid_on: '2026-10-09', vendor_name: 'X', pay_from: 'I1', lines: [{ account_list_id: 'E1', amount: 5 }] }, null, staff), /bank account or card/);
  await assert.rejects(createExpense({ paid_on: '2026-10-09', vendor_name: 'X', pay_from: 'B1', lines: [{ account_list_id: 'AR', amount: 5 }] }, null, staff), /expense account for every line/);
  await assert.rejects(createExpense({ paid_on: '2026-10-09', pay_from: 'B1', lines: [{ account_list_id: 'E1', amount: 5 }] }, null, staff), /who was paid/);
  await assert.rejects(createExpense({ paid_on: '2999-01-01', vendor_name: 'X', pay_from: 'B1', lines: [{ account_list_id: 'E1', amount: 5 }] }, null, staff), /future/);

  const accented = await createExpense({ paid_on: '2026-10-09', vendor_list_id: 'V1', pay_from: 'B1', memo: 'Café · José', lines: [{ account_list_id: 'E1', amount: 1 }] }, null, staff);
  const { syncRequest } = await import('../server/qbSync.js');
  assert.match((await syncRequest({ id: 1, what: `expense:${accented.id}` })).body, /<Memo>Caf&#233; &#183; Jos&#233; - Lease app expense #\d+<\/Memo>/, 'plain ASCII only: QuickBooks refuses anything else');
  await removeExpense(accented.id);

  const e = await createExpense({ paid_on: '2026-10-09', vendor_name: 'Lone Star Plumbing', pay_from: 'B1', ref_no: 'ACH', memo: 'INV. # 1672', building_id: building.id,
    lines: JSON.stringify([{ account_list_id: 'E2', amount: 611.61, memo: 'Leak in 101' }, { account_list_id: 'E1', amount: 20 }]) }, null, staff);
  assert.equal(e.total, 631.61);
  assert.equal(e.vendor_list_id, null, 'not in QuickBooks yet');
  const card = await createExpense({ paid_on: '2026-10-09', vendor_list_id: 'V1', pay_from: 'C1', lines: [{ account_list_id: 'E1', amount: 70.97 }] }, null, staff);
  assert.equal(card.vendor_name, 'Entergy');

  let r = await run();
  assert.match(await r.next(), /<VendorAddRq requestID="\d+"><VendorAdd><Name>Lone Star Plumbing<\/Name><\/VendorAdd><\/VendorAddRq>/);
  await r.reply(answer('<VendorAddRs statusCode="0" statusSeverity="Info"><VendorRet><ListID>V9</ListID><Name>Lone Star Plumbing</Name><FullName>Lone Star Plumbing</FullName></VendorRet></VendorAddRs>'));
  assert.equal((await getExpense(e.id)).vendor_list_id, 'V9');
  const check = await r.next();
  assert.match(check, /<CheckAddRq requestID="\d+"><CheckAdd><AccountRef><ListID>B1<\/ListID><\/AccountRef><PayeeEntityRef><ListID>V9<\/ListID><\/PayeeEntityRef><RefNumber>ACH<\/RefNumber><TxnDate>2026-10-09<\/TxnDate><Memo>INV\. # 1672 - Lease app expense #\d+<\/Memo>/);
  assert.match(check, /<ExpenseLineAdd><AccountRef><ListID>E2<\/ListID><\/AccountRef><Amount>611.61<\/Amount><Memo>Leak in 101<\/Memo><\/ExpenseLineAdd><ExpenseLineAdd><AccountRef><ListID>E1<\/ListID><\/AccountRef><Amount>20.00<\/Amount><\/ExpenseLineAdd>/);
  await r.reply(made('Check', 'K1', '7'));
  const charge = await r.next();
  assert.match(charge, /<CreditCardChargeAddRq requestID="\d+"><CreditCardChargeAdd><AccountRef><ListID>C1<\/ListID><\/AccountRef><PayeeEntityRef><ListID>V1<\/ListID><\/PayeeEntityRef><TxnDate>2026-10-09<\/TxnDate>/);
  assert.equal(await r.reply(made('CreditCardCharge', 'K2', '3')), 100);
  assert.deepEqual((await listExpenses()).map((x) => x.quickbooks.state), ['sent', 'sent']);

  await updateExpense(e.id, { paid_on: '2026-10-09', vendor_list_id: 'V9', pay_from: 'B1', ref_no: '2365', lines: [{ account_list_id: 'E2', amount: 600 }] });
  assert.equal((await getExpense(e.id)).quickbooks.state, 'waiting');
  r = await run();
  assert.match(await r.next(), /<CheckModRq requestID="\d+"><CheckMod><TxnID>K1<\/TxnID><EditSequence>7<\/EditSequence><AccountRef><ListID>B1<\/ListID><\/AccountRef><PayeeEntityRef><ListID>V9<\/ListID><\/PayeeEntityRef><RefNumber>2365<\/RefNumber>.*<ExpenseLineMod><TxnLineID>-1<\/TxnLineID><AccountRef><ListID>E2<\/ListID><\/AccountRef><Amount>600.00<\/Amount><\/ExpenseLineMod><\/CheckMod>/);
  await r.reply(made('Check', 'K1', '8', 'Mod'));

  await removeExpense(card.id);
  r = await run();
  assert.match(await r.next(), /<TxnDelType>CreditCardCharge<\/TxnDelType><TxnID>K2<\/TxnID>/);
  await r.reply(gone('CreditCardCharge', 'K2'));
  assert.deepEqual((await db.prepare('SELECT key FROM qb_sync ORDER BY key').all()).map((x) => x.key), [`expense:${e.id}`]);
});

test('a refusal from QuickBooks is shown on the entry and waits to be tried again; a cut-off new entry waits for a person', async () => {
  const { staff } = await books();
  await saveSettings({ start_date: '2026-10-01', bank_account: 'B1', rent_account: 'I1' });
  const e = await createExpense({ paid_on: '2026-10-09', vendor_list_id: 'V1', pay_from: 'B1', lines: [{ account_list_id: 'E1', amount: 50 }] }, null, staff);
  let r = await run();
  await r.next();
  await r.reply(failed('CheckAdd', 3140, 'There is an invalid reference to QuickBooks Account "E1" in the Check.'));
  const st = (await getExpense(e.id)).quickbooks;
  assert.equal(st.state, 'failed');
  assert.match(st.error, /invalid reference to QuickBooks Account/);
  assert.equal(await plan(), 0, 'not queued again on its own');

  assert.equal(await retryFailed(), 1);
  r = await run();
  await r.next(); // sent, and the Web Connector stops before the answer
  await run();
  const cut = (await getExpense(e.id)).quickbooks;
  assert.equal(cut.state, 'failed');
  assert.match(cut.error, /cannot tell whether it was made/);
});

test('a monthly bill becomes an expense on its day, each month once', async () => {
  const { staff } = await books();
  await assert.rejects(createRepeat({ vendor_list_id: 'V1', pay_from: 'B1', account_list_id: 'E1', amount: 70, day: 31 }, staff, '2026-10-03'), /1 to 28/);
  const rp = await createRepeat({ vendor_list_id: 'V1', pay_from: 'B1', ref_no: 'ACH', account_list_id: 'E1', amount: 70.97, memo: 'Electric GSL', day: 5 }, staff, '2026-10-03');
  assert.equal(rp.first_month, '2026-10');
  const late = await createRepeat({ vendor_list_id: 'V1', pay_from: 'B1', account_list_id: 'E1', amount: 10, day: 2 }, staff, '2026-10-03');
  assert.equal(late.first_month, '2026-11', 'its day has passed this month');

  assert.equal(await runRepeats('2026-10-04'), 0);
  assert.equal(await runRepeats('2026-12-05'), 5); // Oct, Nov, Dec of one; Nov, Dec of the other
  assert.equal(await runRepeats('2026-12-20'), 0, 'once a month');
  const list = await listExpenses();
  assert.deepEqual(list.filter((x) => x.repeat_id === rp.id).map((x) => [x.paid_on, x.total, x.ref_no, x.memo]),
    [['2026-12-05', 70.97, 'ACH', 'Electric GSL'], ['2026-11-05', 70.97, 'ACH', 'Electric GSL'], ['2026-10-05', 70.97, 'ACH', 'Electric GSL']]);
  assert.equal((await listRepeats()).find((x) => x.id === rp.id).last_month, '2026-12');
});

test('a receipt read by the AI is tied to QuickBooks\' own vendor and accounts', async () => {
  await books();
  const c = await choices();
  assert.deepEqual(c.pay_from.map((p) => p.name), ['HCI - 1468', 'XALLE-CC-1518']);
  assert.ok(!c.accounts.some((a) => ['Bank', 'CreditCard', 'AccountsReceivable'].includes(a.type)));
  const got = await receiptFrom('{"vendor":"ENTERGY","paid_on":"2026-10-02","total":"$70.97","memo":"ACCT 215505306","lines":[{"account":"utilities:electric","amount":"70.97","memo":"Electric"},{"account":"Nonsense","amount":"0"}]}', c);
  assert.deepEqual(got, { vendor_name: 'Entergy', vendor_list_id: 'V1', paid_on: '2026-10-02', total: 70.97, memo: 'ACCT 215505306', lines: [{ account_list_id: 'E1', amount: 70.97, memo: 'Electric' }] });
  assert.deepEqual(await receiptFrom('not json', c), {});
  const unknown = await receiptFrom('{"vendor":"Joe\'s Hardware","total":12}', c);
  assert.deepEqual(unknown, { vendor_name: 'Joe\'s Hardware', total: 12 });

  let asked = '';
  useAsk(async (_, { content }) => { asked = content[1].text; return '{"vendor":"Entergy","total":5}'; });
  const r = await readReceipt({ buffer: Buffer.from('%PDF-1.4'), mimetype: 'application/pdf', originalname: 'bill.pdf' });
  assert.equal(r.vendor_list_id, 'V1');
  assert.match(asked, /KNOWN VENDORS:\nEntergy/);
  assert.match(asked, /Utilities:Electric/);
});
