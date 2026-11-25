import { askSaifsys } from './client.js';

// saifsys → Real Estate → Maintenance: the maintenance requests and the work orders
// (WO-2-02187…) the maintenance team works from. Matches api/jarvis/v1/modules/maintenance.php
// on the saifsys side.
//
// View only: three lookups, carried by the agents of anyone who has the Real Estate module
// (the master always; others only when ticked).

const DATE = { type: 'string', description: 'YYYY-MM-DD. Work it out from the current date given to you.' };
const tool = (name, description, properties = {}, required = []) => ({
  name, description, input_schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
});
const WHERE = {
  building: { type: 'string', description: 'Building name or part of it, e.g. "Park Place". Leave out for every building.' },
  unit: { type: 'string', description: 'Unit number, e.g. "205". Use with building.' },
  company: { type: 'string', description: 'Company name or part of it. Leave out for all companies.' },
  q: { type: 'string', description: 'Words to look for in the description, notes or title.' },
};

const LOOKUPS = [
  { action: 'work_orders', status: 'Reading the work orders…', tool: tool('maintenance_work_orders',
    'Work orders from saifsys Real Estate → Maintenance Schedule: each has its WO number, date and time, place (building, unit ' +
    'or common area), type (ac, electrical, plumbing, civil, painting, carpentry, inspection, general, emergency, other), title, ' +
    'priority, status (scheduled, in_progress, completed, delayed, cancelled), whether it is overdue, the team on it and the ' +
    'maintenance request it came from. Comes with counts by status, type and building over everything that matched (up to 200 rows ' +
    'listed, newest first). Use for "work order report", "open work orders at Park Place", "what is overdue", "AC jobs this month", ' +
    '"what is Usman working on". For a report, call it with the period asked; lead with the overdue and open ones. ' +
    'No dates = any date. View only: you cannot create, close or reassign a work order.',
    {
      ...WHERE,
      from: { ...DATE, description: 'First schedule date.' },
      to: { ...DATE, description: 'Last schedule date.' },
      status: { type: 'string', enum: ['scheduled', 'in_progress', 'completed', 'delayed', 'cancelled'] },
      open: { type: 'boolean', description: 'Only the ones not finished: scheduled, in progress or delayed.' },
      overdue: { type: 'boolean', description: 'Only open ones whose date has passed.' },
      type: { type: 'string', enum: ['ac', 'electrical', 'plumbing', 'civil', 'painting', 'carpentry', 'inspection', 'general', 'emergency', 'other'] },
      person: { type: 'string', description: 'A technician\'s or engineer\'s name, or part of it: only the work orders they are on.' },
    }) },
  { action: 'requests', status: 'Reading the maintenance requests…', tool: tool('maintenance_requests',
    'Maintenance requests from saifsys Real Estate → Maintenance (raised by the office or by tenants on the tenant app): id, date, ' +
    'place, category (HVAC, plumbing, electrical, cleaning…), priority, status (pending, in_progress, completed, cancelled), ' +
    'description, tenant, who it is assigned to, vendor, cost, photos. Comes with counts by status, category, building and priority, ' +
    'how many are open for over 7 days, total cost and average resolution time (up to 200 rows listed, newest first). ' +
    'Use for "maintenance complaints at Park Place", "what did tenants report this month", "pending requests", "AC complaints". ' +
    'No dates = any date. A request becomes one or more work orders: use maintenance_work_orders or maintenance_item for those.',
    {
      ...WHERE,
      from: { ...DATE, description: 'First request date.' },
      to: { ...DATE, description: 'Last request date.' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
      open: { type: 'boolean', description: 'Only pending or in progress.' },
      category: { type: 'string', description: 'Category or part of it, e.g. "HVAC", "plumb".' },
    }) },
  { action: 'item', status: 'Opening the work order…', tool: tool('maintenance_item',
    'One maintenance request or one work order in full. Give id (a request id, e.g. 1596) to get the request with its photos ' +
    'counted and all its work orders; or wo (a work order number, e.g. "WO-2-02177") to get the work order with its team, notes ' +
    'and the request it came from.',
    {
      id: { type: 'integer', description: 'A maintenance request id.' },
      wo: { type: 'string', description: 'A work order number, e.g. "WO-2-02177".' },
    }) },
];

export const tools = LOOKUPS.map((l) => l.tool);

// true/false become 1 or nothing: saifsys reads open=1, overdue=1.
const params = (input) => Object.fromEntries(Object.entries(input)
  .map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 1 : undefined) : v]));

export const handlers = Object.fromEntries(LOOKUPS.map((l) => [l.tool.name, async (input) => {
  const { ok, ...answer } = await askSaifsys('maintenance', l.action, params(input));
  return JSON.stringify(answer);
}]));

export const status = Object.fromEntries(LOOKUPS.map((l) => [l.tool.name, l.status]));
