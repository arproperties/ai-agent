import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { reset, closeDb, db } from './helpers/db.js';
import { setUp, qwcFile, setEnabled, forgetFile, queueListRead, retryFailed, status, listOf, listQuery, queueLook, looks, qbwcRoutes } from '../server/quickbooks.js';

test.after(() => closeDb());

// The Web Connector, played over real HTTP: SOAP in, SOAP out, as it does it.
const app = express();
app.use(express.json());
app.use('/api/qbwc', qbwcRoutes);
const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
test.after(() => new Promise((ok) => server.close(ok)));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
async function call(method, params = {}) {
  const inner = Object.entries(params).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://developer.intuit.com/">${inner}</${method}></soap:Body></soap:Envelope>`;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/qbwc`, {
    method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `"http://developer.intuit.com/${method}"` }, body,
  });
  const text = await res.text();
  if (method === 'authenticate') return [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unesc(m[1]));
  const m = text.match(new RegExp(`<${method}Result>([\\s\\S]*)</${method}Result>`));
  return m ? unesc(m[1]) : text;
}

const FILE = 'D:\\Francis\\qb-test\\HCI-TEST.QBW';

// QuickBooks' answers, shaped as QuickBooks writes them.
const answer = (rs) => `<?xml version="1.0" ?>\n<QBXML><QBXMLMsgsRs>${rs}</QBXMLMsgsRs></QBXML>`;
const ok = (what, rets, extra = '') => answer(`<${what}QueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK"${extra}>${rets}</${what}QueryRs>`);
const empty = (what) => answer(`<${what}QueryRs requestID="1" statusCode="1" statusSeverity="Info" statusMessage="A query request did not find a matching object in QuickBooks" />`);
const account = (id, name, type, active = true) => `<AccountRet><ListID>${id}</ListID><Name>${esc(name)}</Name><FullName>${esc(name)}</FullName><IsActive>${active}</IsActive><AccountType>${type}</AccountType></AccountRet>`;
const named = (tag, id, name) => `<${tag}><ListID>${id}</ListID><Name>${esc(name)}</Name><FullName>${esc(name)}</FullName><IsActive>true</IsActive></${tag}>`;

async function ready() {
  await reset();
  const { username, password } = await setUp();
  await setEnabled(true);
  return { username, password };
}

test('set up gives a one-time password and a .qwc file that points at the app', async () => {
  await reset();
  const first = await setUp();
  assert.equal(first.username, 'leaseapp');
  assert.ok(first.password.length >= 16);
  const row = await db.prepare('SELECT * FROM qb_connection').get();
  assert.notEqual(row.password_hash, first.password, 'only a hash is kept');
  assert.equal(row.enabled, false, 'sending starts switched off');

  const qwc = await qwcFile('https://jnrpro.co/');
  assert.match(qwc, /<AppURL>https:\/\/jnrpro\.co\/api\/qbwc<\/AppURL>/);
  assert.match(qwc, /<AppSupport>https:\/\/jnrpro\.co\/<\/AppSupport>/);
  assert.match(qwc, new RegExp(`<OwnerID>${row.owner_id.replace(/[{}]/g, '\\$&')}</OwnerID>`));
  assert.match(qwc, /<QBType>QBFS<\/QBType>/);

  const again = await setUp();
  assert.notEqual(again.password, first.password, 'a second set-up is a new password');
  const after = await db.prepare('SELECT * FROM qb_connection').get();
  assert.equal(after.owner_id, row.owner_id, 'but the same ids, so the Web Connector keeps its entry');
});

test('the Web Connector is refused with a wrong password, and told "none" when off or idle', async () => {
  const { username, password } = await ready();
  assert.deepEqual(await call('authenticate', { strUserName: username, strPassword: 'nope' }), ['', 'nvu']);
  assert.deepEqual(await call('authenticate', { strUserName: 'someone', strPassword: password }), ['', 'nvu']);

  const [ticket, idle] = await call('authenticate', { strUserName: username, strPassword: password });
  assert.ok(ticket);
  assert.equal(idle, 'none', 'nothing waiting');

  await queueListRead();
  await setEnabled(false);
  assert.equal((await call('authenticate', { strUserName: username, strPassword: password }))[1], 'none', 'switched off');
  assert.equal(await call('serverVersion'), '1.0');
  assert.equal(await call('clientVersion', { strVersion: '34.0.10010.76' }), '');
});

test('a full read of the lists, with a paged list and an empty one', async () => {
  const { username, password } = await ready();
  assert.equal(await queueListRead(), 5);
  assert.equal(await queueListRead(), 0, 'not queued twice');

  const [ticket, file] = await call('authenticate', { strUserName: username, strPassword: password });
  assert.equal(file, '', 'no file tied yet: use the one open');
  const send = () => call('sendRequestXML', { ticket, strHCPResponse: '<QBXML/>', strCompanyFileName: FILE, qbXMLCountry: 'US', qbXMLMajorVers: '16', qbXMLMinorVers: '0' });
  const receive = (response) => call('receiveResponseXML', { ticket, response, hresult: '', message: '' });

  let rq = await send();
  assert.match(rq, /<\?qbxml version="13.0"\?>/);
  assert.match(rq, /<AccountQueryRq requestID="\d+"><ActiveStatus>All<\/ActiveStatus><\/AccountQueryRq>/);
  let pct = Number(await receive(ok('Account', account('80000001-1', 'Checking', 'Bank') + account('80000002-1', 'Rental Income', 'Income') + account('80000003-1', 'Old & Closed', 'Expense', false))));
  assert.ok(pct > 0 && pct < 100, `still going: ${pct}`);

  rq = await send();
  assert.match(rq, /<ClassQueryRq/);
  await receive(empty('Class'));

  rq = await send();
  assert.match(rq, /<VendorQueryRq requestID="\d+" iterator="Start"><MaxReturned>100<\/MaxReturned>/);
  await receive(ok('Vendor', named('VendorRet', 'V1', 'Lone Star Plumbing'), ' iteratorRemainingCount="1" iteratorID="{abc-123}"'));
  rq = await send();
  assert.match(rq, /<VendorQueryRq requestID="\d+" iterator="Continue" iteratorID="\{abc-123\}">/, 'the next page');
  await receive(ok('Vendor', named('VendorRet', 'V2', 'City Water'), ' iteratorRemainingCount="0" iteratorID="{abc-123}"'));

  rq = await send();
  assert.match(rq, /<CustomerQueryRq/);
  const many = Array.from({ length: 300 }, (_, i) => named('CustomerRet', `C${i}`, `Tenant ${i} & Sons <GSL${i}>`)).join('');
  await receive(ok('Customer', many, ' iteratorRemainingCount="0" iteratorID="{c}"'));

  rq = await send();
  assert.match(rq, /<ItemQueryRq/);
  pct = Number(await receive(ok('Item', named('ItemServiceRet', 'I1', 'Rent') + named('ItemOtherChargeRet', 'I2', 'Late fee'), ' iteratorRemainingCount="0"')));
  assert.equal(pct, 100, 'all done');
  assert.match(await call('closeConnection', { ticket }), /6 handled/);

  const accounts = await listOf('Account');
  assert.deepEqual(accounts.map((a) => [a.full_name, a.type, a.active]), [['Checking', 'Bank', true], ['Old & Closed', 'Expense', false], ['Rental Income', 'Income', true]]);
  assert.deepEqual((await listOf('Vendor')).map((v) => v.name), ['City Water', 'Lone Star Plumbing'], 'both pages kept');
  assert.equal((await listOf('Customer')).length, 300);
  assert.equal((await listOf('Customer')).find((c) => c.list_id === 'C7').name, 'Tenant 7 & Sons <GSL7>', 'escaped names come back whole');
  assert.deepEqual((await listOf('Item')).map((i) => [i.name, i.type]), [['Late fee', 'OtherCharge'], ['Rent', 'Service']]);
  assert.deepEqual(await listOf('Class'), []);

  const s = await status();
  assert.equal(s.company_file, FILE, 'the first file to connect is now the one');
  assert.deepEqual(s.queue, { waiting: 0, sent: 0, done: 5, failed: 0 });
  assert.ok(s.last_contact);
});

test('a second full read drops what QuickBooks no longer has', async () => {
  const { username, password } = await ready();
  await db.prepare("INSERT INTO qb_queue (kind, what) VALUES ('list', 'Class')").run();
  const [ticket] = await call('authenticate', { strUserName: username, strPassword: password });
  await call('sendRequestXML', { ticket, strCompanyFileName: FILE });
  await call('receiveResponseXML', { ticket, response: ok('Class', named('ClassRet', 'K1', 'GSL') + named('ClassRet', 'K2', 'Tower')), hresult: '', message: '' });
  assert.equal((await listOf('Class')).length, 2);

  await db.prepare("INSERT INTO qb_queue (kind, what) VALUES ('list', 'Class')").run();
  const [t2] = await call('authenticate', { strUserName: username, strPassword: password });
  await call('sendRequestXML', { ticket: t2, strCompanyFileName: FILE });
  await call('receiveResponseXML', { ticket: t2, response: ok('Class', named('ClassRet', 'K1', 'GSL')), hresult: '', message: '' });
  assert.deepEqual((await listOf('Class')).map((c) => c.name), ['GSL']);
});

test('another company file is refused once one is tied, until the master forgets it', async () => {
  const { username, password } = await ready();
  await db.prepare("UPDATE qb_connection SET company_file = ? WHERE id = 1").run(FILE);
  await queueListRead();

  const [ticket, file] = await call('authenticate', { strUserName: username, strPassword: password });
  assert.equal(file, FILE, 'the Web Connector is told which file to open');
  const rq = await call('sendRequestXML', { ticket, strCompanyFileName: 'C:\\QB\\HCI - 1468.QBW' });
  assert.equal(rq, '', 'nothing is sent to the wrong file');
  assert.match(await call('getLastError', { ticket }), /not the company file the app is tied to/);
  assert.equal((await status()).queue.waiting, 5, 'the work still waits');

  // The same file, written in another case, is the same file (Windows).
  const [t2] = await call('authenticate', { strUserName: username, strPassword: password });
  assert.match(await call('sendRequestXML', { ticket: t2, strCompanyFileName: FILE.toUpperCase() }), /AccountQueryRq/);

  await forgetFile();
  assert.equal((await status()).company_file, null);
});

test('an error from QuickBooks fails that request, the run carries on, and it can be tried again', async () => {
  const { username, password } = await ready();
  await queueListRead();
  const [ticket] = await call('authenticate', { strUserName: username, strPassword: password });
  await call('sendRequestXML', { ticket, strCompanyFileName: FILE });
  const pct = Number(await call('receiveResponseXML', { ticket, response: '', hresult: '0x80040400', message: 'QuickBooks found an error when parsing the provided XML text stream.' }));
  assert.ok(pct > 0 && pct < 100);
  await call('sendRequestXML', { ticket, strCompanyFileName: FILE });
  await call('receiveResponseXML', { ticket, response: answer('<ClassQueryRs statusCode="3120" statusSeverity="Error" statusMessage="Object not found" />'), hresult: '', message: '' });

  const s = await status();
  assert.equal(s.queue.failed, 2);
  assert.match(s.failed.find((f) => f.what === 'Account').error, /parsing the provided XML/);
  assert.match(s.failed.find((f) => f.what === 'Class').error, /QuickBooks said: Object not found \(3120\)/);
  assert.ok(s.log.some((l) => l.event === 'failed'));

  assert.equal(await retryFailed(), 2);
  assert.equal((await status()).queue.waiting, 5);
});

test('switching off mid-run ends it, and a run cut off is picked up next time', async () => {
  const { username, password } = await ready();
  await queueListRead();
  const [ticket] = await call('authenticate', { strUserName: username, strPassword: password });
  await call('sendRequestXML', { ticket, strCompanyFileName: FILE });
  await setEnabled(false);
  assert.equal(await call('receiveResponseXML', { ticket, response: ok('Account', ''), hresult: '', message: '' }), '100');

  // Cut off: sent, never answered.
  await setEnabled(true);
  const [t2] = await call('authenticate', { strUserName: username, strPassword: password });
  await call('sendRequestXML', { ticket: t2, strCompanyFileName: FILE });
  assert.equal((await status()).queue.sent, 1);
  const [t3, file] = await call('authenticate', { strUserName: username, strPassword: password });
  assert.equal(file, FILE);
  assert.equal((await status()).queue.sent, 0, 'sent again in the new run');
  assert.match(await call('sendRequestXML', { ticket: t3, strCompanyFileName: FILE }), /ClassQueryRq/);
});

test('connection errors and unknown calls are answered, not crashed on', async () => {
  const { username, password } = await ready();
  await queueListRead();
  const [ticket] = await call('authenticate', { strUserName: username, strPassword: password });
  assert.equal(await call('connectionError', { ticket, hresult: '0x80040408', message: 'Could not start QuickBooks.' }), 'done');
  assert.match(await call('getLastError', { ticket }), /Could not start QuickBooks/);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/qbwc`, { method: 'POST', headers: { 'content-type': 'text/xml' }, body: '<nonsense/>' });
  assert.equal(res.status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/qbwc`)).status, 200);
});

test('a look at recent transactions is read only and kept as QuickBooks sent it', async () => {
  const { username, password } = await ready();
  await assert.rejects(() => queueLook('last week'), /YYYY-MM-DD/);
  await assert.rejects(() => queueLook('2026-07-01', ['Payroll']), /Unknown transaction type/);
  assert.equal(await queueLook('2026-07-01', ['Deposit', 'Check']), 2);
  const [ticket] = await call('authenticate', { strUserName: username, strPassword: password });
  const rq = await call('sendRequestXML', { ticket, strCompanyFileName: FILE });
  assert.match(rq, /<DepositQueryRq requestID="\d+"><MaxReturned>40<\/MaxReturned><TxnDateRangeFilter><FromTxnDate>2026-07-01<\/FromTxnDate><\/TxnDateRangeFilter><IncludeLineItems>true<\/IncludeLineItems><\/DepositQueryRq>/);
  const dep = answer('<DepositQueryRs statusCode="0" statusSeverity="Info"><DepositRet><TxnID>1-1</TxnID><DepositToAccountRef><FullName>HCI - 1468</FullName></DepositToAccountRef></DepositRet></DepositQueryRs>');
  await call('receiveResponseXML', { ticket, response: dep, hresult: '', message: '' });
  assert.match(await call('sendRequestXML', { ticket, strCompanyFileName: FILE }), /<CheckQueryRq.*<IncludeLineItems>true<\/IncludeLineItems><\/CheckQueryRq>/);
  const kept = await looks('Deposit');
  assert.equal(kept.length, 1);
  assert.match(kept[0].xml, /HCI - 1468/);
});

test('the requests are well formed qbXML', () => {
  assert.equal(listQuery('Class', null, 4), '<?xml version="1.0" encoding="utf-8"?>\n<?qbxml version="13.0"?>\n<QBXML><QBXMLMsgsRq onError="stopOnError"><ClassQueryRq requestID="4"><ActiveStatus>All</ActiveStatus></ClassQueryRq></QBXMLMsgsRq></QBXML>');
  assert.throws(() => listQuery('Payroll', null, 1), /Unknown list/);
});
