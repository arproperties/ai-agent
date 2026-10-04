import { db } from './db.js';
import { availability, todayHere } from './leasing.js';
import { report } from './leasingReports.js';

// Riley's view of leasing: read-only. She can look up any report, a tenant's account and
// which units are free, and write a reminder from what she finds. She never records a
// payment or changes a booking; people do that on the screens.

const REPORT = { rent_roll: 'rent-roll', overdue: 'aging', collections: 'collections', expiring_leases: 'expiring', vacant_units: 'vacancy' };

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

const handlers = {
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
};

/** The leasing tools, in the shape chat.js keeps its toolkits in. */
export function leasingKit() {
  return {
    definitions: LEASING_TOOLS,
    status: (name) => (name === 'leasing_free_units' ? 'Checking which units are free…' : name === 'leasing_tenant_statement' ? "Looking at the tenant's account…" : 'Looking at the leasing records…'),
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}
