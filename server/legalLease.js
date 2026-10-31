import { Router } from 'express';
import { db } from './db.js';
import { needsModule, userModules } from './modules.js';
import { isExternal } from './access.js';
import { askSaifsys, saifsysConfigured, dubaiDate } from './saifsys/client.js';
import { getCase, caseDetail, updateCase, log, listCases, STAGES } from './legalCases.js';
import { checks, sorted } from './legalChecks.js';
import { adviseCase } from './legalAdvice.js';

// Legal cases ↔ saifsys leases. A case is linked to the lease it is about; Reem keeps the
// lease file saifsys gives (api/jarvis/v1/modules/legal.php: rent owed, cheques, Ejari,
// notices, saifsys's own legal desk) and checks it against the case (legalChecks.js), and
// on a tap asks the careful model for a view to help the lawyer decide (legalAdvice.js).
// The same, read only, is in chat for whoever has Legal cases (legalKit below).
//
// saifsys being away never blocks a case: the last copy of the lease file is shown, marked
// with when it was fetched.

const STALE = 30 * 60; // a lease file older than half an hour is fetched again when the case opens
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// Everything that reaches outside, swappable for the tests.
const D = { ask: askSaifsys, configured: saifsysConfigured, advise: adviseCase, now: () => Date.now() };
export const useForTests = (over) => Object.assign(D, over);
const secs = () => Math.floor(D.now() / 1000);
const today = () => dubaiDate(D.now());

// ---------- saifsys ----------

export async function searchLeases(q) {
  const s = String(q || '').trim();
  if (s.length < 2) return [];
  return (await D.ask('legal', 'leases', { q: s.slice(0, 80) })).leases || [];
}

export async function fetchLeaseFile(leaseId) {
  const id = Number(leaseId) || 0;
  if (!id) throw bad('Pick the lease first.');
  return (await D.ask('legal', 'lease', { id })).lease;
}

/** Leases that may need a case, each with the Reem case already open on it, if any. */
export async function atRisk(days = 30) {
  const { leases = [] } = await D.ask('legal', 'at_risk', { days: Math.max(1, Math.min(365, Number(days) || 30)) });
  const linked = await db.prepare(`SELECT l.lease_id, c.id, c.number FROM legal_case_leases l JOIN legal_cases c ON c.id = l.case_id
    WHERE c.stage <> 'closed'`).all();
  const by = Object.fromEntries(linked.map((r) => [r.lease_id, { id: r.id, number: r.number }]));
  return leases.map((x) => ({ ...x, case: by[x.lease_id] || null }));
}

// ---------- the case's lease ----------

const ROW = (r) => (r ? { leaseId: r.lease_id, data: r.data, fetchedAt: r.fetched_at === null ? null : Number(r.fetched_at) } : null);
export const leaseOf = async (caseId) => ROW(await db.prepare('SELECT * FROM legal_case_leases WHERE case_id = ?').get(Number(caseId) || 0));

/**
 * Linking the lease: its file is fetched and kept, and the case's own details that are
 * still empty (party, contacts, building, unit, contract) are filled from it - never
 * overwritten. Both go on the timeline.
 */
export async function linkLease(user, caseId, leaseId) {
  const c = await getCase(caseId);
  if (!c) throw bad('Case not found', 404);
  const file = await fetchLeaseFile(leaseId);
  if (!file?.lease) throw bad('saifsys did not send that lease.', 502);
  const was = await leaseOf(c.id);
  await db.prepare(`INSERT INTO legal_case_leases (case_id, lease_id, data, fetched_at, linked_by, linked_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (case_id) DO UPDATE SET lease_id = EXCLUDED.lease_id, data = EXCLUDED.data, fetched_at = EXCLUDED.fetched_at,
    linked_by = EXCLUDED.linked_by, linked_at = EXCLUDED.linked_at`).run(c.id, file.lease.id, JSON.stringify(file), secs(), user.id, secs());
  const label = [file.lease.number || `lease #${file.lease.id}`, file.tenant?.name, [file.building, file.unit && `unit ${file.unit}`].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  if (was?.leaseId !== file.lease.id) {
    await log(c.id, 'update', `${was ? 'Lease changed' : 'Lease linked'} from saifsys: ${label}`, { user, data: { changes: { lease: { before: was?.leaseId ?? null, after: file.lease.id } } } });
  }
  const fill = {
    party_name: file.tenant?.name, party_phone: file.tenant?.phone || file.tenant?.phone_alt, party_email: file.tenant?.email,
    building: file.building, unit: file.unit, contract_ref: file.lease.number,
  };
  const blanks = Object.fromEntries(Object.entries(fill).filter(([k, v]) => v && !c[k]));
  if (Object.keys(blanks).length) await updateCase(user, c.id, blanks);
  return insight(c.id, { fresh: true });
}

export async function unlinkLease(user, caseId) {
  const was = await leaseOf(caseId);
  if (!was) return insight(caseId);
  await db.prepare('DELETE FROM legal_case_leases WHERE case_id = ?').run(Number(caseId));
  await log(Number(caseId), 'update', `Lease unlinked: ${was.data?.lease?.number || `lease #${was.leaseId}`}`, { user, data: { changes: { lease: { before: was.leaseId, after: null } } } });
  return insight(caseId);
}

/** The lease file fetched again; on failure the old copy stays and the error is said. */
async function refresh(caseId, row) {
  try {
    const file = await fetchLeaseFile(row.leaseId);
    await db.prepare('UPDATE legal_case_leases SET data = ?, fetched_at = ? WHERE case_id = ?').run(JSON.stringify(file), secs(), caseId);
    return { ...row, data: file, fetchedAt: secs(), error: null };
  } catch (e) {
    return { ...row, error: e.message };
  }
}

/**
 * What the case screen and chat show beside the case: the lease file, the checks, and
 * the last advice. fresh: fetch the lease again whatever its age.
 */
export async function insight(caseId, { fresh = false } = {}) {
  const c = await caseDetail(caseId);
  if (!c) throw bad('Case not found', 404);
  let lease = await leaseOf(c.id);
  if (lease && D.configured() && (fresh || !lease.fetchedAt || secs() - lease.fetchedAt > STALE)) lease = await refresh(c.id, lease);
  const advice = await db.prepare(`SELECT a.data, a.at, u.name AS by FROM legal_case_advice a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.case_id = ? ORDER BY a.id DESC LIMIT 1`).get(c.id);
  return {
    saifsys: D.configured(),
    lease: lease && { leaseId: lease.leaseId, data: lease.data, fetchedAt: lease.fetchedAt, error: lease.error || null },
    checks: sorted(checks(c, lease?.data || null, today())),
    advice: advice ? { ...advice.data, at: Number(advice.at), by: advice.by || null } : null,
  };
}

// ---------- the facts, as Reem reads them ----------

const j = (v) => JSON.stringify(v);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The case, its lease and its checks as plain text for the model. */
export function factsOf(c, lease, list, on = today()) {
  const lines = [`Today: ${on}`, '', '# The case',
    `${c.number} · ${c.type} · ${c.title}`, `Stage now: ${c.stageLabel}${c.due ? ` (period ends ${c.due}${c.overdue ? ', OVERDUE' : ''})` : ''} · Status: ${c.statusLabel} · Priority: ${c.priority}`,
    `Party: ${c.party || '-'} ${c.partyPhone || ''} ${c.partyEmail || ''}`.trim(), `Property: ${[c.building, c.unit && `unit ${c.unit}`].filter(Boolean).join(' ') || '-'} · Contract: ${c.contractRef || '-'}`,
    `Opened: ${new Date(c.createdAt * 1000).toISOString().slice(0, 10)}${c.incidentDate ? ` · Incident: ${c.incidentDate}` : ''} · Assigned: ${c.assigned?.name || 'nobody'}`];
  if (c.description) lines.push(`Description: ${clip(c.description, 2000)}`);
  if (c.remarks) lines.push(`Remarks: ${clip(c.remarks, 1000)}`);
  const done = Object.entries(c.steps || {}).filter(([, v]) => v && Object.keys(v).length);
  if (done.length) {
    lines.push('', '## What each stage recorded');
    for (const [k, v] of done) {
      const { entered_at: _e, done_by: _b, ...rest } = v;
      lines.push(`- ${STAGES[k]?.label || k}${v.done_at ? ' (done)' : ' (current)'}: ${j({ ...rest, done_at: v.done_at ? new Date(v.done_at * 1000).toISOString().slice(0, 10) : undefined })}`);
    }
  }
  if (c.files?.length) lines.push('', '## Documents on the case', ...c.files.map((f) => `- ${f.doc_type}: ${f.name} (${STAGES[f.stage]?.label || f.stage})`));
  if (c.events?.length) {
    lines.push('', '## Timeline, newest first');
    for (const e of c.events.slice(0, 25)) lines.push(`- ${new Date(e.at * 1000).toISOString().slice(0, 10)} ${e.by ? `${e.by}: ` : ''}${clip(e.title, 300)}`);
  }
  lines.push('', '# The lease in saifsys');
  if (!lease) lines.push('No lease is linked to this case.');
  else {
    const { open_charges: charges = [], ...money } = lease.money || {};
    lines.push(`Lease: ${j(lease.lease)}`, `Property: ${lease.building} unit ${lease.unit} (${lease.unit_type || '-'})`, `Tenant: ${j(lease.tenant)}`,
      `Money (AED): ${j(money)}`, `Open charges: ${j(charges.slice(0, 25))}`, `Payments (latest first): ${j((lease.payments || []).slice(0, 15))}`,
      `Cheques: ${j(lease.cheques || [])}`, `Security deposit: ${j(lease.deposit)}`, `Ejari: ${j(lease.ejari)}`,
      `Violations / complaints: ${j(lease.violations || [])}`, `Move-out notices: ${j(lease.move_out_notices || [])}`,
      `Renewal open in saifsys: ${lease.renewal || 'none'}`, `Tenant's other leases: ${j(lease.other_leases || [])}`,
      `saifsys legal desk on this lease: ${j(lease.saifsys_legal || {})}`);
  }
  lines.push('', '# Checks the system found', ...(list.length ? list.map((x) => `- [${x.level}] ${x.text}`) : ['- none']));
  return lines.join('\n');
}

/** Ask Reem: a fresh lease file, the checks, and the careful model's view, kept on the case. */
export async function askAdvice(user, caseId) {
  const c = await caseDetail(caseId);
  if (!c) throw bad('Case not found', 404);
  const now = await insight(c.id, { fresh: true });
  const advice = await D.advise({ facts: factsOf(c, now.lease?.data || null, now.checks) });
  await db.prepare('INSERT INTO legal_case_advice (case_id, data, user_id, at) VALUES (?, ?, ?, ?)').run(c.id, JSON.stringify(advice), user.id, secs());
  await log(c.id, 'note', `Reem's advice asked: ${advice.position} position${advice.next[0] ? ` · next: ${advice.next[0].step}` : ''}`.slice(0, 600), { stage: c.stage === 'closed' ? null : c.stage, user });
  return { ...now, advice: { ...advice, at: secs(), by: user.name || null } };
}

// ---------- chat ----------

const tool = (name, description, properties = {}, required = []) => ({
  name, description, input_schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
});

const DEFS = [
  tool('legal_cases', 'The legal cases in Reem\'s Legal cases module: number, type, title, party, property, stage, status, due date, overdue, ' +
    'assigned person, whether a saifsys lease is linked, and the most serious checks. Use for "which cases are overdue", "what is waiting for a decision", ' +
    '"cases on Ayla Residence". Open cases unless the user asks for closed ones.',
    { q: { type: 'string', description: 'Words to match: case number, party, building, unit, reference.' }, closed: { type: 'boolean', description: 'true to include closed cases.' } }),
  tool('legal_case', 'One legal case whole: its stages so far, documents, timeline, the linked lease file from saifsys (rent owed, overdue, cheques and bounced ones, ' +
    'deposit, Ejari, violations, notices, saifsys legal desk), the checks of what is wrong or missing, and the last advice Reem gave on it. ' +
    'Use it before advising on a case: say what is wrong, what to do next, and what the lawyer must decide, using only these facts.',
    { number: { type: 'string', description: 'The case number, e.g. LC-2026-0003.' } }, ['number']),
  tool('legal_lease_search', 'Search saifsys leases by tenant name, building, unit or lease number (any status). Returns lease ids for legal_lease_file.',
    { q: { type: 'string', description: 'At least 2 characters.' } }, ['q']),
  tool('legal_lease_file', 'One saifsys lease as a lawyer needs it: tenant contacts, rent, what is owed and overdue, open charges, payments, cheques (bounced), deposit, Ejari, ' +
    'violations, move-out notices, open renewal, other leases of the tenant, saifsys legal desk, and any Reem legal case already linked to it. ' +
    'Use for "should we take legal action on unit 507?" before a case exists.',
    { lease_id: { type: 'integer', description: 'From legal_lease_search.' } }, ['lease_id']),
  tool('legal_at_risk', 'Leases in saifsys that may need a legal case: a bounced or legal-escalated cheque not replaced, or rent overdue longer than `days`. ' +
    'Each says whether a Reem case is already open on it.',
    { days: { type: 'integer', description: 'Overdue longer than this many days. Default 30.' } }),
];
const STATUS = { legal_cases: 'Reading the legal cases…', legal_case: 'Opening the legal case…', legal_lease_search: 'Searching saifsys leases…',
  legal_lease_file: 'Reading the lease from saifsys…', legal_at_risk: 'Looking for leases at risk…' };

async function findCase(number) {
  const n = String(number || '').trim().toUpperCase();
  return db.prepare('SELECT id FROM legal_cases WHERE upper(number) = ? OR upper(number) LIKE ?').get(n, `%${n}`);
}

const HANDLERS = {
  legal_cases: async ({ q, closed } = {}) => {
    const want = String(q || '').trim().toLowerCase();
    const rows = (await listCases()).filter((c) => (closed || c.stage !== 'closed')
      && (!want || [c.number, c.title, c.type, c.party, c.building, c.unit, c.contractRef, c.refs].join(' ').toLowerCase().includes(want)));
    const leases = await db.prepare('SELECT case_id, data FROM legal_case_leases').all();
    const by = Object.fromEntries(leases.map((l) => [l.case_id, l.data]));
    const on = today();
    return JSON.stringify({ today: on, count: rows.length, cases: rows.slice(0, 60).map((c) => ({
      number: c.number, type: c.type, title: c.title, party: c.party, property: [c.building, c.unit].filter(Boolean).join(' '),
      stage: c.stageLabel, status: c.statusLabel, priority: c.priority, due: c.due, overdue: c.overdue, waitingDecision: c.waitingDecision,
      assigned: c.assigned?.name || null, leaseLinked: !!by[c.id],
      checks: sorted(checks(c, by[c.id] || null, on)).filter((x) => x.level !== 'info').slice(0, 3).map((x) => x.text),
    })) });
  },
  legal_case: async ({ number }) => {
    const row = await findCase(number);
    if (!row) return `No legal case ${number}.`;
    const c = await caseDetail(row.id);
    const now = await insight(c.id);
    return [factsOf(c, now.lease?.data || null, now.checks),
      now.lease?.error ? `\n(saifsys did not answer just now: the lease file is the copy from ${new Date(now.lease.fetchedAt * 1000).toISOString().slice(0, 16)})` : '',
      now.advice ? `\n# Reem's last advice (${new Date(now.advice.at * 1000).toISOString().slice(0, 10)})\n${j(now.advice)}` : ''].join('');
  },
  legal_lease_search: async ({ q }) => JSON.stringify({ leases: await searchLeases(q) }),
  legal_lease_file: async ({ lease_id: id }) => {
    const file = await fetchLeaseFile(id);
    const cases = await db.prepare(`SELECT c.number, c.stage, c.status FROM legal_case_leases l JOIN legal_cases c ON c.id = l.case_id WHERE l.lease_id = ?`).all(Number(id));
    return JSON.stringify({ today: today(), ...file, reem_cases: cases });
  },
  legal_at_risk: async ({ days } = {}) => JSON.stringify({ today: today(), leases: await atRisk(days) }),
};

/** Legal cases in chat, for whoever has the module (never an external user). Read only. */
export async function legalKit(user) {
  if (isExternal(user) || !(await userModules(user)).includes('legal')) return null;
  const names = new Set(['legal_cases', 'legal_case', ...(D.configured() ? ['legal_lease_search', 'legal_lease_file', 'legal_at_risk'] : [])]);
  return {
    definitions: DEFS.filter((d) => names.has(d.name)),
    status: (name) => STATUS[name] || null,
    run: async (block) => {
      try {
        if (!names.has(block.name)) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await HANDLERS[block.name](block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- routes (mounted before legalCaseRoutes, same /api/legal-cases) ----------

export const legalLeaseRoutes = Router();
legalLeaseRoutes.use(needsModule('legal'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

legalLeaseRoutes.get('/leases/search', wrap(async (req, res) => { res.json({ leases: await searchLeases(req.query.q) }); }));
legalLeaseRoutes.get('/leases/at-risk', wrap(async (req, res) => { res.json({ leases: await atRisk(req.query.days) }); }));
legalLeaseRoutes.get('/:id/insight', wrap(async (req, res) => { res.json(await insight(req.params.id, { fresh: req.query.fresh === '1' })); }));
legalLeaseRoutes.put('/:id/lease', wrap(async (req, res) => { res.json(await linkLease(req.user, req.params.id, req.body?.lease_id)); }));
legalLeaseRoutes.delete('/:id/lease', wrap(async (req, res) => { res.json(await unlinkLease(req.user, req.params.id)); }));
legalLeaseRoutes.post('/:id/advice', wrap(async (req, res) => { res.json(await askAdvice(req.user, req.params.id)); }));
