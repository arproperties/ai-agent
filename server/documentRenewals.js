import { Router } from 'express';
import { db } from './db.js';
import { isMaster, masterReach } from './access.js';
import { retrievalScope } from './knowledge.js';
import { needsModule } from './modules.js';
import { listCategories } from './docCategories.js';
import { askSaifsys, dubaiDate } from './saifsys/client.js';
import { syncNow, fileFor, hrSalary } from './saifsysDocSync.js';
import multer from 'multer';
import { alertSettings, saveAlertSettings } from './documentAlerts.js';
import * as cases from './renewalCases.js';
import * as proTasks from './renewalTasks.js';
import { readFileSync } from 'node:fs';
import { compareTerms, compareWithContract } from './renewalCompare.js';
import { readReturnedDoc } from './renewalAi.js';
import { extname } from 'node:path';
import { imapAccount } from './imap.js';
import { createDraft, decideDraft, draftOut, getDraft } from './drafts.js';
import { keepFiles } from './draftFiles.js';
import { kick } from './outbox.js';

// Document Renewals, the screen (client/src/components/DocumentRenewals.jsx): every
// categorised Shelf file this person may read, by the employee or the company it is for,
// with what needs someone on top. Who may read which file is the Shelf's own rule
// (retrievalScope); nothing here widens it. saifsys gives the staff list and profiles;
// when it is down the screen still works from the files.

// How near a file's end is, worst first. not_renewing: somebody said it will not be renewed.
const ORDER = ['expired', 'd14', 'd30', 'd60', 'no_date', 'later', 'not_renewing', 'none'];
const ALERT_STEPS = ['expired', 'd14', 'd30', 'd60'];
const worse = (a, b) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** One file's state on `today` (Dubai, YYYY-MM-DD): the step, the days left, and what is unconfirmed. */
export function docState(d, today = dubaiDate()) {
  const days = d.expires_on ? daysBetween(today, d.expires_on) : null;
  const step = d.not_renewing_at ? 'not_renewing'
    : days === null ? 'no_date'
      : days < 0 ? 'expired' : days <= 14 ? 'd14' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : 'later';
  const confirm = [];
  if (d.expires_on && !d.expiry_confirmed_at) confirm.push('expiry');
  if ((d.employee_code || d.subject) && !d.link_confirmed_at) confirm.push('link');
  return { step, days, confirm };
}

// The files, as the screen gets them: never where a file sits on disk.
const out = ({ path, hash, ...d }, today) => ({ ...d, tags: undefined, has_file: !!path, state: docState(d, today) });

async function readableFiles(user, where = 'TRUE', params = []) {
  const scope = isMaster(user) ? masterReach('t') : retrievalScope(user.id, 't');
  return db.prepare(`SELECT t.*, dt.label AS type, dt.required, dt.opens_case, dc.label AS category, dc.links_to, u.name AS owner_name,
      (SELECT json_build_object('id', r.id, 'status', r.status, 'kind', r.kind) FROM doc_renewal_cases r
        WHERE r.document_id = t.id AND r.closed_at IS NULL) AS open_case,
      (SELECT l.saifsys_has_file FROM saifsys_doc_links l WHERE l.document_id = t.id) AS saifsys_has_file
    FROM documents t
    JOIN document_types dt ON dt.id = t.type_id
    JOIN document_categories dc ON dc.id = t.category_id
    LEFT JOIN users u ON u.id = t.user_id
    WHERE ${scope.sql} AND t.superseded_by IS NULL AND t.kind IS DISTINCT FROM 'fact' AND (${where})
    ORDER BY t.expires_on ASC NULLS LAST, t.id`).all(...scope.params, ...params);
}

// A person's or a company's line on the list: how many files, the worst of them, and the
// counts behind the alerts, so tapping one on top can narrow the list to them.
function tally(files, today) {
  let worst = 'none';
  const steps = {};
  let confirm = 0;
  for (const f of files) {
    const s = docState(f, today);
    worst = worse(s.step, worst);
    if (s.step === 'not_renewing') continue;
    if (ALERT_STEPS.includes(s.step)) steps[s.step] = (steps[s.step] || 0) + 1;
    if (s.confirm.length) confirm++;
  }
  return { documents: files.length, worst, steps, confirm };
}
// A person's labour contract (a type that "opens a case"), the one paper the company renews:
// the one running longest when there are two, with its state. Null: no contract on file.
function contractOf(files, today) {
  const c = files.filter((f) => f.opens_case).sort((a, b) => String(b.expires_on || '').localeCompare(String(a.expires_on || '')))[0];
  return c ? { id: c.id, expires_on: c.expires_on, open_case: c.open_case, ...docState(c, today) } : null;
}
const byUrgency = (a, b) => ORDER.indexOf(a.worst) - ORDER.indexOf(b.worst) || a.name.localeCompare(b.name);

/** The whole screen's list: employees, companies and the alerts on top. */
export async function overview(user, { lookup = askSaifsys, today = dubaiDate() } = {}) {
  const files = await readableFiles(user);
  let roster = null;
  try {
    roster = ((await lookup('hr', 'employees', { status: 'current' })).employees || []).filter((e) => e.code);
  } catch (e) {
    console.error('[document-renewals] no staff list from saifsys:', e.message);
  }

  const people = new Map();
  for (const e of roster || []) {
    people.set(String(e.code), {
      code: String(e.code), name: e.name || String(e.code), position: e.position || null, department: e.department || null,
      company: e.company || null, current: !e.left,
    });
  }
  // Someone with files whom saifsys does not list now: left, or saifsys is down.
  for (const f of files.filter((x) => x.links_to === 'employee' && x.employee_code)) {
    if (!people.has(f.employee_code)) {
      people.set(f.employee_code, { code: f.employee_code, name: f.employee_name || f.employee_code, position: null, department: null, company: null, current: roster ? false : null });
    }
  }
  const employees = [...people.values()]
    .map((p) => {
      const own = files.filter((f) => f.links_to === 'employee' && f.employee_code === p.code);
      return { ...p, ...tally(own, today), contract: contractOf(own, today) };
    })
    .sort(byUrgency);

  const names = [...new Set(files.filter((f) => f.links_to === 'subject' && f.subject).map((f) => f.subject))];
  const subjects = names.map((name) => ({ name, ...tally(files.filter((f) => f.links_to === 'subject' && f.subject === name), today) })).sort(byUrgency);

  const alerts = { expired: 0, d14: 0, d30: 0, d60: 0, confirm: 0, unlinked: 0 };
  for (const f of files) {
    const s = docState(f, today);
    if (s.step === 'not_renewing') continue;
    if (ALERT_STEPS.includes(s.step)) alerts[s.step]++;
    if (s.confirm.length) alerts.confirm++;
    if (!f.employee_code && !f.subject) alerts.unlinked++;
  }
  return { saifsys: !!roster, alerts, cases: await majorCases(employees, files, today), employees, subjects };
}

/**
 * What the boss should know about first, worst first, each with the people in it so the
 * screen can narrow the list to them. A case nobody is in is left out. "Must-have" and
 * "contract" are the master's ticks on the document types (required, opens_case).
 */
async function majorCases(employees, files, today) {
  const staff = files.filter((f) => f.links_to === 'employee' && f.employee_code);
  const filesOf = new Map();
  for (const f of staff) filesOf.set(f.employee_code, [...(filesOf.get(f.employee_code) || []), f]);
  const current = employees.filter((e) => e.current !== false);
  const left = employees.filter((e) => e.current === false);
  const who = (list, test) => list.filter((e) => (filesOf.get(e.code) || []).some((f) => test(f, docState(f, today)))).map((e) => e.code);
  const VALID = ['d14', 'd30', 'd60', 'later'];

  const must = (await listCategories()).filter((c) => c.links_to === 'employee').flatMap((c) => c.types.filter((t) => t.required));
  const missing = employees.some((e) => e.current === true) && must.length
    ? current.filter((e) => e.current === true && must.some((t) => !(filesOf.get(e.code) || []).some((f) => f.type_id === t.id))).map((e) => e.code)
    : [];
  const mustWords = must.map((t) => t.label).join(', ').replace(/, ([^,]*)$/, ' or $1');

  const n = (list, one, many) => `${list.length} ${list.length === 1 ? one : many}`;
  const cases = [
    { key: 'working_expired', tone: 'bad', people: who(current, (f, s) => s.step === 'expired' && (f.required || f.opens_case)) },
    { key: 'left_valid', tone: 'bad', people: who(left, (f, s) => f.required && VALID.includes(s.step)) },
    { key: 'contracts_60', tone: 'warn', people: who(current, (f, s) => f.opens_case && ['d14', 'd30', 'd60'].includes(s.step)) },
    { key: 'due_14', tone: 'warn', people: who(current, (f, s) => s.step === 'd14') },
    { key: 'to_confirm', tone: 'p1', people: who(employees, (f, s) => s.step !== 'not_renewing' && s.confirm.length > 0) },
    { key: 'missing', tone: 'mute', people: missing },
  ];
  const label = {
    working_expired: (p) => `${n(p, 'person is', 'people are')} still working with an expired must-have paper or contract`,
    left_valid: (p) => `${n(p, 'person has', 'people have')} left the company with a visa or ID still valid: cancel it?`,
    contracts_60: (p) => `${n(p, 'contract ends', 'contracts end')} within 60 days: renew or not?`,
    due_14: (p) => `${n(p, 'person has', 'people have')} a paper running out within 14 days`,
    to_confirm: (p) => `${n(p, 'person has', 'people have')} a date or name to confirm`,
    missing: (p) => `${n(p, 'current staff member is', 'current staff are')} missing a ${mustWords} on file`,
  };
  return cases.filter((c) => c.people.length).map((c) => ({ ...c, label: label[c.key](c.people) }));
}

/** One employee: their saifsys profile (or what their files say, if saifsys cannot) and their files. */
export async function employeeData(user, code, { lookup = askSaifsys, today = dubaiDate() } = {}) {
  const want = String(code || '').trim();
  const files = await readableFiles(user, "t.employee_code = ? AND dc.links_to = 'employee'", [want]);
  let employee = null;
  let known = null;
  try {
    const e = (await lookup('hr', 'employee', { q: want })).employee;
    known = !!(e && String(e.code).toLowerCase() === want.toLowerCase());
    if (known) {
      employee = {
        code: String(e.code), name: e.name, position: e.position || null, department: e.department || null, company: e.company || null,
        location: e.location || null, manager: e.manager || null, salary: e.salary || null,
        joined: e.joined || null, status: e.status || null, current: !e.left,
      };
    }
  } catch (e) {
    console.error('[document-renewals] no profile from saifsys:', e.message);
  }
  employee ||= { code: want, name: files[0]?.employee_name || want, current: known === false ? false : null };
  return { employee, documents: files.map((f) => out(f, today)) };
}

/** One company, vehicle or policy, by the name its files carry. */
export async function subjectData(user, name, { today = dubaiDate() } = {}) {
  const files = await readableFiles(user, "t.subject = ? AND dc.links_to = 'subject'", [String(name || '')]);
  return { documents: files.map((f) => out(f, today)) };
}

/** The categorised files nobody is linked to yet: whose visa, which company's licence. */
export async function unlinkedData(user, { today = dubaiDate() } = {}) {
  const files = await readableFiles(user, 't.employee_code IS NULL AND t.subject IS NULL');
  return { documents: files.map((f) => out(f, today)) };
}

/**
 * Renew or Terminate on an employee's row: on their labour contract (a type that "opens a
 * case"), the one paper the company renews. A renewal not yet sent for approval turns into a
 * termination and back; one already further along is left as it is.
 */
export async function startEmployeeCases(user, code, kind) {
  if (!['renew', 'cancel'].includes(kind)) throw Object.assign(new Error('Renew or terminate?'), { status: 400 });
  const files = (await readableFiles(user, "t.employee_code = ? AND dc.links_to = 'employee' AND dt.opens_case", [String(code || '').trim()]))
    .filter((f) => !f.not_renewing_at);
  if (!files.length) throw Object.assign(new Error('They have no labour contract here'), { status: 400 });
  const r = { opened: [], switched: [], left: [] };
  for (const f of files) {
    if (!f.open_case) { r.opened.push((await cases.startCase(user, f.id, kind)).id); continue; }
    if (f.open_case.kind === kind) { r.left.push(f.open_case.id); continue; }
    try {
      await cases.decide(user, f.open_case.id, { choice: kind });
      r.switched.push(f.open_case.id);
    } catch (e) {
      if (e.status !== 400) throw e;
      r.left.push(f.open_case.id); // past its decision: approved, with the PRO...
    }
  }
  return { ...r, case_id: [...r.opened, ...r.switched, ...r.left][0] };
}

/**
 * An employee's company salary (saifsys's HR API) beside what their labour contract says. The
 * contract's file is fetched from saifsys if it is not here yet and read by Reem once; what it
 * read is kept with the file's hash, so it is read again only when the file changes.
 */
export async function contractSalary(user, code, { salary = hrSalary, fetch = fileFor, read = readReturnedDoc } = {}) {
  const want = String(code || '').trim();
  const [c] = (await readableFiles(user, "t.employee_code = ? AND dc.links_to = 'employee' AND dt.opens_case", [want]))
    .sort((a, b) => String(b.expires_on || '').localeCompare(String(a.expires_on || '')));
  if (!c) throw Object.assign(new Error('No labour contract on file'), { status: 404 });
  const doc = await fetch(user, c.id);
  let terms = doc.terms_read?.hash && doc.terms_read.hash === doc.hash ? doc.terms_read : null;
  if (!terms) {
    if (!/^(application\/pdf|image\/)/.test(doc.mime || '')) throw Object.assign(new Error('Reem can only read a contract that is a PDF or a photo'), { status: 400 });
    terms = { ...(await read({ mime: doc.mime, data: readFileSync(doc.path).toString('base64') })), hash: doc.hash };
    await db.prepare('UPDATE documents SET terms_read = ? WHERE id = ?').run(JSON.stringify(terms), doc.id);
  }
  const pay = await salary(want).catch((e) => { console.error('[document-renewals] no salary from saifsys:', e.message); return null; });
  const out = compareWithContract(pay, terms);
  // Kept on the contract for the bell: the differences, or none.
  const differs = out.rows.filter((r) => r.flag === 'differs').length ? out.flags.filter((f) => /company salary/.test(f)) : [];
  await db.prepare('UPDATE documents SET terms_flags = ? WHERE id = ?').run(JSON.stringify(differs), c.id);
  if (!pay) out.flags.unshift('saifsys did not give the company salary');
  return { document: { id: c.id, name: doc.name, expires_on: c.expires_on }, paid_by: pay?.paid_by || null, ...out };
}

// ---------- the bell: who sent what, when ----------

/**
 * Document Renewals' bell: only what was sent out on a labour contract, newest first, with
 * who sent it and when: a renewal or termination email (to whom), and a case given to the
 * PRO. Only for someone who works cases, on the contracts they can read.
 */
export async function renewalFeed(user) {
  if (!(await cases.worker(user))) throw Object.assign(new Error('You do not have Document Renewals'), { status: 403 });
  const ids = (await readableFiles(user, 'dt.opens_case')).map((d) => d.id);
  if (!ids.length) return { items: [] };
  const rows = await db.prepare(`SELECT e.id, e.at, e.kind, e.detail, c.id AS case_id, c.kind AS case_kind, c.employee_name, c.employee_code,
        u.name AS by, p.name AS pro
      FROM doc_renewal_case_events e JOIN doc_renewal_cases c ON c.id = e.case_id
      LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN users p ON e.kind = 'task' AND p.id = (e.detail->>'assignee_id')::int
      WHERE c.document_id = ANY(?::int[]) AND e.kind IN ('emailed', 'task') ORDER BY e.id DESC LIMIT 200`).all(ids);
  const items = rows.map((e) => {
    const what = e.case_kind === 'cancel' ? 'Termination' : 'Renewal';
    const d = e.detail || {};
    const title = e.kind === 'emailed'
      ? `${what} email sent to ${(d.to || []).join(', ')}${d.cc?.length ? ` (cc ${d.cc.join(', ')})` : ''}`
      : `${what} given to the PRO${e.pro ? ` ${e.pro}` : ''} to do`;
    return { key: `e${e.id}`, at: Number(e.at), title, by: e.by || null, case_id: e.case_id, employee_name: e.employee_name, employee_code: e.employee_code };
  });
  return { items };
}

// ---------- the email after a proposal ----------

const longDay = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const money = (n) => (n == null ? null : `AED ${Number(n).toLocaleString('en-US')}`);

/**
 * The email a proposal makes. A renewal goes to the PRO: who it is for, the new 2-year period,
 * the terms, the documents attached, and HR's note. A termination goes to the employee: their
 * contract ends, the last working day and notice; the reason and HR's note stay with HR.
 */
function emailText(c, user, e, pros = []) {
  const t = c.proposal?.terms || {};
  const company = e?.company || '';
  const lines = [];
  if (c.kind === 'cancel') {
    lines.push(`Dear ${c.employee_name || 'colleague'},`, '');
    lines.push(`This is to inform you that your labour contract${company ? ` with ${company}` : ''} will come to an end.`, '');
    if (t.last_working_day) lines.push(`Your last working day: ${longDay(t.last_working_day)}`);
    if (t.notice_days) lines.push(`Notice period: ${t.notice_days} days${t.notice_given_on ? `, starting ${longDay(t.notice_given_on)}` : ''}`);
    lines.push('', 'HR will contact you about your final settlement and the cancellation of your visa and labour card.',
      'Thank you for your work with us.');
  } else {
    lines.push(`Dear ${pros.length === 1 ? pros[0].name : 'PRO team'},`, '');
    lines.push(`Please process the renewal of the labour contract of ${c.employee_name}${c.employee_code ? ` (${c.employee_code})` : ''}${company ? `, ${company}` : ''}.`, '');
    if (t.new_start) lines.push(`New contract: 2 years, ${longDay(t.new_start)} to ${longDay(t.new_end)}`);
    lines.push(c.proposal?.mode === 'update' ? 'Terms: updated as below' : 'Terms: same as the current contract');
    for (const [k, label] of [['position', 'Job title'], ['location', 'Work location']]) if (t[k]) lines.push(`${label}: ${t[k]}`);
    for (const [k, label] of [['basic', 'Basic salary'], ['allowance', 'Allowance'], ['bonus', 'Bonus']]) if (t[k] != null && Number(t[k]) > 0) lines.push(`${label}: ${money(t[k])} a month`);
    const total = ['basic', 'allowance', 'bonus'].reduce((n, k) => n + (Number(t[k]) || 0), 0);
    if (total) lines.push(`Total: ${money(total)} a month`);
    for (const [k, label] of [['hours', 'Working hours'], ['benefits', 'Benefits']]) if (t[k]) lines.push(`${label}: ${t[k]}`);
    lines.push('', 'Their documents are attached.');
    if (c.proposal?.note) lines.push('', `Note: ${c.proposal.note}`);
  }
  lines.push('', 'Regards,', user.name || '', company);
  return lines.join('\n').trim();
}

// The documents a renewal email can carry: the employee's own. A termination carries none.
async function attachable(user, c) {
  if (c.kind === 'cancel' || !c.employee_code) return [];
  return readableFiles(user, "t.employee_code = ? AND dc.links_to = 'employee'", [c.employee_code]);
}

/**
 * The draft the person sees after saving a proposal. A renewal: to the PROs named in
 * Settings, with the employee's documents to tick. A termination: to the employee (their
 * email from saifsys, when it has one), with nothing attached.
 */
export async function caseEmail(user, caseId, { mailbox = imapAccount, lookup = askSaifsys } = {}) {
  const c = await cases.getCase(user, caseId);
  if (!c.proposal) throw Object.assign(new Error('Save the proposal first'), { status: 400 });
  const acc = await mailbox(user.id);
  const docs = await attachable(user, c);
  const e = c.employee_code ? await lookup('hr', 'employee', { q: c.employee_code }).then((r) => r.employee || null, () => null) : null;
  const pros = c.kind === 'cancel' ? [] : (await people((await cases.caseSettings()).pro_ids)).filter((p) => p.email);
  const to = c.kind === 'cancel' ? (e?.email ? [String(e.email).trim().toLowerCase()] : []) : pros.map((p) => p.email.toLowerCase());
  return {
    to,
    to_who: c.kind === 'cancel' ? 'employee' : 'pro',
    subject: c.kind === 'cancel'
      ? `Your labour contract termination${e?.company ? ` – ${e.company}` : ''}`
      : `Labour contract renewal – ${c.employee_name}${c.employee_code ? ` (${c.employee_code})` : ''}`,
    body: emailText(c, user, e, pros),
    from: acc?.can_write && acc.smtp_host ? acc.email : null,
    documents: docs.map((d) => ({ id: d.id, type: d.type, name: d.name, expires_on: d.expires_on, available: !!d.path || d.saifsys_has_file !== false })),
  };
}

/**
 * Send it: the person typed the addresses and pressed Send, so the draft is made and approved
 * in one go and the outbox sends it from their own mailbox. The ticked documents (the
 * employee's own, fetched from saifsys if not here yet) are attached; a termination has none.
 */
export async function sendCaseEmail(user, caseId, { to, cc = [], subject, body, document_ids: ids = [] } = {}, { mailbox = imapAccount, fetch = fileFor, kick: go = kick } = {}) {
  const c = await cases.getCase(user, caseId);
  const acc = await mailbox(user.id);
  if (!acc?.can_write || !acc.smtp_host) throw Object.assign(new Error('Connect your email with sending turned on first (Settings, Email)'), { status: 400 });
  const own = new Map((await attachable(user, c)).map((d) => [d.id, d]));
  const files = [];
  for (const id of (Array.isArray(ids) ? ids : []).map(Number)) {
    const d = own.get(id);
    if (!d) throw Object.assign(new Error('That document is not one of this employee\'s'), { status: 400 });
    const doc = await fetch(user, id);
    files.push({ name: `${d.type} - ${c.employee_name || c.employee_code}${extname(doc.name || doc.path || '') || '.pdf'}`.replace(/[\\/:*?"<>|]+/g, '-'), mimetype: doc.mime, buffer: readFileSync(doc.path) });
  }
  let draft = await createDraft(user.id, { to, cc, subject: String(subject || '').trim(), body: String(body || '').trim(), from: acc.email, attachments: keepFiles(user.id, files) });
  draft = await decideDraft(user.id, draft.id, true);
  go();
  await cases.event(c.id, user.id, 'emailed', { draft_id: draft.id, to: JSON.parse(draft.to_addrs), cc: JSON.parse(draft.cc_addrs), files: files.map((f) => f.name) });
  return draftOut(await getDraft(user.id, draft.id));
}

// ---------- routes ----------

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const documentRenewalRoutes = Router();
documentRenewalRoutes.use(needsModule('document_renewals'));
documentRenewalRoutes.get('/', wrap(async (req, res) => {
  res.json({ ...await overview(req.user), types: await listCategories(), master: isMaster(req.user) });
}));
documentRenewalRoutes.get('/employees/:code', wrap(async (req, res) => {
  res.json(await employeeData(req.user, req.params.code));
}));
documentRenewalRoutes.post('/employees/:code/cases', wrap(async (req, res) => {
  res.json(await startEmployeeCases(req.user, req.params.code, req.body?.kind));
}));
documentRenewalRoutes.get('/employees/:code/contract-salary', wrap(async (req, res) => {
  res.json(await contractSalary(req.user, req.params.code));
}));
documentRenewalRoutes.get('/feed', wrap(async (req, res) => { res.json(await renewalFeed(req.user)); }));
documentRenewalRoutes.get('/subjects', wrap(async (req, res) => {
  res.json(await subjectData(req.user, req.query.name));
}));
// The master brings saifsys's employee documents across now, rather than waiting for the night.
documentRenewalRoutes.post('/sync', wrap(async (req, res) => {
  res.json(await syncNow(req.user));
}));
// Before a document is opened: makes sure its file is here, asking saifsys for it if it was
// copied before its file came. Then the screen opens /api/documents/:id/file as any file.
documentRenewalRoutes.post('/documents/:id/file', wrap(async (req, res) => {
  const doc = await fileFor(req.user, req.params.id);
  res.json({ id: doc.id, ready: true });
}));
// The alert days (60/30/14, every 7 after expiry): everyone with the module reads them, the master sets them.
documentRenewalRoutes.get('/alert-settings', wrap(async (req, res) => { res.json(await alertSettings()); }));
documentRenewalRoutes.put('/alert-settings', wrap(async (req, res) => { res.json(await saveAlertSettings(req.user, req.body || {})); }));
documentRenewalRoutes.get('/unlinked', wrap(async (req, res) => {
  res.json(await unlinkedData(req.user));
}));

// ---------- renewal cases (server/renewalCases.js) ----------


const caseUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const people = async (ids) => (ids?.length
  ? db.prepare('SELECT id, name, email FROM users WHERE id = ANY(?::int[]) ORDER BY lower(name)').all(ids)
  : []);

/** A case as its page shows it: the document, the employee from saifsys, pay against payroll, the timeline. */
async function casePage(user, id) {
  const c = await cases.getCase(user, id);
  const doc = await db.prepare(`SELECT d.id, d.title, d.name, d.expires_on, d.path IS NOT NULL AS has_file, t.label AS type, t.opens_case
    FROM documents d LEFT JOIN document_types t ON t.id = d.type_id WHERE d.id = ?`).get(c.document_id);
  let employee = null;
  let compare = null;
  if (c.employee_code) {
    employee = await askSaifsys('hr', 'employee', { q: c.employee_code }).then((r) => r.employee, () => null);
    if (doc?.opens_case) {
      const pay = await askSaifsys('hr_docs', 'payroll', { code: c.employee_code, months: 6 }).then((r) => r.items, () => []);
      compare = compareTerms(employee, pay, dubaiDate());
    }
  }
  const events = await db.prepare(`SELECT e.*, u.name AS user_name FROM doc_renewal_case_events e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.case_id = ? ORDER BY e.id DESC`).all(c.id);
  const tasks = await db.prepare(`SELECT t.*, u.name AS assignee_name FROM doc_renewal_case_tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.case_id = ? ORDER BY t.id`).all(c.id);
  const files = tasks.flatMap((t) => t.evidence?.files || []);
  const returned = files.length ? await db.prepare(`SELECT id, title, name, expires_on, path IS NOT NULL AS has_file FROM documents WHERE id = ANY(?::int[])`).all(files) : [];
  const settings = await cases.caseSettings();
  return { case: c, document: doc, employee, compare, events, tasks, returned, pros: await people(settings.pro_ids), master: isMaster(user) };
}

documentRenewalRoutes.get('/cases', wrap(async (req, res) => { res.json({ cases: await cases.listCases(req.user) }); }));
documentRenewalRoutes.get('/cases/:id', wrap(async (req, res) => { res.json(await casePage(req.user, req.params.id)); }));
documentRenewalRoutes.post('/documents/:id/case', wrap(async (req, res) => {
  res.json(await cases.startCase(req.user, req.params.id, req.body?.kind));
}));
const step = (fn) => wrap(async (req, res) => { await fn(req); res.json(await casePage(req.user, req.params.id)); });
documentRenewalRoutes.post('/cases/:id/decision', step((req) => cases.decide(req.user, req.params.id, req.body || {})));
documentRenewalRoutes.post('/cases/:id/proposal', step((req) => cases.propose(req.user, req.params.id, req.body || {})));
documentRenewalRoutes.post('/cases/:id/submit', step((req) => cases.submit(req.user, req.params.id)));
documentRenewalRoutes.post('/cases/:id/approve', step((req) => cases.approve(req.user, req.params.id)));
documentRenewalRoutes.post('/cases/:id/reject', step((req) => cases.reject(req.user, req.params.id, req.body || {})));
documentRenewalRoutes.post('/cases/:id/pause', step((req) => cases.pause(req.user, req.params.id, req.body || {})));
documentRenewalRoutes.post('/cases/:id/resume', step((req) => cases.resume(req.user, req.params.id)));
documentRenewalRoutes.post('/cases/:id/out-of-scope', step((req) => cases.outOfScope(req.user, req.params.id, req.body || {})));
documentRenewalRoutes.post('/cases/:id/tasks', step((req) => proTasks.createTask(req.user, req.params.id, req.body || {})));
documentRenewalRoutes.post('/cases/:id/papers/:docId/check', step((req) => cases.checkPapers(req.user, req.params.id, req.params.docId)));
documentRenewalRoutes.get('/cases/:id/email', wrap(async (req, res) => { res.json(await caseEmail(req.user, req.params.id)); }));
documentRenewalRoutes.post('/cases/:id/email', wrap(async (req, res) => { res.json(await sendCaseEmail(req.user, req.params.id, req.body || {})); }));
documentRenewalRoutes.post('/cases/:id/verify', step((req) => cases.verify(req.user, req.params.id, req.body || {})));

// The case settings: approvers, PROs, when a contract opens a case. The master sets them.
documentRenewalRoutes.get('/case-settings', wrap(async (req, res) => {
  const s = await cases.caseSettings();
  const staff = isMaster(req.user) ? await db.prepare('SELECT id, name, email FROM users WHERE NOT external ORDER BY lower(name)').all() : [];
  res.json({ ...s, staff });
}));
documentRenewalRoutes.put('/case-settings', wrap(async (req, res) => {
  res.json(await cases.saveCaseSettings(req.user, req.body || {}));
}));

// ---------- the PRO's tasks: their own, nothing else (no module needed) ----------

export const proTaskRoutes = Router();
proTaskRoutes.get('/', wrap(async (req, res) => { res.json({ tasks: await proTasks.myTasks(req.user) }); }));
proTaskRoutes.get('/:id', wrap(async (req, res) => { res.json(await proTasks.taskView(req.user, req.params.id)); }));
proTaskRoutes.get('/:id/files/:docId', wrap(async (req, res) => {
  const d = await proTasks.taskFile(req.user, req.params.id, req.params.docId);
  if (!d.path) return res.status(404).json({ error: 'This paper has no file yet' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(d.mime || 'application/octet-stream').sendFile(d.path, { dotfiles: 'allow' });
}));
proTaskRoutes.post('/:id/files', caseUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file' });
  res.json(await proTasks.taskUpload(req.user, req.params.id, req.file));
}));
proTaskRoutes.post('/:id/done', wrap(async (req, res) => { await proTasks.finishTask(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
proTaskRoutes.post('/:id/blocked', wrap(async (req, res) => { await proTasks.blockTask(req.user, req.params.id, req.body || {}); res.json({ ok: true }); }));
