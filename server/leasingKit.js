import { db } from './db.js';
import { create, listUnits, HELD } from './properties.js';
import { availability, todayHere, listServices, addService, listSources, addSource, addTenant, createBooking, updateBooking, getBooking, listBookings, bookingPayments, total, REQUIRED_DOCS } from './leasing.js';
import { unitInspections, confirmInspected, addInspection, updateInspection, KINDS, USUAL_AREAS } from './inspections.js';
import { report } from './leasingReports.js';
import { tenantHistory } from './leasingHistory.js';
import { cash, region } from './leasingRegion.js';
import { createWorkOrder, updateWorkOrder, addWorkOrderNote, getWorkOrder, listWorkOrders, STATUS as WORK_STATUS } from './workOrders.js';
import { RENEWAL_TOOLS, RENEWAL_STATUS, renewalTools } from './renewals.js';

// Riley's hands in leasing. She reads any report, a tenant's account and which units are
// free, and she sets things up from the conversation: a company, its buildings and units, a
// building's services, a tenant, a lease (with where the tenant came from). So a whole tenancy can be made without leaving
// the chat, and whatever is missing on the way (the building, the service) is made there too.
//
// She does what the person asking could do on the screens and no more: only the master adds
// companies, buildings and units. A lease she makes is a draft, as on the lease form: it is
// confirmed once the tenant's move-in inspection is done (server/inspections.js), and a lease
// that exists is changed, not made a second time. She reads a unit's inspections and what comes
// next for it, and writes one down as the person tells her how the unit is; photos are added on the screens.
// She raises a work order for a repair, moves it on as she is told (assigned, done, closed…) and says what is open.
// She never records a payment, cancels a lease or deletes: people do that on the screens.

const REPORT = { rent_roll: 'rent-roll', overdue: 'aging', collections: 'collections', expiring_leases: 'expiring', vacant_units: 'vacancy' };
const ASK = 'Use only what the user has told you: ask for anything missing, and never invent a name, a phone number, a price or a date.';
const INSPECT_FIRST = 'Ask the user how they found the unit and write it down with leasing_record_inspection (or they can do it on the screens: Leasing, the lease, Move-in inspection), then confirm the lease.';
const str = { type: 'string' };

export const LEASING_TOOLS = [
  {
    name: 'leasing_report',
    description: 'Look up the property leasing records: who rents which unit and for how much (rent_roll), who is behind on rent and by how long (overdue), '
      + 'payments received between two dates (collections), leases ending soon (expiring_leases), or empty units (vacant_units: it also says which of them cannot be leased yet, the last tenant not being inspected out). '
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
    description: 'Which units of a building are free for the whole of a date range, and who has the ones that are not. '
      + "A unit whose lease has ended is not free until its tenant's move-out inspection is done. Read-only.",
    input_schema: {
      type: 'object',
      properties: { building: { type: 'string' }, start_date: { type: 'string', description: 'YYYY-MM-DD' }, end_date: { type: 'string', description: 'YYYY-MM-DD, the last night' } },
      required: ['building', 'start_date', 'end_date'],
    },
  },
  {
    name: 'leasing_tenant_history',
    description: "What kind of tenant someone has been: each rent that came in late (how many days, and any late fee), the complaints made about them (noise, parking…) "
      + 'and the maintenance done for them, with what is still open. Use it when asked whether to renew or trust a tenant. Read-only.',
    input_schema: { type: 'object', properties: { tenant: { type: 'string', description: "The tenant's name, or part of it." } }, required: ['tenant'] },
  },
  {
    name: 'leasing_unit_inspections',
    description: "One unit's condition over time and what comes next for it: the make-ready (the work on the empty unit before it is let), each tenant's move-in inspection "
      + 'and their move-out inspection, area by area, with the notes. Use it when asked whether a unit is ready, why a lease cannot be confirmed yet, '
      + 'or how a tenant left a unit compared with how they found it. Read-only.',
    input_schema: { type: 'object', properties: { building: str, unit_no: str }, required: ['building', 'unit_no'] },
  },
  {
    name: 'leasing_work_orders',
    description: 'The work orders (repairs to a unit): what is wrong, its status, who is on it, when they come, and what was done. Each is linked to the tenant who had the unit when it was reported. '
      + 'Use it for "what is open in unit 303", "what is overdue", or before raising one, so the same fault is not raised twice. Repairs are under the AMC: no cost is kept. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        building: { ...str, description: 'Only this building (part of its name is enough).' },
        unit_no: { ...str, description: 'Only this unit; needs the building.' },
        tenant: { ...str, description: "Only this tenant's (part of the name is enough)." },
        status: { type: 'string', enum: ['active', 'open', 'assigned', 'in_progress', 'done', 'closed', 'cancelled', 'all'], description: 'Default active: everything not closed or cancelled.' },
        overdue: { type: 'boolean', description: 'true: only those whose scheduled day has passed and are not done.' },
      },
    },
  },
  {
    name: 'leasing_list',
    description: 'What is already set up: the companies, the buildings (of one company or all), the units of a building (each with who is in it today and any inspection or make-ready it waits for) or its services, tenants by name, the sources (where tenants come from: one list for the whole app), or the leases (drafts included) with their references and charges. '
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
    input_schema: { type: 'object', properties: { name: str, trade_license_no: { ...str, description: 'The EIN: nine digits, like 12-3456789.' }, trn: { ...str, description: 'Another tax ID, only when it has one besides the EIN.' }, registration_date: { ...str, description: 'The day the company was registered, YYYY-MM-DD.' }, phone: str, email: str, address: { ...str, description: 'The street line only.' }, city: str, state: { ...str, description: 'The US state, as two letters, e.g. TX.' }, zip: { ...str, description: 'ZIP code.' } }, required: ['name'] },
  },
  {
    name: 'leasing_add_building',
    description: `Add a building under a company that exists (add the company first if it does not). Master only. ${ASK}`,
    input_schema: { type: 'object', properties: { company: str, name: str, address: str, city: str, emirate: { ...str, description: 'The US state, as two letters, e.g. TX.' }, zip: { ...str, description: 'ZIP code.' }, area: str }, required: ['company', 'name'] },
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
    description: `Add an extra service to a building's list (pet fee, parking, laundry…), which its leases can then be charged. ${ASK}`,
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
      properties: { full_name: str, phone: str, email: str, id_no: { ...str, description: 'An ID number (driver license, passport, national ID…).' }, nationality: str, is_company: { type: 'boolean' },
        same_name_is_someone_else: { type: 'boolean', description: 'Only when a tenant of this name exists and the user has said this is a different person.' } },
      required: ['full_name', 'phone'],
    },
  },
  {
    name: 'leasing_add_booking',
    description: 'Make a NEW lease of a unit for a tenant. To change a lease that already exists, a draft included (add a charge, new dates, another rent), '
      + 'use leasing_change_booking: never make it again. The building, the unit and the tenant must exist: add them first in this same turn if they do not. '
      + "A charge whose name is not yet in the building's services is added to that list as it is used. "
      + "It is always saved as a DRAFT, as on the lease form: a lease is confirmed (leasing_confirm_booking) only once the tenant's move-in inspection is done (leasing_record_inspection). "
      + `Afterwards say that it is a draft, with its reference, and what is still to do. ${ASK}`,
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
        tax_percent: { type: 'number', description: "Tax (VAT) on the rent and the charges, in percent; the deposit is never taxed. Left out, the lease gets the region's usual tax, as the lease form does: say so in the answer. 0 only when the user says there is no tax." },
        charges: { type: 'array', maxItems: 10, items: { type: 'object', properties: { name: str, amount: { type: 'number' }, repeats: { type: 'boolean', description: 'true: with every rent payment. false: once.' } }, required: ['name', 'amount'] } },
        source: { ...str, description: 'Where the tenant came from (walk-in, referral, a listing site…), as in leasing_list sources. Only when the user says; a new one is added to that list.' },
        tenant_energy_account: { type: 'boolean', description: "true when the tenant has an energy (electricity and water) account in their own name; false when the bill is on the company's account. Only when the user says." },
        contract_no: str, notes: str,
      },
      required: ['building', 'unit_no', 'tenant', 'start_date', 'end_date', 'rent_amount'],
    },
  },
  {
    name: 'leasing_record_inspection',
    description: "Write down a unit's condition, as the user who looked at it tells it: the make-ready (the work on the empty unit: each job done or pending), a tenant's move-in inspection, "
      + 'or their move-out inspection (each area good, fair or damaged). It starts with the usual list '
      + `(make-ready: ${USUAL_AREAS.make_ready.join(', ')}; inspections: ${USUAL_AREAS.inspect.join(', ')}); another area named is added. `
      + 'Called again for the same inspection it carries on with it: only the areas given change, so it can be done in parts. It is finished once every area is rated; '
      + 'a finished move-in lets the lease be confirmed, and a finished move-out makes the unit vacant. '
      + 'Rate only what the user has said: use everything_else only when they say so ("all good", "the rest is fine"), and never guess a condition. Photos are added on the screens.',
    input_schema: {
      type: 'object',
      properties: {
        building: str, unit_no: str,
        kind: { type: 'string', enum: ['make_ready', 'move_in', 'move_out'] },
        booking: { ...str, description: "move_in and move_out: the lease's reference, like LS-2026-0007. Left out, it is the unit's own lease, as leasing_unit_inspections has it." },
        areas: { type: 'array', maxItems: 40, items: { type: 'object', properties: { area: str, condition: { type: 'string', enum: ['good', 'fair', 'damaged', 'done', 'pending'], description: 'make_ready: done or pending. move_in and move_out: good, fair or damaged.' },
          note: { ...str, description: 'What was seen or done there.' } }, required: ['area'] } },
        everything_else: { type: 'string', enum: ['good', 'fair', 'damaged', 'done'], description: 'The rating of every area not rated yet, only when the user has said it for all of them.' },
        notes: { ...str, description: 'A note on the whole of it (keys handed over, meter readings…).' },
        date: { ...str, description: 'The day it was done, YYYY-MM-DD. Default today; never ahead.' },
      },
      required: ['building', 'unit_no', 'kind'],
    },
  },
  {
    name: 'leasing_change_booking',
    description: 'Change a lease that already exists, by its reference: its dates, rent, discount, tax, deposit, unit, source, or its extra charges. Give only what changes; the rest stays. '
      + `Use this, not leasing_add_booking, whenever the user corrects or adds to a lease already made. It does not confirm a draft. ${ASK}`,
    input_schema: {
      type: 'object',
      properties: {
        booking: { ...str, description: 'The reference, like LS-2026-0007.' },
        unit_no: { ...str, description: 'Move it to this unit of the same building.' },
        start_date: { ...str, description: 'YYYY-MM-DD' }, end_date: { ...str, description: 'YYYY-MM-DD, the last day of the stay' },
        rent_amount: { type: 'number' }, rent_period: { type: 'string', enum: ['month', 'year'] },
        payment_frequency: { type: 'string', enum: ['monthly', 'quarterly', 'every_6_months', 'yearly', 'upfront'] },
        security_deposit: { type: 'number' },
        discount_percent: { type: 'number', description: 'A discount off the rent, in percent. 0 takes the discount off.' },
        discount_amount: { type: 'number', description: 'A discount as an amount off rent_amount (off the month, or off the year). Give this or discount_percent, never both. 0 takes the discount off.' }, discount_note: { ...str, description: 'Why the discount was given.' },
        tax_percent: { type: 'number', description: 'Tax (VAT) on the rent and the charges, in percent; the deposit is never taxed. 0 takes the tax off.' },
        set_charges: { type: 'array', maxItems: 10, description: 'Charges to add, or to re-price if the lease already has one of that name. The others stay as they are.',
          items: { type: 'object', properties: { name: str, amount: { type: 'number' }, repeats: { type: 'boolean', description: 'true: with every rent payment. false: once.' } }, required: ['name', 'amount'] } },
        remove_charges: { type: 'array', items: str, description: 'Names of charges to take off the lease.' },
        source: { ...str, description: 'Where the tenant came from, as in leasing_list sources; a new one is added to that list. Empty takes it off.' },
        tenant_energy_account: { type: 'boolean', description: "true when the tenant has an energy (electricity and water) account in their own name; false when the bill is on the company's account. Only when the user says." },
        contract_no: str, notes: str,
      },
      required: ['booking'],
    },
  },
  {
    name: 'leasing_confirm_booking',
    description: 'Confirm a draft lease, by its reference (LS-2026-0007). Only when the user has said to. It takes the unit for those dates and writes the payment schedule. '
      + "It is refused until the tenant's move-in inspection is done (a renewal needs none: the tenant is already in), and while the unit's last tenant has not been inspected out.",
    input_schema: { type: 'object', properties: { booking: { ...str, description: 'The reference, like LS-2026-0007.' } }, required: ['booking'] },
  },
  {
    name: 'leasing_add_work_order',
    description: `Raise a work order: a repair to a unit (the AC is not cooling, a tap leaks). It links itself to the tenant in the unit that day; an empty unit's has no tenant. Look at leasing_work_orders first: a fault already raised is updated, not raised again. ${ASK}`,
    input_schema: {
      type: 'object',
      properties: {
        building: str, unit_no: str,
        detail: { ...str, description: 'What is wrong, in the words the user gave.' },
        category: { ...str, description: 'AC, Plumbing, Electrical, Appliance, Pest control, or another word.' },
        priority: { type: 'string', enum: ['low', 'normal', 'urgent'], description: 'Default normal. urgent only when the user says so.' },
        reported_by: { ...str, description: 'Who told the office: the tenant, the watchman…' },
        reported_on: { ...str, description: 'YYYY-MM-DD. Default today.' },
        assigned_to: { ...str, description: 'The technician or vendor, when the user names one.' },
        scheduled_on: { ...str, description: 'YYYY-MM-DD, the day the work is planned for.' },
      },
      required: ['building', 'unit_no', 'detail'],
    },
  },
  {
    name: 'leasing_update_work_order',
    description: 'Change a work order, by its reference (WO-2026-0014): who is on it, when they come, its priority, its status, or add a note to its history. '
      + 'Statuses go forward: open, assigned, in_progress, done (needs what was done), then closed; or cancelled (needs why). A finished one is taken back to work with reopen. Only what the user has said.',
    input_schema: {
      type: 'object',
      properties: {
        work_order: { ...str, description: 'The reference, like WO-2026-0014.' },
        status: { type: 'string', enum: ['assigned', 'in_progress', 'done', 'closed', 'cancelled'] },
        resolution: { ...str, description: 'With done: what was done.' },
        cancel_reason: { ...str, description: 'With cancelled: why.' },
        reopen: { type: 'boolean', description: 'true: a done, closed or cancelled one goes back to work.' },
        assigned_to: { ...str, description: 'The technician or vendor. Empty takes them off.' },
        scheduled_on: { ...str, description: 'YYYY-MM-DD. Empty clears it.' },
        priority: { type: 'string', enum: ['low', 'normal', 'urgent'] },
        note: { ...str, description: 'A line for its history: "tenant not home, coming back Thursday".' },
      },
      required: ['work_order'],
    },
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

/** The unit of this number in a building, if it has one. */
const unitOf = (b, unitNo) => db.prepare('SELECT id, unit_no FROM prop_units WHERE building_id = ? AND lower(unit_no) = lower(?)').get(b.id, String(unitNo || '').trim());

/** A booking's id from its reference (LS-2026-0007). */
function bookingId(ref) {
  const id = Number(String(ref || '').match(/(\d+)\s*$/)?.[1]);
  if (!id) throw new Error('Give the lease reference, like LS-2026-0007.');
  return id;
}

/** A work order's id from its reference (WO-2026-0014). The number finds it; the year is only for reading. */
function workOrderId(ref) {
  const id = Number(String(ref || '').match(/^\s*WO-\d{4}-(\d+)\s*$/i)?.[1]);
  if (!id) throw new Error('Give the work order reference, like WO-2026-0014.');
  return id;
}

/** A work order in one line, as Riley is told it. */
const workOrderLine = (w) => `${w.ref} (${WORK_STATUS[w.status]}${w.overdue ? ', OVERDUE' : ''}${w.priority !== 'normal' ? `, ${w.priority}` : ''}): unit ${w.unit_no}, ${w.building}, ${w.tenant || 'vacant'}; `
  + `${w.category ? `${w.category}: ` : ''}${w.detail}; reported ${w.reported_on}${w.assigned_to ? `; assigned to ${w.assigned_to}` : ''}${w.scheduled_on ? `; scheduled ${w.scheduled_on}` : ''}`
  + `${w.done_on ? `; done ${w.done_on}${w.resolution ? `: ${w.resolution}` : ''}` : ''}${w.cancel_reason ? `; cancelled: ${w.cancel_reason}` : ''}`;

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

/** Where a lease stands with its move-in inspection, when that is worth saying. */
const inspected = (b) => (b.status === 'draft' ? (b.renewed_from ? ', a renewal: no move-in inspection needed' : `, move-in inspection ${b.moved_in ? 'done' : 'not done'}`)
  : b.status === 'confirmed' && !b.moved_in && !b.moved_out && !b.renewed_from ? ', move-in inspection not done' : '');

/** A booking in one line, as Riley is told it. */
const bookingLine = (b) => `${b.ref} (${b.stage}${inspected(b)}): ${b.tenant}, unit ${b.unit_no}, ${b.building}, ${b.start_date} to ${b.end_date}, `
  + `${cash(b.rent_amount)} per ${b.rent_period}, paid ${b.payment_frequency.replace(/_/g, ' ')}; deposit ${b.security_deposit == null ? 'none' : cash(b.security_deposit)}; charges: ${chargesLine(b.fees)}`
  + (b.discount_type || b.tax_percent ? `; ${discountLine(b) || 'discount none'}; ${taxLine(b) || `${region().tax_name} none`}` : '')
  + (b.source ? `; source: ${b.source}` : '')
  + (b.tenant_energy_account ? "; energy on the tenant's own account" : '');

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

/** The units a lease has ended on whose tenant has not been inspected out: empty by the dates, and not yet to be leased. */
async function heldUnits({ building_id, company_id }, today = todayHere()) {
  const rows = await db.prepare(`SELECT u.unit_no, bl.id AS building_id, bl.company_id, bl.name AS building, t.full_name AS tenant, to_char(b.end_date, 'YYYY-MM-DD') AS end_date
    FROM lease_bookings b JOIN prop_units u ON u.id = b.unit_id JOIN prop_buildings bl ON bl.id = u.building_id JOIN lease_tenants t ON t.id = b.tenant_id
    WHERE b.status = 'confirmed' AND b.end_date < ?::date AND NOT u.blocked AND ${HELD}
      AND NOT EXISTS (SELECT 1 FROM lease_bookings n WHERE n.unit_id = b.unit_id AND n.status = 'confirmed' AND ?::date BETWEEN n.start_date AND n.end_date)
    ORDER BY bl.name, u.unit_no`).all(today, today);
  return rows.filter((r) => (!building_id || r.building_id === building_id) && (!company_id || r.company_id === company_id));
}

const KIND = { make_ready: 'Make-ready', move_in: 'Move-in inspection', move_out: 'Move-out inspection' };

/** What comes next for a unit, in words (nextStep in server/inspections.js). */
function nextLine(next, lease) {
  if (!next) return 'nothing: it is made ready, and waits for a lease';
  const whose = lease ? `${lease.ref} (${lease.tenant})` : '';
  if (next.kind === 'make_ready') return `the make-ready: the work on the empty unit before it is let${next.also ? `. The move-in inspection of ${whose} can be done as well` : ''}`;
  if (next.kind === 'move_in') return `the move-in inspection of ${whose}${next.late ? ', which is late: the lease has started' : ''}${lease.status === 'draft' ? '. The lease is confirmed after it' : ''}`;
  if (next.kind === 'confirm') return `confirming ${whose}: the move-in inspection is done`;
  return next.late ? `the move-out inspection of ${whose}, which is late: the lease ended ${lease.end_date}, and the unit is not vacant until it is done`
    : `the move-out inspection of ${whose}, when the lease ends (${lease.end_date})`;
}

const reads = {
  leasing_report: async (input) => {
    const q = { from: input.from, to: input.to, days: input.days };
    if (input.building) q.building_id = (await find('prop_buildings', 'building', input.building)).id;
    else if (input.company) q.company_id = (await find('prop_companies', 'company', input.company)).id;
    if (!REPORT[input.report]) throw new Error(`Unknown report. Use one of: ${Object.keys(REPORT).join(', ')}.`);
    const out = asText(await report(REPORT[input.report], q));
    if (input.report !== 'vacant_units') return out;
    // The report goes by the dates; a unit is not vacant until its tenant is inspected out.
    const held = await heldUnits(q);
    return held.length ? `${out}\nListed as vacant, but not to be leased yet (the move-out inspection is not done):\n${held.map((h) => `- Unit ${h.unit_no}, ${h.building}: ${h.tenant}, lease ended ${h.end_date}`).join('\n')}` : out;
  },
  leasing_unit_inspections: async (input) => {
    const b = await find('prop_buildings', 'building', input.building);
    const unit = await unitOf(b, input.unit_no);
    if (!unit) throw new Error(`${b.name} has no unit "${input.unit_no}". Look at leasing_list units.`);
    const { lease, next, list } = await unitInspections(unit.id);
    const item = (it) => `${it.area}: ${it.condition || 'not looked at yet'}${it.note ? ` (${it.note})` : ''}`;
    const line = (i) => `- ${i.date} ${KIND[i.kind]}${i.tenant ? `, ${i.tenant}` : ''}${i.ref ? ` [${i.ref}]` : ''}, ${i.complete ? 'finished' : 'NOT finished'}${i.done_by ? `, by ${i.done_by}` : ''}`
      + `${i.photos.length ? `, ${i.photos.length} photo${i.photos.length === 1 ? '' : 's'}` : ''}: ${i.items.map(item).join('; ')}${i.notes ? `. Notes: ${i.notes}` : ''}`;
    return [
      `Unit ${unit.unit_no}, ${b.name} (today is ${todayHere()}). ${lease ? `Its lease: ${bookingLine(lease)}.` : 'No lease now or to come.'}`,
      `Next: ${nextLine(next, lease)}.`,
      list.length ? `Inspections, newest first:\n${list.slice(0, 30).map(line).join('\n')}` : 'No inspection or make-ready has been written down yet.',
    ].join('\n');
  },
  leasing_work_orders: async (input) => {
    const q = { status: input.status === 'all' ? '' : input.status || 'active', overdue: input.overdue === true };
    if (input.building) {
      const b = await find('prop_buildings', 'building', input.building);
      q.building_id = b.id;
      if (input.unit_no) {
        const unit = await unitOf(b, input.unit_no);
        if (!unit) throw new Error(`${b.name} has no unit "${input.unit_no}". Look at leasing_list units.`);
        q.unit_id = unit.id;
      }
    } else if (input.unit_no) throw new Error('Say which building the unit is in.');
    if (input.tenant) q.tenant_id = (await find('lease_tenants', 'tenant', input.tenant)).id;
    const rows = await listWorkOrders(q);
    return rows.length ? `Work orders (today is ${todayHere()}), newest first:\n${rows.slice(0, 60).map((w) => `- ${workOrderLine(w)}`).join('\n')}${rows.length > 60 ? `\n…and ${rows.length - 60} more not shown.` : ''}`
      : 'No work orders match.';
  },
  leasing_tenant_statement: async (input) => asText(await report('statement', { tenant_id: (await find('lease_tenants', 'tenant', input.tenant)).id })),
  leasing_tenant_history: async (input) => {
    const h = await tenantHistory((await find('lease_tenants', 'tenant', input.tenant)).id);
    const s = h.summary;
    const where = (i) => (i.ref ? ` [${i.ref}, unit ${i.unit_no}, ${i.building}]` : '');
    const line = (i) => (i.type === 'late'
      ? `- ${i.date} Late rent: ${cash(i.amount)} due, ${i.paid_on ? `paid in full on ${i.paid_on}, ${i.days_late} days late` : `${cash(i.left)} still owed, ${i.days_late} days late so far`}${i.fee ? `, late fee ${cash(i.fee)}` : ''}${where(i)}`
      : `- ${i.date} ${i.type === 'complaint' ? 'Complaint' : `Maintenance${i.wo ? ` ${i.wo}` : ''}`}${i.category ? ` (${i.category})` : ''}, `
        + `${i.resolved_on ? `resolved ${i.resolved_on}${i.resolution ? ` (${i.resolution})` : ''}` : i.wo ? WORK_STATUS[i.status].toLowerCase() : 'open'}: ${i.detail}${where(i)}`);
    return [
      `History · ${h.tenant.full_name} (as of ${todayHere()})`,
      `Late rent: ${s.late} (${s.late_unpaid} still unpaid, ${s.late_days} days late on average, late fees ${cash(s.late_fees)}) | Complaints: ${s.complaints} (${s.complaints_open} open) | Maintenance: ${s.maintenance} (${s.maintenance_open} open)`,
      h.items.length ? h.items.slice(0, 80).map(line).join('\n') : 'Nothing on record: no late rent, no complaints, no maintenance.',
    ].join('\n');
  },
  leasing_free_units: async (input) => {
    const b = await find('prop_buildings', 'building', input.building);
    const units = await availability(b.id, input.start_date, input.end_date);
    if (!units.length) return `${b.name} has no units yet.`;
    const line = (u) => `- Unit ${u.unit_no}${u.type ? ` (${u.type})` : ''}: ${u.free ? 'free' : u.blocked ? 'blocked, not for rent'
      : u.taken_by.end_date < input.start_date ? `not vacant: ${u.taken_by.tenant}'s lease ended ${u.taken_by.end_date} and the move-out inspection is not done (${u.taken_by.ref})`
        : `taken by ${u.taken_by.tenant}, ${u.taken_by.start_date} to ${u.taken_by.end_date}`}`;
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
      return live.length ? live.map((b) => `- ${bookingLine(b)}`).join('\n') : none('leases');
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
      const rows = await listUnits(b.id);
      // As the unit's card has it: who is in it today, and the inspection or the make-ready it waits for.
      const state = (u) => (u.blocked ? 'blocked, not for rent'
        : u.move_out_due ? `lease ended ${u.current_until}, not vacant until ${u.current_tenant}'s move-out inspection is done`
          : u.current_tenant ? `leased to ${u.current_tenant} until ${u.current_until}${u.move_in_due ? ', move-in inspection not done' : ''}`
            : u.needs_make_ready ? 'empty, to be made ready' : 'empty');
      return rows.length ? `${b.name} has ${rows.length} unit${rows.length === 1 ? '' : 's'} (today is ${todayHere()}):\n${rows.map((u) => `- ${u.unit_no}${u.type ? ` (${u.type})` : ''}: ${state(u)}`).join('\n')}` : `${b.name} has no units yet.`;
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
        throw new Error(`There is already a tenant named ${same.full_name}${same.phone ? ` (${same.phone})` : ''}. Use them for the lease, or ask the user whether this is a different person.`);
      }
      if (!String(input.phone || '').trim()) throw new Error("A tenant needs a contact number. Ask the user for it.");
      const t = await addTenant({ full_name: input.full_name, phone: input.phone, email: input.email, emirates_id_no: input.id_no, nationality: input.nationality, kind: input.is_company ? 'company' : 'person' }, user.id);
      return `Tenant added: ${[t.full_name, t.phone, t.email].filter(Boolean).join(' · ')}.`;
    },
    leasing_add_booking: async (input) => {
      const b = await find('prop_buildings', 'building', input.building);
      const unit = await unitOf(b, input.unit_no);
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
        fees: charges.map((c) => ({ label: c.name, amount: c.amount, repeats: !!c.repeats })), contract_no: input.contract_no, notes: input.notes, tenant_energy_account: input.tenant_energy_account === true,
        // Like the lease form, a new lease starts with the region's usual tax unless another rate, or none, is given,
        // and is a draft: it is confirmed after the move-in inspection.
        tax_percent: region().tax_percent, ...terms(input), ...(source ? { source: source.name } : {}), status: 'draft',
      }, user.id);
      if (source?.fresh) await addSource({ name: source.name }, user.id).catch(() => {});
      return [
        `Lease ${made.ref} saved as a DRAFT (not confirmed: the unit is not held yet): ${made.tenant}, unit ${made.unit_no}, ${made.building}, ${made.start_date} to ${made.end_date}, `
          + `${[`${cash(made.rent_amount)} per ${made.rent_period}`, `paid ${made.payment_frequency.replace(/_/g, ' ')}`, discountLine(made), taxLine(made) || `no ${region().tax_name}`, made.source && `source ${made.source}`].filter(Boolean).join(', ')}.`,
        added.length ? `Added to ${b.name}'s services: ${added.join(', ')}.` : '',
        source?.fresh ? `Added to the sources list: ${source.name}.` : '',
        `Still to do: the move-in inspection, after which the lease is confirmed; and, on the screens, attach the tenant's ${REQUIRED_DOCS.map(([, name]) => name).join(' and ')} (the lease form asks for both).`,
      ].filter(Boolean).join('\n');
    },
    leasing_record_inspection: async (input) => {
      const b = await find('prop_buildings', 'building', input.building);
      const unit = await unitOf(b, input.unit_no);
      if (!unit) throw new Error(`${b.name} has no unit "${input.unit_no}". Look at leasing_list units.`);
      const kind = input.kind;
      if (!KINDS[kind]) throw new Error('An inspection is a make_ready, a move_in or a move_out.');
      const { lease, list } = await unitInspections(unit.id, kind !== 'make_ready' && input.booking ? bookingId(input.booking) : null);
      if (kind !== 'make_ready' && !lease) throw new Error(`Unit ${unit.unit_no} has no lease to inspect for. Make the lease first, or give its reference.`);
      // The one already begun is carried on: a lease has one move-in and one move-out; a make-ready is carried on until it is finished.
      const begun = kind === 'make_ready' ? [list.find((i) => i.kind === kind)].find((i) => i && !i.complete) : list.find((i) => i.kind === kind && i.booking_id === lease.id);
      // A new move-out looks at what the move-in looked at, so the two can be set side by side.
      const before = kind === 'move_out' && list.find((i) => i.kind === 'move_in' && i.booking_id === lease.id);
      const items = begun ? begun.items.map((it) => ({ ...it })) : (before ? before.items.map((it) => it.area) : USUAL_AREAS[kind === 'make_ready' ? 'make_ready' : 'inspect']).map((area) => ({ area, condition: null, note: null }));
      const rating = (c) => { if (c != null && !KINDS[kind].includes(c)) throw new Error(`A ${KIND[kind].toLowerCase()} is rated ${KINDS[kind].join(' or ')}, not "${c}".`); return c; };
      for (const a of Array.isArray(input.areas) ? input.areas : []) {
        const name = String(a?.area || '').trim();
        if (!name) continue;
        const at = items.find((it) => it.area.toLowerCase() === name.toLowerCase()) || items[items.push({ area: name, condition: null, note: null }) - 1];
        if (a.condition != null) at.condition = rating(a.condition);
        if (a.note != null) at.note = a.note;
      }
      if (input.everything_else != null) for (const it of items) if (!it.condition || it.condition === 'pending') it.condition = rating(input.everything_else);
      const body = { items, ...(input.notes != null ? { notes: input.notes } : {}), ...(input.date ? { date: input.date } : {}) };
      const now = begun ? await updateInspection(begun.id, body) : await addInspection(unit.id, { ...body, kind, ...(kind === 'make_ready' ? {} : { booking_id: lease.id }) }, user.id);
      const left = now.items.filter((it) => !it.condition || it.condition === 'pending').map((it) => it.area);
      const after = await unitInspections(unit.id, lease?.id);
      return [
        `${KIND[kind]} of unit ${unit.unit_no}, ${b.name}${now.ref ? ` for ${now.ref} (${now.tenant})` : ''}, dated ${now.date}: ${left.length ? `NOT finished. Still to ${kind === 'make_ready' ? 'do' : 'look at'}: ${left.join(', ')}` : 'finished'}.`,
        `It says: ${now.items.filter((it) => it.condition).map((it) => `${it.area}: ${it.condition}${it.note ? ` (${it.note})` : ''}`).join('; ') || 'nothing rated yet'}.`,
        `Next: ${nextLine(after.next, after.lease)}.${after.next?.kind === 'confirm' ? ' Confirm it only when the user says to.' : ''}`,
        'Photos can be added on the screens.',
      ].join('\n');
    },
    leasing_change_booking: async (input) => {
      const old = await getBooking(bookingId(input.booking));
      const body = terms(input);
      for (const f of ['start_date', 'end_date', 'rent_amount', 'rent_period', 'payment_frequency', 'security_deposit', 'contract_no', 'notes', 'tenant_energy_account']) if (input[f] != null) body[f] = input[f];
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
        if (missing.length) throw new Error(`This lease has no charge named ${missing.join(', ')}. Its charges: ${chargesLine(old.fees)}.`);
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
        `Lease changed, still ${now.status === 'confirmed' ? 'CONFIRMED' : 'a DRAFT (not confirmed)'}. It is now: ${bookingLine(now)}.`,
        now.status === 'confirmed' ? await scheduleLine(now.id) : '',
        added.length ? `Added to ${now.building}'s services: ${added.join(', ')}.` : '',
        source?.fresh ? `Added to the sources list: ${source.name}.` : '',
      ].filter(Boolean).join('\n');
    },
    leasing_confirm_booking: async (input) => {
      // As on the screens: not before the tenant is inspected in.
      const made = await confirmInspected(bookingId(input.booking), user.id).catch((e) => { throw /move-in inspection/.test(e.message) ? new Error(`${e.message} ${INSPECT_FIRST}`) : e; });
      return `Lease ${made.ref} is confirmed: ${made.tenant}, unit ${made.unit_no}, ${made.building}, ${made.start_date} to ${made.end_date}.\n${await scheduleLine(made.id)}`;
    },
    leasing_add_work_order: async (input) => {
      const b = await find('prop_buildings', 'building', input.building);
      const unit = await unitOf(b, input.unit_no);
      if (!unit) throw new Error(`${b.name} has no unit "${input.unit_no}". Look at leasing_list units.`);
      const body = { unit_id: unit.id, detail: input.detail };
      for (const f of ['category', 'priority', 'reported_by', 'reported_on', 'assigned_to', 'scheduled_on']) if (input[f] != null) body[f] = input[f];
      const w = await createWorkOrder(body, user.id);
      return `Work order ${w.ref} raised ${w.tenant ? `for ${w.tenant}` : 'for the vacant unit'}: ${workOrderLine(w)}.\nPhotos can be added on the screens (Leasing, Work orders).`;
    },
    leasing_update_work_order: async (input) => {
      const id = workOrderId(input.work_order);
      const body = {};
      for (const f of ['status', 'resolution', 'cancel_reason', 'reopen', 'assigned_to', 'scheduled_on', 'priority']) if (input[f] != null) body[f] = input[f];
      const note = String(input.note ?? '').trim();
      if (!Object.keys(body).length && !note) throw new Error('Say what to change.');
      // With reopen the note is the reason it was reopened; otherwise it is a line of its own.
      if (Object.keys(body).length) await updateWorkOrder(id, body.reopen ? { ...body, note } : body, user.id);
      if (note && !body.reopen) await addWorkOrderNote(id, note, user.id);
      return `Work order changed. It is now: ${workOrderLine(await getWorkOrder(id))}.`;
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
  leasing_free_units: 'Checking which units are free…', leasing_tenant_statement: "Looking at the tenant's account…", leasing_tenant_history: "Looking at the tenant's history…", leasing_unit_inspections: "Looking at the unit's inspections…", leasing_work_orders: 'Looking at the work orders…', leasing_list: 'Looking at what is set up…',
  leasing_add_company: 'Adding the company…', leasing_add_building: 'Adding the building…', leasing_add_units: 'Adding the units…', leasing_add_service: 'Adding the service…',
  leasing_add_tenant: 'Adding the tenant…', leasing_record_inspection: 'Writing down the inspection…', leasing_add_booking: 'Making the lease…', leasing_change_booking: 'Changing the lease…', leasing_confirm_booking: 'Confirming the lease…',
  leasing_add_work_order: 'Raising the work order…', leasing_update_work_order: 'Changing the work order…',
};

/**
 * The leasing tools, in the shape chat.js keeps its toolkits in. `user` is who is asking;
 * `onChanged` is told when something was added, so an open screen can show it.
 */
export function leasingKit(user, { onChanged, renewals } = {}) {
  const change = writes(user);
  const renew = renewalTools(user, renewals); // getting a document renewed: server/renewals.js
  return {
    definitions: [...LEASING_TOOLS, ...RENEWAL_TOOLS],
    status: (name) => STATUS[name] || RENEWAL_STATUS[name] || 'Looking at the leasing records…',
    run: async (block) => {
      try {
        const fn = reads[block.name] || change[block.name] || renew[block.name];
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
