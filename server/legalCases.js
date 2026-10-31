import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';
import { isMaster } from './access.js';
import { fileName } from './files.js';
import { sendPush } from './push.js';
import { needsModule } from './modules.js';
import { directory } from './tenantCare.js';
import { dubaiDate, saifsysConfigured } from './saifsys/client.js';

// Legal cases: Alreem's legal case flow (the Azinova SRS of 31 Aug 2026), one case from its
// type to its end. Whoever has the module (server/modules.js) opens a case, fills in each
// stage and moves it on; the stages come one after another as the SRS's flowchart draws them:
//
//   Initial cooling period → Legal notice → Legal cooling period → Settlement?
//     settled       → Not proceeding → closed
//     no settlement → Proceeding #1 → Government registration → Voucher fee upload → Case status?
//       settled   → Paid → closed
//       dismissed → Appeal → Proceeding #2 → Payment voucher upload → closed
//
// A stage is completed only with its required fields (and, for the two vouchers, the voucher
// itself uploaded); the two decisions are the master's and the deciders' the master picks.
// Stage and status are kept apart: the stage is where the case is in the flow, the status
// what it means for the business (open, settled, in proceedings, dismissed, ...).
//
// Every change is a line on the case's timeline, with what it was before and after - the
// SRS's audit trail. Documents are kept against the case and the stage they came with, and
// are never lost when the case moves on: only the master can take one away, and that too
// stays on the timeline.

const DIR = `${DATA_DIR}/legal-cases`;
const NOW = 'extract(epoch from now())::bigint';
const EVERY = 60 * 60_000; // the cooling-period alerts are a matter of days: once an hour is plenty
const FILE_TYPES = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// Everything that reaches outside, swappable for the tests.
const D = { push: sendPush, now: () => Date.now(), places: async () => (await directory()).buildings };
export const useForTests = (over) => Object.assign(D, over);

const today = () => dubaiDate(D.now());
const secs = () => Math.floor(D.now() / 1000);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// ---------- the flow ----------

const date = (key, label, required = true) => ({ key, label, type: 'date', required });
const text = (key, label, required = false) => ({ key, label, type: 'text', required });
const long = (key, label, required = false) => ({ key, label, type: 'long', required });
const money = (key, label, required = true) => ({ key, label, type: 'money', required });

const PROCEEDING = [date('date', 'Proceeding date'), text('reference', 'Case / reference number', true),
  text('authority', 'Court or government authority'), long('remarks', 'Remarks')];

/**
 * Each stage: what it asks for, and where completing it goes. A decision stage goes where its
 * choice says; a stage with end closes the case with that outcome and status.
 * period: a cooling period, its start and end dates, filled in from the settings when the case
 * gets there. file: the stage cannot be completed until a document of that type is uploaded.
 */
export const STAGES = {
  initial_cooling: { label: 'Initial cooling period', period: 'initial_days', next: 'legal_notice',
    fields: [date('start', 'Start date'), date('end', 'End date'), long('remarks', 'Remarks')] },
  legal_notice: { label: 'Legal notice', next: 'legal_cooling', docType: 'Legal notice',
    fields: [date('notice_date', 'Notice date'), text('reference', 'Notice reference', true), long('description', 'Notice description')] },
  legal_cooling: { label: 'Legal cooling period', period: 'legal_days', next: 'settlement',
    fields: [date('start', 'Start date'), date('end', 'End date'), long('remarks', 'Remarks')] },
  settlement: { label: 'Settlement decision', docType: 'Settlement document',
    decision: { settled: { label: 'Settled', next: 'not_proceeding', status: 'settled' }, no_settlement: { label: 'No settlement', next: 'proceeding_1', status: 'proceeding' } },
    fields: [date('date', 'Decision date'), long('remarks', 'Settlement remarks')] },
  not_proceeding: { label: 'Not proceeding', end: { status: 'closed', outcome: 'Settled - not proceeding' },
    fields: [long('reason', 'Reason for not proceeding', true)] },
  proceeding_1: { label: 'Proceeding #1', next: 'gov_registration', docType: 'Proceeding document', fields: PROCEEDING },
  gov_registration: { label: 'Government registration', next: 'fee_voucher', docType: 'Registration document',
    fields: [text('number', 'Registration number', true), date('date', 'Registration date'), text('authority', 'Authority')] },
  fee_voucher: { label: 'Voucher fee upload', next: 'case_status', docType: 'Fee voucher', file: true,
    fields: [text('voucher_type', 'Voucher type'), text('number', 'Voucher number', true), date('date', 'Voucher date'), money('amount', 'Amount (AED)'), long('remarks', 'Remarks')] },
  case_status: { label: 'Case status',
    decision: { settled: { label: 'Case settled', next: 'paid', status: 'settled' }, dismissed: { label: 'Dismissed', next: 'appeal', status: 'dismissed' } },
    fields: [date('date', 'Decision date'), long('remarks', 'Remarks')] },
  paid: { label: 'Paid', docType: 'Payment document', end: { status: 'paid', outcome: 'Settled after proceedings - paid' },
    fields: [date('date', 'Payment date'), money('amount', 'Amount (AED)'), text('reference', 'Payment reference'), long('remarks', 'Remarks')] },
  appeal: { label: 'Appeal', next: 'proceeding_2', status: 'appealed', docType: 'Appeal document',
    fields: [date('date', 'Appeal date'), text('reference', 'Appeal reference number', true), long('reason', 'Reason', true), long('remarks', 'Remarks')] },
  proceeding_2: { label: 'Proceeding #2', next: 'payment_voucher', docType: 'Proceeding document', fields: PROCEEDING },
  payment_voucher: { label: 'Payment voucher upload', docType: 'Payment voucher', file: true, end: { status: 'closed', outcome: 'Closed after appeal' },
    fields: [text('number', 'Payment voucher reference', true), date('date', 'Voucher date'), money('amount', 'Amount (AED)'), long('remarks', 'Remarks')] },
};
export const FIRST = 'initial_cooling';
export const CLOSED = 'closed';
const stageLabel = (s) => (s === CLOSED ? 'Closed' : STAGES[s]?.label || s);

export const STATUSES = {
  open: 'Open', settled: 'Settled', proceeding: 'In proceedings', dismissed: 'Dismissed', appealed: 'Appealed', paid: 'Paid', closed: 'Closed',
};
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

/** The flow as the screen draws it: every stage in order, with its fields. */
export const flow = () => Object.entries(STAGES).map(([key, s]) => ({
  key, label: s.label, fields: s.fields, file: !!s.file, docType: s.docType || null, period: !!s.period,
  decision: s.decision ? Object.entries(s.decision).map(([k, d]) => ({ key: k, label: d.label })) : null,
}));

/**
 * Where a cooling period stands (SRS FR-014): Pending until it is reached and has begun,
 * Active while it runs, Overdue once its end has passed and the case is still in it,
 * Completed once the stage is done.
 */
export function periodState(c, stage, on = today()) {
  const st = c.steps?.[stage] || {};
  if (st.done_at) return 'completed';
  if (c.stage !== stage || !st.start || on < st.start) return 'pending';
  if (st.end && on > st.end) return 'overdue';
  return 'active';
}

/** The date the case is waiting on now, if its stage has one: a cooling period's end. */
const dueOf = (c) => (STAGES[c.stage]?.period ? c.steps?.[c.stage]?.end || null : null);

// ---------- settings and people ----------

const DEFAULTS = { initial_days: 7, legal_days: 30, warn_days: 3, max_file_mb: 15, deciders: [] };

export async function settings() {
  const s = await db.prepare('SELECT * FROM legal_case_settings WHERE id = 1').get();
  return s ? { ...DEFAULTS, ...s } : { ...DEFAULTS };
}

export async function saveSettings(b = {}) {
  const days = (v, min, max, name) => {
    const n = Math.round(Number(v));
    if (!(n >= min && n <= max)) throw bad(`${name} must be ${min} to ${max}.`);
    return n;
  };
  const s = {
    initial_days: days(b.initial_days, 0, 365, 'The initial cooling period'),
    legal_days: days(b.legal_days, 0, 365, 'The legal cooling period'),
    warn_days: days(b.warn_days, 0, 60, 'The days of warning'),
    max_file_mb: days(b.max_file_mb, 1, 50, 'The largest file'),
    deciders: [...new Set((Array.isArray(b.deciders) ? b.deciders : []).map(Number).filter(Boolean))],
  };
  await db.prepare(`INSERT INTO legal_case_settings (id, initial_days, legal_days, warn_days, max_file_mb, deciders, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ${NOW}) ON CONFLICT (id) DO UPDATE SET initial_days = EXCLUDED.initial_days, legal_days = EXCLUDED.legal_days,
    warn_days = EXCLUDED.warn_days, max_file_mb = EXCLUDED.max_file_mb, deciders = EXCLUDED.deciders, updated_at = EXCLUDED.updated_at`)
    .run(s.initial_days, s.legal_days, s.warn_days, s.max_file_mb, JSON.stringify(s.deciders));
  return settings();
}

/** The settlement and case-status decisions are the master's, and the deciders'. */
export async function canDecide(user) {
  return isMaster(user) || (await settings()).deciders.map(Number).includes(user.id);
}

/** The people who work cases: the masters and everyone ticked for the module. */
async function holders() {
  return db.prepare(`SELECT id, name, email, role FROM users WHERE NOT disabled AND (role = 'master'
    OR (NOT external AND id IN (SELECT user_id FROM module_access WHERE module = 'legal'))) ORDER BY name, id`).all();
}
const masters = async () => (await db.prepare(`SELECT id FROM users WHERE role = 'master' AND NOT disabled`).all()).map((r) => r.id);

/** A push to these people about a case, leaving out whoever caused it. Never in the way. */
function tell(ids, c, body, except = null) {
  const to = [...new Set(ids)].filter((id) => id && id !== except);
  if (!to.length) return;
  Promise.resolve(D.push(to, { title: `${c.number} · ${c.title}`, body, url: `/?legal=${c.id}`, tag: `legal-${c.id}` })).catch(() => {});
}
async function assigneeOrAll(c) { return c.assigned_to ? [c.assigned_to, ...await masters()] : (await holders()).map((p) => p.id); }

// ---------- types ----------

export const listTypes = () => db.prepare('SELECT id, name, active FROM legal_case_types ORDER BY sort, id').all();

export async function addType(name) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw bad('Type a name for the case type.');
  const clash = await db.prepare('SELECT id, active FROM legal_case_types WHERE lower(name) = lower(?)').get(n);
  if (clash) {
    if (clash.active) throw bad('That case type is already there.', 409);
    await db.prepare('UPDATE legal_case_types SET active = true WHERE id = ?').run(clash.id);
    return listTypes();
  }
  await db.prepare('INSERT INTO legal_case_types (name, sort) VALUES (?, (SELECT coalesce(max(sort), 0) + 1 FROM legal_case_types))').run(n);
  return listTypes();
}

/** Rename, or retire / bring back. A retired type is not offered for new cases; old cases keep it. */
export async function changeType(id, { name, active } = {}) {
  const t = await db.prepare('SELECT * FROM legal_case_types WHERE id = ?').get(Number(id) || 0);
  if (!t) throw bad('Case type not found', 404);
  if (name !== undefined) {
    const n = String(name || '').trim().slice(0, 80);
    if (!n) throw bad('Type a name for the case type.');
    if (await db.prepare('SELECT 1 FROM legal_case_types WHERE lower(name) = lower(?) AND id <> ?').get(n, t.id)) throw bad('Another case type has that name.', 409);
    await db.prepare('UPDATE legal_case_types SET name = ? WHERE id = ?').run(n, t.id);
  }
  if (active !== undefined) await db.prepare('UPDATE legal_case_types SET active = ? WHERE id = ?').run(!!active, t.id);
  return listTypes();
}

// ---------- reading ----------

const N = (v) => (v === null || v === undefined ? null : Number(v));
const ROW = (c) => c && { ...c, created_at: N(c.created_at), updated_at: N(c.updated_at), closed_at: N(c.closed_at) };
export const getCase = async (id) => ROW(await db.prepare('SELECT * FROM legal_cases WHERE id = ?').get(Number(id) || 0));

const SELECT = `SELECT c.*, a.name AS assigned_name, b.name AS created_name, x.name AS closed_name FROM legal_cases c
  LEFT JOIN users a ON a.id = c.assigned_to LEFT JOIN users b ON b.id = c.created_by LEFT JOIN users x ON x.id = c.closed_by`;

/** A case as a list shows it. */
export function summary(c, on = today()) {
  const due = dueOf(c);
  const st = STAGES[c.stage];
  return {
    id: c.id, number: c.number, type: c.type_name, typeId: c.type_id, title: c.title, stage: c.stage, stageLabel: stageLabel(c.stage),
    status: c.status, statusLabel: STATUSES[c.status] || c.status, priority: c.priority,
    building: c.building, unit: c.unit, party: c.party_name, contractRef: c.contract_ref,
    assigned: c.assigned_to ? { id: c.assigned_to, name: c.assigned_name || null } : null,
    createdAt: N(c.created_at), updatedAt: N(c.updated_at), closedAt: N(c.closed_at), outcome: c.outcome,
    due, period: st?.period ? periodState(c, c.stage, on) : null, overdue: !!(due && on > due),
    waitingDecision: !!st?.decision, enteredAt: c.steps?.[c.stage]?.entered_at || null,
    refs: Object.values(c.steps || {}).map((v) => [v.reference, v.number].filter(Boolean).join(' ')).filter(Boolean).join(' '),
  };
}

export async function listCases() {
  const on = today();
  return (await db.prepare(`${SELECT} ORDER BY c.id DESC`).all()).map((c) => summary(ROW(c), on));
}

/** One case whole: its details, every stage filled in so far, its documents and its timeline. */
export async function caseDetail(id) {
  const c = ROW(await db.prepare(`${SELECT} WHERE c.id = ?`).get(Number(id) || 0));
  if (!c) return null;
  const files = await db.prepare(`SELECT f.id, f.stage, f.doc_type, f.name, f.mime, f.size, f.created_at, u.name AS by
    FROM legal_case_files f LEFT JOIN users u ON u.id = f.user_id WHERE f.case_id = ? ORDER BY f.id`).all(c.id);
  const events = await db.prepare(`SELECT e.id, e.kind, e.stage, e.title, e.data, e.at, u.name AS by
    FROM legal_case_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.case_id = ? ORDER BY e.at DESC, e.id DESC`).all(c.id);
  const on = today();
  return {
    ...summary(c, on),
    description: c.description, incidentDate: c.incident_date, partyPhone: c.party_phone, partyEmail: c.party_email, remarks: c.remarks,
    createdBy: c.created_name || null, closedBy: c.closed_name || null,
    steps: c.steps || {},
    periods: Object.fromEntries(Object.entries(STAGES).filter(([, s]) => s.period).map(([k]) => [k, periodState(c, k, on)])),
    files: files.map((f) => ({ ...f, created_at: Number(f.created_at) })),
    events: events.map((e) => ({ ...e, at: Number(e.at) })),
  };
}

// ---------- writing ----------

/** A line on the timeline. */
export async function log(caseId, kind, title, { stage = null, data = null, user = null } = {}) {
  await db.prepare('INSERT INTO legal_case_events (case_id, kind, stage, title, data, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(caseId, kind, stage, title, data ? JSON.stringify(data) : null, user?.id || null, secs());
}

const clean = (v, max = 300) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const dateOrNull = (v, name) => {
  const s = clean(v, 10);
  if (s && !DATE.test(s)) throw bad(`${name} must be a date.`);
  return s;
};

const DETAILS = {
  title: ['Title', 200], description: ['Description', 4000], incident_date: ['Incident date', 10], priority: ['Priority', 10],
  building: ['Building', 120], unit: ['Unit', 40], party_name: ['Party name', 200], party_phone: ['Contact number', 60],
  party_email: ['Contact email', 200], contract_ref: ['Contract / reference', 120], remarks: ['Remarks', 4000],
};

function details(b) {
  const out = {};
  for (const [k, [name, max]] of Object.entries(DETAILS)) {
    if (b[k] === undefined) continue;
    out[k] = k === 'incident_date' ? dateOrNull(b[k], name) : clean(b[k], max);
  }
  if (out.priority !== undefined) {
    out.priority ||= 'normal';
    if (!PRIORITIES.includes(out.priority)) throw bad('Pick a priority.');
  }
  if (out.party_email && !out.party_email.includes('@')) throw bad('The contact email does not look right.');
  return out;
}

async function holderId(v) {
  if (v === null || v === undefined || v === '') return null;
  const id = Number(v);
  if (!(await holders()).some((p) => p.id === id)) throw bad('Assign the case to someone who has Legal cases.');
  return id;
}

/** The next case number: LC-2026-0001, counted per year. */
async function nextNumber() {
  const year = today().slice(0, 4);
  const { n } = await db.prepare(`SELECT count(*)::int AS n FROM legal_cases WHERE number LIKE ?`).get(`LC-${year}-%`);
  return (k) => `LC-${year}-${String(n + 1 + k).padStart(4, '0')}`;
}

/** A new case (SRS FR-001..FR-013): its type, its details, and straight into the initial cooling period. */
export async function createCase(user, b = {}) {
  const typeId = Number(b.type_id) || 0;
  const type = await db.prepare('SELECT * FROM legal_case_types WHERE id = ? AND active').get(typeId);
  if (!type) throw bad('Pick the case type first.');
  const d = details(b);
  const assigned = await holderId(b.assigned_to);
  const title = d.title || [type.name, d.party_name || [d.building, d.unit && `Unit ${d.unit}`].filter(Boolean).join(' ')].filter(Boolean).join(' - ');
  const s = await settings();
  const start = today();
  const steps = { [FIRST]: { start, end: addDays(start, s.initial_days), entered_at: secs() } };
  const number = await nextNumber();
  let made = null;
  for (let k = 0; !made && k < 5; k++) {
    made = await db.prepare(`INSERT INTO legal_cases (number, type_id, type_name, title, stage, status, priority, description, incident_date, building, unit,
      party_name, party_phone, party_email, contract_ref, remarks, steps, assigned_to, created_by)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (number) DO NOTHING RETURNING id`)
      .get(number(k), type.id, type.name, title, FIRST, d.priority || 'normal', d.description ?? null, d.incident_date ?? null, d.building ?? null, d.unit ?? null,
        d.party_name ?? null, d.party_phone ?? null, d.party_email ?? null, d.contract_ref ?? null, d.remarks ?? null, JSON.stringify(steps), assigned, user.id);
  }
  if (!made) throw bad('Could not number the case. Try again.', 409);
  const c = await getCase(made.id);
  await log(c.id, 'created', `Case opened: ${type.name}`, { user, data: { number: c.number } });
  await log(c.id, 'stage', `Initial cooling period: ${steps[FIRST].start} to ${steps[FIRST].end}`, { stage: FIRST, user });
  if (assigned) {
    await log(c.id, 'assign', `Assigned to ${await nameOf(assigned)}`, { user, data: { before: null, after: assigned } });
    tell([assigned], c, 'A legal case was assigned to you.', user.id);
  }
  return caseDetail(c.id);
}

const nameOf = async (id) => (id ? (await db.prepare('SELECT coalesce(name, email) AS n FROM users WHERE id = ?').get(id))?.n || `#${id}` : 'nobody');

/** Changing a case's details, its type or who it is assigned to. Each change goes on the timeline, before and after. */
export async function updateCase(user, id, b = {}) {
  const c = await getCase(id);
  if (!c) throw bad('Case not found', 404);
  const d = details(b);
  if (d.title === null) throw bad('The case needs a title.');
  const changes = {};
  for (const [k, v] of Object.entries(d)) if ((c[k] ?? null) !== v) changes[k] = { before: c[k] ?? null, after: v };

  let type = null;
  if (b.type_id !== undefined && Number(b.type_id) !== c.type_id) {
    type = await db.prepare('SELECT * FROM legal_case_types WHERE id = ? AND active').get(Number(b.type_id) || 0);
    if (!type) throw bad('Pick a case type.');
  }
  const assignChanged = b.assigned_to !== undefined && ((await holderId(b.assigned_to)) ?? null) !== (c.assigned_to ?? null);
  const assigned = assignChanged ? await holderId(b.assigned_to) : c.assigned_to;
  if (!Object.keys(changes).length && !type && !assignChanged) return caseDetail(c.id);

  await tx(async () => {
    const set = Object.keys(changes).map((k) => `${k} = ?`);
    const vals = Object.values(changes).map((x) => x.after);
    if (type) { set.push('type_id = ?', 'type_name = ?'); vals.push(type.id, type.name); }
    if (assignChanged) { set.push('assigned_to = ?'); vals.push(assigned); }
    await db.prepare(`UPDATE legal_cases SET ${set.join(', ')}, updated_at = ${NOW} WHERE id = ?`).run(...vals, c.id);
    if (Object.keys(changes).length) {
      await log(c.id, 'update', `Details changed: ${Object.keys(changes).map((k) => DETAILS[k][0]).join(', ')}`, { user, data: { changes } });
    }
    if (type) await log(c.id, 'update', `Case type changed: ${c.type_name} → ${type.name}`, { user, data: { changes: { type: { before: c.type_name, after: type.name } } } });
    if (assignChanged) await log(c.id, 'assign', assigned ? `${c.assigned_to ? 'Reassigned' : 'Assigned'} to ${await nameOf(assigned)}` : 'Unassigned', { user, data: { before: c.assigned_to, after: assigned } });
  });
  if (assignChanged && assigned) tell([assigned], c, c.assigned_to ? 'A legal case was reassigned to you.' : 'A legal case was assigned to you.', user.id);
  return caseDetail(c.id);
}

/** A stage's fields as typed, checked against what the stage asks for. required: refuse a missing one. */
export function stageValues(stage, values = {}, { required = false } = {}) {
  const s = STAGES[stage];
  const out = {};
  const missing = [];
  for (const f of s.fields) {
    let v = values[f.key];
    if (f.type === 'date') v = dateOrNull(v, f.label);
    else if (f.type === 'money') {
      const raw = clean(v, 30);
      if (raw !== null) {
        const n = Number(raw.replace(/,/g, ''));
        if (!(n >= 0) || !Number.isFinite(n)) throw bad(`${f.label} must be a number.`);
        v = Math.round(n * 100) / 100;
      } else v = null;
    } else v = clean(v, f.type === 'long' ? 4000 : 200);
    if (v !== null) out[f.key] = v;
    else if (required && f.required) missing.push(f.label);
  }
  if (missing.length) throw bad(`Fill in ${missing.join(', ')} first.`);
  if (out.start && out.end && out.end < out.start) throw bad('The end date is before the start date.');
  return out;
}

const FIELD_KEYS = (stage) => STAGES[stage].fields.map((f) => f.key);

/** Saving the current stage's fields without completing it, e.g. a cooling period's dates moved. */
export async function saveStage(user, id, values = {}) {
  const c = await getCase(id);
  if (!c) throw bad('Case not found', 404);
  if (c.stage === CLOSED) throw bad('This case is closed.', 409);
  const was = c.steps[c.stage] || {};
  const now = stageValues(c.stage, values);
  const changes = {};
  for (const k of FIELD_KEYS(c.stage)) if ((was[k] ?? null) !== (now[k] ?? null)) changes[k] = { before: was[k] ?? null, after: now[k] ?? null };
  if (!Object.keys(changes).length) return caseDetail(c.id);
  const kept = Object.fromEntries(Object.entries(was).filter(([k]) => !FIELD_KEYS(c.stage).includes(k)));
  const steps = { ...c.steps, [c.stage]: { ...kept, ...now } };
  await db.prepare(`UPDATE legal_cases SET steps = ?, updated_at = ${NOW} WHERE id = ?`).run(JSON.stringify(steps), c.id);
  const labels = Object.fromEntries(STAGES[c.stage].fields.map((f) => [f.key, f.label]));
  await log(c.id, 'update', `${stageLabel(c.stage)}: ${Object.keys(changes).map((k) => labels[k]).join(', ')} saved`, { stage: c.stage, user, data: { changes } });
  return caseDetail(c.id);
}

/**
 * Completing the stage the case is in, and moving it on (SRS FR-015..FR-058). stage must be
 * the case's own, so two people completing the same stage at once move it once. A decision
 * stage needs the choice, and someone allowed to make it; a voucher stage its voucher.
 */
export async function completeStage(user, id, { stage, values = {}, decision = null } = {}) {
  const c = await getCase(id);
  if (!c) throw bad('Case not found', 404);
  if (c.stage === CLOSED) throw bad('This case is closed.', 409);
  if (stage !== c.stage) throw bad(`This case has moved on to ${stageLabel(c.stage)}. Open it again.`, 409);
  const s = STAGES[stage];
  const now = stageValues(stage, values, { required: true });

  let choice = null;
  if (s.decision) {
    choice = s.decision[decision];
    if (!choice) throw bad(`Choose ${Object.values(s.decision).map((d) => d.label).join(' or ')}.`);
    if (!(await canDecide(user))) throw bad('Only the master, and the people the master picks, can take this decision.', 403);
  }
  if (s.file) {
    const has = await db.prepare('SELECT 1 FROM legal_case_files WHERE case_id = ? AND stage = ?').get(c.id, stage);
    if (!has) throw bad(`Upload the ${s.docType.toLowerCase()} first.`);
  }

  const next = choice ? choice.next : s.next || CLOSED;
  const status = choice?.status || s.status || s.end?.status || c.status;
  const st = await settings();
  const steps = { ...c.steps, [stage]: { ...(c.steps[stage] || {}), ...now, ...(decision ? { decision } : {}), done_at: secs(), done_by: user.id } };
  if (next !== CLOSED) {
    const p = STAGES[next].period;
    const start = today();
    steps[next] = { ...(steps[next] || {}), entered_at: secs(), ...(p ? { start, end: addDays(start, st[p]) } : {}) };
  }
  const end = next === CLOSED ? s.end : null;
  const moved = await db.prepare(`UPDATE legal_cases SET stage = ?, status = ?, steps = ?, updated_at = ${NOW}
    ${end ? `, outcome = ?, closed_at = ${NOW}, closed_by = ?` : ''} WHERE id = ? AND stage = ? RETURNING id`)
    .get(next, status, JSON.stringify(steps), ...(end ? [end.outcome, user.id] : []), c.id, stage);
  if (!moved) throw bad('Someone else just moved this case on. Open it again.', 409);

  await log(c.id, choice ? 'decision' : 'stage',
    choice ? `${s.label}: ${choice.label}` : `${s.label} completed`, { stage, user, data: { values: now, ...(decision ? { decision } : {}), status: { before: c.status, after: status } } });
  const after = await getCase(c.id);
  if (end) {
    await log(c.id, 'closed', `Case closed: ${end.outcome}`, { stage, user });
  } else {
    if (STAGES[next].period) await log(c.id, 'stage', `${STAGES[next].label}: ${steps[next].start} to ${steps[next].end}`, { stage: next, user });
    await alertOnArrival(after, user);
  }
  return caseDetail(c.id);
}

/** Who hears that the case has reached a stage that wants someone (SRS: notifications). */
async function alertOnArrival(c, user) {
  const s = STAGES[c.stage];
  if (s.decision) {
    const deciders = [...await masters(), ...(await settings()).deciders.map(Number)];
    return tell(deciders, c, `${s.label} is needed.`, user?.id);
  }
  if (s.file) return tell(await assigneeOrAll(c), c, `${s.label}: the voucher and its details are needed.`, user?.id);
  if (['proceeding_1', 'proceeding_2', 'appeal'].includes(c.stage)) return tell(await assigneeOrAll(c), c, `${s.label} is due.`, user?.id);
  return null;
}

/** A remark on the timeline, from anyone working the case. */
export async function addNote(user, id, words) {
  const c = await getCase(id);
  if (!c) throw bad('Case not found', 404);
  const t = clean(words, 4000);
  if (!t) throw bad('Write the note first.');
  await log(c.id, 'note', t, { stage: c.stage === CLOSED ? null : c.stage, user });
  await db.prepare(`UPDATE legal_cases SET updated_at = ${NOW} WHERE id = ?`).run(c.id);
  return caseDetail(c.id);
}

export async function deleteCase(user, id) {
  if (!isMaster(user)) throw bad('Only the master can delete a case.', 403);
  const files = await db.prepare('SELECT path FROM legal_case_files WHERE case_id = ?').all(Number(id) || 0);
  const { changes } = await db.prepare('DELETE FROM legal_cases WHERE id = ?').run(Number(id) || 0);
  if (!changes) throw bad('Case not found', 404);
  for (const f of files) if (f.path.startsWith(`${DIR}/`)) rmSync(f.path, { force: true });
}

// ---------- documents ----------

/** A document for the case, at the stage it is in (or one already done). f is multer's. */
export async function addFile(user, id, f, { stage, docType } = {}) {
  const c = await getCase(id);
  if (!c) throw bad('Case not found', 404);
  if (!f?.buffer?.length) throw bad('Choose a file.');
  const ext = FILE_TYPES[f.mimetype];
  if (!ext) throw bad('That kind of file cannot be kept here: a PDF, a picture, a Word or an Excel file.');
  const { max_file_mb: max } = await settings();
  if (f.buffer.length > max * 1024 * 1024) throw bad(`That file is larger than ${max} MB.`);
  const at = stage || c.stage;
  if (at !== 'case' && !STAGES[at]) throw bad('Unknown stage.');
  if (at !== 'case' && at !== c.stage && !c.steps?.[at]?.done_at) throw bad('The case has not reached that stage yet.');
  const type = clean(docType, 80) || (at === 'case' ? 'Supporting document' : STAGES[at].docType || 'Supporting document');
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/${randomUUID()}.${ext}`;
  await writeFile(path, f.buffer);
  const name = fileName(f).slice(0, 200);
  await db.prepare('INSERT INTO legal_case_files (case_id, stage, doc_type, name, mime, size, path, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, at, type, name, f.mimetype, f.buffer.length, path, user.id);
  await log(c.id, 'file', `${type} uploaded: ${name}`, { stage: at === 'case' ? null : at, user });
  await db.prepare(`UPDATE legal_cases SET updated_at = ${NOW} WHERE id = ?`).run(c.id);
  return caseDetail(c.id);
}

export async function removeFile(user, id, fileId) {
  if (!isMaster(user)) throw bad('Only the master can take a document off a case.', 403);
  const f = await db.prepare('SELECT * FROM legal_case_files WHERE id = ? AND case_id = ?').get(Number(fileId) || 0, Number(id) || 0);
  if (!f) throw bad('Document not found', 404);
  await db.prepare('DELETE FROM legal_case_files WHERE id = ?').run(f.id);
  if (f.path.startsWith(`${DIR}/`)) rmSync(f.path, { force: true });
  await log(f.case_id, 'file', `${f.doc_type} removed: ${f.name}`, { stage: f.stage === 'case' ? null : f.stage, user });
  return caseDetail(f.case_id);
}

// ---------- reports ----------

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (head, rows) => `﻿${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
const ymd = (secsAt) => (secsAt ? dubaiDate(Number(secsAt) * 1000) : '');

/** The SRS's reports, each a CSV that opens in Excel. */
export const REPORTS = {
  register: 'Legal case register', status: 'Case status report', aging: 'Workflow aging report', settlement: 'Settlement report',
  proceeding: 'Proceeding report', appeal: 'Appeal report', vouchers: 'Voucher / payment report', overdue: 'Overdue cases report',
};

export async function report(kind) {
  if (!REPORTS[kind]) throw bad('Unknown report.', 404);
  const on = today();
  const all = (await db.prepare(`${SELECT} ORDER BY c.id`).all()).map(ROW);
  const party = (c) => [c.party_name, [c.building, c.unit && `Unit ${c.unit}`].filter(Boolean).join(' ')].filter(Boolean).join(' / ');
  const st = (c, k) => c.steps?.[k] || {};
  if (kind === 'register') {
    return csv(['Case number', 'Type', 'Title', 'Party / property', 'Stage', 'Status', 'Priority', 'Assigned to', 'Opened', 'Last update', 'Closed'],
      all.map((c) => [c.number, c.type_name, c.title, party(c), stageLabel(c.stage), STATUSES[c.status], c.priority, c.assigned_name, ymd(c.created_at), ymd(c.updated_at), ymd(c.closed_at)]));
  }
  if (kind === 'status') {
    return csv(['Case number', 'Type', 'Status', 'Stage', 'Outcome', 'Closed', 'Closed by'],
      all.map((c) => [c.number, c.type_name, STATUSES[c.status], stageLabel(c.stage), c.outcome, ymd(c.closed_at), c.closed_name]));
  }
  if (kind === 'aging') {
    return csv(['Case number', 'Stage', 'Days in stage', 'Due date', 'Days overdue', 'Assigned to'],
      all.filter((c) => c.stage !== CLOSED).map((c) => {
        const due = dueOf(c);
        const entered = st(c, c.stage).entered_at;
        return [c.number, stageLabel(c.stage), entered ? daysBetween(ymd(entered), on) : '', due || '', due && on > due ? daysBetween(due, on) : '', c.assigned_name];
      }));
  }
  if (kind === 'settlement') {
    return csv(['Case number', 'Type', 'Decision', 'Decision date', 'Remarks'],
      all.filter((c) => st(c, 'settlement').decision).map((c) => [c.number, c.type_name, STAGES.settlement.decision[st(c, 'settlement').decision].label, st(c, 'settlement').date, st(c, 'settlement').remarks]));
  }
  if (kind === 'proceeding') {
    const rows = [];
    for (const c of all) {
      for (const k of ['proceeding_1', 'proceeding_2']) {
        const p = st(c, k);
        if (p.date || p.reference) rows.push([c.number, STAGES[k].label, p.date, p.reference, p.authority, p.remarks, p.done_at ? 'Completed' : 'In progress']);
      }
    }
    return csv(['Case number', 'Proceeding', 'Date', 'Reference', 'Court / authority', 'Remarks', 'State'], rows);
  }
  if (kind === 'appeal') {
    return csv(['Case number', 'Appeal date', 'Appeal reference', 'Reason', 'Remarks', 'Current stage', 'Current status'],
      all.filter((c) => st(c, 'appeal').reference || c.stage === 'appeal').map((c) => {
        const a = st(c, 'appeal');
        return [c.number, a.date, a.reference, a.reason, a.remarks, stageLabel(c.stage), STATUSES[c.status]];
      }));
  }
  if (kind === 'vouchers') {
    const rows = [];
    for (const c of all) {
      const f = st(c, 'fee_voucher');
      if (f.number) rows.push([c.number, 'Fee voucher', f.voucher_type, f.number, f.date, f.amount, f.remarks]);
      const p = st(c, 'paid');
      if (p.amount !== undefined) rows.push([c.number, 'Paid (settlement)', '', p.reference, p.date, p.amount, p.remarks]);
      const v = st(c, 'payment_voucher');
      if (v.number) rows.push([c.number, 'Payment voucher', '', v.number, v.date, v.amount, v.remarks]);
    }
    return csv(['Case number', 'Kind', 'Voucher type', 'Voucher / reference', 'Date', 'Amount (AED)', 'Remarks'], rows);
  }
  // overdue
  return csv(['Case number', 'Title', 'Stage', 'Due date', 'Days overdue', 'Assigned to'],
    all.filter((c) => { const due = dueOf(c); return c.stage !== CLOSED && due && on > due; })
      .map((c) => [c.number, c.title, stageLabel(c.stage), dueOf(c), daysBetween(dueOf(c), on), c.assigned_name]));
}

// ---------- the clock: cooling periods ending and overdue ----------

/** Once per case, stage and date: a cooling period about to end, and one that has run over. */
export async function alertPeriods() {
  const { warn_days: warn } = await settings();
  const on = today();
  const rows = (await db.prepare(`SELECT * FROM legal_cases WHERE stage IN (${Object.keys(STAGES).filter((k) => STAGES[k].period).map(() => '?').join(',')})`)
    .all(...Object.keys(STAGES).filter((k) => STAGES[k].period))).map(ROW);
  let sent = 0;
  for (const c of rows) {
    const end = dueOf(c);
    if (!end) continue;
    const left = daysBetween(on, end);
    const key = left < 0 ? `${c.stage}:overdue:${end}` : left <= warn ? `${c.stage}:ending:${end}` : null;
    if (!key) continue;
    const fresh = await db.prepare('INSERT INTO legal_case_alerts (case_id, key) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING case_id').get(c.id, key);
    if (!fresh) continue;
    const label = STAGES[c.stage].label;
    tell(await assigneeOrAll(c), c, left < 0 ? `${label} is overdue: it ended on ${end}.` : left === 0 ? `${label} ends today.` : `${label} ends in ${left} day${left > 1 ? 's' : ''} (${end}).`);
    sent += 1;
  }
  return sent;
}

let timer = null;
export function startLegalCases() {
  if (timer) return;
  const tick = () => alertPeriods().catch((e) => console.warn('[legal cases]', e.message));
  timer = setInterval(tick, EVERY);
  timer.unref?.();
  setTimeout(tick, 90_000).unref?.();
}

// ---------- routes ----------

export const legalCaseRoutes = Router();
legalCaseRoutes.use(needsModule('legal'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const masterOnly = (req, res, next) => (isMaster(req.user) ? next() : res.status(403).json({ error: 'Only the master can change this' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

legalCaseRoutes.get('/', wrap(async (req, res) => {
  const s = await settings();
  res.json({
    cases: await listCases(), types: await listTypes(), flow: flow(), statuses: STATUSES, reports: REPORTS,
    people: (await holders()).map((p) => ({ id: p.id, name: p.name || p.email })),
    canDecide: await canDecide(req.user), master: isMaster(req.user), today: today(), saifsys: saifsysConfigured(),
    settings: { initial_days: s.initial_days, legal_days: s.legal_days, warn_days: s.warn_days, max_file_mb: s.max_file_mb, deciders: s.deciders.map(Number) },
  });
}));

// The buildings and units from saifsys, for picking the property. Typing it is fine when saifsys is away.
legalCaseRoutes.get('/places', wrap(async (req, res) => {
  try { res.json(await D.places()); } catch { res.json([]); }
}));

legalCaseRoutes.get('/reports/:kind', wrap(async (req, res) => {
  const body = await report(req.params.kind);
  const name = `${REPORTS[req.params.kind]} ${today()}.csv`;
  res.set('Cache-Control', 'no-store').set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`).type('text/csv').send(body);
}));

legalCaseRoutes.put('/settings', masterOnly, wrap(async (req, res) => { await saveSettings(req.body || {}); res.json({ ok: true }); }));
legalCaseRoutes.post('/types', masterOnly, wrap(async (req, res) => { res.json(await addType(req.body?.name)); }));
legalCaseRoutes.patch('/types/:id', masterOnly, wrap(async (req, res) => { res.json(await changeType(req.params.id, req.body || {})); }));

legalCaseRoutes.post('/', wrap(async (req, res) => { res.json(await createCase(req.user, req.body || {})); }));

legalCaseRoutes.get('/:id', wrap(async (req, res) => {
  const c = await caseDetail(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
}));
legalCaseRoutes.patch('/:id', wrap(async (req, res) => { res.json(await updateCase(req.user, req.params.id, req.body || {})); }));
legalCaseRoutes.delete('/:id', wrap(async (req, res) => { await deleteCase(req.user, req.params.id); res.json({ ok: true }); }));
legalCaseRoutes.put('/:id/stage', wrap(async (req, res) => { res.json(await saveStage(req.user, req.params.id, req.body?.values || {})); }));
legalCaseRoutes.post('/:id/complete', wrap(async (req, res) => { res.json(await completeStage(req.user, req.params.id, req.body || {})); }));
legalCaseRoutes.post('/:id/notes', wrap(async (req, res) => { res.json(await addNote(req.user, req.params.id, req.body?.text)); }));

legalCaseRoutes.post('/:id/files', upload.single('file'), wrap(async (req, res) => {
  res.json(await addFile(req.user, req.params.id, req.file, { stage: req.body?.stage, docType: req.body?.doc_type }));
}));
legalCaseRoutes.get('/:id/files/:file', wrap(async (req, res) => {
  const f = await db.prepare('SELECT mime, path, name FROM legal_case_files WHERE id = ? AND case_id = ?').get(Number(req.params.file) || 0, Number(req.params.id) || 0);
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff')
    .set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`).type(f.mime).send(await readFile(f.path));
}));
legalCaseRoutes.delete('/:id/files/:file', wrap(async (req, res) => { res.json(await removeFile(req.user, req.params.id, req.params.file)); }));
