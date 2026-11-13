import { Router } from 'express';
import { isMaster, isExternal } from './access.js';
import { userModules } from './modules.js';
import { userModules as saifsysModules } from './saifsys/index.js';
import { askSaifsys, saifsysConfigured, dubaiDate } from './saifsys/client.js';

// Leases, one place for all of Reem: a search over saifsys's leases and the whole lease file
// of one (rent and every charge, deposit, cheques and their status, what is owed, payments,
// Ejari, notices, violations, saifsys's legal desk, the tenant's other leases, and the
// earlier leases on the same unit). Chat asks it whatever the talk is about (a renewal, an
// RDC case, anything); the renewal page shows it beside the lease; the renewal's advisors
// read it. Read only: saifsys's own door (api/jarvis/v1/modules/legal.php, actions
// `leases` and `lease`) is the source, and nothing here writes back.
//
// Who may read them: the master, anyone with saifsys's Real Estate module, and anyone with
// Lease renewals. Never an external user.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const FRESH = 5 * 60_000; // a lease file read in the last five minutes is used again, not fetched

// Everything that reaches outside, swappable for the tests.
const D = { ask: askSaifsys, configured: saifsysConfigured, now: () => Date.now() };
export const useForTests = (over) => { Object.assign(D, over); cache.clear(); };

/** May this person read saifsys leases, in chat and on screens? */
export async function mayReadLeases(user) {
  if (!user || isExternal(user)) return false;
  if (isMaster(user)) return true;
  if ((await userModules(user)).includes('renewals')) return true;
  return (await saifsysModules(user)).includes('realestate');
}

/** Leases matching a tenant name, building, unit, "building unit" or lease number, any status, newest first. */
export async function searchLeases(q, { ask = D.ask } = {}) {
  const s = String(q || '').trim();
  if (s.length < 2) throw bad('Type at least 2 characters to search leases.');
  return (await ask('legal', 'leases', { q: s.slice(0, 80) })).leases || [];
}

const cache = new Map(); // lease id → { at, file }

/**
 * One lease's whole file, as saifsys gives it, with `earlier`: the leases before it on the
 * same unit (any tenant), newest first, so last year's rent and charges are one look away.
 */
export async function leaseFile(leaseId, { fresh = false, ask = D.ask } = {}) {
  const id = Number(leaseId) || 0;
  if (!id) throw bad('Which lease? Search for it first.');
  const hit = cache.get(id);
  if (!fresh && hit && D.now() - hit.at < FRESH) return hit.file;
  const file = (await ask('legal', 'lease', { id })).lease;
  if (!file?.lease) throw bad('saifsys has no such lease.', 404);
  const l = file.lease;
  let earlier = [];
  try {
    earlier = (await searchLeases(`${file.building} ${file.unit}`, { ask }))
      .filter((o) => o.lease_id !== id && String(o.building) === String(file.building) && String(o.unit) === String(file.unit)
        && String(o.start_date) < String(l.start_date))
      .sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))
      .slice(0, 5);
  } catch (e) { console.warn('[leases] earlier leases:', e.message); }
  const out = { ...file, earlier, read_at: dubaiDate(D.now()) };
  cache.set(id, { at: D.now(), file: out });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return out;
}

const aed = (n) => `AED ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const money = (label, v) => (Number(v) > 0 ? `${label} ${aed(v)}` : null);

/** The charges written on the lease, in words: what the tenant pays besides the rent. */
export function chargesOf(l) {
  return [money('chiller fee', l.chiller_fee), money('admin fee', l.admin_fee), money('parking', l.parking_fee),
    money('storeroom', l.store_fee), money('service charge a month', l.service_charge_monthly), money('security deposit', l.security_deposit)].filter(Boolean);
}

/**
 * The lease file as plain lines, for Claude to read (the renewal's advisors, the chat beside a
 * renewal). Everything that matters and nothing that does not, so it is short enough to
 * send with every question.
 */
export function leaseText(f) {
  if (!f?.lease) return 'The lease file could not be read from saifsys just now.';
  const l = f.lease;
  const m = f.money || {};
  const legal = f.saifsys_legal || {};
  const cheques = f.cheques || [];
  return [
    `Lease ${l.number || l.id} in saifsys (${l.status}): ${f.building}, Unit ${f.unit}${f.unit_type ? ` (${f.unit_type})` : ''}. Tenant: ${f.tenant?.name || '?'}${f.tenant?.email ? `, ${f.tenant.email}` : ''}.`,
    `Term ${l.start_date} to ${l.end_date}, ${aed(l.annual_rent)} a year, ${l.installments} cheques${l.payment_method ? `, paid by ${l.payment_method}` : ''}.`,
    `Charges on it: ${chargesOf(l).join('; ') || 'none recorded'}.`,
    f.ejari?.number || l.ejari_number ? `Ejari ${f.ejari?.number || l.ejari_number}${f.ejari?.expiry_date ? `, expires ${f.ejari.expiry_date}` : ''}.` : 'No Ejari number in saifsys.',
    m.outstanding !== undefined ? `Owed as of ${m.as_of || 'today'}: ${aed(m.outstanding)}${Number(m.rent_outstanding) ? ` (rent ${aed(m.rent_outstanding)})` : ''}${Number(m.penalties) ? `, penalties ${aed(m.penalties)}` : ''}.` : '',
    cheques.length ? `Cheques: ${cheques.map((c) => `${c.date} ${aed(c.amount)} ${c.status}${c.bounced_reason ? ` (${c.bounced_reason})` : ''}`).join('; ')}.` : '',
    (f.payments || []).length ? `Payments: ${f.payments.slice(0, 20).map((p) => `${p.date} ${aed(p.amount)}${p.method ? ` ${p.method}` : ''}`).join('; ')}.` : '',
    f.deposit ? `Deposit: ${JSON.stringify(f.deposit)}` : '',
    l.renewal_terms ? `Renewal terms: ${l.renewal_terms}` : '',
    l.notes ? `Staff notes: ${l.notes}` : '',
    (f.violations || []).length ? `Violations: ${f.violations.map((v) => `${v.date} ${v.title} (${v.status})`).join('; ')}.` : '',
    (f.move_out_notices || []).length ? `Move-out notices: ${f.move_out_notices.map((n) => `${n.notice_date} to leave ${n.move_out_date} (${n.status})`).join('; ')}.` : '',
    (legal.cases || []).length ? `saifsys legal cases: ${legal.cases.map((c) => `${c.number} "${c.title}" (${c.type}, ${c.status})`).join('; ')}.` : 'saifsys has no legal case on this lease.',
    (legal.hearings || []).length ? `Hearings: ${legal.hearings.map((h) => `${h.date} ${h.title} ${h.status}${h.outcome ? `: ${h.outcome}` : ''}`).join('; ')}.` : '',
    (f.other_leases || []).length ? `The tenant's other leases: ${f.other_leases.map((o) => `${o.lease_number} ${o.building} ${o.unit} (${o.status}, ends ${o.end_date})`).join('; ')} (lease_file has each).` : '',
    (f.earlier || []).length ? `Earlier leases on this unit: ${f.earlier.map((o) => `lease ${o.lease_id} ${o.lease_number} ${o.tenant} ${o.start_date} to ${o.end_date} (${o.status})`).join('; ')} (lease_file has each).` : '',
  ].filter(Boolean).join('\n');
}

// ---------- in chat ----------

const tool = (name, description, properties, required = []) => ({ name, description, input_schema: { type: 'object', properties, required } });
const DEFS = [
  tool('lease_search', 'Search the company\'s leases in saifsys by tenant name, building, unit ("PARK PLACE 610"), or lease number, any status (active, ended, renewed). ' +
    'Returns lease ids for lease_file. Use it whenever the user asks about a lease, a tenant\'s rent or charges, or "the related lease" of what you are discussing.',
    { q: { type: 'string', description: 'At least 2 characters.' } }, ['q']),
  tool('lease_file', 'One saifsys lease whole: tenant, term, rent, every charge (chiller, admin, parking, storeroom, service charge), deposit, cheques with their status ' +
    '(cleared, pending, bounced and why), payments, what is owed, Ejari, renewal terms, staff notes, violations, move-out notices, saifsys legal cases and hearings, ' +
    'the tenant\'s other leases, and the earlier leases on the same unit. For last year\'s figures, call it again with an earlier lease\'s id.',
    { lease_id: { type: 'integer', description: 'From lease_search, or an id in another lease file.' } }, ['lease_id']),
];
const STATUS = { lease_search: 'Searching saifsys leases…', lease_file: 'Reading the lease from saifsys…' };
const HANDLERS = {
  lease_search: async ({ q }) => JSON.stringify({ leases: await searchLeases(q) }),
  lease_file: async ({ lease_id: id }) => JSON.stringify({ today: dubaiDate(D.now()), ...(await leaseFile(id)) }),
};

/** Leases in chat, read only, for whoever may read them. */
export async function leaseKit(user) {
  if (!D.configured() || !(await mayReadLeases(user))) return null;
  return {
    definitions: DEFS,
    status: (name) => STATUS[name] || null,
    run: async (block) => {
      try {
        if (!HANDLERS[block.name]) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await HANDLERS[block.name](block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- for screens ----------

export const leaseRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
leaseRoutes.use(wrap(async (req, res, next) => {
  if (!(await mayReadLeases(req.user))) return res.status(404).json({ error: 'Not found' });
  if (!D.configured()) return res.status(503).json({ error: 'saifsys is not connected.' });
  next();
}));
leaseRoutes.get('/search', wrap(async (req, res) => { res.json({ leases: await searchLeases(req.query.q) }); }));
leaseRoutes.get('/:id', wrap(async (req, res) => { res.json(await leaseFile(req.params.id, { fresh: req.query.fresh === '1' })); }));
