import { Router } from 'express';
import { db } from './db.js';
import { isMaster, masterReach } from './access.js';
import { retrievalScope } from './knowledge.js';
import { needsModule } from './modules.js';
import { listCategories } from './docCategories.js';
import { askSaifsys, dubaiDate } from './saifsys/client.js';
import { syncNow, fileFor } from './saifsysDocSync.js';
import { alertSettings, saveAlertSettings } from './documentAlerts.js';

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
  return db.prepare(`SELECT t.*, dt.label AS type, dt.required, dt.opens_case, dc.label AS category, dc.links_to, u.name AS owner_name
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
    .map((p) => ({ ...p, ...tally(files.filter((f) => f.links_to === 'employee' && f.employee_code === p.code), today) }))
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
