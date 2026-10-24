import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { isMaster } from './access.js';
import { decrypt } from './secrets.js';
import { compose, sendRaw, friendlySmtp } from './smtp.js';
import { withMailbox, replySubject } from './imap.js';
import { sendPush } from './push.js';
import { createTodo } from './todos.js';
import { renderPdf } from './replyDoc.js';
import { needsModule } from './modules.js';
import { inbox, fileInSent, ownWords, claimTenantMail, checkTenantMail } from './tenantCare.js';
import { askSaifsys, actSaifsys, saifsysConfigured, saifsysActionsConfigured, dubaiDate } from './saifsys/client.js';
import { readReply, readDocs, advise, caseSummary, rewriteReply } from './leaseRenewalAi.js';

// Lease renewals: whoever has the module renews each lease with its tenant by email, from
// Reem, instead of the staff in saifsys. The list is saifsys's leases ending within 150 days.
//
//   Start      a person types the rent (any rent: our choice) and the cheques; Reem writes the
//              offer and its letter, they read it and tap Send. saifsys's own renewal workflow
//              is made then, at that rent, and marked notice_sent.
//   Replies    come back to the Tenant care inbox and are taken here. Reem reads each one, in
//              any language: what the tenant wants in one line, whether they are disputing it
//              (RERA, RDC, "not legal"), and a reply a person could send. The renewal then
//              waits for a person.
//   Answers    Accept, Counter (another rent), RERA index rent (when the tenant pushes back,
//              the rent the Rental Index allows), Not renewing, or a free reply. Each is an
//              email the person sees first; each moves saifsys's workflow along with it.
//   Papers     once agreed, the signed agreement and cheque photos the tenant sends are read
//              and checked against saifsys's own cheque schedule; what is wrong is listed and
//              the person sends it back with a tap, or marks the papers OK.
//   Convert    saifsys makes the new lease and its cheques with its own code, once; the
//              tenant is told, and the person gets a to-do for the cheques and the Ejari.
//   Silence    Reem reminds a silent tenant by itself, a week apart, twice; then the renewal
//              says No answer and waits for a person.
//
//   Advisors   the agents the master picks (Lawyer, Property Manager, RDC...) each read the
//              emails and the lease and give a short view and a reply a person could send,
//              when asked and by themselves on a tenant's dispute. They never file a case or
//              say whether an increase is legal. The RDC case pack is one PDF of the story and
//              its papers, for a person to upload to RDC.
//
// Automatic (the renewal's auto, on when the person gives the RERA index at Start): the
// person's one step is Start, with the increase the RERA index allows (rera_pct). Reem then
// sends the offer 120 days before the end (a renewal started earlier waits, 'scheduled'),
// and answers by itself: an acceptance gets the contract; a dispute, a counter or a request
// for less gets the RERA index rent (never a counter-offer of its own); papers that match
// are marked OK and renewed in saifsys; papers that do not are sent back, up to three times.
// Everything else (not renewing, a question, a second push-back after the index rent, no
// answer) waits for a person, with a push. Every step is on the renewal's timeline.
//
// Staff can step in at any time: Take over turns a renewal's auto off and they do it by
// hand, as before. When something breaks (saifsys, an email it cannot read, papers still
// wrong after three tries) Reem takes its own auto off and tells them. The master's Pause
// (settings.paused) stops Reem on every renewal at once.
//
// Later, the RERA check itself can be Reem's: the rent from the DLD Rental Index API is one
// more rent source (RENT_SOURCES), filling the slot the person's % fills now.

const DAYS_AHEAD = 150;   // the list: far enough ahead to give the RERA index before the offer is due
const SEND_AT = 120;      // days before the end the offer goes
const AUTO_FIXES = 3;
const DEFAULT_ADMIN = 1500; // the admin fee a renewal starts with     // papers sent back by Reem before a person looks
const REMIND_AFTER = 7;   // days of silence before each reminder
const REMINDERS = 2;
const EVERY = 3 * 60_000;
const DIR = `${DATA_DIR}/lease-renewals`;
const MAX_FILE = 10 * 1024 * 1024;
const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const OPEN = ['offer_sent', 'negotiating', 'agreed', 'papers_ok'];
const NOW = 'extract(epoch from now())::bigint';
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Where the rent on offer comes from. A person types it today: 'manual' is our own choice
 * of rent, 'rera_index' the rent the RERA Rental Index allows, read off DLD's calculator
 * when a tenant pushes back. 'dld_api' is the same index read by Reem from DLD's API once
 * it is bought: indexRent() then answers instead of a person, and nothing else changes.
 */
export const RENT_SOURCES = {
  manual: 'Our offer',
  rera_index: 'RERA index rent',
  dld_api: 'RERA index rent (DLD API)',
};
/** The index rent from DLD's Rental Index API. Not connected: a person enters it. */
async function indexRent() { return null; }

// Everything that reaches outside, swappable for the tests.
const D = {
  ask: askSaifsys, act: actSaifsys, readReply, readDocs, indexRent, advise, caseSummary, rewriteReply, checkMail: checkTenantMail,
  send: sendRaw, file: fileInSent, fetch: fetchMessage, push: sendPush, todo: createTodo, actor: async () => (await inbox())?.email,
  mirror: (action, body) => saifsys(action, body),
  now: () => Date.now(),
};
export const useForTests = (over) => Object.assign(D, over);

// ---------- money and dates ----------

export const aed = (n) => `AED ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const down100 = (n) => Math.floor(Number(n) / 100) * 100;
const today = () => dubaiDate(D.now());
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const longDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const secs = () => Math.floor(D.now() / 1000);

/** The index rent from the allowed increase: the current rent up by pct, rounded down to the hundred. */
export const indexRentFrom = (current, pct) => Math.max(Number(current), down100(Number(current) * (1 + Number(pct) / 100)));

// ---------- settings ----------

const DEFAULTS = { payee: null, actor_id: null, reminders: true, auto: {}, advisors: [], paused: false, bcc: ['accounts@ainalreempro.com'] };

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
/** The addresses copied silently on a renewal's emails: valid ones only, never the tenant's own. */
const bccFor = (s, r) => [...new Set((s.bcc || []).map((x) => String(x).trim().toLowerCase()))]
  .filter((x) => EMAIL.test(x) && x !== String(r.lease.email || '').toLowerCase());

export async function settings() {
  const s = await db.prepare('SELECT * FROM lease_renewal_settings WHERE id = 1').get();
  return s ? { ...DEFAULTS, ...s } : { ...DEFAULTS };
}

// ---------- the papers ----------

/**
 * The papers the tenant has sent so far against what saifsys will make: the signed agreement
 * and, for a lease paid by cheque, one cheque per payment in the schedule, the right amount,
 * dated within three days, payable to the landlord. Returns what is still missing and what
 * is wrong; both empty means it is complete.
 */
export function checkPapers(r, received, payee) {
  const missing = [];
  const wrong = [];
  if (received.agreement !== 'signed') missing.push(received.agreement === 'unsigned' ? 'your signature on the tenancy contract (the copy you sent is not signed)' : 'the signed tenancy contract');
  if (r.lease.payment_method === 'cheque' && r.quote) {
    const got = [...(received.cheques || [])];
    for (const want of r.quote.cheques) {
      const i = got.findIndex((g) => g.amount !== null && Math.abs(g.amount - want.amount) < 1 && g.date && Math.abs(daysBetween(want.date, g.date)) <= 3);
      if (i < 0) { missing.push(`a cheque of ${aed(want.amount)} dated ${longDate(want.date)}`); continue; }
      const [g] = got.splice(i, 1);
      if (payee && g.payee && !samePayee(g.payee, payee)) wrong.push(`The cheque of ${aed(g.amount)} dated ${longDate(g.date)} is payable to "${g.payee}". It must be payable to ${payee}.`);
      if (g.signed === false) wrong.push(`The cheque of ${aed(g.amount)} dated ${longDate(g.date)} is not signed.`);
    }
    for (const g of got) wrong.push(`A cheque of ${g.amount !== null ? aed(g.amount) : 'an amount we could not read'}${g.date ? ` dated ${longDate(g.date)}` : ''} does not match any payment in the schedule.`);
  }
  return { missing, wrong, complete: !missing.length && !wrong.length };
}

const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const samePayee = (a, b) => { const x = letters(a); const y = letters(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };

/**
 * Papers from one email added to what came before: a signed agreement stays signed, and a
 * cheque dated the same day as one sent before replaces it (a corrected cheque), whatever
 * its amount. A cheque with no readable date replaces one of the same amount and no date.
 */
export function addPapers(before, read) {
  const agreement = before.agreement === 'signed' || read.agreement === 'signed' ? 'signed'
    : before.agreement === 'unsigned' || read.agreement === 'unsigned' ? 'unsigned' : 'none';
  const cheques = [...(before.cheques || [])];
  for (const ch of read.cheques || []) {
    const i = cheques.findIndex((k) => (ch.date ? k.date === ch.date : !k.date && k.amount === ch.amount));
    if (i >= 0) cheques[i] = ch; else cheques.push(ch);
  }
  return { agreement, cheques };
}

// ---------- the renewals ----------

const N = (v) => (v === null || v === undefined ? null : Number(v));
const ROW = (r) => r && {
  ...r, offer: N(r.offer), agreed: N(r.agreed), tenant_offer: N(r.tenant_offer), rera_pct: N(r.rera_pct),
  last_out_at: N(r.last_out_at), last_in_at: N(r.last_in_at), created_at: N(r.created_at), updated_at: N(r.updated_at),
};
export const getRenewal = async (id) => ROW(await db.prepare('SELECT * FROM lease_renewals WHERE id = ?').get(Number(id) || 0));

const JSON_COLS = ['lease', 'rent_source', 'quote', 'received', 'papers', 'plan'];
async function update(id, fields) {
  const keys = Object.keys(fields);
  await db.prepare(`UPDATE lease_renewals SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = ?`)
    .run(...keys.map((k) => (JSON_COLS.includes(k) && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k])), id);
  return getRenewal(id);
}

/** A line on the timeline that is not an email. */
async function step(r, title, { user = null, data = null } = {}) {
  await db.prepare(`INSERT INTO lease_renewal_events (renewal_id, kind, title, data, user_id, at) VALUES (?, 'step', ?, ?, ?, ?)`)
    .run(r.id, title, data ? JSON.stringify(data) : null, user?.id || null, secs());
  await mirror(r, `${title}${user?.name ? ` (${user.name})` : ''}`);
}

/** Who hears about renewals: the masters and everyone ticked for the module. */
async function holders() {
  const rows = await db.prepare(`SELECT id FROM users WHERE NOT disabled AND (role = 'master'
    OR (NOT external AND id IN (SELECT user_id FROM module_access WHERE module = 'renewals')))`).all();
  return rows.map((r) => r.id);
}

async function tell(r, body) {
  D.push(await holders(), { title: `${r.lease.building} ${r.lease.unit}`, body, url: `/?renewals=${r.id}`, tag: `renewal-${r.id}` })?.catch?.(() => {});
}

/** Something broke on an automatic renewal: Reem stops on it, says why, and staff take it from here. */
async function stopAuto(r, reason) {
  if (r.auto) {
    await update(r.id, { auto: false });
    await step(r, `Reem stopped: ${reason}`);
  }
  await tell(r, `Reem stopped on this lease: ${reason}. Please take it from here.`);
}

/** saifsys's leases ending within 150 days, as they are now. */
async function dueLeases() {
  const { leases = [] } = await D.ask('realestate', 'renewals_due', { days: DAYS_AHEAD });
  return leases;
}

// ---------- the emails ----------

const subjectOf = (r) => `Lease renewal: ${r.lease.building}, Unit ${r.lease.unit}`;
const SIGN = ['', 'Kind regards,', 'Tenant Care Team'];
const dear = (r) => `Dear ${r.lease.tenant || 'Tenant'},`;

const schedule = (q) => q.cheques.map((ch, i) => `  ${i + 1}. ${longDate(ch.date)}: ${aed(ch.amount)}${ch.type !== 'rent' ? ' (renewal charges)' : ''}`);

/**
 * The offer, charge by charge: each with its VAT, the Ejari fee, the total, and the cheques.
 * When saifsys laid the cheques out Reem's way (fees, VAT and Ejari in the first; rent and
 * chiller split in whole dirhams) each cheque says what it is made of.
 */
function offerLines(q, rent) {
  const c = chargesOf(q);
  const rera = Number(q.rera) || 0;
  const total = q.grand_total != null ? round2(q.grand_total) : round2(c.total + rera);
  const parts = chequeParts(q, rent, c);
  return [
    `- Period: ${longDate(q.start_date)} to ${longDate(q.end_date)}`,
    `- Annual rent: ${aed(rent)}`,
    ...c.items.map((x) => `- ${x.label}: ${aed(x.amount)}${x.vat ? ` + ${c.onCharges ? '5% ' : ''}VAT ${aed(x.vat)} = ${aed(x.amount + x.vat)}` : ''}`),
    ...(c.vat && !c.onCharges ? [`- VAT: ${aed(c.vat)}`] : []),
    ...(rera ? [`- Ejari fee: ${aed(rera)}`] : []),
    `- Total: ${aed(total)}`,
    `- Payment by ${q.cheques.length} cheque${q.cheques.length > 1 ? 's' : ''}:`,
    ...(parts || schedule(q)),
  ];
}

/**
 * Each cheque and what it is made of, when the cheques are laid out Reem's way: the first
 * carries the rent and chiller left over from whole dirhams, every fee with its VAT and the
 * Ejari fee; the others the rent and chiller alone. null when saifsys's cheques are not
 * laid out so (a renewal started before), and the plain list is shown instead.
 */
export function chequeParts(q, rent, c = chargesOf(q)) {
  const ch = q.cheques || [];
  const n = ch.length;
  if (!n || ch.some((x) => x.type !== 'rent')) return null;
  const chiller = c.items.find((x) => x.key === 'chiller');
  const chAmount = chiller?.amount || 0;
  const rentPer = Math.floor(rent / n);
  const chPer = Math.floor(chAmount / n);
  const per = rentPer + chPer;
  const rera = Number(q.rera) || 0;
  const firstRent = round2(rent - rentPer * (n - 1));
  const firstCh = round2(chAmount - chPer * (n - 1));
  const fees = c.items.filter((x) => x.key !== 'chiller');
  const first = round2(firstRent + firstCh + (chiller?.vat || 0) + fees.reduce((t, x) => t + x.amount + x.vat, 0) + rera);
  if (Math.abs(ch[0].amount - first) > 0.05 || ch.slice(1).some((x) => Math.abs(x.amount - per) > 0.01)) return null;
  const firstBits = [
    `rent ${aed(firstRent)}`,
    ...(chiller ? [`chiller ${aed(firstCh)}`, ...(chiller.vat ? [`chiller VAT ${aed(chiller.vat)}`] : [])] : []),
    ...fees.map((x) => `${x.label.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase())}${x.vat ? ' with VAT' : ''} ${aed(x.amount + x.vat)}`),
    ...(rera ? [`Ejari fee ${aed(rera)}`] : []),
  ];
  const restBits = chiller ? ` (rent ${aed(rentPer)} + chiller ${aed(chPer)})` : '';
  return ch.map((x, i) => (i === 0
    ? `  1. ${longDate(x.date)}: ${aed(x.amount)} (${firstBits.join(' + ')})`
    : `  ${i + 1}. ${longDate(x.date)}: ${aed(x.amount)}${restBits}`));
}

/** The renewal's charges one by one, as saifsys charges them. */
const CHARGES = [['chiller', 'Chiller fee'], ['admin', 'Admin fee'], ['parking', 'Additional parking slot'], ['small_store', 'Small storeroom'], ['big_store', 'Big storeroom'], ['ev', 'EV charger']];
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * The charges, their VAT and the total, from saifsys's own quote. The VAT is what saifsys
 * added (its grand total less the rent, the charges and the Ejari fee), never worked out
 * here, so it is always what the tenant will be asked to pay. Each charge carries its share
 * of it, the last taking what rounding leaves, so the shares add up to saifsys's VAT.
 */
export function chargesOf(q) {
  const f = q?.fees || {};
  const items = CHARGES.filter(([k]) => Number(f[k]) > 0).map(([k, label]) => ({ key: k, label, amount: round2(f[k]), vat: 0 }));
  const base = round2(items.reduce((t, c) => t + c.amount, 0));
  const rent = Number(q?.proposed_rent) || 0;
  const vat = q?.grand_total != null ? Math.max(0, round2(Number(q.grand_total) - rent - base - (Number(q.rera) || 0))) : 0;
  // 5% of the charges alone: say so, so nobody thinks the rent carries VAT.
  const onCharges = base > 0 && Math.abs(vat - round2(base * 0.05)) < 0.02;
  if (onCharges) {
    let left = vat;
    items.forEach((x, i) => { x.vat = i === items.length - 1 ? round2(left) : round2(x.amount * 0.05); left -= x.vat; });
  }
  return { items, base, vat, onCharges, total: round2(rent + base + vat) };
}

const offerText = (r, q, rent) => [dear(r), '',
  `Your tenancy of ${r.lease.building}, Unit ${r.lease.unit} ends on ${longDate(r.lease.end_date)}, and we would be glad to renew it.`, '',
  'Our renewal offer:', ...offerLines(q, rent), '',
  `Please reply to this email by ${replyBy()}:`,
  '- to accept, simply reply "I accept";',
  '- or tell us what you would like to propose.', '',
  'The terms of the renewal and the documents we will need are in the attached letter.', ...SIGN].join('\n');

const counterText = (r, q, rent) => [dear(r), '',
  'Thank you for your reply.', '',
  `We have looked at it carefully and can offer the renewal at ${aed(rent)} a year:`,
  ...offerLines(q, rent), '',
  'Please reply to this email to accept, or let us know your thoughts.', ...SIGN].join('\n');

const indexText = (r, q, rent) => [dear(r), '',
  'Thank you for your reply.', '',
  `We have reviewed the rent against the RERA Rental Index for your unit, and we offer the renewal at ${aed(rent)} a year, as the index allows:`,
  ...offerLines(q, rent), '',
  'Please reply to this email to accept.', ...SIGN].join('\n');

const agreedText = (r, q, rent, payee) => [dear(r), '',
  `Thank you. We are pleased to confirm the renewal of ${r.lease.building}, Unit ${r.lease.unit} at ${aed(rent)} a year.`, '',
  'To complete it, please reply to this email with:',
  '1. The attached tenancy contract, signed (a scan or a clear photo of each page is fine).',
  ...(r.lease.payment_method === 'cheque' ? [`2. Clear photos of the cheques below${payee ? `, payable to ${payee}` : ''}:`, ...schedule(q)] : []),
  ...(q.required_documents_text ? ['', 'And, if they have changed or expired since your last contract:', ...q.required_documents_text.split('\n').filter(Boolean).map((d) => `- ${d}`)] : []), '',
  ...(r.lease.payment_method === 'cheque' ? ['Please keep the original cheques ready: we will collect them before the new term starts.', ''] : []),
  ...SIGN.slice(1)].join('\n');

const fixText = (r, check) => [dear(r), '',
  'Thank you for sending these. To complete your renewal:', '',
  ...(check.wrong.length ? ['Please correct:', ...check.wrong.map((w) => `- ${w}`), ''] : []),
  ...(check.missing.length ? ['Still missing:', ...check.missing.map((m) => `- ${m[0].toUpperCase()}${m.slice(1)}`), ''] : []),
  'Please reply to this email with them.', ...SIGN].join('\n');

const doneText = (r) => [dear(r), '',
  `Your renewal of ${r.lease.building}, Unit ${r.lease.unit} is complete: ${aed(r.agreed)} a year from ${longDate(r.quote.start_date)} to ${longDate(r.quote.end_date)}.`, '',
  r.lease.payment_method === 'cheque' ? 'We will be in touch to collect the original cheques, and we will register the new tenancy contract with Ejari.' : 'We will register the new tenancy contract with Ejari.', '',
  'Thank you for staying with us.', ...SIGN].join('\n');

const notRenewingText = (r) => [dear(r), '',
  `Thank you for letting us know that you will not renew your tenancy of ${r.lease.building}, Unit ${r.lease.unit}.`, '',
  `Your tenancy ends on ${longDate(r.lease.end_date)}. Our team will contact you about the move-out inspection and the handover of the keys.`,
  ...SIGN].join('\n');

const replyText = (r, words) => [dear(r), '', String(words || '').trim(), ...SIGN].join('\n');

const reminderText = (r, payee) => (['agreed', 'papers_ok'].includes(r.status)
  ? [dear(r), '', `A reminder that your renewal of ${r.lease.building}, Unit ${r.lease.unit} at ${aed(r.agreed)} a year is waiting for:`,
    ...checkPapers(r, r.received || {}, payee).missing.map((m) => `- ${m}`), '', 'Please reply to this email with them.', ...SIGN].join('\n')
  : [dear(r), '', `A reminder about the renewal of your tenancy of ${r.lease.building}, Unit ${r.lease.unit}, which ends on ${longDate(r.lease.end_date)}.`, '',
    `Our offer is ${aed(r.offer)} a year. Please reply to this email to accept, or tell us what you would like to propose.`, ...SIGN].join('\n'));

const keep = async (renewalId, eventId, { name, mime, buffer }) => {
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/${randomUUID()}.${FILE_TYPES[mime]}`;
  await writeFile(path, buffer);
  const { id } = await db.prepare('INSERT INTO lease_renewal_files (renewal_id, event_id, name, mime, path) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .run(renewalId, eventId, String(name || 'file').slice(0, 200), mime, path);
  return id;
};

/**
 * One email to the tenant, on the renewal's thread, and its line on the timeline. Saved with
 * its exact bytes first, so a failure is retried with the same Message-ID by the next tick.
 */
async function mail(r, { title, text, attachments = [], user = null, data = null }) {
  const acc = await inbox();
  const thread = await db.prepare(`SELECT message_id FROM lease_renewal_events WHERE renewal_id = ? AND message_id IS NOT NULL ORDER BY id`).all(r.id);
  const ids = thread.map((t) => t.message_id);
  const subject = ids.length ? replySubject(subjectOf(r)) : subjectOf(r);
  const bcc = bccFor(await settings(), r);
  const m = await compose({
    from: { name: 'Tenant Care', address: acc ? acc.email : 'tenant-care@invalid' }, to: [r.lease.email], bcc, subject, text, attachments,
    ...(ids.length ? { inReplyTo: ids[ids.length - 1], references: ids.join(' ') } : {}),
  });
  const { id } = await db.prepare(`INSERT INTO lease_renewal_events (renewal_id, kind, title, body, subject, message_id, raw, status, error, data, user_id, at)
    VALUES (?, 'out', ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?) RETURNING id`)
    .run(r.id, title, text, subject, m.messageId, m.raw, acc ? 'Not sent yet' : 'The Tenant care inbox is not connected.',
      data ? JSON.stringify(data) : null, user?.id || null, secs());
  for (const a of attachments) await keep(r.id, id, { name: a.filename, mime: a.contentType, buffer: Buffer.from(a.content, 'base64') });
  await update(r.id, { last_out_at: secs() });
  if (acc) await deliver(acc, id, m);
  await mirror(r, `Email to the tenant: ${title}`, { text });
  return id;
}

async function deliver(acc, id, m) {
  try {
    await D.send(acc, decrypt(acc.password_enc), m);
    await db.prepare(`UPDATE lease_renewal_events SET status = 'sent', error = NULL WHERE id = ?`).run(id);
    await D.file(acc, m.raw).catch((e) => console.warn('[lease renewals] could not file in Sent:', e.message));
  } catch (e) {
    await db.prepare(`UPDATE lease_renewal_events SET status = 'failed', error = ? WHERE id = ?`).run(String(friendlySmtp(e, acc.smtp_host)).slice(0, 500), id);
  }
}

/** Emails that could not go out, tried again with the same bytes. */
async function resend() {
  const acc = await inbox();
  if (!acc) return 0;
  const rows = await db.prepare(`SELECT e.id, e.raw, r.lease FROM lease_renewal_events e JOIN lease_renewals r ON r.id = e.renewal_id
    WHERE e.kind = 'out' AND e.status = 'failed' ORDER BY e.id LIMIT 20`).all();
  const s = await settings();
  for (const x of rows) await deliver(acc, x.id, { raw: x.raw, envelope: { from: acc.email, to: [x.lease.email, ...bccFor(s, x)] } });
  return rows.length;
}

// ---------- saifsys ----------

/**
 * saifsys records each step under one of its users, found by email. Renewals are Tenant
 * care's, so they are recorded as the saifsys user with the Tenant care inbox's email,
 * never as the person who tapped.
 */
async function actingEmail() {
  const email = String((await D.actor()) || '').trim().toLowerCase();
  if (!email) throw bad('The Tenant care inbox is not connected, so saifsys cannot record the renewal. Connect it under Tenant care.', 409);
  return email;
}

const saifsys = async (action, body) => D.act('realestate_renewal', action, { email: await actingEmail(), ...body });

/**
 * The story kept in saifsys too, so anyone opening the renewal there sees it: a line on its
 * log for each email and step (the email itself in its notes), and the tenant's papers with
 * its tenant uploads. Never in the way: a copy that fails is only noted in the server log.
 */
async function mirror(r, message, { text = null, files = [] } = {}) {
  if (!r.workflow_id) return;
  try {
    await D.mirror('note', { workflow_id: r.workflow_id, message: message.slice(0, 500), ...(text ? { text } : {}) });
    for (const f of files) await D.mirror('file', { workflow_id: r.workflow_id, name: f.name, mime: f.mime, data: f.data });
  } catch (e) {
    console.warn(`[lease renewals] could not copy to saifsys renewal #${r.workflow_id}:`, e.message);
  }
}

/** saifsys's own cheques and charges for a renewal at this rent. Nothing is saved. */
/** The charges to ask saifsys for: null keeps the old lease's, 0 is none. */
const feesOf = (f = {}) => ({
  admin_fees: f.admin ?? null, chiller_charges: f.chiller ?? null,
  additional_parking_fee: f.parking ?? null, small_store_fee: f.small_store ?? null, big_store_fee: f.big_store ?? null,
  ev_fee: f.ev ?? null,
});

async function quoteFor(lease, rent, cheques, fees) {
  const { quote } = await saifsys('quote', { lease_id: lease.lease_id, end_date: lease.end_date, rent, cheques, ...feesOf(fees) });
  return quote;
}

/** The fees a new renewal of this lease starts with (the old lease's), for the Start box. */
export async function startFees(leaseId) {
  const lease = (await dueLeases()).find((l) => l.lease_id === Number(leaseId));
  if (!lease) throw bad(`That lease is not in saifsys's list of leases ending within ${DAYS_AHEAD} days.`, 404);
  const q = await quoteFor(lease, Math.round(Number(lease.annual_rent)) || 1, lease.cheques || 4);
  // saifsys's VAT on the extra charges for this building: 5%, or none where it is switched off.
  const c = chargesOf(q);
  const vatRate = c.base > 0 && c.vat === 0 ? 0 : 5;
  // The admin fee starts at 1,500 for every renewal (the user's rule); the person can change it.
  return { ...(q.fees || { admin: 0, chiller: 0, chiller_shown: false }), admin: DEFAULT_ADMIN, vat_rate: vatRate, rera: Number(q.rera) || 0 };
}

// ---------- what a person does: a draft first, then Send ----------

/**
 * Each answer to a tenant. draft() writes the email for the person to read (and change);
 * send() sends what they approved and moves the renewal, and saifsys, along. start opens
 * a renewal; the rest act on one.
 */
const ACTIONS = {
  start: { from: null, title: (rent) => `Offer sent · ${aed(rent)}` },
  counter: { from: ['offer_sent', 'negotiating'], title: (rent) => `Counter-offer · ${aed(rent)}` },
  index: { from: ['offer_sent', 'negotiating'], title: (rent) => `RERA index rent offered · ${aed(rent)}` },
  accept: { from: ['offer_sent', 'negotiating'], title: (rent) => `Agreed · ${aed(rent)}` },
  not_renewing: { from: ['offer_sent', 'negotiating', 'agreed', 'papers_ok'], title: () => 'Not renewing' },
  reply: { from: OPEN, title: () => 'Reply sent' },
  fix: { from: ['agreed'], title: () => 'Asked to fix the papers' },
  convert: { from: ['agreed', 'papers_ok'], title: (rent) => `Renewed in saifsys · ${aed(rent)}` },
};

const rentOf = (v) => {
  const n = Math.round(Number(v));
  if (!(n > 0)) throw bad('Type the yearly rent in AED.');
  return n;
};

/** The renewal (or, for start, the lease) a draft or a send is about, and the figures it needs. */
async function prepare({ id, lease_id: leaseId, action, rent, cheques, pct, rera_pct: rawPct, words, admin_fees: adminFee, chiller_charges: chillerFee,
  additional_parking_fee: parkingFee, small_store_fee: smallFee, big_store_fee: bigFee, ev_fee: evFee }) {
  const a = ACTIONS[action];
  if (!a) throw bad('Unknown step.');
  const s = await settings();
  let r;
  if (action === 'start') {
    const lease = (await dueLeases()).find((l) => l.lease_id === Number(leaseId));
    if (!lease) throw bad(`That lease is not in saifsys's list of leases ending within ${DAYS_AHEAD} days.`, 404);
    if (lease.saifsys_renewal) throw bad(`The staff already have a renewal for this lease in saifsys (${lease.saifsys_renewal}).`, 409);
    if (!String(lease.email || '').includes('@')) throw bad('saifsys has no email for this tenant. Add it in saifsys first.', 409);
    if (await db.prepare('SELECT 1 FROM lease_renewals WHERE lease_id = ? AND end_date = ?').get(lease.lease_id, lease.end_date)) throw bad('This renewal has already started.', 409);
    r = { id: null, lease, status: null };
  } else {
    r = await getRenewal(id);
    if (!r) throw bad('Renewal not found', 404);
    if (!a.from.includes(r.status)) throw bad(`This renewal is ${r.status.replace('_', ' ')}: that step is not open.`, 409);
  }
  const n = Math.min(12, Math.max(1, Math.round(Number(cheques) || r.cheques || r.lease.cheques || 4)));
  let amount = null;
  let source = null;
  if (action === 'start' || action === 'counter') { amount = rentOf(rent); source = { kind: 'manual' }; }
  if (action === 'index') {
    const api = await D.indexRent(r.lease);
    if (api) { amount = api.rent; source = { kind: 'dld_api', ...api }; }
    else if (pct !== undefined && pct !== null && pct !== '') {
      const p = Number(pct);
      if (!(p >= 0 && p <= 20)) throw bad('The increase the index allows is 0 to 20%.');
      amount = indexRentFrom(r.lease.annual_rent, p); source = { kind: 'rera_index', pct: p };
    } else { amount = rentOf(rent); source = { kind: 'rera_index' }; }
  }
  if (action === 'accept') amount = rent ? rentOf(rent) : (r.tenant_offer ?? r.offer);
  if (action === 'convert') amount = r.agreed;
  // Start takes the fees the person typed; later steps keep the renewal's.
  const fee = (v) => (v === undefined || v === null || v === '' ? null : Math.max(0, Math.round(Number(v) * 100) / 100));
  const fees = action === 'start' ? { admin: fee(adminFee), chiller: fee(chillerFee), parking: fee(parkingFee), small_store: fee(smallFee), big_store: fee(bigFee), ev: fee(evFee) } : r.quote?.fees;
  const quote = amount && action !== 'convert' ? (action !== 'accept' || amount !== r.offer || !r.quote ? await quoteFor(r.lease, amount, n, fees) : r.quote) : r.quote;

  let text;
  // The offer carries saifsys's own renewal notice, made by saifsys when the renewal starts.
  if (action === 'start') text = offerText(r, quote, amount);
  if (action === 'counter') text = counterText(r, quote, amount);
  if (action === 'index') text = indexText(r, quote, amount);
  // The agreement is saifsys's own tenancy contract for the new lease, made when it is sent.
  if (action === 'accept') text = agreedText(r, quote, amount, s.payee);
  if (action === 'not_renewing') text = notRenewingText(r);
  if (action === 'reply') text = replyText(r, words || '');
  if (action === 'fix') text = fixText(r, r.papers || checkPapers(r, r.received || {}, s.payee));
  if (action === 'convert') text = doneText(r);
  // Start: the increase the RERA index allows, as the person read it off DLD's calculator.
  let rera = null;
  if (action === 'start' && rawPct !== undefined && rawPct !== null && rawPct !== '') {
    rera = Number(rawPct);
    if (!(rera >= 0 && rera <= 20)) throw bad('The increase the RERA index allows is 0 to 20%.');
  }
  const sendOn = action === 'start' ? sendDate(r.lease) : null;
  return { r, a, s, amount, cheques: n, source, quote, fees, text, rera, sendOn: sendOn > today() ? sendOn : null };
}

/** The day the offer goes: 120 days before the lease ends. */
const sendDate = (lease) => addDays(lease.end_date, -SEND_AT);
const replyBy = () => longDate(addDays(today(), 14));

const contractName = (r) => `Tenancy contract - ${r.lease.building} ${r.lease.unit}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
const noticeName = (r) => `Renewal notice - ${r.lease.building} ${r.lease.unit}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');

/** The email a step would send, for the person to read. Nothing is sent or saved. */
export async function draft(user, body) {
  const p = await prepare(body);
  if (body.action === 'reply' && !body.words) {
    const last = await db.prepare(`SELECT reading FROM lease_renewal_events WHERE renewal_id = ? AND kind = 'in' ORDER BY id DESC LIMIT 1`).get(p.r.id || 0);
    if (last?.reading?.suggestedReply) p.text = replyText(p.r, last.reading.suggestedReply);
  }
  return {
    to: p.r.lease.email, subject: subjectOf(p.r), text: p.text, rent: p.amount, cheques: p.cheques, source: p.source,
    schedule: p.quote?.cheques || null, total: p.quote?.cheques_total ?? null,
    fees: p.quote?.fees || null, charges: p.quote ? chargesOf(p.quote) : null,
    attachments: body.action === 'start' ? [noticeName(p.r)] : body.action === 'accept' ? [contractName(p.r)] : [],
    sendOn: p.sendOn,
  };
}

/**
 * The offer itself, for a renewal not yet sent: saifsys makes its renewal at this rent, and
 * the email goes with saifsys's own notice. A person's Send, or Reem on the day.
 */
async function sendOffer(r, { text, fees, user = null }) {
  const { renewal } = await saifsys('start', { lease_id: r.lease.lease_id, end_date: r.lease.end_date, rent: r.offer, cheques: r.cheques, ...feesOf(fees) });
  // Never an offer without saifsys's notice. Trying again picks up the same saifsys renewal.
  if (!renewal.notice?.data) throw bad('saifsys did not send its renewal notice PDF, so nothing was emailed. Check the latest realestate_renewal.php is uploaded to saifsys, then try again.', 502);
  r = await update(r.id, { status: 'offer_sent', workflow_id: renewal.workflow_id, plan: null, waiting: null, error: null });
  const attachments = [{ filename: noticeName(r), contentType: 'application/pdf', content: renewal.notice.data }];
  await mail(r, { title: ACTIONS.start.title(r.offer), text, attachments, user, data: { rent: r.offer, source: r.rent_source } });
  return getRenewal(r.id);
}

/** A scheduled offer sent now: on its day by Reem, or when a person taps Send now. */
async function sendPlanned(r, user = null) {
  const lease = (await dueLeases()).find((l) => l.lease_id === r.lease_id && l.end_date === r.end_date);
  if (!lease) throw bad('saifsys no longer lists this lease as ending, so nothing was sent.', 409);
  if (lease.saifsys_renewal) throw bad(`The staff started a renewal for this lease in saifsys (${lease.saifsys_renewal}), so nothing was sent.`, 409);
  // The reply-by date in the words moves to two weeks from the day it goes.
  const text = String(r.plan?.text || '').split(r.plan?.by || '\u0000').join(replyBy());
  return sendOffer(r, { text, fees: r.plan?.fees, user });
}

/** Send what the person approved, and move the renewal (and saifsys) along with it. */
export async function send(user, body) {
  const p = await prepare(body);
  const text = String(body.text || '').trim() || p.text;
  if (body.action === 'reply' && !String(body.text || '').trim()) throw bad('Write the reply first.');
  const attachments = [];
  const title = p.a.title(p.amount);
  const { s } = p;
  let r = p.r;

  if (body.action === 'start') {
    // Reem runs it from here when the person gave the RERA index; without it, a person does.
    const auto = p.rera !== null && body.auto !== false;
    if (p.sendOn) {
      // Too early for the offer: kept, with its words, and sent by Reem on the day.
      const made = await db.prepare(`INSERT INTO lease_renewals (lease_id, end_date, lease, status, offer, cheques, rent_source, quote, started_by, rera_pct, auto, plan)
        VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (lease_id, end_date) DO NOTHING RETURNING id`)
        .get(r.lease.lease_id, r.lease.end_date, JSON.stringify(r.lease), p.amount, p.cheques, JSON.stringify(p.source), JSON.stringify(p.quote),
          user?.id || null, p.rera, auto, JSON.stringify({ text, fees: p.fees, by: replyBy() }));
      if (!made) throw bad('This renewal has already started.', 409);
      r = await getRenewal(made.id);
      await step(r, `Offer ready: Reem sends it on ${longDate(p.sendOn)}`, { user });
      return r;
    }
    const made = await db.prepare(`INSERT INTO lease_renewals (lease_id, end_date, lease, status, offer, cheques, rent_source, quote, started_by, rera_pct, auto)
      VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (lease_id, end_date) DO NOTHING RETURNING id`)
      .get(r.lease.lease_id, r.lease.end_date, JSON.stringify(r.lease), p.amount, p.cheques, JSON.stringify(p.source), JSON.stringify(p.quote),
        user?.id || null, p.rera, auto);
    if (!made) throw bad('This renewal has already started.', 409);
    try {
      return await sendOffer(await getRenewal(made.id), { text, fees: p.fees, user });
    } catch (e) {
      // Nothing went: the lease is free to start again.
      await db.prepare(`DELETE FROM lease_renewals WHERE id = ? AND status = 'scheduled'`).run(made.id);
      throw e;
    }
  }

  if (body.action === 'counter' || body.action === 'index') {
    await saifsys('rent', { workflow_id: r.workflow_id, rent: p.amount, cheques: p.cheques, note: `${RENT_SOURCES[p.source.kind]}${p.source.pct !== undefined ? ` (+${p.source.pct}%)` : ''}` });
    await saifsys('status', { workflow_id: r.workflow_id, status: 'negotiation' });
    r = await update(r.id, { status: 'negotiating', offer: p.amount, cheques: p.cheques, rent_source: p.source, quote: p.quote, tenant_offer: null, waiting: null, reminders: 0 });
    await mail(r, { title, text, user, data: { rent: p.amount, source: p.source } });
    return getRenewal(r.id);
  }

  if (body.action === 'accept') {
    if (p.amount !== r.offer || p.cheques !== r.cheques) await saifsys('rent', { workflow_id: r.workflow_id, rent: p.amount, cheques: p.cheques, note: 'Agreed with the tenant' });
    // Made after the rent is set, so the contract carries the agreed figures. Nothing goes without it.
    const { contract } = await saifsys('contract', { workflow_id: r.workflow_id });
    if (!contract?.data) throw bad('saifsys did not send the tenancy contract PDF, so nothing was emailed. Check the contract template in saifsys, then tap Send again.', 502);
    attachments.push({ filename: contractName(r), contentType: 'application/pdf', content: contract.data });
    await saifsys('status', { workflow_id: r.workflow_id, status: 'accepted', note: `Agreed by email at ${aed(p.amount)} a year` });
    r = await update(r.id, { status: 'agreed', agreed: p.amount, offer: p.amount, cheques: p.cheques, quote: p.quote, received: {}, papers: null, waiting: null, reminders: 0 });
    await mail(r, { title, text, attachments, user, data: { rent: p.amount } });
    return getRenewal(r.id);
  }

  if (body.action === 'not_renewing') {
    await saifsys('status', { workflow_id: r.workflow_id, status: 'rejected', note: 'The tenant is not renewing' });
    r = await update(r.id, { status: 'not_renewing', waiting: null });
    await mail(r, { title, text, user });
    return getRenewal(r.id);
  }

  if (body.action === 'convert') {
    const { renewal } = await saifsys('convert', { workflow_id: r.workflow_id, expected_total: r.quote.cheques_total });
    r = await update(r.id, { status: 'converted', waiting: null, error: null });
    await mail(r, { title, text, user, data: { saifsys: renewal } });
    await D.todo(user?.id || r.started_by || (await holders())[0], {
      text: `${r.lease.payment_method === 'cheque' ? 'Collect the original cheques and register' : 'Register'} the Ejari for ${r.lease.building} ${r.lease.unit}`,
      notes: `Renewed by email at ${aed(r.agreed)} a year, ${longDate(r.quote.start_date)} to ${longDate(r.quote.end_date)}. saifsys renewal #${r.workflow_id}.`,
    }).catch((e) => console.warn('[lease renewals] to-do:', e.message));
    return getRenewal(r.id);
  }

  // reply / fix: an email, nothing else moves.
  r = await update(r.id, { waiting: null, reminders: 0 });
  await mail(r, { title, text, user });
  return getRenewal(r.id);
}

/** Steps without an email: the papers are fine, the tenant's email needs no answer, or the person takes it from here. */
export async function mark(user, id, what) {
  const r = await getRenewal(id);
  if (!r) throw bad('Renewal not found', 404);
  if (what === 'papers_ok') {
    if (r.status !== 'agreed') throw bad('Only an agreed renewal has papers to check.', 409);
    await step(r, 'Papers checked and OK', { user });
    return update(r.id, { status: 'papers_ok', waiting: null });
  }
  if (what === 'seen') {
    await step(r, 'Read, no reply needed', { user });
    return update(r.id, { waiting: null });
  }
  if (what === 'send_now') {
    if (r.status !== 'scheduled') throw bad('The offer has already gone.', 409);
    return sendPlanned(r, user);
  }
  if (what === 'unschedule') {
    if (r.status !== 'scheduled') throw bad('The offer has already gone: use Handle outside Reem instead.', 409);
    await db.prepare(`DELETE FROM lease_renewals WHERE id = ? AND status = 'scheduled'`).run(r.id);
    return null;
  }
  if (what === 'auto_on' || what === 'auto_off') {
    const on = what === 'auto_on';
    if (on === r.auto) return r;
    await step(r, on ? 'Handed back to Reem' : 'Taken over: staff run it by hand', { user });
    return update(r.id, { auto: on, ...(on ? { error: null } : {}) });
  }
  if (what === 'close') {
    if (!OPEN.includes(r.status) && r.status !== 'scheduled') throw bad('This renewal is already finished.', 409);
    await step(r, 'Closed: handled outside Reem', { user });
    return update(r.id, { status: 'closed', waiting: null });
  }
  throw bad('Unknown step.');
}

// ---------- the tenant's emails ----------

/**
 * Called by Tenant care for every new email in its inbox. An answer on a renewal's thread,
 * or from the tenant of a renewal under way, is kept here to be read and Tenant care leaves
 * it alone. Returns whether it was one.
 */
export async function claim(m, uidValidity) {
  const ids = [m.inReplyTo, ...String(m.refs || '').split(/\s+/)].filter(Boolean);
  let r = ids.length && await db.prepare(`SELECT r.id FROM lease_renewal_events e JOIN lease_renewals r ON r.id = e.renewal_id
    WHERE e.kind = 'out' AND e.message_id = ANY(?::text[]) ORDER BY r.id DESC LIMIT 1`).get(ids);
  const via = r ? 'thread' : 'sender';
  if (!r) {
    r = await db.prepare(`SELECT id FROM lease_renewals WHERE lower(lease->>'email') = ? AND status IN ('offer_sent', 'negotiating', 'agreed', 'papers_ok')
      ORDER BY id DESC LIMIT 1`).get(String(m.from || '').toLowerCase());
  }
  if (!r) return false;
  await db.prepare(`INSERT INTO lease_renewal_events (renewal_id, kind, title, body, subject, message_id, ref, status, data, at)
    VALUES (?, 'in', 'Tenant replied', ?, ?, ?, ?, 'new', ?, ?) ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING`)
    .run(r.id, tenantWords(m.text).slice(0, 20000), String(m.subject || '').slice(0, 300), m.messageId || null,
      `${uidValidity}:${m.uid}`, JSON.stringify({ via }), m.at || secs());
  return true;
}
claimTenantMail(claim);

/**
 * What the tenant wrote: their own words above the quoted thread. When there are none, they
 * typed inside the quote (Gmail shows it behind a bar), so it is the quote's start, up to our
 * own email ("Dear ...").
 */
export function tenantWords(text) {
  const own = ownWords(text).replace(/^\s*On .{0,200}wrote:\s*$/gim, '').trim();
  if (own) return own;
  const plain = String(text || '').split('\n').map((l) => l.replace(/^\s*(>\s?)+/, '')).join('\n');
  const parts = plain.split(/^\s*On .{0,200}wrote:\s*$/im);
  const quoted = parts.length > 1 ? parts.slice(1).join('\n') : plain;
  return quoted.split(/^\s*(?:Dear |On .{0,200}wrote:)/im)[0].trim();
}

/** The whole email again, for its attachments: Tenant care only read the first part of it. */
async function fetchMessage(ref) {
  const acc = await inbox();
  if (!acc) return null;
  const [validity, uid] = String(ref).split(':').map(Number);
  return withMailbox(acc, async (c) => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      if (Number(c.mailbox.uidValidity) !== validity) return null;
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
      return m?.source ? simpleParser(m.source) : null;
    } finally { lock.release(); }
  });
}

const factsOf = (r, s) => [
  `Premises: ${r.lease.building}, Unit ${r.lease.unit} (${r.lease.unit_type || 'unit'}). Tenant: ${r.lease.tenant}.`,
  `Current contract: ${longDate(r.lease.start_date)} to ${longDate(r.lease.end_date)}, ${aed(r.lease.annual_rent)} a year, ${r.lease.cheques} cheques.`,
  r.quote ? `Renewal on offer: ${aed(r.agreed ?? r.offer)} a year from ${longDate(r.quote.start_date)} to ${longDate(r.quote.end_date)}, ${r.quote.cheques.length} cheques: ${r.quote.cheques.map((ch) => `${longDate(ch.date)} ${aed(ch.amount)}`).join('; ')}.` : '',
  r.quote?.rera ? `Ejari fee: ${aed(r.quote.rera)}.` : '',
  s.payee ? `Cheques are payable to ${s.payee}.` : '',
  ['agreed', 'papers_ok'].includes(r.status) ? `The rent is agreed at ${aed(r.agreed)}; the tenant still has to send the signed agreement${r.lease.payment_method === 'cheque' ? ' and photos of the cheques' : ''}.` : '',
  r.quote?.terms_text ? `Terms: ${r.quote.terms_text.replace(/\n/g, ' ')}` : '',
  r.quote?.required_documents_text ? `Documents needed: ${r.quote.required_documents_text.replace(/\n/g, '; ')}` : '',
].filter(Boolean).join('\n');

async function history(renewalId, before) {
  const rows = await db.prepare(`SELECT kind, body FROM lease_renewal_events WHERE renewal_id = ? AND id < ? AND kind IN ('out', 'in') ORDER BY id DESC LIMIT 8`).all(renewalId, before);
  return rows.reverse().map((x) => `${x.kind === 'out' ? 'We wrote' : 'Tenant wrote'}: ${String(x.body || '').slice(0, 1500)}`).join('\n\n');
}

async function attachmentsOf(e) {
  const parsed = e.ref ? await D.fetch(e.ref) : null;
  const files = [];
  for (const a of parsed?.attachments || []) {
    const mime = String(a.contentType || '').toLowerCase();
    if (!FILE_TYPES[mime] || !a.content?.length || a.content.length > MAX_FILE) continue;
    const name = a.filename || `file.${FILE_TYPES[mime]}`;
    await keep(e.renewal_id, e.id, { name, mime, buffer: a.content });
    files.push({ name, mime, data: a.content.toString('base64') });
  }
  return files;
}

const SAYS = {
  accept: 'Accepts the offer',
  reject: 'Not renewing',
  question: 'Asks a question',
  documents: 'Sent documents',
};

/** Every new email from a tenant, read: what it says on the timeline, and the renewal waits for a person. */
let reading = null;
export function readInbound() {
  reading ||= readNew().finally(() => { reading = null; });
  return reading;
}
async function readNew() {
  const rows = await db.prepare(`SELECT * FROM lease_renewal_events WHERE kind = 'in' AND status = 'new' ORDER BY id LIMIT 20`).all();
  for (const e of rows) {
    const r = await getRenewal(e.renewal_id);
    try {
      await handle(r, e);
    } catch (err) {
      console.warn('[lease renewals] reading an email failed:', err.message);
      await db.prepare(`UPDATE lease_renewal_events SET status = 'error', error = ? WHERE id = ?`).run(String(err.message).slice(0, 500), e.id);
      await update(r.id, { waiting: 'reply', last_in_at: Number(e.at) || secs() });
      if (r.auto) await stopAuto(r, 'it could not read the tenant\'s email');
      else await tell(r, 'The tenant emailed. Reem could not read it: open the renewal to read it yourself.');
    }
  }
  return rows.length;
}

async function handle(r, e) {
  const s = await settings();
  const files = await attachmentsOf(e);
  if (!e.body && e.ref) { // kept before tenantWords knew to look inside the quote
    e.body = tenantWords((await D.fetch(e.ref))?.text).slice(0, 20000);
    if (e.body) await db.prepare('UPDATE lease_renewal_events SET body = ? WHERE id = ?').run(e.body, e.id);
  }
  const set = (title, reading) => db.prepare(`UPDATE lease_renewal_events SET status = 'read', title = ?, reading = ? WHERE id = ?`).run(title, JSON.stringify(reading), e.id);
  await update(r.id, { last_in_at: Number(e.at) || secs() });

  // Papers for an agreed renewal: read and checked against saifsys's cheque schedule.
  if (['agreed', 'papers_ok'].includes(r.status) && files.length) {
    const docs = await D.readDocs(files);
    const received = addPapers(r.received || {}, docs);
    const check = checkPapers({ ...r, received }, received, s.payee);
    await set(`Tenant sent ${files.length} file${files.length > 1 ? 's' : ''}`, { docs });
    await db.prepare(`INSERT INTO lease_renewal_events (renewal_id, kind, title, data, at) VALUES (?, 'papers', ?, ?, ?)`)
      .run(r.id, check.complete ? 'Papers complete: everything matches' : `Papers: ${check.missing.length + check.wrong.length} thing${check.missing.length + check.wrong.length > 1 ? 's' : ''} to fix`,
        JSON.stringify({ check, docs }), secs());
    await update(r.id, { received, papers: check, waiting: 'papers', status: 'agreed' });
    await mirror(r, `The tenant emailed ${files.length} file${files.length > 1 ? 's' : ''}. ${check.complete ? 'Papers complete.' : `To fix: ${[...check.wrong, ...check.missing].join('; ')}`}`, { text: e.body, files });
    if (r.auto && !s.paused) return autoPapers(await getRenewal(r.id), check);
    return tell(r, check.complete ? 'The papers are complete. Check them and convert in saifsys.' : 'The tenant sent papers: some things need fixing.');
  }

  const reading = await D.readReply({ facts: factsOf(r, s), history: await history(r.id, e.id), text: e.body });
  if (e.data?.via === 'sender' && reading.intent === 'unclear' && !reading.dispute && !reading.asksLess) {
    await set('Tenant emailed (not about the renewal, it seems)', { ...reading, note: 'Matched only by who sent it.' });
    return null;
  }
  const title = reading.intent === 'counter' ? `Tenant asks for ${aed(reading.amount)}` : (reading.summary || SAYS[reading.intent] || 'Tenant replied');
  await set(title, reading);
  await mirror(r, `The tenant replied: ${title}${reading.dispute ? ' (disputes it)' : ''}`, { text: e.body, files });
  await update(r.id, {
    waiting: 'reply',
    ...(reading.intent === 'counter' ? { tenant_offer: reading.amount } : reading.intent === 'accept' ? { tenant_offer: null } : {}),
    ...(reading.dispute ? { dispute: reading.disputeNote || 'The tenant disputes the renewal.' } : {}),
  });
  const auto = s.paused ? null : autoAnswer(r, reading);
  if (auto) {
    try {
      await send(null, { id: r.id, ...auto.ask });
      await tell(r, `${title}. Reem ${auto.did}.`);
    } catch (err) {
      console.warn('[lease renewals] answering by itself failed:', err.message);
      await update(r.id, { waiting: 'reply', error: String(err.message).slice(0, 500) });
      await stopAuto(r, `it could not answer "${title}" (${err.message})`);
    }
  } else {
    await tell(r, `${reading.dispute ? '⚠️ Dispute: ' : ''}${title}${r.auto && !s.paused ? ' (needs you)' : ''}`);
  }
  // A dispute is put to the advisors straight away. Their answer is advice on the timeline,
  // never an email, so it waits for the same person as everything else.
  if (reading.dispute) await askAdvisors(await getRenewal(r.id)).catch((err) => console.warn('[lease renewals] advisors:', err.message));
  return null;
}

/**
 * What Reem answers by itself, on an automatic renewal: an acceptance of the rent on offer
 * gets the contract; a dispute, a counter or a request for less gets the RERA index rent,
 * once (never a counter-offer of Reem's own). Anything else is for a person: null.
 */
export function autoAnswer(r, reading) {
  if (!r.auto || !['offer_sent', 'negotiating'].includes(r.status)) return null;
  if (reading.intent === 'accept' && !reading.dispute) return { ask: { action: 'accept', rent: r.offer }, did: `agreed at ${aed(r.offer)} and sent the contract` };
  const pushback = reading.dispute || reading.intent === 'counter' || reading.asksLess;
  if (pushback && r.rent_source?.kind === 'manual' && r.rera_pct !== null) {
    const index = indexRentFrom(r.lease.annual_rent, r.rera_pct);
    if (index < r.offer) return { ask: { action: 'index', pct: r.rera_pct }, did: `offered the RERA index rent, ${aed(index)}` };
  }
  return null;
}

/** Papers on an automatic renewal: complete ones are renewed in saifsys, others sent back, up to three times. */
async function autoPapers(r, check) {
  try {
    if (check.complete) {
      await mark(null, r.id, 'papers_ok');
      // The last step stays a person's for now (the user, 2026-10-24): Renew in saifsys makes
      // the new lease and its invoices, and that is checked against accounts first.
      return tell(r, 'The papers match. Check them and tap Renew in saifsys.');
    }
    const { n } = await db.prepare(`SELECT count(*)::int AS n FROM lease_renewal_events WHERE renewal_id = ? AND kind = 'out' AND title = ? AND user_id IS NULL`)
      .get(r.id, ACTIONS.fix.title());
    if (n >= AUTO_FIXES) return stopAuto(r, `the papers are still not right after ${AUTO_FIXES} tries`);
    await send(null, { id: r.id, action: 'fix' });
    return tell(r, 'The papers were not right. Reem asked the tenant to fix them.');
  } catch (err) {
    console.warn('[lease renewals] papers by itself failed:', err.message);
    await update(r.id, { waiting: 'papers', error: String(err.message).slice(0, 500) });
    return stopAuto(r, `it could not finish the papers (${err.message})`);
  }
}

/** "Rewrite with Reem": the reply in the box, written again as the building management team. Nothing is sent. */
export async function rewrite(id, text) {
  const r = await getRenewal(id);
  if (!r) throw bad('Renewal not found', 404);
  // Only the words between the greeting and the sign-off are rewritten; both are put back as they are.
  const lines = String(text || '').split('\n');
  const start = lines[0]?.trim() === dear(r) ? 1 : 0;
  const signAt = lines.findIndex((l) => l.trim() === SIGN[1]);
  const words = lines.slice(start, signAt > start ? signAt : undefined).join('\n').trim();
  if (!words) throw bad('Write a few words first, then Reem can write them again.');
  const body = await D.rewriteReply({ facts: factsOf(r, await settings()), thread: await thread(r.id), draft: words });
  return { text: replyText(r, body) };
}

// ---------- the advisors ----------

/** The agents the master picked to advise, as they are now. */
async function advisors(s) {
  const ids = (s.advisors || []).map(Number).filter(Boolean);
  if (!ids.length) return [];
  return db.prepare('SELECT id, name, icon, color, persona FROM agents WHERE id = ANY(?::int[]) ORDER BY id').all(ids);
}

async function thread(renewalId) {
  const rows = await db.prepare(`SELECT kind, body, at FROM lease_renewal_events WHERE renewal_id = ? AND kind IN ('out', 'in') ORDER BY at DESC, id DESC LIMIT 12`).all(renewalId);
  return rows.reverse().map((x) => `${x.kind === 'out' ? 'We wrote' : 'Tenant wrote'} (${dubaiDate(Number(x.at) * 1000)}):\n${String(x.body || '').slice(0, 2000)}`).join('\n\n');
}

/**
 * Each advisor's view of the renewal, side by side on its timeline: what it thinks and a
 * reply a person could send. One that fails is left out and the others still answer.
 */
export async function askAdvisors(r, { user = null } = {}) {
  const s = await settings();
  const team = await advisors(s);
  if (!team.length) return 0;
  const facts = factsOf(r, s);
  const emails = await thread(r.id);
  const answers = await Promise.allSettled(team.map((agent) => D.advise({ agent, facts, thread: emails, dispute: r.dispute })));
  let n = 0;
  for (const [i, a] of answers.entries()) {
    const agent = team[i];
    if (a.status !== 'fulfilled' || !a.value.view) { console.warn(`[lease renewals] ${agent.name} could not advise:`, a.reason?.message || 'no answer'); continue; }
    await db.prepare(`INSERT INTO lease_renewal_events (renewal_id, kind, title, body, data, user_id, at) VALUES (?, 'advice', ?, ?, ?, ?, ?)`)
      .run(r.id, `${agent.name}'s view`, a.value.view,
        JSON.stringify({ agent: { id: agent.id, name: agent.name, icon: agent.icon, color: agent.color }, reply: a.value.reply, asked: !!user }), user?.id || null, secs());
    n += 1;
  }
  if (!n) throw bad('None of the advisors could answer just now. Try again in a minute.', 502);
  return n;
}

// ---------- the RDC case pack ----------

const KIND = { out: 'Email to the tenant', in: 'Email from the tenant', step: 'Step', papers: 'Papers checked' };

/**
 * One PDF for a person to upload to RDC: the lease, what happened, every step oldest first,
 * and a numbered list of the emails and files. The advisors' views are the landlord's own
 * advice, so they are left out.
 */
export async function casePack(r) {
  const s = await settings();
  const events = await db.prepare(`SELECT id, kind, title, subject, status, at FROM lease_renewal_events WHERE renewal_id = ? AND kind <> 'advice' ORDER BY at, id`).all(r.id);
  const files = await db.prepare('SELECT event_id, name FROM lease_renewal_files WHERE renewal_id = ? ORDER BY id').all(r.id);
  const on = (e) => dubaiDate(Number(e.at) * 1000);
  const facts = factsOf(r, s);
  const story = events.map((e) => `${on(e)}: ${KIND[e.kind] || e.kind}: ${e.title}`).join('\n');
  const summary = await D.caseSummary({ facts, story }).catch((err) => { console.warn('[lease renewals] case summary:', err.message); return ''; });

  const papers = [];
  for (const e of events) {
    if (e.kind === 'out' && e.status === 'sent') papers.push(`${on(e)}: email to the tenant, "${e.subject || e.title}"`);
    if (e.kind === 'in') papers.push(`${on(e)}: email from the tenant${e.subject ? `, "${e.subject}"` : ''}`);
    for (const f of files.filter((x) => x.event_id === e.id)) papers.push(`${on(e)}: ${f.name} (${e.kind === 'out' ? 'sent to' : 'from'} the tenant)`);
  }
  const markdown = [
    `**Tenant:** ${r.lease.tenant}  `, `**Email:** ${r.lease.email}  `, `**Premises:** ${r.lease.building}, Unit ${r.lease.unit}${r.lease.premises_number ? ` (premises ${r.lease.premises_number})` : ''}  `,
    ...(r.lease.ejari ? [`**Ejari:** ${r.lease.ejari}  `] : []),
    `**Current contract:** ${longDate(r.lease.start_date)} to ${longDate(r.lease.end_date)}, ${aed(r.lease.annual_rent)} a year  `,
    ...(r.offer ? [`**Renewal rent offered:** ${aed(r.offer)} a year${r.rent_source?.kind === 'rera_index' || r.rent_source?.kind === 'dld_api' ? ' (RERA Rental Index)' : ''}  `] : []),
    ...(r.tenant_offer ? [`**Rent the tenant asked for:** ${aed(r.tenant_offer)} a year  `] : []),
    ...(r.agreed ? [`**Rent agreed:** ${aed(r.agreed)} a year  `] : []),
    ...(r.dispute ? [`**What the tenant disputes:** ${r.dispute}`] : []), '',
    ...(summary ? ['## What happened', '', summary, ''] : []),
    '## Timeline', '', ...events.map((e) => `- **${on(e)}** ${KIND[e.kind] || e.kind}: ${e.title}`), '',
    '## Emails and papers', '', ...(papers.length ? papers.map((p, i) => `${i + 1}. ${p}`) : ['None yet.']),
  ].join('\n');
  return renderPdf({ title: `RDC case pack: ${r.lease.building}, Unit ${r.lease.unit}`, markdown, date: new Date(D.now()) });
}

// ---------- silence ----------

/** Reminders after a week of silence, twice, by Reem itself; then No answer, for a person. */
export async function chase() {
  const s = await settings();
  if (!s.reminders) return;
  const rows = await db.prepare(`SELECT id FROM lease_renewals WHERE status IN ('offer_sent', 'negotiating', 'agreed') AND waiting IS NULL`).all();
  const nowS = secs();
  for (const { id } of rows) {
    const r = await getRenewal(id);
    if (!r.last_out_at || (r.last_in_at && r.last_in_at > r.last_out_at)) continue; // the tenant spoke last
    if ((nowS - r.last_out_at) / 86400 < REMIND_AFTER) continue;
    if (r.reminders >= REMINDERS) {
      await update(r.id, { waiting: 'no_answer' });
      await step(r, `No answer after ${REMINDERS} reminders`);
      await tell(r, `No answer from the tenant, ${daysBetween(today(), r.lease.end_date)} days before the lease ends.`);
      continue;
    }
    await mail(r, { title: `Reminder ${r.reminders + 1} sent by Reem`, text: reminderText(r, s.payee) });
    await update(r.id, { reminders: r.reminders + 1 });
  }
}

// ---------- the offers due, and the leases waiting for the RERA check ----------

/** Scheduled offers whose day has come, sent by Reem. One that fails stops, for staff to Send now. */
export async function sendDue() {
  if ((await settings()).paused) return;
  const rows = await db.prepare(`SELECT id FROM lease_renewals WHERE status = 'scheduled' AND auto AND end_date <= ? ORDER BY end_date, id`)
    .all(addDays(today(), SEND_AT));
  for (const { id } of rows) {
    const r = await getRenewal(id);
    try {
      await sendPlanned(r);
      await tell(r, `Reem sent the renewal offer, ${aed(r.offer)} a year.`);
    } catch (e) {
      console.warn('[lease renewals] a scheduled offer failed:', e.message);
      await update(r.id, { waiting: 'error', error: String(e.message).slice(0, 500) });
      await stopAuto(r, `it could not send the offer (${e.message})`);
    }
  }
}

/**
 * The one step that is a person's: leases 120 days or less from their end that nobody has
 * started, told to the renewals people in one push, each lease once.
 */
let nudgedAt = 0;
export async function nudge() {
  if (D.now() - nudgedAt < 3600_000) return 0;
  nudgedAt = D.now();
  const started = new Set((await db.prepare('SELECT lease_id, end_date FROM lease_renewals').all()).map((x) => `${x.lease_id}:${x.end_date}`));
  const told = new Set((await db.prepare('SELECT lease_id, end_date FROM lease_renewal_nudges').all()).map((x) => `${x.lease_id}:${x.end_date}`));
  const fresh = (await dueLeases()).filter((l) => daysLeft(l.end_date) <= SEND_AT && !l.saifsys_renewal
    && !started.has(`${l.lease_id}:${l.end_date}`) && !told.has(`${l.lease_id}:${l.end_date}`));
  if (!fresh.length) return 0;
  for (const l of fresh) await db.prepare('INSERT INTO lease_renewal_nudges (lease_id, end_date) VALUES (?, ?) ON CONFLICT DO NOTHING').run(l.lease_id, l.end_date);
  const one = fresh.length === 1 ? `${fresh[0].building} ${fresh[0].unit}` : `${fresh.length} leases`;
  D.push(await holders(), { title: 'Lease renewals', body: `${one} ${fresh.length === 1 ? 'is' : 'are'} due: check the RERA index so Reem can send the offer${fresh.length === 1 ? '' : 's'}.`, url: '/?renewals=list', tag: 'renewals-due' })?.catch?.(() => {});
  return fresh.length;
}
export const resetNudge = () => { nudgedAt = 0; };

// ---------- the clock ----------

let timer = null;
let busy = false;
export async function tick() {
  if (busy) return;
  busy = true;
  try {
    await readInbound();
    await chase();
    await resend();
    if (saifsysConfigured()) {
      await sendDue();
      await nudge();
    }
  } catch (e) {
    console.warn('[lease renewals]', e.message);
  } finally { busy = false; }
}

export function startLeaseRenewals() {
  if (timer) return;
  timer = setInterval(tick, EVERY);
  timer.unref?.();
  setTimeout(tick, 60_000);
}

// ---------- routes ----------

const out = (r) => r && {
  id: r.id, status: r.status, waiting: r.waiting, dispute: r.dispute, error: r.error, offer: r.offer, agreed: r.agreed,
  tenantOffer: r.tenant_offer, cheques: r.cheques, rentSource: r.rent_source, workflowId: r.workflow_id,
  schedule: r.quote?.cheques || null, total: r.quote?.cheques_total ?? null, start: r.quote?.start_date ?? null, end: r.quote?.end_date ?? null,
  papers: r.papers, reminders: r.reminders, lastOutAt: r.last_out_at, lastInAt: r.last_in_at, updatedAt: r.updated_at,
  auto: r.auto, reraPct: r.rera_pct, indexRent: r.rera_pct !== null ? indexRentFrom(r.lease.annual_rent, r.rera_pct) : null,
  sendOn: r.status === 'scheduled' ? sendDate(r.lease) : null,
};

const daysLeft = (end) => daysBetween(today(), end);
const card = (l, r) => ({
  lease_id: l.lease_id, building: l.building, unit: l.unit, unit_type: l.unit_type, bedrooms: l.bedrooms, tenant: l.tenant, email: l.email || null,
  premises_number: l.premises_number || null, ejari: l.ejari || null, start_date: l.start_date, end_date: l.end_date,
  annual_rent: l.annual_rent, cheques: l.cheques, days_left: daysLeft(l.end_date), saifsys_renewal: l.saifsys_renewal || null,
  renewal: out(r),
});

export const leaseRenewalRoutes = Router();
leaseRenewalRoutes.use(needsModule('renewals'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const masterOnly = (req, res, next) => (isMaster(req.user) ? next() : res.status(403).json({ error: 'Only the master can change this' }));

leaseRenewalRoutes.get('/', wrap(async (req, res) => {
  const leases = saifsysConfigured() ? await dueLeases() : [];
  const rows = (await db.prepare(`SELECT * FROM lease_renewals WHERE status IN ('scheduled', 'offer_sent', 'negotiating', 'agreed', 'papers_ok')
    OR updated_at > ${NOW} - 30 * 86400`).all()).map(ROW);
  const byLease = new Map(rows.map((r) => [`${r.lease_id}:${r.end_date}`, r]));
  const list = leases.map((l) => { const k = `${l.lease_id}:${l.end_date}`; const r = byLease.get(k); byLease.delete(k); return card(l, r); });
  for (const r of byLease.values()) list.push(card(r.lease, r)); // renewed or ended since: still shown a while
  const s = await settings();
  const acc = await inbox();
  res.json({
    days: DAYS_AHEAD, sendAt: SEND_AT, leases: list.sort((a, b) => a.end_date.localeCompare(b.end_date) || String(a.building).localeCompare(String(b.building))),
    settings: {
      payee: s.payee || '', reminders: !!s.reminders, paused: !!s.paused, bcc: s.bcc || [],
      advisors: (await advisors(s)).map((a) => a.id),
    },
    // The team the master picks advisors from: their own agents.
    agents: isMaster(req.user) ? (await db.prepare('SELECT id, name, icon, color FROM agents WHERE user_id = ? ORDER BY id').all(req.user.id)) : [],
    hasAdvisors: !!(s.advisors || []).length,
    inbox: acc ? acc.email : null, saifsys: saifsysConfigured() && saifsysActionsConfigured(), master: isMaster(req.user),
  });
}));

leaseRenewalRoutes.get('/:id', wrap(async (req, res) => {
  const r = await getRenewal(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const events = await db.prepare(`SELECT e.id, e.kind, e.title, e.body, e.subject, e.status, e.error, e.reading, e.data, e.at, u.name AS by
    FROM lease_renewal_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.renewal_id = ? ORDER BY e.at DESC, e.id DESC`).all(r.id);
  const files = await db.prepare('SELECT id, event_id, name, mime FROM lease_renewal_files WHERE renewal_id = ? ORDER BY id').all(r.id);
  res.json({
    ...card(r.lease, r), advisors: (await advisors(await settings())).length, paused: !!(await settings()).paused,
    events: events.map((e) => ({ ...e, at: Number(e.at), files: files.filter((f) => f.event_id === e.id) })),
  });
}));

leaseRenewalRoutes.get('/:id/files/:file', wrap(async (req, res) => {
  const f = await db.prepare('SELECT mime, path, name FROM lease_renewal_files WHERE id = ? AND renewal_id = ?').get(Number(req.params.file) || 0, Number(req.params.id) || 0);
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff')
    .set('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`).type(f.mime).send(await readFile(f.path));
}));

leaseRenewalRoutes.get('/fees/:leaseId', wrap(async (req, res) => { res.json(await startFees(req.params.leaseId)); }));
leaseRenewalRoutes.post('/draft', wrap(async (req, res) => { res.json(await draft(req.user, req.body || {})); }));
leaseRenewalRoutes.post('/send', wrap(async (req, res) => { res.json(out(await send(req.user, req.body || {}))); }));
// "Check for replies": the Tenant care inbox now, then any new email read, instead of waiting for the clock.
leaseRenewalRoutes.post('/check', wrap(async (req, res) => {
  await D.checkMail();
  res.json({ read: await readInbound() });
}));

leaseRenewalRoutes.post('/:id/advise', wrap(async (req, res) => {
  const r = await getRenewal(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (!(await advisors(await settings())).length) throw bad('No advisors are picked yet: the master picks them in the Lease renewals settings.', 409);
  res.json({ added: await askAdvisors(r, { user: req.user }) });
}));

// "Rewrite with Reem": the reply in the box, written again as the building management team. Nothing is sent.
leaseRenewalRoutes.post('/:id/rewrite', wrap(async (req, res) => { res.json(await rewrite(req.params.id, req.body?.text)); }));

leaseRenewalRoutes.get('/:id/case-pack', wrap(async (req, res) => {
  const r = await getRenewal(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const name = `RDC case pack - ${r.lease.building} ${r.lease.unit}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
  res.set('Cache-Control', 'no-store').set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    .type('application/pdf').send(Buffer.from(await casePack(r)));
}));

leaseRenewalRoutes.post('/:id/mark', wrap(async (req, res) => { res.json(out(await mark(req.user, req.params.id, req.body?.what))); }));

leaseRenewalRoutes.put('/settings', masterOnly, wrap(async (req, res) => {
  const b = req.body || {};
  // Advisors are the master's own agents: an id that is not one of theirs is dropped.
  const wanted = (Array.isArray(b.advisors) ? b.advisors : []).map(Number).filter(Boolean);
  const own = wanted.length ? (await db.prepare('SELECT id FROM agents WHERE user_id = ? AND id = ANY(?::int[]) ORDER BY id').all(req.user.id, wanted)).map((a) => a.id) : [];
  const bcc = [...new Set((Array.isArray(b.bcc) ? b.bcc : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  const wrong = bcc.find((x) => !EMAIL.test(x));
  if (wrong) throw bad(`"${wrong}" is not an email address.`);
  if (bcc.length > 10) throw bad('Up to 10 addresses can be copied.');
  await db.prepare(`INSERT INTO lease_renewal_settings (id, payee, actor_id, reminders, advisors, paused, bcc, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ${NOW})
    ON CONFLICT (id) DO UPDATE SET payee = EXCLUDED.payee, actor_id = EXCLUDED.actor_id, reminders = EXCLUDED.reminders, advisors = EXCLUDED.advisors,
      paused = EXCLUDED.paused, bcc = EXCLUDED.bcc, updated_at = EXCLUDED.updated_at`)
    .run(String(b.payee || '').trim().slice(0, 200) || null, req.user.id, b.reminders !== false, JSON.stringify(own), b.paused === true, JSON.stringify(bcc));
  res.json({ ok: true });
}));
