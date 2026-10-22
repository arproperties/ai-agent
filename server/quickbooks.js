import express, { Router } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { db, tx } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import { plan, syncRequest, syncApply, settings, saveSettings } from './qbSync.js';

// QuickBooks Desktop, through Intuit's Web Connector.
//
// QuickBooks Desktop lives on one Windows PC, out of the server's reach. So the server never
// calls it: the Web Connector, installed on that PC, calls the server every few minutes
// (SOAP, at /api/qbwc) and asks for work. The server hands it one qbXML request at a time
// from qb_queue, the Web Connector runs it in QuickBooks and posts the answer back. If the PC
// is off, the work waits in the queue.
//
// The conversation, as the Web Connector holds it:
//   authenticate(user, password)  → [ticket, ''] work waiting; [ticket, 'none'] nothing to do;
//                                   ['', 'nvu'] wrong sign-in
//   sendRequestXML(ticket, …)     → the next qbXML request ('' = stop, then getLastError)
//   receiveResponseXML(ticket, …) → how far along, 0-100; 100 ends the run
//   getLastError / connectionError / closeConnection
//
// Safety: sending has an off switch (qb_connection.enabled). Off, nothing is written into
// QuickBooks; reading its lists still goes, so the app can be connected and shown the real
// accounts and vendors before anything is sent. And the first company file to
// connect is the only one ever served: any other file is refused, so a test copy and the
// real books can never be mixed up. "Forget the file" is the master's deliberate step.
//
// What goes through it: reads of QuickBooks' lists (accounts, classes, vendors, customers,
// items) into qb_lists, read-only looks at recent transactions, and the app's own entries
// (rent deposits, deposit refunds, expenses), which server/qbSync.js works out and builds.

const QBXML_VERSION = '13.0';
const PAGE = 100;
const SENT_TIMEOUT_NOTE = 'The Web Connector stopped before answering; sent again.';
const CUT_OFF_ADD = 'The Web Connector stopped before QuickBooks answered, so the app cannot tell whether it was made. Look for it in QuickBooks: if it is there, delete it there; then Try again.';

// The lists read from QuickBooks. The long ones come back in pages (an "iterator").
export const LISTS = [
  { what: 'Account', paged: false },
  { what: 'Class', paged: false },
  { what: 'Vendor', paged: true },
  { what: 'Customer', paged: true },
  { what: 'Item', paged: true },
];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const soapParser = new XMLParser({ removeNSPrefix: true, parseTagValue: false, ignoreAttributes: true });
const qbParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, isArray: (name) => name.endsWith('Ret') });

const log = (ticket, event, detail = null) =>
  db.prepare('INSERT INTO qb_log (ticket, event, detail) VALUES (?, ?, ?)').run(ticket || null, event, detail);
const connection = () => db.prepare('SELECT * FROM qb_connection WHERE id = 1').get();
const session = (ticket) => db.prepare('SELECT * FROM qb_sessions WHERE ticket = ?').get(String(ticket || ''));
/** What is waiting to go: everything, or with sending off, the reads alone. */
const waiting = async (sending) => (await db.prepare("SELECT count(*)::int AS n FROM qb_queue WHERE status = 'waiting' AND (kind <> 'sync' OR ?)").get(!!sending)).n;
const sameFile = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// ---------- what the master sets up ----------

/** Creates the Web Connector's sign-in, or gives it a new password. The password is shown once. */
export async function setUp() {
  const password = randomBytes(12).toString('base64url');
  const hash = await hashPassword(password);
  const c = await connection();
  if (c) await db.prepare('UPDATE qb_connection SET password_hash = ? WHERE id = 1').run(hash);
  else {
    const guid = () => `{${randomUUID().toUpperCase()}}`;
    await db.prepare('INSERT INTO qb_connection (id, username, password_hash, owner_id, file_id) VALUES (1, ?, ?, ?, ?)')
      .run('leaseapp', hash, guid(), guid());
  }
  const { username } = await connection();
  return { username, password };
}

/** The .qwc file the Web Connector is given ("Add an application"). base is the app's own address. */
export async function qwcFile(base) {
  const c = await connection();
  if (!c) throw bad('Set up the QuickBooks connection first.');
  const root = String(base).replace(/\/$/, '');
  return `<?xml version="1.0"?>
<QBWCXML>
  <AppName>${esc(`Lease app (${new URL(root).host})`)}</AppName>
  <AppID></AppID>
  <AppURL>${esc(`${root}/api/qbwc`)}</AppURL>
  <AppDescription>Sends the lease app's entries to QuickBooks and reads its lists.</AppDescription>
  <AppSupport>${esc(`${root}/`)}</AppSupport>
  <UserName>${esc(c.username)}</UserName>
  <OwnerID>${esc(c.owner_id)}</OwnerID>
  <FileID>${esc(c.file_id)}</FileID>
  <QBType>QBFS</QBType>
  <Scheduler><RunEveryNMinutes>5</RunEveryNMinutes></Scheduler>
  <IsReadOnly>false</IsReadOnly>
</QBWCXML>
`;
}

export async function setEnabled(on) {
  if (!(await connection())) throw bad('Set up the QuickBooks connection first.');
  await db.prepare('UPDATE qb_connection SET enabled = ? WHERE id = 1').run(!!on);
}

/**
 * Unties the company file, so the next file to connect becomes the one: moving from a test copy
 * to the real books. Everything the app sent to the old file is forgotten, so the new one is
 * sent all of it; vendors the app made there are made again in the new one. Sending is switched
 * off, and the lists are read again from the new file before anything goes.
 */
export async function forgetFile() {
  await tx(async () => {
    for (const t of ['expenses', 'expense_repeats']) {
      await db.prepare(`UPDATE ${t} SET vendor_list_id = NULL WHERE vendor_list_id IN (SELECT list_id FROM qb_lists WHERE kind = 'Vendor' AND made_here)`).run();
    }
    await db.prepare("DELETE FROM qb_lists WHERE made_here").run();
    await db.prepare('DELETE FROM qb_sync').run();
    await db.prepare("DELETE FROM qb_queue WHERE kind = 'sync'").run();
    await db.prepare('UPDATE qb_connection SET company_file = NULL, enabled = false WHERE id = 1').run();
  });
  await queueListRead();
}

/** Puts a read of every list in the queue, skipping any already waiting. Returns how many were added. */
export async function queueListRead() {
  let added = 0;
  for (const { what } of LISTS) {
    const open = await db.prepare("SELECT 1 FROM qb_queue WHERE kind = 'list' AND what = ? AND status IN ('waiting', 'sent')").get(what);
    if (open) continue;
    await db.prepare("INSERT INTO qb_queue (kind, what) VALUES ('list', ?)").run(what);
    added++;
  }
  return added;
}

// Transactions that can be looked at, and whether their query takes IncludeLineItems
// (without it, QuickBooks leaves the lines out).
export const LOOKS = {
  Deposit: true, SalesReceipt: true, ReceivePayment: true, Invoice: true,
  Check: true, Bill: true, CreditCardCharge: true, JournalEntry: true,
};

/** Queues a read-only look at recent transactions of each type, from a date (YYYY-MM-DD). */
export async function queueLook(since, types = Object.keys(LOOKS)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(since))) throw bad('Give the date to look from as YYYY-MM-DD.');
  for (const t of types) if (!(t in LOOKS)) throw bad(`Unknown transaction type: ${t}`);
  for (const t of types) await db.prepare("INSERT INTO qb_queue (kind, what, since) VALUES ('look', ?, ?)").run(t, since);
  return types.length;
}

export async function looks(what) {
  return db.prepare('SELECT id, what, xml, at FROM qb_looks WHERE what = ? ORDER BY id DESC').all(String(what));
}

/** Failed requests go back in the queue. */
export async function retryFailed() {
  const rows = await db.prepare("UPDATE qb_queue SET status = 'waiting', error = NULL, ticket = NULL, done_at = NULL WHERE status = 'failed' RETURNING id").all();
  return rows.length;
}

export async function status() {
  const c = await connection();
  const counts = Object.fromEntries((await db.prepare('SELECT status, count(*)::int AS n FROM qb_queue GROUP BY status').all()).map((r) => [r.status, r.n]));
  const lists = Object.fromEntries((await db.prepare('SELECT kind, count(*)::int AS n FROM qb_lists GROUP BY kind').all()).map((r) => [r.kind, r.n]));
  const contact = await db.prepare("SELECT max(at) AS at FROM qb_log WHERE event IN ('start', 'nothing')").get();
  return {
    set_up: !!c,
    enabled: !!c?.enabled,
    username: c?.username ?? null,
    company_file: c?.company_file ?? null,
    last_contact: contact?.at ?? null,
    queue: { waiting: counts.waiting || 0, sent: counts.sent || 0, done: counts.done || 0, failed: counts.failed || 0 },
    failed: await db.prepare("SELECT id, kind, what, error, done_at FROM qb_queue WHERE status = 'failed' ORDER BY id DESC LIMIT 20").all(),
    lists,
    log: await db.prepare('SELECT at, event, detail FROM qb_log ORDER BY id DESC LIMIT 50').all(),
  };
}

export async function listOf(kind) {
  return db.prepare('SELECT list_id, name, full_name, active, type FROM qb_lists WHERE kind = ? ORDER BY full_name').all(String(kind));
}

// ---------- the Web Connector's side ----------

export async function authenticate(user, password) {
  const c = await connection();
  const ok = c && user === c.username && (await verifyPassword(String(password ?? ''), c.password_hash).catch(() => false));
  if (!ok) {
    await log(null, 'refused', 'Wrong Web Connector user name or password');
    return ['', 'nvu'];
  }
  const ticket = randomUUID();
  // Only one Web Connector runs, so anything still marked sent was cut off mid-run. A read, a
  // change or a removal is simply sent again. A new entry may have been made without the answer
  // getting back, and sending it again could make it twice: that waits for a person to look.
  await db.prepare("UPDATE qb_queue SET status = 'failed', ticket = NULL, done_at = now(), error = ? WHERE status = 'sent' AND kind = 'sync' AND stage IN ('add', 'vendor')")
    .run(CUT_OFF_ADD);
  await db.prepare("UPDATE qb_queue SET status = 'waiting', ticket = NULL, error = ? WHERE status = 'sent'").run(SENT_TIMEOUT_NOTE);
  if (c.enabled) await plan(); // what QuickBooks should have that it does not, as the app is now
  const n = await waiting(c.enabled);
  if (!n) {
    await log(ticket, 'nothing', c.enabled ? 'Nothing waiting' : 'Nothing to read; sending is switched off');
    return [ticket, 'none'];
  }
  await db.prepare('INSERT INTO qb_sessions (ticket) VALUES (?)').run(ticket);
  await log(ticket, 'start', `${n} waiting`);
  return [ticket, c.company_file || ''];
}

export async function sendRequestXML(ticket, companyFile) {
  const s = await session(ticket);
  if (!s || s.closed_at) return '';
  const c = await connection();
  const stop = async (why) => {
    await db.prepare('UPDATE qb_sessions SET error = ? WHERE ticket = ?').run(why, s.ticket);
    await log(s.ticket, 'stopped', why);
    return '';
  };
  if (!s.company_file) {
    if (c.company_file && !sameFile(c.company_file, companyFile)) {
      return stop(`Refused: this is not the company file the app is tied to (${c.company_file}). Open that file, or forget it in the app first.`);
    }
    if (!c.company_file) {
      await db.prepare('UPDATE qb_connection SET company_file = ? WHERE id = 1').run(companyFile);
      await log(s.ticket, 'tied', `Tied to ${companyFile}`);
    }
    await db.prepare('UPDATE qb_sessions SET company_file = ? WHERE ticket = ?').run(companyFile, s.ticket);
  }
  // Reads first (the lists the entries refer to), then entries, oldest first.
  for (;;) {
    const item = await db.prepare(`UPDATE qb_queue SET status = 'sent', ticket = ?, sent_at = now(), attempts = attempts + 1
      WHERE id = (SELECT id FROM qb_queue WHERE status = 'waiting' AND (kind <> 'sync' OR ?) ORDER BY (kind = 'sync'), id LIMIT 1) RETURNING *`).get(s.ticket, !!c.enabled);
    if (!item) return stop('Nothing waiting.');
    if (item.kind !== 'sync') {
      await log(s.ticket, 'sent', item.kind === 'look' ? `${item.what} sample` : `${item.what} list${item.iterator_id ? ' (next page)' : ''}`);
      return requestFor(item);
    }
    let r;
    try { r = await syncRequest(item); } catch (e) {
      await db.prepare("UPDATE qb_queue SET status = 'failed', error = ?, done_at = now() WHERE id = ?").run(e.message, item.id);
      await log(s.ticket, 'failed', `${item.what}: ${e.message}`);
      continue;
    }
    if (!r) { // QuickBooks already has it as it is
      await db.prepare("UPDATE qb_queue SET status = 'done', done_at = now() WHERE id = ?").run(item.id);
      continue;
    }
    await db.prepare('UPDATE qb_queue SET stage = ?, sent_hash = ? WHERE id = ?').run(r.stage, r.hash, item.id);
    await log(s.ticket, 'sent', `${item.what} (${STAGE[r.stage]})`);
    return qbxml(r.body);
  }
}
const STAGE = { vendor: 'new vendor', add: 'new', mod: 'change', del: 'take out' };

export async function receiveResponseXML(ticket, response, hresult, message) {
  const s = await session(ticket);
  if (!s) return 100;
  const item = await db.prepare("SELECT * FROM qb_queue WHERE status = 'sent' AND ticket = ? ORDER BY id LIMIT 1").get(s.ticket);
  if (item) {
    try {
      if (hresult) throw new Error(`QuickBooks could not run it: ${message || hresult}`);
      if (item.kind === 'sync') await log(s.ticket, 'received', `${item.what}: ${await syncApply(item, response)}`);
      else await apply(item, response);
    } catch (e) {
      await db.prepare("UPDATE qb_queue SET status = 'failed', error = ?, done_at = now() WHERE id = ?").run(e.message, item.id);
      await log(s.ticket, 'failed', `${item.what}${item.kind === 'list' ? ' list' : ''}: ${e.message}`);
    }
  }
  const { handled } = await db.prepare('UPDATE qb_sessions SET handled = handled + 1 WHERE ticket = ? RETURNING handled').get(s.ticket);
  const c = await connection();
  const left = await waiting(c?.enabled);
  if (!left) return 100;
  return Math.max(1, Math.min(99, Math.floor((100 * handled) / (handled + left))));
}

export async function getLastError(ticket) {
  return (await session(ticket))?.error || 'Something went wrong in the lease app; see its QuickBooks log.';
}

export async function connectionError(ticket, hresult, message) {
  const why = `The Web Connector could not open QuickBooks: ${message || hresult}`;
  if (await session(ticket)) await db.prepare('UPDATE qb_sessions SET error = ? WHERE ticket = ?').run(why, String(ticket));
  await log(ticket, 'qb-error', why);
  return 'done';
}

export async function closeConnection(ticket) {
  const s = await session(ticket);
  if (!s) return 'OK';
  await db.prepare('UPDATE qb_sessions SET closed_at = now() WHERE ticket = ?').run(s.ticket);
  const done = await db.prepare('SELECT handled FROM qb_sessions WHERE ticket = ?').get(s.ticket);
  await log(s.ticket, 'end', `${done.handled} handled`);
  return `Lease app: ${done.handled} handled.`;
}

// ---------- qbXML ----------

const qbxml = (body) => `<?xml version="1.0" encoding="utf-8"?>\n<?qbxml version="${QBXML_VERSION}"?>\n<QBXML><QBXMLMsgsRq onError="stopOnError">${body}</QBXMLMsgsRq></QBXML>`;

export function listQuery(what, iteratorId, requestId) {
  const spec = LISTS.find((l) => l.what === what);
  if (!spec) throw new Error(`Unknown list: ${what}`);
  const paging = !spec.paged ? '' : iteratorId ? ` iterator="Continue" iteratorID="${esc(iteratorId)}"` : ' iterator="Start"';
  const inner = `${spec.paged ? `<MaxReturned>${PAGE}</MaxReturned>` : ''}<ActiveStatus>All</ActiveStatus>`;
  return qbxml(`<${what}QueryRq requestID="${esc(requestId)}"${paging}>${inner}</${what}QueryRq>`);
}

const LOOK_SIZE = 40;
export function lookQuery(what, since, requestId) {
  if (!(what in LOOKS)) throw new Error(`Unknown transaction type: ${what}`);
  // A DATE column comes back as local midnight; read it in local time, or it slips a day.
  const d = since instanceof Date ? since : null;
  const date = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(since).slice(0, 10);
  const lines = LOOKS[what] ? '<IncludeLineItems>true</IncludeLineItems>' : '';
  return qbxml(`<${what}QueryRq requestID="${esc(requestId)}"><MaxReturned>${LOOK_SIZE}</MaxReturned><TxnDateRangeFilter><FromTxnDate>${date}</FromTxnDate></TxnDateRangeFilter>${lines}</${what}QueryRq>`);
}

function requestFor(item) {
  if (item.kind === 'list') return listQuery(item.what, item.iterator_id, item.id);
  if (item.kind === 'look') return lookQuery(item.what, item.since, item.id);
  throw new Error(`Unknown kind: ${item.kind}`);
}

async function apply(item, xml) {
  if (item.kind === 'look') return applyLook(item, xml);
  if (item.kind !== 'list') throw new Error(`Unknown kind: ${item.kind}`);
  const rs = qbParser.parse(String(xml || ''))?.QBXML?.QBXMLMsgsRs?.[`${item.what}QueryRs`];
  if (!rs) throw new Error('QuickBooks sent an answer the app could not read.');
  const code = Number(rs.statusCode);
  if (rs.statusSeverity === 'Error' && code !== 1) throw new Error(`QuickBooks said: ${rs.statusMessage} (${code})`); // 1: the list is empty

  // Items come as ItemServiceRet, ItemNonInventoryRet and so on; the rest as <What>Ret.
  const rets = Object.entries(rs)
    .filter(([k]) => (item.what === 'Item' ? /^Item\w+Ret$/.test(k) : k === `${item.what}Ret`))
    .flatMap(([k, list]) => list.map((r) => ({ r, type: item.what === 'Item' ? k.slice(4, -3) : item.what === 'Account' ? r.AccountType : null })));
  for (const { r, type } of rets) {
    if (!r.ListID) continue;
    await db.prepare(`INSERT INTO qb_lists (kind, list_id, name, full_name, active, type, read_by, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, now())
      ON CONFLICT (kind, list_id) DO UPDATE SET name = EXCLUDED.name, full_name = EXCLUDED.full_name, active = EXCLUDED.active,
        type = EXCLUDED.type, read_by = EXCLUDED.read_by, seen_at = now()`)
      .run(item.what, String(r.ListID), String(r.Name ?? ''), String(r.FullName ?? r.Name ?? ''), r.IsActive !== 'false', type ?? null, item.id);
  }

  const more = LISTS.find((l) => l.what === item.what).paged && Number(rs.iteratorRemainingCount) > 0;
  if (more) {
    await db.prepare("UPDATE qb_queue SET status = 'waiting', iterator_id = ?, ticket = NULL, error = NULL WHERE id = ?").run(String(rs.iteratorID), item.id);
  } else {
    // The whole list is in: what this read did not see is gone from QuickBooks.
    await db.prepare('DELETE FROM qb_lists WHERE kind = ? AND read_by IS DISTINCT FROM ?').run(item.what, item.id);
    await db.prepare("UPDATE qb_queue SET status = 'done', iterator_id = NULL, error = NULL, done_at = now() WHERE id = ?").run(item.id);
  }
  await log(item.ticket, 'received', `${item.what} list: ${rets.length}${more ? `, ${rs.iteratorRemainingCount} more to come` : ''}`);
}

async function applyLook(item, xml) {
  const rs = qbParser.parse(String(xml || ''))?.QBXML?.QBXMLMsgsRs?.[`${item.what}QueryRs`];
  if (!rs) throw new Error('QuickBooks sent an answer the app could not read.');
  const code = Number(rs.statusCode);
  if (rs.statusSeverity === 'Error' && code !== 1) throw new Error(`QuickBooks said: ${rs.statusMessage} (${code})`);
  const n = (rs[`${item.what}Ret`] || []).length;
  await db.prepare('INSERT INTO qb_looks (queue_id, what, xml) VALUES (?, ?, ?)').run(item.id, item.what, String(xml));
  await db.prepare("UPDATE qb_queue SET status = 'done', error = NULL, done_at = now() WHERE id = ?").run(item.id);
  await log(item.ticket, 'received', `${item.what} sample: ${n}`);
}

// ---------- SOAP ----------

const envelope = (method, inner) => `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><${method}Response xmlns="http://developer.intuit.com/">${inner}</${method}Response></soap:Body></soap:Envelope>`;
const result = (method, value) => envelope(method, `<${method}Result>${esc(value)}</${method}Result>`);
const fault = (message) => `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>${esc(message)}</faultstring></soap:Fault></soap:Body></soap:Envelope>`;

/** One SOAP call from the Web Connector, answered. */
export async function handleSoap(xml) {
  const body = soapParser.parse(String(xml || ''))?.Envelope?.Body;
  const method = body && Object.keys(body)[0];
  const p = (method && body[method]) || {};
  switch (method) {
    case 'serverVersion': return result(method, '1.0');
    case 'clientVersion': return result(method, ''); // any version is fine
    case 'authenticate': {
      const [ticket, file] = await authenticate(p.strUserName, p.strPassword);
      return envelope(method, `<authenticateResult><string>${esc(ticket)}</string><string>${esc(file)}</string></authenticateResult>`);
    }
    case 'sendRequestXML': return result(method, await sendRequestXML(p.ticket, p.strCompanyFileName));
    case 'receiveResponseXML': return result(method, await receiveResponseXML(p.ticket, p.response, p.hresult, p.message));
    case 'getLastError': return result(method, await getLastError(p.ticket));
    case 'connectionError': return result(method, await connectionError(p.ticket, p.hresult, p.message));
    case 'closeConnection': return result(method, await closeConnection(p.ticket));
    default: return null;
  }
}

/** The Web Connector's door. Mounted before sign-in: it signs in with its own user name and password. */
export const qbwcRoutes = Router();
qbwcRoutes.use(express.text({ type: () => true, limit: '50mb' }));
qbwcRoutes.get('/', (req, res) => res.type('text/plain').send('Lease app: QuickBooks Web Connector endpoint.'));
qbwcRoutes.post('/', async (req, res) => {
  try {
    const out = await handleSoap(req.body);
    if (out === null) return res.status(400).type('text/xml').send(fault('Unknown call.'));
    res.type('text/xml').send(out);
  } catch (e) {
    await log(null, 'error', e.message).catch(() => {});
    res.status(500).type('text/xml').send(fault('The lease app hit an error.'));
  }
});

/** The master's screen. Mount after requireUser and requireMaster. */
export const quickbooksRoutes = Router();
const appBase = (req) => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
quickbooksRoutes.get('/status', async (req, res) => res.json(await status()));
quickbooksRoutes.post('/setup', async (req, res) => res.json(await setUp()));
quickbooksRoutes.get('/qwc', async (req, res) => {
  const file = await qwcFile(appBase(req));
  res.type('application/xml').attachment('lease-app.qwc').send(file);
});
quickbooksRoutes.post('/enabled', async (req, res) => { await setEnabled(req.body?.on); res.json(await status()); });
quickbooksRoutes.post('/forget-file', async (req, res) => { await forgetFile(); res.json(await status()); });
quickbooksRoutes.post('/read-lists', async (req, res) => res.json({ added: await queueListRead() }));
quickbooksRoutes.post('/retry', async (req, res) => res.json({ retried: await retryFailed() }));
quickbooksRoutes.get('/lists/:kind', async (req, res) => res.json(await listOf(req.params.kind)));
quickbooksRoutes.get('/settings', async (req, res) => res.json({ settings: await settings(), accounts: (await listOf('Account')).filter((a) => a.active) }));
quickbooksRoutes.put('/settings', async (req, res) => res.json(await saveSettings(req.body)));
quickbooksRoutes.post('/plan', async (req, res) => res.json({ queued: await plan() }));
