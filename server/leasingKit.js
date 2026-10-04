import { db } from './db.js';
import { create } from './properties.js';
import { availability, todayHere, listServices, addService, listSources, addSource, addTenant, createBooking, updateBooking, confirmBooking, getBooking, listBookings, bookingPayments, total } from './leasing.js';
import { report } from './leasingReports.js';
import { cash, region } from './leasingRegion.js';

// Riley's hands in leasing. She reads any report, a tenant's account and which units are
// free, and she sets things up from the conversation: a company, its buildings and units, a
// building's services, a tenant, a booking (with where the tenant came from). So a whole tenancy can be made without leaving
// the chat, and whatever is missing on the way (the building, the service) is made there too.
//
// She does what the person asking could do on the screens and no more: only the master adds
// companies, buildings and units. A booking is saved as a draft unless the person has clearly
// said to confirm it, and a booking that exists is changed, not made a second time.
// She never records a payment, cancels or deletes: people do that on the screens.

const REPORT = { rent_roll: 'rent-roll', overdue: 'aging', collections: 'collections', expiring_leases: 'expiring', vacant_units: 'vacancy' };
const ASK = 'Use only what the user has told you: ask for anything missing, and never invent a name, a phone number, a price or a date.';
const str = { type: 'string' };

export const LEASING_TOOLS = [
  {
    name: 'leasing_report',
    description: 'Look up the property leasing records: who rents which unit and for how much (rent_roll), who is behind on rent and by how long (overdue), '
      + 'payments received between two dates (collections), leases ending soon (expiring_leases), or empty units (vacant_units). '
      + 'The result says which currency the amounts are in. Use it for any question about tenants, rent, occupancy or collections. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        report: { type: 'string', enum: Object.keys(REPORT) },
        company: { type: 'string', description: 'Only this company (part of its name is enough). Leave out for all.' },
        building: { type: 'string', description: 'Only this building (part of its name is enough). Leave out for all.' },
        from: { type: 'string', description: 'collections only: first day, YYYY-MM-DD. Default: the 1st of this month.' },
        to: { type: 'string', description: 'collections only: last day, YYYY-MM-DD. Default: today.' },
        days: { type: 'integer', enum: [30, 60, 90], description: 'expiring_leases only: how far ahead to look. Default 90.' },
      },
      required: ['report'],
    },
  },
  {
    name: 'leasing_tenant_statement',
    description: "One tenant's account: every rent, deposit or charge due so far, every payment, and the balance still owed. "
      + 'Use it before drafting a reminder to a tenant, so the amount and dates are right. Read-only.',
    input_schema: { type: 'object', properties: { tenant: { type: 'string', description: "The tenant's name, or part of it." } }, required: ['tenant'] },
  },
  {
    name: 'leasing_free_units',
    description: 'Which units of a building are free for the whole of a date range, and who has the ones that are not. Read-only.',
    input_schema: {
      type: 'object',
      properties: { building: { type: 'string' }, start_date: { type: 'string', description: 'YYYY-MM-DD' }, end_date: { type: 'string', description: 'YYYY-MM-DD, the last night' } },
      required: ['building', 'start_date', 'end_date'],
    },
  },
  {
    name: 'leasing_list',
    description: 'What is already set up: the companies, the buildings (of one company or all), the units or the services of a building, tenants by name, the sources (where tenants come from: one list for the whole app), or the bookings (drafts included) with their references and charges. '
      + 'Check here before adding anything, so nothing is made twice. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['companies', 'buildings', 'units', 'services', 'tenants', 'sources', 'bookings'] },
        company: { ...str, description: 'buildings: only this company.' },
        building: { ...str, description: 'units and services: which building (required for those). bookings: only this building.' },
        search: { ...str, description: 'tenants: part of a name, phone or email. bookings: part of the tenant, unit or building name.' },
      },
      required: ['what'],
    },
  },
  {
    name: 'leasing_add_company',
    description: `Add a company (a landlord of the group) to Properties. Master only. ${ASK}`,
    input_schema: { type: 'object', properties: { name: str, trade_license_no: str, trn: str, phone: str, email: str, address: str }, required: ['name'] },
  },
  {
    name: 'leasing_add_building',
    description: `Add a building under a company that exists (add the company first if it does not). Master only. ${ASK}`,
    input_schema: { type: 'object', properties: { company: str, name: str, emirate: str, area: str, address: str }, required: ['company', 'name'] },
  },
  {
    name: 'leasing_add_units',
    description: `Add one or many units to a building that exists. Master only. Give every unit its own number; "101 to 110" is ten units. ${ASK}`,
    input_schema: {
      type: 'object',
      properties: {
        building: str,
        units: { type: 'array', maxItems: 300, items: { type: 'object', properties: { unit_no: str, floor: str, type: { ...str, description: 'Studio, 1BR, 2BR, Shop, Office, Parking…' }, size_sqft: { type: 'number' }, furnished: { type: 'boolean' } }, required: ['unit_no'] } },
      },
      required: ['building', 'units'],
    },
  },
  {
    name: 'leasing_add_service',
    description: `Add an extra service to a building's list (pet fee, parking, laundry…), which its bookings can then be charged. ${ASK}`,
    input_schema: {
      type: 'object',
      properties: { building: str, name: str, amount: { type: 'number', description: 'The usual price. Leave out if not known.' },
        repeats: { type: 'boolean', description: 'true: charged with every rent payment. false (default): once, on the first day.' } },
      required: ['building', 'name'],
    },
  },
  {
    name: 'leasing_add_tenant',
    description: `Add a tenant (a person or a company that rents), with a contact number. Check leasing_list tenants first: an existing tenant is used, not added again. ${ASK}`,
    input_schema: {
      type: 'object',
      properties: { full_name: str, phone: str, email: str, id_no: { ...str, description: 'Emirates ID or other ID number' }, nationality: str, is_company: { type: 'boolean' },
        same_name_is_someone_else: { type: 'boolean', description: 'Only when a tenant of this name exists and the user has said this is a different person.' } },
      required: ['full_name', 'phone'],
    },
  },
  {
    name: 'leasing_add_booking',
    description: 'Make a NEW booking of a unit for a tenant. To change a booking that already exists, a draft included (add a charge, new dates, another rent), '
      + 'use leasing_change_booking: never make it again. The building, the unit and the tenant must exist: add them first in this same turn if they do not. '
      + "A charge whose name is not yet in the building's services is added to that list as it is used. "
      + 'It is saved as a DRAFT unless the user has clearly said to confirm it; a confirmed booking takes the unit and writes the payment schedule. '
      + `Afterwards say which it is, with its reference. ${ASK}`,
    input_schema: {
      type: 'object',
      properties: {
        building: str, unit_no: str, tenant: { ...str, description: "The tenant's name, as in leasing_list tenants." },
        start_date: { ...str, description: 'YYYY-MM-DD' }, end_date: { ...str, description: 'YYYY-MM-DD, the last day of the stay' },
        rent_amount: { type: 'number' }, rent_period: { type: 'string', enum: ['month', 'year'], description: 'Whether rent_amount is per month or per year. Default month.' },
        payment_frequency: { type: 'string', enum: ['monthly', 'quarterly', 'every_6_months', 'yearly', 'upfront'], description: 'Default monthly.' },
        security_deposit: { type: 'number' },
        discount_percent: { type: 'number', description: 'A discount off the rent, in percent. Only when the user gives one.' },
        discount_amount: { type: 'number', description: 'A discount as an amount off rent_amount (off the month, or off the year). Give this or discount_percent, never both.' }, discount_note: { ...str, description: 'Why the discount was given.' },
        tax_percent: { type: 'number', description: "Tax (VAT) on the rent and the charges, in percent; the deposit is never taxed. Left out, the booking gets the region's usual tax, as the booking form does: say so in the answer. 0 only when the user says there is no tax." },
        charges: { type: 'array', maxItems: 10, items: { type: 'object', properties: { name: str, amount: { type: 'number' }, repeats: { type: 'boolean', description: 'true: with every rent payment. false: once.' } }, required: ['name', 'amount'] } },
        source: { ...str, description: 'Where the tenant came from (walk-in, referral, a listing site…), as in leasing_list sources. Only when the user says; a new one is added to that list.' },
        contract_no: str, notes: str,
        confirm: { type: 'boolean', description: 'true only when the user has said to confirm. Default false: a draft.' },
      },
      required: ['building', 'unit_no', 'tenant', 'start_date', 'end_date', 'rent_amount'],
    },
  },
  {
    name: 'leasing_change_booking',
    description: 'Change a booking that already exists, by its reference: its dates, rent, discount, tax, deposit, unit, source, or its extra charges. Give only what changes; the rest stays. '
      + `Use this, not leasing_add_booking, whenever the user corrects or adds to a booking already made. It does not confirm a draft. ${ASK}`,
    input_schema: {
      type: 'object',
      properties: {
        booking: { ...str, description: 'The reference, like BK-2026-0007.' },
        unit_no: { ...str, description: 'Move it to this unit of the same building.' },
        start_date: { ...str, description: 'YYYY-MM-DD' }, end_date: { ...str, description: 'YYYY-MM-DD, the last day of the stay' },
        rent_amount: { type: 'number' }, rent_period: { type: 'string', enum: ['month', 'year'] },
        payment_frequency: { type: 'string', enum: ['monthly', 'quarterly', 'every_6_months', 'yearly', 'upfront'] },
        security_deposit: { type: 'number' },
        discount_percent: { type: 'number', description: 'A discount off the rent, in percent. 0 takes the discount off.' },
        discount_amount: { type: 'number', description: 'A discount as an amount off rent_amount (off the month, or off the year). Give this or discount_percent, never both. 0 takes the discount off.' }, discount_note: { ...str, description: 'Why the discount was given.' },
        tax_percent: { type: 'number', description: 'Tax (VAT) on the rent and the charges, in percent; the deposit is never taxed. 0 takes the tax off.' },
        set_charges: { type: 'array', maxItems: 10, description: 'Charges to add, or to re-price if the booking already has one of that name. The others stay as they are.',
          items: { type: 'object', properties: { name: str, amount: { type: 'number' }, repeats: { type: 'boolean', description: 'true: with every rent payment. false: once.' } }, required: ['name', 'amount'] } },
        remove_charges: { type: 'array', items: str, description: 'Names of charges to take off the booking.' },
        source: { ...str, description: 'Where the tenant came from, as in leasing_list sources; a new one is added to that list. Empty takes it off.' },
        contract_no: str, notes: str,
      },
      required: ['booking'],
    },
  },
  {
    name: 'leasing_confirm_booking',
    description: 'Confirm a draft booking, by its reference (BK-2026-0007). Only when the user has said to. It takes the unit for those dates and writes the payment schedule.',
    input_schema: { type: 'object', properties: { booking: { ...str, description: 'The reference, like BK-2026-0007.' } }, required: ['booking'] },
  },
];

/** The one row whose name contains `q`; says which ones there are when it is none or several. */
async function find(table, what, q) {
  const rows = await db.prepare(`SELECT id, ${what === 'tenant' ? 'full_name' : 'name'} AS name FROM ${table} ORDER BY 2`).all();
  const hits = rows.filter((r) => r.name.toLowerCase().includes(String(q).trim().toLowerCase()));
  const exact = hits.filter((r) => r.name.toLowerCase() === String(q).trim().toLowerCase());
  if (exact.length === 1 || hits.length === 1) return exact[0] || hits[0];
  const names = (hits.length ? hits : rows).slice(0, 30).map((r) => r.name).join('; ');
  throw new Error(hits.length ? `More than one ${what} matches "${q}": ${names}. Ask which one.` : `No ${what} matches "${q}". There are: ${names || 'none yet'}.`);
}

/** A booking's id from its reference (BK-2026-0007). */
function bookingId(ref) {
  const id = Number(String(ref || '').match(/(\d+)\s*$/)?.[1]);
  if (!id) throw new Error('Give the booking reference, like BK-2026-0007.');
  return id;
}

/** The discount and the tax a booking is given, as createBooking and updateBooking take them. */
function terms(input) {
  const out = {};
  if (input.discount_percent != null) Object.assign(out, { discount_type: 'percent', discount_value: input.discount_percent });
  else if (input.discount_amount != null) Object.assign(out, { discount_type: 'amount', discount_value: input.discount_amount });
  if (input.discount_note != null) out.discount_note = input.discount_note;
  if (input.tax_percent != null) out.tax_percent = input.tax_percent;
  return out;
}
/** A source as the list has it, however it was typed; `fresh` when the list does not have it yet. */
async function sourceOf(name) {
  const typed = String(name ?? '').trim();
  const has = typed && (await listSources()).find((s) => s.name.toLowerCase() === typed.toLowerCase());
  return { name: has ? has.name : typed, fresh: !!typed && !has };
}
const discountLine = (b) => (b.discount_type ? `discount ${b.discount_type === 'percent' ? `${b.discount_value}%` : cash(b.discount_value)}${b.discount_note ? ` (${b.discount_note})` : ''}` : '');
const taxLine = (b) => (b.tax_percent ? `${region().tax_name} ${b.tax_percent}%` : '');

const chargesLine = (fees) => (fees.length ? fees.map((f) => `${f.label} ${cash(f.amount)}${f.repeats ? ' with every rent payment' : ' once'}`).join(', ') : 'none');

/** A booking in one line, as Riley is told it. */
const bookingLine = (b) => `${b.ref} (${b.stage}): ${b.tenant}, unit ${b.unit_no}, ${b.building}, ${b.start_date} to ${b.end_date}, `
  + `${cash(b.rent_amount)} per ${b.rent_period}, paid ${b.payment_frequency.replace(/_/g, ' ')}; deposit ${b.security_deposit == null ? 'none' : cash(b.security_deposit)}; charges: ${chargesLine(b.fees)}`
  + (b.discount_type || b.tax_percent ? `; ${discountLine(b) || 'discount none'}; ${taxLine(b) || `${region().tax_name} none`}` : '')
  + (b.source ? `; source: ${b.source}` : '');

/** A report as plain text: its headline figures, then a line per row. */
function asText(r, limit = 80) {
  const cell = (row, c) => (row[c.key] == null || row[c.key] === '' ? null : `${c.label}: ${c.kind === 'money' ? Number(row[c.key]).toLocaleString('en-US') : row[c.key]}`);
  const lines = r.rows.slice(0, limit).map((row) => `- ${r.columns.map((c) => cell(row, c)).filter(Boolean).join(' | ')}`);
  return [
    `${r.title} (${r.subtitle}; as of ${r.generated}; amounts in ${r.currency})`,
    r.summary.map((s) => `${s.label}: ${typeof s.value === 'number' ? s.value.toLocaleString('en-US') : s.value}`).join(' | '),
    lines.length ? lines.join('\n') : 'No rows.',
    r.rows.length > limit ? `…and ${r.rows.length - limit} more rows not shown.` : '',
  ].filter(Boolean).join('\n');
}

const reads = {
  leasing_report: async (input) => {
    const q = { from: input.from, to: input.to, days: input.days };
    if (input.building) q.building_id = (await find('prop_buildings', 'building', input.building)).id;
    else if (input.company) q.company_id = (await find('prop_companies', 'company', input.company)).id;
    if (!REPORT[input.report]) throw new Error(`Unknown report. Use one of: ${Object.keys(REPORT).join(', ')}.`);
    return asText(await report(REPORT[input.report], q));
  },
  leasing_tenant_statement: async (input) => asText(await report('statement', { tenant_id: (await find('lease_tenants', 'tenant', input.tenant)).id })),
  leasing_free_units: async (input) => {
    const b = await find('prop_buildings', 'building', input.building);
    const units = await availability(b.id, input.start_date, input.end_date);
    if (!units.length) return `${b.name} has no units yet.`;
    const line = (u) => `- Unit ${u.unit_no}${u.type ? ` (${u.type})` : ''}: ${u.free ? 'free' : u.blocked ? 'blocked, not for rent' : `taken by ${u.taken_by.tenant}, ${u.taken_by.start_date} to ${u.taken_by.end_date}`}`;
    return `${b.name}, ${input.start_date} to ${input.end_date} (today is ${todayHere()}): ${units.filter((u) => u.free).length} of ${units.length} units free.\n${units.map(line).join('\n')}`;
  },
  leasing_list: async (input) => {
    const none = (what) => `No ${what} yet.`;
    if (input.what === 'companies') {
      const rows = await db.prepare('SELECT c.name, (SELECT count(*)::int FROM prop_buildings b WHERE b.company_id = c.id) AS n FROM prop_companies c ORDER BY c.name').all();
      return rows.length ? rows.map((c) => `- ${c.name} (${c.n} building${c.n === 1 ? '' : 's'})`).join('\n') : none('companies');
    }
    if (input.what === 'buildings') {
      const only = input.company ? (await find('prop_companies', 'company', input.company)).id : null;
      const rows = (await db.prepare(`SELECT b.name, b.company_id, c.name AS company, (SELECT count(*)::int FROM prop_units u WHERE u.building_id = b.id) AS n
        FROM prop_buildings b JOIN prop_companies c ON c.id = b.company_id ORDER BY c.name, b.name`).all()).filter((b) => !only || b.company_id === only);
      return rows.length ? rows.map((b) => `- ${b.name}, ${b.company} (${b.n} unit${b.n === 1 ? '' : 's'})`).join('\n') : none('buildings');
    }
    if (input.what === 'tenants') {
      const like = `%${String(input.search || '').trim().toLowerCase()}%`;
      const rows = await db.prepare("SELECT full_name, phone, email FROM lease_tenants WHERE lower(concat_ws(' ', full_name, phone, email)) LIKE ? ORDER BY full_name LIMIT 50").all(like);
      return rows.length ? rows.map((t) => `- ${[t.full_name, t.phone, t.email].filter(Boolean).join(' · ')}`).join('\n') : input.search ? `No tenant matches "${input.search}".` : none('tenants');
    }
    if (input.what === 'bookings') {
      const rows = await listBookings({ building_id: input.building ? (await find('prop_buildings', 'building', input.building)).id : null, q: input.search });
      const live = rows.filter((b) => b.status !== 'cancelled').slice(0, 50);
      return live.length ? live.map((b) => `- ${bookingLine(b)}`).join('\n') : none('bookings');
    }
    if (input.what === 'sources') {
      const rows = await listSources();
      return rows.length ? `Sources:\n${rows.map((s) => `- ${s.name}`).join('\n')}` : none('sources');
    }
    if (!input.building) throw new Error('Say which building.');
    const b = await find('prop_buildings', 'building', input.building);
    if (input.what === 'services') {
      const rows = await listServices(b.id);
      return rows.length ? `Services of ${b.name}:\n${rows.map((s) => `- ${s.name}: ${s.amount == null ? 'no usual price yet' : cash(s.amount)}, ${s.repeats ? 'with every rent payment' : 'once'}`).join('\n')}` : `${b.name} has no services yet.`;
    }
    if (input.what === 'units') {
      const rows = await db.prepare('SELECT unit_no, floor, type, blocked FROM prop_units WHERE building_id = ? ORDER BY unit_no').all(b.id);
      return rows.length ? `${b.name} has ${rows.length} unit${rows.length === 1 ? '' : 's'}: ${rows.map((u) => `${u.unit_no}${u.type ? ` (${u.type})` : ''}${u.blocked ? ' blocked' : ''}`).join(', ')}` : `${b.name} has no units yet.`;
    }
    throw new Error('Unknown list. Use one of: companies, buildings, units, services, tenants, sources, bookings.');
  },
};

/** What sets things up. Each does what the same person could do on the screens, through the same code. */
const writes = (user) => {
  const master = (what) => { if (user?.role !== 'master') throw new Error(`Only the master can add ${what}. Tell the user to ask them.`); };
  return {
    leasing_add_company: async (input) => {
      master('a company');
      const c = await create('company', input, null, user.id);
      return `Company added: ${c.name}.`;
    },
    leasing_add_building: async (input) => {
      master('a building');
      const c = await find('prop_companies', 'company', input.company);
      const b = await create('building', input, c.id);
      return `Building added: ${b.name}, under ${c.name}. It has no units yet.`;
    },
    leasing_add_units: async (input) => {
      master('units');
      const b = await find('prop_buildings', 'building', input.building);
      const list = Array.isArray(input.units) ? input.units : [];
      if (!list.length) throw new Error('Give at least one unit number.');
      const done = [];
      const failed = [];
      for (const u of list) {
        try { done.push((await create('unit', u, b.id)).unit_no); } catch (e) { failed.push(`${u.unit_no || '?'}: ${e.message}`); }
      }
      return [`${done.length} unit${done.length === 1 ? '' : 's'} added to ${b.name}${done.length ? `: ${done.join(', ')}` : ''}.`, failed.length ? `Not added: ${failed.join('; ')}` : ''].filter(Boolean).join('\n');
    },
    leasing_add_service: async (input) => {
      const b = await find('prop_buildings', 'building', input.building);
      const s = await addService({ name: input.name, amount: input.amount ?? '', repeats: !!input.repeats, building_id: b.id }, user.id);
      return `Service added to ${b.name}: ${s.name}, ${s.amount == null ? 'no usual price yet' : cash(s.amount)}, ${s.repeats ? 'charged with every rent payment' : 'charged once'}.`;
    },
    leasing_add_tenant: async (input) => {
      const same = await db.prepare('SELECT full_name, phone FROM lease_tenants WHERE lower(full_name) = lower(?) LIMIT 1').get(String(input.full_name || '').trim());
      if (same && !input.same_name_is_someone_else) {
        throw new Error(`There is already a tenant named ${same.full_name}${same.phone ? ` (${same.phone})` : ''}. Use them for the booking, or ask the user whether this is a different person.`);
      }
      if (!String(input.phone || '').trim()) throw new Error("A tenant needs a contact number. Ask the user for it.");
      const t = await addTenant({ full_name: input.full_name, phone: input.phone, email: input.email, emirates_id_no: input.id_no, nationality: input.nationality, kind: input.is_company ? 'company' : 'person' }, user.id);
      return `Tenant added: ${[t.full_name, t.phone, t.email].filter(Boolean).join(' · ')}.`;
    },
    leasing_add_booking: async (input) => {
      const b = await find('prop_buildings', 'building', input.building);
      const unit = await db.prepare('SELECT id, unit_no FROM prop_units WHERE building_id = ? AND lower(unit_no) = lower(?)').get(b.id, String(input.unit_no || '').trim());
      if (!unit) throw new Error(`${b.name} has no unit "${input.unit_no}". Look at leasing_list units, or add it.`);
      const tenant = await find('lease_tenants', 'tenant', input.tenant);
      // The same stay asked for again is a correction of the draft already there, not a second booking.
      const draft = (await listBookings({ unit_id: unit.id, tenant_id: tenant.id, stage: 'draft' })).find((d) => d.start_date <= input.end_date && d.end_date >= input.start_date);
      if (draft) {
        throw new Error(`There is already a draft for this tenant and unit: ${bookingLine(draft)}. Do not make it again: `
          + 'change it with leasing_change_booking, or confirm it with leasing_confirm_booking.');
      }
      // A charge the building does not list yet is added to its list on the way, so the chat never has to stop for it.
      const known = new Set((await listServices(b.id)).map((s) => s.name.toLowerCase()));
      const charges = Array.isArray(input.charges) ? input.charges : [];
      const added = [];
      for (const c of charges) {
        if (!c?.name || known.has(String(c.name).trim().toLowerCase())) continue;
        added.push((await addService({ name: c.name, amount: c.amount, repeats: !!c.repeats, building_id: b.id }, user.id)).name);
      }
      const source = input.source != null ? await sourceOf(input.source) : null;
      const made = await createBooking({
        unit_id: unit.id, tenant_id: tenant.id, start_date: input.start_date, end_date: input.end_date, rent_amount: input.rent_amount,
        rent_period: input.rent_period || 'month', payment_frequency: input.payment_frequency || 'monthly', security_deposit: input.security_deposit ?? null,
        fees: charges.map((c) => ({ label: c.name, amount: c.amount, repeats: !!c.repeats })), contract_no: input.contract_no, notes: input.notes,
        // Like the booking form, a new booking starts with the region's usual tax unless another rate, or none, is given.
        tax_percent: region().tax_percent, ...terms(input), ...(source ? { source: source.name } : {}), status: input.confirm ? 'confirmed' : 'draft',
      }, user.id);
      if (source?.fresh) await addSource({ name: source.name }, user.id).catch(() => {});
      return [
        `Booking ${made.ref} ${made.status === 'confirmed' ? 'CONFIRMED' : 'saved as a DRAFT (not confirmed: the unit is not held yet)'}: ${made.tenant}, unit ${made.unit_no}, ${made.building}, ${made.start_date} to ${made.end_date}, `
          + `${[`${cash(made.rent_amount)} per ${made.rent_period}`, `paid ${made.payment_frequency.replace(/_/g, ' ')}`, discountLine(made), taxLine(made) || `no ${region().tax_name}`, made.source && `source ${made.source}`].filter(Boolean).join(', ')}.`,
        made.status === 'confirmed' ? await scheduleLine(made.id) : '',
        added.length ? `Added to ${b.name}'s services: ${added.join(', ')}.` : '',
        source?.fresh ? `Added to the sources list: ${source.name}.` : '',
      ].filter(Boolean).join('\n');
    },
    leasing_change_booking: async (input) => {
      const old = await getBooking(bookingId(input.booking));
      const body = terms(input);
      for (const f of ['start_date', 'end_date', 'rent_amount', 'rent_period', 'payment_frequency', 'security_deposit', 'contract_no', 'notes']) if (input[f] != null) body[f] = input[f];
      if (input.unit_no) {
        const unit = await db.prepare('SELECT id FROM prop_units WHERE building_id = ? AND lower(unit_no) = lower(?)').get(old.building_id, String(input.unit_no).trim());
        if (!unit) throw new Error(`${old.building} has no unit "${input.unit_no}". Look at leasing_list units.`);
        body.unit_id = unit.id;
      }
      // Charges are changed one by one, so naming the new one never drops the ones already there.
      const key = (n) => String(n).trim().toLowerCase();
      const set = Array.isArray(input.set_charges) ? input.set_charges.filter((c) => c?.name) : [];
      const drop = new Set((Array.isArray(input.remove_charges) ? input.remove_charges : []).map(key));
      const added = [];
      if (set.length || drop.size) {
        const missing = [...drop].filter((n) => !old.fees.some((f) => key(f.label) === n));
        if (missing.length) throw new Error(`This booking has no charge named ${missing.join(', ')}. Its charges: ${chargesLine(old.fees)}.`);
        body.fees = [...old.fees.filter((f) => !drop.has(key(f.label)) && !set.some((c) => key(c.name) === key(f.label))),
          ...set.map((c) => ({ label: c.name, amount: c.amount, repeats: !!c.repeats }))];
      }
      const source = input.source != null ? await sourceOf(input.source) : null;
      if (source) body.source = source.name;
      if (!Object.keys(body).length) throw new Error('Say what to change.');
      const now = await updateBooking(old.id, body, user.id);
      if (source?.fresh) await addSource({ name: source.name }, user.id).catch(() => {});
      const known = new Set((await listServices(old.building_id)).map((s) => s.name.toLowerCase()));
      for (const c of set) {
        if (!known.has(key(c.name))) added.push((await addService({ name: c.name, amount: c.amount, repeats: !!c.repeats, building_id: old.building_id }, user.id)).name);
      }
      return [
        `Booking changed, still ${now.status === 'confirmed' ? 'CONFIRMED' : 'a DRAFT (not confirmed)'}. It is now: ${bookingLine(now)}.`,
        now.status === 'confirmed' ? await scheduleLine(now.id) : '',
        added.length ? `Added to ${now.building}'s services: ${added.join(', ')}.` : '',
        source?.fresh ? `Added to the sources list: ${source.name}.` : '',
      ].filter(Boolean).join('\n');
    },
    leasing_confirm_booking: async (input) => {
      const made = await confirmBooking(bookingId(input.booking), user.id);
      return `Booking ${made.ref} is confirmed: ${made.tenant}, unit ${made.unit_no}, ${made.building}, ${made.start_date} to ${made.end_date}.\n${await scheduleLine(made.id)}`;
    },
  };
};

/** One line on what a confirmed booking's schedule came to. */
async function scheduleLine(bookingId) {
  const rows = await bookingPayments(bookingId);
  const { start_date } = await getBooking(bookingId);
  const first = rows.filter((r) => r.due_date === start_date);
  return `Payment schedule: ${rows.length} payment${rows.length === 1 ? '' : 's'}, ${cash(total(rows))} in all; ${cash(total(first))} is due on the first day.`;
}

const STATUS = {
  leasing_free_units: 'Checking which units are free…', leasing_tenant_statement: "Looking at the tenant's account…", leasing_list: 'Looking at what is set up…',
  leasing_add_company: 'Adding the company…', leasing_add_building: 'Adding the building…', leasing_add_units: 'Adding the units…', leasing_add_service: 'Adding the service…',
  leasing_add_tenant: 'Adding the tenant…', leasing_add_booking: 'Making the booking…', leasing_change_booking: 'Changing the booking…', leasing_confirm_booking: 'Confirming the booking…',
};

/**
 * The leasing tools, in the shape chat.js keeps its toolkits in. `user` is who is asking;
 * `onChanged` is told when something was added, so an open screen can show it.
 */
export function leasingKit(user, { onChanged } = {}) {
  const change = writes(user);
  return {
    definitions: LEASING_TOOLS,
    status: (name) => STATUS[name] || 'Looking at the leasing records…',
    run: async (block) => {
      try {
        const fn = reads[block.name] || change[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        const content = await fn(block.input || {});
        if (change[block.name]) onChanged?.();
        return { type: 'tool_result', tool_use_id: block.id, content };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}
