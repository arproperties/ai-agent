import { Router } from 'express';
import multer from 'multer';
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
import { inbox, fileInSent, ownWords, claimTenantMail } from './tenantCare.js';
import { askSaifsys, actSaifsys, saifsysConfigured, saifsysActionsConfigured, dubaiDate, dubaiHour } from './saifsys/client.js';
import { verifiedEmail } from './saifsys/booking.js';
import { readDld, readReply, readDocs } from './renewalAi.js';

// Lease renewals: Reem runs each renewal with the tenant by email, start to finish, so the
// staff no longer do. Every word to the tenant goes from the Tenant care inbox; the replies
// come back there and are passed here instead of to Tenant care's own asking.
//
//   1. Each morning, saifsys's leases ending within 120 days become cases (renewals_due).
//   2. Someone with the module checks the DLD rental index and uploads the screenshot; Reem
//      reads the allowed increase and shows it, and one tap sends the notice.
//   3. Reem reads each reply and answers within the boss's rules: accept at or above the
//      floor, counter below it (max_rounds times), and anything else goes to the boss.
//   4. Once agreed, the tenant sends the signed agreement and photos of the cheques; Reem
//      checks them against saifsys's own cheque schedule and says what to fix.
//   5. Then saifsys is told, once (realestate_renewal/renew): it makes and converts the
//      renewal with its own code. The tenant gets a confirmation, the boss a to-do to
//      collect the original cheques and register the Ejari.
//
// The letters are fixed texts here. Claude only reads (server/renewalAi.js), and the only
// words of its that reach a tenant are an answer to a question, from the case's facts.
//
// A decision outside the rules is the boss's (status 'boss', with needs saying what is
// asked). Reem never guesses: an email it cannot read with confidence goes there too.

const DAYS_AHEAD = 120;
const LATE = 90;          // the law wants 90 days' notice of a rent change
const NO_REPLY = 60;      // days before the end: silence since the notice goes to the boss
const REMIND_AFTER = 7;   // days of silence before each reminder
const REMINDERS = 2;
const MIN_LEASE_DAYS = 300; // a monthly lease is not renewed this way
const EVERY = 3 * 60_000;
const JOB = 'renewals';
const DIR = `${DATA_DIR}/renewals`;
const MAX_FILE = 10 * 1024 * 1024;
const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const OPEN = ['notice_sent', 'negotiating', 'agreed'];
const NOW = 'extract(epoch from now())::bigint';
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// Everything that reaches outside, swappable for the tests.
const D = {
  ask: askSaifsys, act: actSaifsys, readDld, readReply, readDocs,
  send: sendRaw, file: fileInSent, fetch: fetchMessage, push: sendPush, todo: createTodo, actor: verifiedEmail,
  now: () => Date.now(),
};
export const useForTests = (over) => Object.assign(D, over);

// ---------- money and dates ----------

export const aed = (n) => `AED ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const down100 = (n) => Math.floor(Number(n) / 100) * 100;
const up500 = (n) => Math.ceil(Number(n) / 500) * 500;
const today = () => dubaiDate(D.now());
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const longDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const secs = () => Math.floor(D.now() / 1000);

// ---------- the rules ----------

const DEFAULTS = { enabled: false, floor_pct: 0, building_floors: {}, max_rounds: 2, payee: null, actor_id: null };

export async function settings() {
  const s = await db.prepare('SELECT * FROM renewal_settings WHERE id = 1').get();
  return s ? { ...s, floor_pct: Number(s.floor_pct), max_rounds: Number(s.max_rounds) } : { ...DEFAULTS };
}

/**
 * The offer and the floor for a lease, from the increase DLD allows. A notice that goes out
 * with fewer than 90 days left may not raise the rent, so then the offer is the rent as it is.
 */
export function plan(lease, pct, s, on = today()) {
  const current = Number(lease.annual_rent);
  const late = daysBetween(on, lease.end_date) < LATE;
  const offer = late ? current : Math.max(current, down100(current * (1 + Number(pct) / 100)));
  const floorPct = Number(s.building_floors?.[lease.building] ?? s.floor_pct ?? 0);
  const floor = Math.min(offer, Math.max(0, down100(current * (1 + floorPct / 100))));
  return { offer, floor, late };
}

/**
 * What to do with a tenant's answer while the rent is still open. reading is readReply()'s.
 * Returns { do: 'agree', rent } | { do: 'counter', rent } | { do: 'reject' } | { do: 'answer', text } | { do: 'boss', why }.
 */
export function respond(c, reading, s) {
  const offer = Number(c.offer);
  const floor = Number(c.floor);
  switch (reading.intent) {
    case 'accept': return { do: 'agree', rent: offer };
    case 'reject': return { do: 'reject' };
    case 'question': return reading.answer ? { do: 'answer', text: reading.answer }
      : { do: 'boss', why: `The tenant asks: "${reading.question || reading.summary}". Reem could not answer it from the renewal's facts.` };
    case 'counter': {
      const asked = Number(reading.amount);
      if (asked >= offer) return { do: 'agree', rent: offer };
      if (asked >= floor) return { do: 'agree', rent: asked };
      if (c.rounds >= s.max_rounds) {
        return { do: 'boss', why: `The tenant offers ${aed(asked)}. Your lowest is ${aed(floor)}, and Reem's last offer was ${aed(offer)} after ${c.rounds} counter-offer${c.rounds === 1 ? '' : 's'}.` };
      }
      const next = Math.min(offer, Math.max(floor, up500((offer + asked) / 2)));
      if (next >= offer) return { do: 'boss', why: `The tenant offers ${aed(asked)}. Reem's offer of ${aed(offer)} is already your lowest, so it cannot come down.` };
      return { do: 'counter', rent: next };
    }
    default: return { do: 'boss', why: `Reem is not sure what the tenant means: "${reading.summary}".` };
  }
}

/**
 * The papers the tenant has sent so far against what saifsys will make: the signed agreement
 * and, for a lease paid by cheque, one cheque per payment in the schedule, the right amount,
 * dated within three days, payable to the landlord. Returns what is still missing and what
 * is wrong; both empty means it is complete.
 */
export function checkPapers(c, received, payee) {
  const missing = [];
  const wrong = [];
  if (received.agreement !== 'signed') missing.push(received.agreement === 'unsigned' ? 'your signature on the renewal agreement (the copy you sent is not signed)' : 'the signed renewal agreement');
  if (c.lease.payment_method === 'cheque') {
    const got = [...(received.cheques || [])];
    for (const want of c.quote.cheques) {
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
 * cheque for the same amount and date as one sent before replaces it (it was sent again
 * to put something right).
 */
export function addPapers(before, read) {
  const agreement = before.agreement === 'signed' || read.agreement === 'signed' ? 'signed'
    : before.agreement === 'unsigned' || read.agreement === 'unsigned' ? 'unsigned' : 'none';
  const cheques = [...(before.cheques || [])];
  for (const ch of read.cheques || []) {
    const i = cheques.findIndex((k) => k.amount === ch.amount && k.date === ch.date);
    if (i >= 0) cheques[i] = ch; else cheques.push(ch);
  }
  return { agreement, cheques };
}

// ---------- the cases ----------

const CASE = (r) => r && {
  ...r,
  offer: r.offer === null ? null : Number(r.offer),
  floor: r.floor === null ? null : Number(r.floor),
  agreed: r.agreed === null ? null : Number(r.agreed),
  tenant_offer: r.tenant_offer === null ? null : Number(r.tenant_offer),
  last_out_at: r.last_out_at === null ? null : Number(r.last_out_at),
  last_in_at: r.last_in_at === null ? null : Number(r.last_in_at),
};
export const getCase = async (id) => CASE(await db.prepare('SELECT * FROM renewal_cases WHERE id = ?').get(Number(id) || 0));

async function update(id, fields) {
  const keys = Object.keys(fields);
  const json = ['lease', 'dld', 'quote', 'received', 'saifsys'];
  await db.prepare(`UPDATE renewal_cases SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = ?`)
    .run(...keys.map((k) => (json.includes(k) && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k])), id);
  return getCase(id);
}

/** Who hears about renewals: the masters and everyone ticked for the module. */
async function holders() {
  const rows = await db.prepare(`SELECT id FROM users WHERE NOT disabled AND (role = 'master'
    OR id IN (SELECT user_id FROM module_access WHERE module = 'renewals'))`).all();
  return rows.map((r) => r.id);
}

async function tell(body) {
  D.push(await holders(), { title: 'Lease renewals', body, url: '/?renewals=1', tag: 'renewals' })?.catch?.(() => {});
}

async function toBoss(c, why) {
  const done = await update(c.id, { status: 'boss', needs: why });
  await tell(`${c.lease.building} ${c.lease.unit}: ${why}`);
  return done;
}

const leaseDays = (l) => daysBetween(l.start_date, l.end_date);

/**
 * The morning job: every lease saifsys has ending within 120 days becomes a case, once.
 * Leases the staff already started a renewal for in saifsys, and monthly leases, are left out.
 */
export async function openCases({ force = false } = {}) {
  const s = await settings();
  if (!s.enabled && !force) return { skipped: 'switched off' };
  if (!saifsysConfigured()) return { skipped: 'saifsys not connected' };
  const day = today();
  if (!force) {
    if (dubaiHour(D.now()) < 8) return { skipped: 'before 8' };
    if (await db.prepare('SELECT 1 FROM saifsys_runs WHERE job = ? AND day = ?').get(JOB, day)) return { skipped: 'already done today' };
  }
  const { leases = [] } = await D.ask('realestate', 'renewals_due', { days: DAYS_AHEAD });
  if (!force) {
    const claimed = await db.prepare('INSERT INTO saifsys_runs (job, day, found) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING day').get(JOB, day, leases.length);
    if (!claimed) return { skipped: 'already done today' };
  }
  let opened = 0;
  for (const l of leases) {
    if (l.saifsys_renewal || leaseDays(l) < MIN_LEASE_DAYS) continue;
    const noEmail = !String(l.email || '').includes('@');
    const r = await db.prepare(`INSERT INTO renewal_cases (lease_id, end_date, lease, status, needs) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (lease_id, end_date) DO NOTHING RETURNING id`)
      .run(l.lease_id, l.end_date, JSON.stringify(l), noEmail ? 'boss' : 'dld_needed',
        noEmail ? 'saifsys has no email for this tenant, so Reem cannot write to them. Add it in saifsys and tap Try again, or handle this renewal yourself.' : null);
    if (r.id) opened++;
  }
  if (opened) await tell(`${opened} lease${opened > 1 ? 's' : ''} to renew: check the DLD rental index for ${opened > 1 ? 'each' : 'it'}.`);
  return { day, due: leases.length, opened };
}

// ---------- email ----------

const subjectOf = (c) => `Lease renewal: ${c.lease.building}, Unit ${c.lease.unit}`;
const SIGN = ['', 'Kind regards,', 'Tenant Care Team'];
const dear = (c) => `Dear ${c.lease.tenant || 'Tenant'},`;

function schedule(q) {
  return q.cheques.map((ch, i) => `  ${i + 1}. ${longDate(ch.date)}: ${aed(ch.amount)}${ch.type !== 'rent' ? ' (renewal charges)' : ''}`);
}

function offerLines(c, rent) {
  const q = c.quote;
  return [
    `- Period: ${longDate(q.start_date)} to ${longDate(q.end_date)}`,
    `- Annual rent: ${aed(rent)}`,
    `- Payment by ${q.cheques.length} cheque${q.cheques.length > 1 ? 's' : ''}:`,
    ...schedule(q),
    ...(q.rera ? [`- RERA / registration charges: ${aed(q.rera)}, paid on registration`] : []),
  ];
}

export function noticeText(c) {
  const replyBy = longDate(addDays(today(), 14));
  return [dear(c), '',
    `Your tenancy of ${c.lease.building}, Unit ${c.lease.unit} ends on ${longDate(c.lease.end_date)}, and we would be glad to renew it.`, '',
    'Our renewal offer:',
    ...offerLines(c, c.offer), '',
    c.dld?.late || Number(c.offer) <= Number(c.lease.annual_rent)
      ? 'The rent stays as it is.'
      : `The new rent is within the increase the Dubai Land Department's Rental Index allows for your unit.`, '',
    `Please reply to this email by ${replyBy}:`,
    '- to accept, simply reply "I accept";',
    '- or tell us what you would like to propose.', '',
    'The terms of the renewal and the documents we will need are in the attached letter.',
    ...SIGN].join('\n');
}

const counterText = (c, rent) => [dear(c), '',
  'Thank you for your reply.', '',
  `We have looked at it carefully and can offer the renewal at ${aed(rent)} a year:`,
  ...offerLines({ ...c, quote: c.quote }, rent), '',
  'Please reply to this email to accept, or let us know your thoughts.', ...SIGN].join('\n');

const agreedText = (c, payee) => [dear(c), '',
  `Thank you. We are pleased to confirm the renewal of ${c.lease.building}, Unit ${c.lease.unit} at ${aed(c.agreed)} a year.`, '',
  'To complete it, please reply to this email with:',
  '1. The attached renewal agreement, signed (a scan or a clear photo of each page is fine).',
  ...(c.lease.payment_method === 'cheque' ? [
    `2. Clear photos of the cheques below${payee ? `, payable to ${payee}` : ''}:`,
    ...schedule(c.quote)] : []),
  ...(c.quote.required_documents_text ? ['', 'And, if they have changed or expired since your last contract:', ...c.quote.required_documents_text.split('\n').map((d) => `- ${d}`)] : []), '',
  ...(c.lease.payment_method === 'cheque' ? ['Please keep the original cheques ready: we will collect them before the new term starts.', ''] : []),
  ...SIGN.slice(1)].join('\n');

const fixText = (c, check) => [dear(c), '',
  'Thank you for sending these. To complete your renewal we still need:', '',
  ...check.wrong.map((w) => `- ${w}`),
  ...check.missing.map((m) => `- ${m[0].toUpperCase()}${m.slice(1)}`), '',
  'Please reply to this email with them.', ...SIGN].join('\n');

const doneText = (c) => [dear(c), '',
  `Your renewal of ${c.lease.building}, Unit ${c.lease.unit} is complete: ${aed(c.agreed)} a year from ${longDate(c.quote.start_date)} to ${longDate(c.quote.end_date)}.`, '',
  ...(c.lease.payment_method === 'cheque' ? ['We will be in touch to collect the original cheques, and we will register the new tenancy contract with Ejari.', ''] : ['We will register the new tenancy contract with Ejari.', '']),
  'Thank you for staying with us.', ...SIGN].join('\n');

const notRenewingText = (c) => [dear(c), '',
  `Thank you for letting us know that you will not renew your tenancy of ${c.lease.building}, Unit ${c.lease.unit}.`, '',
  `Your tenancy ends on ${longDate(c.lease.end_date)}. Our team will contact you about the move-out inspection and the handover of the keys.`,
  ...SIGN].join('\n');

const answerText = (c, text) => [dear(c), '', text, '',
  `Our offer of ${aed(c.offer)} a year stands. Please reply to this email to accept, or let us know your thoughts.`, ...SIGN].join('\n');

const reminderText = (c) => (c.status === 'agreed'
  ? [dear(c), '', `A reminder that your renewal of ${c.lease.building}, Unit ${c.lease.unit} at ${aed(c.agreed)} a year is waiting for:`,
    ...checkPapers(c, c.received || {}, null).missing.map((m) => `- ${m}`), '', 'Please reply to this email with them.', ...SIGN].join('\n')
  : [dear(c), '', `A reminder about the renewal of your tenancy of ${c.lease.building}, Unit ${c.lease.unit}, which ends on ${longDate(c.lease.end_date)}.`, '',
    `Our offer is ${aed(c.offer)} a year. Please reply to this email to accept, or tell us what you would like to propose.`, ...SIGN].join('\n'));

function noticeMarkdown(c) {
  const q = c.quote;
  return [
    `**Tenant:** ${c.lease.tenant}  `, `**Premises:** ${c.lease.building}, Unit ${c.lease.unit}  `, `**Current contract ends:** ${longDate(c.lease.end_date)}`, '',
    '## Renewal offer', '', ...offerLines(c, c.offer), '',
    '## Terms', '', ...String(q.terms_text || '').split('\n').filter(Boolean).map((t) => `- ${t}`), '',
    '## Documents we will need', '', ...String(q.required_documents_text || '').split('\n').filter(Boolean).map((t) => `- ${t}`),
  ].join('\n');
}

function agreementMarkdown(c, payee) {
  const q = c.quote;
  return [
    `This agreement renews the tenancy of **${c.lease.building}, Unit ${c.lease.unit}** (contract ${c.lease.lease_number}).`, '',
    `**Landlord:** ${payee || 'The Landlord'}  `, `**Tenant:** ${c.lease.tenant}`, '',
    '## Renewal terms', '', ...offerLines(c, c.agreed), '',
    'All other terms of the current tenancy contract remain the same, together with these:', '',
    ...String(q.terms_text || '').split('\n').filter(Boolean).map((t) => `- ${t}`), '',
    '## Signatures', '',
    'Tenant: ______________________________   Date: ______________', '',
    'Landlord: ____________________________   Date: ______________',
  ].join('\n');
}

const pdf = async (title, markdown, name) => ({ filename: name, contentType: 'application/pdf',
  content: Buffer.from(await renderPdf({ title, markdown, date: new Date(D.now()) })).toString('base64') });

/**
 * One email to the tenant, on the case's thread. Saved with its exact bytes first, so a
 * failure is retried with the same Message-ID by the next tick.
 */
async function mail(c, kind, text, attachments = []) {
  const acc = await inbox();
  const thread = await db.prepare('SELECT message_id FROM renewal_messages WHERE case_id = ? AND message_id IS NOT NULL ORDER BY id').all(c.id);
  const ids = thread.map((t) => t.message_id);
  const subject = ids.length ? replySubject(subjectOf(c)) : subjectOf(c);
  const from = acc ? acc.email : 'tenant-care@invalid';
  const m = await compose({
    from: { name: 'Tenant Care', address: from }, to: [c.lease.email], subject, text, attachments,
    ...(ids.length ? { inReplyTo: ids[ids.length - 1], references: ids.join(' ') } : {}),
  });
  const { id } = await db.prepare(`INSERT INTO renewal_messages (case_id, direction, kind, subject, body, message_id, raw, status, error)
    VALUES (?, 'out', ?, ?, ?, ?, ?, 'failed', ?) RETURNING id`)
    .run(c.id, kind, subject, text, m.messageId, m.raw, acc ? 'Not sent yet' : 'The Tenant care inbox is not connected.');
  await update(c.id, { last_out_at: secs(), ...(kind !== 'reminder' ? { reminders: 0 } : {}) });
  if (acc) await deliver(acc, id, m);
  return id;
}

async function deliver(acc, id, m) {
  try {
    await D.send(acc, decrypt(acc.password_enc), m);
    await db.prepare(`UPDATE renewal_messages SET status = 'sent', error = NULL, at = ${NOW} WHERE id = ?`).run(id);
    await D.file(acc, m.raw).catch((e) => console.warn('[renewals] could not file in Sent:', e.message));
  } catch (e) {
    await db.prepare(`UPDATE renewal_messages SET status = 'failed', error = ? WHERE id = ?`).run(String(friendlySmtp(e, acc.smtp_host)).slice(0, 500), id);
  }
}

/** Emails that could not go out, tried again with the same bytes. */
async function resend() {
  const acc = await inbox();
  if (!acc) return 0;
  const rows = await db.prepare(`SELECT m.id, m.raw, c.lease FROM renewal_messages m JOIN renewal_cases c ON c.id = m.case_id
    WHERE m.direction = 'out' AND m.status = 'failed' ORDER BY m.id LIMIT 20`).all();
  for (const r of rows) await deliver(acc, r.id, { raw: r.raw, envelope: { from: acc.email, to: [r.lease.email] } });
  return rows.length;
}

// ---------- saifsys ----------

async function actingEmail(s) {
  const email = s.actor_id ? await D.actor(s.actor_id) : null;
  if (!email) throw bad('Nobody is set to act in saifsys: the master who saves the Lease renewals settings must have their company email connected under Email.', 409);
  return email;
}

/** saifsys's own cheques and charges for a renewal at this rent. */
async function quoteFor(c, rent) {
  const s = await settings();
  const { quote } = await D.act('realestate_renewal', 'quote', {
    email: await actingEmail(s), lease_id: c.lease_id, end_date: c.end_date, rent, cheques: c.lease.cheques,
  });
  return quote;
}

// ---------- the DLD check and the notice ----------

const keep = async (caseId, messageId, { name, mime, buffer }) => {
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/${randomUUID()}.${FILE_TYPES[mime]}`;
  await writeFile(path, buffer);
  const { id } = await db.prepare('INSERT INTO renewal_files (case_id, message_id, name, mime, path) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .run(caseId, messageId, String(name || 'file').slice(0, 200), mime, path);
  return id;
};

/** The DLD screenshot: kept, read, and the offer worked out from it. Nothing is sent. */
export async function readDldShot(user, id, file) {
  const c = await getCase(id);
  if (!c) throw bad('Renewal not found', 404);
  if (!['dld_needed', 'dld_read'].includes(c.status)) throw bad('The DLD check is done for this renewal.', 409);
  if (!file?.buffer?.length || !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) throw bad('Upload the DLD screenshot as a picture (JPG or PNG).');
  const fileId = await keep(c.id, null, { name: file.originalname, mime: file.mimetype, buffer: file.buffer });
  const read = await D.readDld({ mime: file.mimetype, data: file.buffer.toString('base64') }, c.lease);
  if (!read.confident) {
    await update(c.id, { dld: { ...read, file: fileId, by: user.id, at: secs() }, status: 'dld_needed' });
    throw bad(`Reem could not read the allowed increase from that picture${read.note ? ` (${read.note})` : ''}. Upload a clear screenshot of the DLD result.`, 422);
  }
  const p = plan(c.lease, read.pct, await settings());
  return update(c.id, { dld: { ...read, late: p.late, file: fileId, by: user.id, at: secs() }, offer: p.offer, floor: p.floor, status: 'dld_read', error: null });
}

/** Send: the notice goes to the tenant at the offer Reem worked out. */
export async function sendNotice(user, id) {
  const s = await settings();
  if (!s.enabled) throw bad('Lease renewals is switched off. The master switches it on under Settings.', 409);
  let c = await getCase(id);
  if (!c) throw bad('Renewal not found', 404);
  if (c.status !== 'dld_read') throw bad(c.status === 'dld_needed' ? 'Upload the DLD screenshot first.' : 'The notice was already sent.', 409);
  const p = plan(c.lease, c.dld.pct, s); // again: a day or two may have passed since the screenshot
  const quote = await quoteFor(c, p.offer);
  const claimed = await db.prepare(`UPDATE renewal_cases SET status = 'notice_sent', offer = ?, floor = ?, quote = ?, rounds = 0, error = NULL,
    dld = dld || ?::jsonb, updated_at = ${NOW} WHERE id = ? AND status = 'dld_read' RETURNING id`)
    .get(p.offer, p.floor, JSON.stringify(quote), JSON.stringify({ late: p.late, first_offer: p.offer, noticed: today() }), c.id);
  if (!claimed) throw bad('The notice was already sent.', 409);
  c = await getCase(c.id);
  await mail(c, 'notice', noticeText(c), [await pdf('Lease renewal offer', noticeMarkdown(c), `Renewal offer - ${c.lease.building} ${c.lease.unit}.pdf`)]);
  return getCase(c.id);
}

// ---------- the tenant's emails ----------

/**
 * Called by Tenant care for every new email in its inbox. An answer on a renewal's thread,
 * or from the tenant of a renewal under way, is kept here to be read and Tenant care leaves
 * it alone. Returns whether it was one.
 */
export async function claim(m, uidValidity) {
  const ids = [m.inReplyTo, ...String(m.refs || '').split(/\s+/)].filter(Boolean);
  let c = ids.length && await db.prepare(`SELECT c.id FROM renewal_messages rm JOIN renewal_cases c ON c.id = rm.case_id
    WHERE rm.direction = 'out' AND rm.message_id = ANY(?::text[]) ORDER BY c.id DESC LIMIT 1`).get(ids);
  // kind on an incoming email: how it was matched. One matched only by who sent it may be
  // about something else (a leak), and is let go if it does not read as about the renewal.
  const via = c ? 'thread' : 'sender';
  if (!c) {
    c = await db.prepare(`SELECT id FROM renewal_cases WHERE lower(lease->>'email') = ? AND status IN ('notice_sent', 'negotiating', 'agreed', 'boss', 'no_reply')
      ORDER BY id DESC LIMIT 1`).get(String(m.from || '').toLowerCase());
  }
  if (!c) return false;
  await db.prepare(`INSERT INTO renewal_messages (case_id, direction, kind, subject, body, message_id, ref, status, at)
    VALUES (?, 'in', ?, ?, ?, ?, ?, 'new', ?) ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING`)
    .run(c.id, via, String(m.subject || '').slice(0, 300), ownWords(m.text).trim().slice(0, 20000), m.messageId || null, `${uidValidity}:${m.uid}`, m.at || secs());
  return true;
}
claimTenantMail(claim);

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

const factsOf = (c, s) => [
  `Premises: ${c.lease.building}, Unit ${c.lease.unit} (${c.lease.unit_type || 'unit'}). Tenant: ${c.lease.tenant}.`,
  `Current contract: ${longDate(c.lease.start_date)} to ${longDate(c.lease.end_date)}, ${aed(c.lease.annual_rent)} a year, ${c.lease.cheques} cheques.`,
  c.quote ? `Renewal offered: ${aed(c.agreed ?? c.offer)} a year from ${longDate(c.quote.start_date)} to ${longDate(c.quote.end_date)}, ${c.quote.cheques.length} cheques: ${c.quote.cheques.map((ch) => `${longDate(ch.date)} ${aed(ch.amount)}`).join('; ')}.` : '',
  c.quote?.rera ? `RERA / registration charges: ${aed(c.quote.rera)}.` : '',
  s.payee ? `Cheques are payable to ${s.payee}.` : '',
  c.status === 'agreed' ? `The rent is agreed at ${aed(c.agreed)}; the tenant still has to send the signed agreement${c.lease.payment_method === 'cheque' ? ' and photos of the cheques' : ''}.` : '',
  c.quote?.terms_text ? `Terms: ${c.quote.terms_text.replace(/\n/g, ' ')}` : '',
  c.quote?.required_documents_text ? `Documents needed: ${c.quote.required_documents_text.replace(/\n/g, '; ')}` : '',
  'The rent increase follows the Dubai Land Department Rental Index (Decree 43 of 2013).',
].filter(Boolean).join('\n');

async function history(caseId, before) {
  const rows = await db.prepare(`SELECT direction, body FROM renewal_messages WHERE case_id = ? AND id < ? ORDER BY id DESC LIMIT 8`).all(caseId, before);
  return rows.reverse().map((r) => `${r.direction === 'out' ? 'We wrote' : 'Tenant wrote'}: ${String(r.body || '').slice(0, 1500)}`).join('\n\n');
}

/** Every new email from a tenant, read and acted on, one by one. */
export async function readInbound() {
  const rows = await db.prepare(`SELECT * FROM renewal_messages WHERE direction = 'in' AND status = 'new' ORDER BY id LIMIT 20`).all();
  for (const r of rows) {
    try {
      await handle(r);
    } catch (e) {
      console.warn('[renewals] reading an email failed:', e.message);
      await db.prepare(`UPDATE renewal_messages SET status = 'error', error = ? WHERE id = ?`).run(String(e.message).slice(0, 500), r.id);
      const c = await getCase(r.case_id);
      if (c) await toBoss(c, `Reem could not read the tenant's email of ${new Date(Number(r.at) * 1000).toLocaleDateString('en-GB')} (${e.message}). Read it in the thread and decide.`);
    }
  }
  return rows.length;
}

async function attachmentsOf(r) {
  const parsed = r.ref ? await D.fetch(r.ref) : null;
  const files = [];
  for (const a of parsed?.attachments || []) {
    const mime = String(a.contentType || '').toLowerCase();
    if (!FILE_TYPES[mime] || !a.content?.length || a.content.length > MAX_FILE) continue;
    await keep(r.case_id, r.id, { name: a.filename || `file.${FILE_TYPES[mime]}`, mime, buffer: a.content });
    files.push({ name: a.filename || `file.${FILE_TYPES[mime]}`, mime, data: a.content.toString('base64') });
  }
  return files;
}

async function handle(r) {
  let c = await getCase(r.case_id);
  const s = await settings();
  const files = await attachmentsOf(r);
  const done = (reading) => db.prepare(`UPDATE renewal_messages SET status = 'read', reading = ? WHERE id = ?`).run(JSON.stringify(reading), r.id);
  await update(c.id, { last_in_at: Number(r.at) || secs() });

  if (c.status === 'no_reply') c = await update(c.id, { status: 'negotiating', needs: null }); // a late answer is still an answer

  if (['notice_sent', 'negotiating'].includes(c.status)) {
    const reading = await D.readReply({ facts: factsOf(c, s), history: await history(c.id, r.id), text: r.body });
    if (r.kind === 'sender' && reading.intent === 'unclear') return done({ ...reading, note: 'Not about the renewal, by the look of it: left for the staff.' });
    await done(reading);
    if (reading.intent === 'counter') await update(c.id, { tenant_offer: reading.amount });
    const next = respond(c, reading, s);
    return act(c, next, s);
  }

  if (c.status === 'agreed') {
    let reading = null;
    if (files.length) {
      reading = await D.readDocs(files);
      const received = addPapers(c.received || {}, reading);
      c = await update(c.id, { received });
      const check = checkPapers(c, received, s.payee);
      await done({ docs: reading, check });
      if (check.complete) return update(c.id, { status: 'converting', error: null });
      return mail(c, 'fix', fixText(c, check));
    }
    reading = await D.readReply({ facts: factsOf(c, s), history: await history(c.id, r.id), text: r.body });
    await done(reading);
    if (reading.intent === 'question' && reading.answer) {
      return mail(c, 'answer', [dear(c), '', reading.answer, '', 'To complete the renewal we are waiting for:', ...checkPapers(c, c.received || {}, s.payee).missing.map((m) => `- ${m}`), ...SIGN].join('\n'));
    }
    if (reading.intent === 'accept' || reading.intent === 'documents') {
      return mail(c, 'fix', fixText(c, checkPapers(c, c.received || {}, s.payee)));
    }
    if (r.kind === 'sender' && reading.intent === 'unclear') return done({ ...reading, note: 'Not about the renewal, by the look of it: left for the staff.' });
    return toBoss(c, `The rent is agreed at ${aed(c.agreed)}, but the tenant now writes: "${reading.summary}".`);
  }

  // Waiting for the boss, or finished: kept on the thread, and the boss is told.
  await done({ note: `Arrived while the renewal was ${c.status}.` });
  await tell(`${c.lease.building} ${c.lease.unit}: the tenant emailed about the renewal (${c.status === 'boss' ? 'waiting for you' : c.status.replace('_', ' ')}).`);
}

/** Carry out a decision: Reem's within the rules, or the boss's. */
async function act(c, next, s) {
  if (next.do === 'agree') {
    const quote = next.rent === c.offer && c.quote ? c.quote : await quoteFor(c, next.rent);
    const agreed = await update(c.id, { status: 'agreed', agreed: next.rent, offer: next.rent, quote, received: {}, needs: null });
    return mail(agreed, 'agreed', agreedText(agreed, s.payee),
      [await pdf('Lease renewal agreement', agreementMarkdown(agreed, s.payee), `Renewal agreement - ${agreed.lease.building} ${agreed.lease.unit}.pdf`)]);
  }
  if (next.do === 'counter') {
    const quote = await quoteFor(c, next.rent);
    const now = await update(c.id, { status: 'negotiating', offer: next.rent, quote, rounds: c.rounds + 1, needs: null });
    return mail(now, 'counter', counterText(now, next.rent));
  }
  if (next.do === 'reject') {
    const now = await update(c.id, { status: 'not_renewing', needs: null });
    await mail(now, 'not_renewing', notRenewingText(now));
    return tell(`${c.lease.building} ${c.lease.unit}: the tenant will not renew and moves out on ${longDate(c.lease.end_date)}.`);
  }
  if (next.do === 'answer') return mail(c, 'answer', answerText(c, next.text));
  return toBoss(c, next.why);
}

// ---------- the boss ----------

/** The boss's answer on a case waiting for them. */
export async function decide(user, id, { action, rent }) {
  const c = await getCase(id);
  if (!c) throw bad('Renewal not found', 404);
  const s = await settings();
  if (action === 'close') return update(c.id, { status: 'closed', needs: null });
  if (action === 'retry') {
    if (c.status !== 'boss') throw bad('Nothing to try again.', 409);
    if (c.saifsys?.pending) return update(c.id, { status: 'converting', saifsys: null, needs: null });
    if (!String(c.lease.email || '').includes('@')) {
      const { leases = [] } = await D.ask('realestate', 'renewals_due', { days: DAYS_AHEAD });
      const l = leases.find((x) => x.lease_id === c.lease_id);
      if (!String(l?.email || '').includes('@')) throw bad('saifsys still has no email for this tenant.', 409);
      return update(c.id, { lease: l, status: 'dld_needed', needs: null });
    }
    throw bad('Nothing to try again: choose what to answer the tenant.', 409);
  }
  if (c.status !== 'boss') throw bad('This renewal is not waiting for you.', 409);
  if (!s.enabled) throw bad('Lease renewals is switched off.', 409);
  if (action === 'accept') {
    if (!c.tenant_offer) throw bad('The tenant has not offered a figure.', 409);
    return act(c, { do: 'agree', rent: c.tenant_offer }, s).then(() => getCase(c.id));
  }
  if (action === 'offer') {
    const n = Math.round(Number(rent));
    if (!(n > 0)) throw bad('Type the annual rent to offer.');
    return act({ ...c, floor: Math.min(c.floor ?? n, n) }, { do: 'counter', rent: n }, s).then(() => getCase(c.id));
  }
  if (action === 'not_renewing') return act(c, { do: 'reject' }, s).then(() => getCase(c.id));
  throw bad('Unknown choice.');
}

// ---------- saifsys at the end ----------

/** Agreed, signed and paid: saifsys makes and converts the renewal, once. */
export async function convert() {
  const rows = await db.prepare(`SELECT id FROM renewal_cases WHERE status = 'converting' ORDER BY id`).all();
  const s = await settings();
  for (const { id } of rows) {
    const c = await getCase(id);
    try {
      const { renewal } = await D.act('realestate_renewal', 'renew', {
        email: await actingEmail(s), lease_id: c.lease_id, end_date: c.end_date, rent: c.agreed, cheques: c.lease.cheques,
        expected_total: c.quote.cheques_total,
        summary: `Agreed by email through Reem at ${aed(c.agreed)} a year (first offer ${aed(c.dld?.first_offer ?? c.agreed)}, ${c.rounds} counter-offer${c.rounds === 1 ? '' : 's'}). `
          + `Signed agreement${c.lease.payment_method === 'cheque' ? ' and cheque photos' : ''} received by email.`,
      });
      const now = await update(c.id, { status: 'renewed', saifsys: renewal, error: null, needs: null });
      await mail(now, 'done', doneText(now));
      const who = s.actor_id ? [s.actor_id] : [];
      for (const u of who) {
        await D.todo(u, {
          text: `${c.lease.payment_method === 'cheque' ? 'Collect the original cheques and register' : 'Register'} the Ejari for ${c.lease.building} ${c.lease.unit}`,
          notes: `Renewed by email at ${aed(c.agreed)} a year, ${longDate(c.quote.start_date)} to ${longDate(c.quote.end_date)}. saifsys renewal #${renewal.workflow_id}.`,
        });
      }
      await tell(`${c.lease.building} ${c.lease.unit} is renewed at ${aed(c.agreed)}.`);
    } catch (e) {
      if (e.code === 'no_answer' || e.status === 502) {
        await update(c.id, { error: `saifsys: ${e.message} Reem tries again in a few minutes.` });
      } else {
        await update(c.id, { saifsys: { pending: true }, error: null });
        await toBoss(c, `saifsys did not make the renewal: ${e.message} Fix it in saifsys, then tap Try again.`);
      }
    }
  }
  return rows.length;
}

// ---------- silence ----------

/** Reminders after a week of silence, twice; then the boss, if the end is near. */
export async function chase() {
  const rows = await db.prepare(`SELECT id FROM renewal_cases WHERE status IN ('notice_sent', 'negotiating', 'agreed')`).all();
  const nowS = secs();
  for (const { id } of rows) {
    const c = await getCase(id);
    if (!c.last_out_at || (c.last_in_at && c.last_in_at > c.last_out_at)) continue; // the tenant spoke last: nothing to chase
    const left = daysBetween(today(), c.lease.end_date);
    const quiet = (nowS - c.last_out_at) / 86400;
    if (c.status !== 'agreed' && left <= NO_REPLY && c.reminders >= REMINDERS && quiet >= REMIND_AFTER) {
      await update(c.id, { status: 'no_reply', needs: null });
      await tell(`${c.lease.building} ${c.lease.unit}: no answer to the renewal offer, ${left} days before the lease ends.`);
      continue;
    }
    if (c.status === 'agreed' && left <= 30 && c.reminders >= REMINDERS && quiet >= REMIND_AFTER) {
      await toBoss(c, `The rent is agreed at ${aed(c.agreed)}, but the tenant has not sent everything back, ${left} days before the lease ends.`);
      continue;
    }
    if (c.reminders < REMINDERS && quiet >= REMIND_AFTER) {
      await mail(c, 'reminder', reminderText(c));
      await update(c.id, { reminders: c.reminders + 1 });
    }
  }
}

// ---------- the clock ----------

let timer = null;
let busy = false;
export async function tick() {
  if (busy) return;
  busy = true;
  try {
    await openCases().catch((e) => console.warn('[renewals] opening:', e.message));
    if ((await settings()).enabled) {
      await readInbound();
      await convert();
      await chase();
      await resend();
    }
  } catch (e) {
    console.warn('[renewals]', e.message);
  } finally { busy = false; }
}

export function startRenewals() {
  if (timer) return;
  timer = setInterval(tick, EVERY);
  timer.unref?.();
  setTimeout(tick, 60_000);
}

// ---------- routes ----------

const out = (c) => c && {
  id: c.id, status: c.status, needs: c.needs, error: c.error, lease: c.lease, dld: c.dld, offer: c.offer, floor: c.floor,
  agreed: c.agreed, rounds: c.rounds, tenantOffer: c.tenant_offer, received: c.received, saifsys: c.saifsys,
  cheques: c.quote?.cheques || null, chequesTotal: c.quote?.cheques_total ?? null, start: c.quote?.start_date ?? null, end: c.quote?.end_date ?? null,
  lastOutAt: c.last_out_at, lastInAt: c.last_in_at, createdAt: Number(c.created_at), updatedAt: Number(c.updated_at),
};

const settingsOut = async (s) => ({
  enabled: !!s.enabled, floorPct: Number(s.floor_pct), buildingFloors: s.building_floors || {}, maxRounds: Number(s.max_rounds),
  payee: s.payee || '', actor: s.actor_id ? await db.prepare('SELECT id, name FROM users WHERE id = ?').get(s.actor_id) : null,
  actorEmail: s.actor_id ? await D.actor(s.actor_id).catch(() => null) : null,
});

export const renewalRoutes = Router();
renewalRoutes.use(needsModule('renewals'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE, files: 1 } });
const masterOnly = (req, res, next) => (isMaster(req.user) ? next() : res.status(403).json({ error: 'Only the master can change this' }));

renewalRoutes.get('/', wrap(async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM renewal_cases WHERE status <> 'closed' OR updated_at > ${NOW} - 30 * 86400 ORDER BY (lease->>'end_date'), id`).all();
  const acc = await inbox();
  res.json({
    cases: rows.map((r) => out(CASE(r))),
    settings: await settingsOut(await settings()),
    inbox: acc ? acc.email : null,
    saifsys: saifsysConfigured() && saifsysActionsConfigured(),
    master: isMaster(req.user),
  });
}));

renewalRoutes.get('/:id', wrap(async (req, res) => {
  const c = await getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const messages = await db.prepare(`SELECT id, direction, kind, subject, body, status, error, reading, at FROM renewal_messages WHERE case_id = ? ORDER BY id`).all(c.id);
  const files = await db.prepare('SELECT id, message_id, name, mime FROM renewal_files WHERE case_id = ? ORDER BY id').all(c.id);
  res.json({ ...out(c), messages: messages.map((m) => ({ ...m, at: Number(m.at) })), files });
}));

renewalRoutes.get('/:id/files/:file', wrap(async (req, res) => {
  const f = await db.prepare('SELECT mime, path FROM renewal_files WHERE id = ? AND case_id = ?').get(Number(req.params.file) || 0, Number(req.params.id) || 0);
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').type(f.mime).send(await readFile(f.path));
}));

renewalRoutes.post('/:id/dld', upload.single('screenshot'), wrap(async (req, res) => {
  res.json(out(await readDldShot(req.user, req.params.id, req.file)));
}));

renewalRoutes.post('/:id/notice', wrap(async (req, res) => {
  res.json(out(await sendNotice(req.user, req.params.id)));
}));

renewalRoutes.post('/:id/decide', wrap(async (req, res) => {
  res.json(out(await decide(req.user, req.params.id, req.body || {})));
}));

renewalRoutes.put('/settings', masterOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const pct = Number(b.floorPct ?? 0);
  if (!(pct >= -50 && pct <= 20)) return res.status(400).json({ error: 'The lowest rent is a percentage of the current rent, from -50 to 20.' });
  const rounds = Math.round(Number(b.maxRounds ?? 2));
  if (!(rounds >= 0 && rounds <= 5)) return res.status(400).json({ error: 'Counter-offers: 0 to 5.' });
  const floors = {};
  for (const [k, v] of Object.entries(b.buildingFloors || {})) {
    if (v === '' || v === null) continue;
    if (!(Number(v) >= -50 && Number(v) <= 20)) return res.status(400).json({ error: `The lowest rent for ${k} must be from -50 to 20.` });
    floors[String(k).slice(0, 200)] = Number(v);
  }
  const payee = String(b.payee || '').trim().slice(0, 200);
  if (b.enabled && !payee) return res.status(400).json({ error: 'Write who the cheques are payable to before switching renewals on.' });
  if (b.enabled && !(await D.actor(req.user.id))) return res.status(400).json({ error: 'Connect your company email under Email first: saifsys records the renewals as yours.' });
  await db.prepare(`INSERT INTO renewal_settings (id, enabled, floor_pct, building_floors, max_rounds, payee, actor_id, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ${NOW})
    ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, floor_pct = excluded.floor_pct, building_floors = excluded.building_floors,
      max_rounds = excluded.max_rounds, payee = excluded.payee, actor_id = excluded.actor_id, updated_at = excluded.updated_at`)
    .run(!!b.enabled, pct, JSON.stringify(floors), rounds, payee || null, req.user.id);
  res.json(await settingsOut(await settings()));
}));

renewalRoutes.post('/open', masterOnly, wrap(async (req, res) => {
  res.json(await openCases({ force: true }));
}));
