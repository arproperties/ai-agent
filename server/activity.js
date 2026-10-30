import { Router } from 'express';
import { db } from './db.js';
import { cash, region } from './leasingRegion.js';

// The activity log, read back in words: who changed what, and when, with each changed field
// old → new. What is written down, and how, is in server/activityCapture.js.
//
// LABELS names a table and its fields the way a person says them. A table without a line
// here still shows, its name tidied ("lease_work_orders" → "Work orders"), so a new feature
// is never hidden for want of a label; adding one just reads better.

const MONEY = new Set(['amount', 'rent_amount', 'rent_amount_2','security_deposit', 'deposit', 'late_fee', 'balance', 'credit', 'total', 'price', 'cost']);
const SKIP_FIELDS = new Set(['id', 'created_at', 'updated_at']);

export const LABELS = {
  lease_payments: { name: 'Payment', about: (r) => [r.amount != null && cash(r.amount), r.received_on && `received ${r.received_on}`, r.method].filter(Boolean).join(', '),
    fields: { received_on: 'Received on', recorded_by: 'Recorded by', installment_id: 'Charge' } },
  lease_installments: { name: 'Charge', about: (r) => [r.label || 'Rent', r.due_date && `due ${r.due_date}`, r.amount != null && cash(r.amount)].filter(Boolean).join(', '),
    fields: { due_date: 'Due on' } },
  lease_bookings: { name: 'Lease', about: (r) => [r.start_date && r.end_date && `${r.start_date} to ${r.end_date}`, r.status].filter(Boolean).join(', '),
    fields: { rent_amount: 'Rent', rent_amount_2: 'Rent (HUD/Agency)', rent_lines: 'Rent lines', shown_rent: 'Rent amount (shown on the lease)', security_deposit: 'Deposit', start_date: 'Starts', end_date: 'Ends', referred_by: 'Referred by (tenant)' } },
  lease_tenants: { name: 'Tenant', about: (r) => r.full_name, fields: { full_name: 'Name' } },
  lease_events: { name: 'Lease history', about: (r) => r.detail },
  lease_documents: { name: 'Lease document', about: (r) => r.file_name },
  lease_services: { name: 'Building service', about: (r) => r.name },
  lease_sources: { name: 'Tenant source', about: (r) => r.name },
  lease_prospects: { name: 'Prospect', about: (r) => [r.full_name, r.status].filter(Boolean).join(', '),
    fields: { follow_up: 'Follow up on', move_in_date: 'Move-in wanted', lost_reason: 'Why lost', booking_id: 'Lease' } },
  lease_settings: { name: 'Setting', about: (r) => r.key },
  lease_tenant_log: { name: 'Tenant complaint', about: (r) => r.detail },
  lease_tenant_notices: { name: 'Tenant notice' },
  lease_work_orders: { name: 'Work order', about: (r) => r.title || r.category },
  lease_work_order_events: { name: 'Work order update', about: (r) => r.detail || r.kind },
  lease_archive: { name: 'Archived lease', about: (r) => [r.tenant_name, r.start_date && r.end_date && `${r.start_date} to ${r.end_date}`].filter(Boolean).join(', '),
    fields: { tenant_name: 'Tenant', ended_how: 'How it ended', unpaid_at_end: 'Unpaid at end' } },
  lease_archive_payments: { name: 'Archived payment', about: (r) => [r.received_on, r.amount].filter(Boolean).join(', '), fields: { received_on: 'Received on' } },
  lease_archive_work_orders: { name: 'Archived work order', about: (r) => r.detail, fields: { reported_on: 'Reported on', done_on: 'Done on' } },
  lease_archive_files: { name: 'Archived file', about: (r) => r.title || r.file_name },
  prop_companies: { name: 'Company', about: (r) => r.name },
  prop_buildings: { name: 'Building', about: (r) => r.name },
  prop_units: { name: 'Unit', about: (r) => r.unit_no && `Unit ${r.unit_no}`, fields: { unit_no: 'Unit no.' } },
  prop_inspections: { name: 'Inspection', about: (r) => r.kind },
  prop_documents: { name: 'Property document', about: (r) => r.title || r.file_name },
  users: { name: 'Person', about: (r) => r.name },
  module_access: { name: 'Module access', about: (r) => r.module },
  action_access: { name: 'Action access', about: (r) => r.action },
  qb_connection: { name: 'QuickBooks connection', about: (r) => (r.enabled ? 'on' : 'off'),
    fields: { enabled: 'On', company_file: 'Company file' } },
  qb_settings: { name: 'QuickBooks setting', about: (r) => r.key },
  expenses: { name: 'Expense', about: (r) => [r.vendor_name, r.paid_on && `paid ${r.paid_on}`, r.ref_no].filter(Boolean).join(', '),
    fields: { paid_on: 'Paid on', vendor_name: 'Vendor', pay_from: 'Paid from', ref_no: 'Check no.' } },
  expense_lines: { name: 'Expense line', about: (r) => r.amount != null && cash(r.amount), fields: { account_list_id: 'Account' } },
  expense_repeats: { name: 'Repeating bill', about: (r) => [r.vendor_name, r.amount != null && cash(r.amount), r.day && `on day ${r.day}`].filter(Boolean).join(', ') },
  zego_payouts: { name: 'Zego payout', about: (r) => [r.paid_on && `paid ${r.paid_on}`, r.total != null && cash(r.total)].filter(Boolean).join(', ') },
  zego_transactions: { name: 'Zego payment', about: (r) => [r.resident, r.amount != null && cash(r.amount), r.trans_no && `Trans # ${r.trans_no}`].filter(Boolean).join(', '),
    fields: { booking_id: 'Lease', init_date: 'Paid on' } },
  zego_names: { name: 'Zego name', about: (r) => r.name_key },
  zego_mailbox: { name: 'Zego Gmail', about: (r) => [r.email, r.auto === false ? 'weekly sync off' : 'weekly sync on'].filter(Boolean).join(', '),
    fields: { email: 'Gmail', sender: 'From', auto: 'Weekly sync' } },
  todos: { name: 'To-do', about: (r) => r.text },
  routines: { name: 'Routine', about: (r) => r.title || r.text },
  conversations: { name: 'Chat', about: (r) => r.title },
  messages: { name: 'Chat message', about: (r) => r.content, fields: { content: 'Text' } },
  dm_messages: { name: 'Staff message', about: (r) => r.body, fields: { body: 'Text' } },
  email_drafts: { name: 'Email draft', about: (r) => r.subject },
  agents: { name: 'Agent', about: (r) => r.name },
  documents: { name: 'File', about: (r) => r.name },
  memories: { name: 'Memory', about: (r) => r.content },
  meetings: { name: 'Meeting', about: (r) => r.title },
};

const tidy = (s) => { const t = String(s).replace(/^(lease|prop)_/, '').replace(/_id$/, '').replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
export const kindName = (table) => LABELS[table]?.name || tidy(table);
const fieldName = (table, col) => LABELS[table]?.fields?.[col] || tidy(col);

function show(col, v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (MONEY.has(col) && !Number.isNaN(Number(v))) return cash(v);
  if (/_at$/.test(col) && Number(v) > 1e9) return when(new Date(Number(v) * 1000));
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function when(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: region().timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Which unit and tenant a row is about, through its lease where it has one; null when it has none or they are gone. */
async function where(r, seen) {
  const key = `${r.installment_id}|${r.booking_id}|${r.unit_id}|${r.tenant_id}`;
  if (seen.has(key)) return seen.get(key);
  let { booking_id: bookingId, unit_id: unitId, tenant_id: tenantId } = r;
  if (r.installment_id && !bookingId) bookingId = (await db.prepare('SELECT booking_id FROM lease_installments WHERE id = ?').get(r.installment_id))?.booking_id;
  if (bookingId && (!unitId || !tenantId)) {
    const b = await db.prepare('SELECT unit_id, tenant_id FROM lease_bookings WHERE id = ?').get(bookingId);
    unitId ??= b?.unit_id; tenantId ??= b?.tenant_id;
  }
  const unit = unitId && await db.prepare('SELECT u.unit_no, b.name AS building FROM prop_units u JOIN prop_buildings b ON b.id = u.building_id WHERE u.id = ?').get(unitId);
  const tenant = tenantId && await db.prepare('SELECT full_name FROM lease_tenants WHERE id = ?').get(tenantId);
  const out = [unit && `Unit ${unit.unit_no} (${unit.building})`, tenant?.full_name].filter(Boolean).join(' · ') || null;
  seen.set(key, out);
  return out;
}

async function entry(row, seen) {
  const r = row.new || row.old || {};
  const cols = row.action === 'update' ? row.changed || [] : Object.keys(r).filter((c) => !SKIP_FIELDS.has(c));
  const changes = cols.map((c) => ({ field: fieldName(row.table_name, c), from: show(c, row.old?.[c]), to: show(c, row.new?.[c]) }))
    .filter((c) => c.from !== null || c.to !== null);
  const own = LABELS[row.table_name]?.about?.(r) || null;
  const place = row.table_name === 'prop_units' ? null : await where(r, seen);
  return {
    id: row.id, at: row.at, when: when(new Date(row.at)), who: row.actor_name || (row.actor_user_id ? `Person #${row.actor_user_id}` : 'System'),
    via: row.via, kind: kindName(row.table_name), table: row.table_name, row_id: row.row_id, action: row.action,
    about: [own && String(own).slice(0, 120), place].filter(Boolean).join(' — ') || null, changes,
  };
}

const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The tables a kind names: "payment", "Payments", "lease_payments" or part of a label. */
function tablesFor(kind) {
  const k = String(kind).trim().toLowerCase().replace(/s$/, '');
  const hits = Object.entries(LABELS).filter(([t, l]) => t === kind || l.name.toLowerCase() === k || l.name.toLowerCase().includes(k)).map(([t]) => t);
  return hits.length ? hits : [String(kind).trim()];
}

/** The log, newest first, in words. Leaves out what the system did unless `system` is set. */
export async function listActivity(f = {}) {
  const where_ = [];
  const args = [];
  const tz = region().timezone;
  if (f.userId) { where_.push('actor_user_id = ?'); args.push(Number(f.userId)); }
  if (f.person) { where_.push('actor_name ILIKE ?'); args.push(like(f.person)); }
  if (f.kind) { const t = tablesFor(f.kind); where_.push(`table_name IN (${t.map(() => '?').join(', ')})`); args.push(...t); }
  if (f.action) { where_.push('action = ?'); args.push({ added: 'insert', changed: 'update', deleted: 'delete' }[f.action] || f.action); }
  if (f.text) { where_.push('(old::text ILIKE ? OR new::text ILIKE ?)'); args.push(like(f.text), like(f.text)); }
  if (f.from) { where_.push('at >= (?::date)::timestamp AT TIME ZONE ?'); args.push(f.from, tz); }
  if (f.to) { where_.push('at < (?::date + 1)::timestamp AT TIME ZONE ?'); args.push(f.to, tz); }
  if (!f.system || f.system === '0' || f.system === 'false') where_.push("via <> 'system'");
  if (f.before) { where_.push('id < ?'); args.push(Number(f.before)); }
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const rows = await db.prepare(`SELECT * FROM activity_log ${where_.length ? `WHERE ${where_.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`).all(...args);
  const seen = new Map();
  const out = [];
  for (const row of rows) out.push(await entry(row, seen));
  return out;
}

/** The kinds of record in the log so far, for the screen's filter. */
export async function activityKinds() {
  const rows = await db.prepare('SELECT DISTINCT table_name FROM activity_log').all();
  return rows.map((r) => ({ key: r.table_name, label: kindName(r.table_name) })).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * How much a person collected: the payments they recorded with the money received in the
 * range (from the payments themselves, so it matches the Leasing screens and reaches back
 * before the log began), and, from the log, any of their payments since deleted or changed.
 */
export async function collected({ person, from, to }) {
  const people = await db.prepare('SELECT id, name FROM users WHERE name ILIKE ? ORDER BY name').all(like(person || ''));
  if (!person || !people.length) throw Object.assign(new Error(`Nobody called "${person || ''}" was found.`), { status: 404 });
  if (people.length > 1 && !people.some((p) => p.name.toLowerCase() === String(person).toLowerCase())) {
    throw Object.assign(new Error(`More than one person matches "${person}": ${people.map((p) => p.name).join(', ')}. Say which.`), { status: 400 });
  }
  const who = people.find((p) => p.name.toLowerCase() === String(person).toLowerCase()) || people[0];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: region().timezone }).format(new Date());
  const start = from || `${today.slice(0, 8)}01`;
  const end = to || today;
  const paid = await db.prepare(`SELECT p.amount, to_char(p.received_on, 'YYYY-MM-DD') AS received_on, p.method, p.installment_id
    FROM lease_payments p WHERE p.recorded_by = ? AND p.received_on BETWEEN ?::date AND ?::date ORDER BY p.received_on, p.id`).all(who.id, start, end);
  const total = paid.reduce((s, p) => s + Number(p.amount), 0);
  // their payments that are gone or were changed since: whoever did it
  const ids = await db.prepare(`SELECT DISTINCT row_id FROM activity_log WHERE table_name = 'lease_payments' AND action = 'insert' AND actor_user_id = ?
    UNION SELECT DISTINCT row_id FROM activity_log WHERE table_name = 'lease_payments' AND (old ->> 'recorded_by')::int = ?`).all(who.id, who.id);
  const later = ids.length ? await listActivity({ kind: 'lease_payments', system: true, limit: 500 })
    .then((all) => all.filter((e) => e.action !== 'insert' && ids.some((i) => i.row_id === e.row_id))) : [];
  return { person: who.name, from: start, to: end, currency: region().currency, total, total_text: cash(total), count: paid.length, payments: paid, changed_or_deleted: later };
}

// ---------- routes ----------

export const activityRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Who may read it is the module gate's job (server/modules.js, 'activity'); nobody may change it.
activityRoutes.get('/', wrap(async (req, res) => {
  res.json({ entries: await listActivity(req.query), kinds: await activityKinds() });
}));
