import { askSaifsys } from './client.js';

// saifsys → HR. Matches api/jarvis/v1/modules/hr.php on the saifsys side.
//
// View only: two lookups, carried by the agents of anyone who has the HR module. Whoever
// has HR sees everything these return, salary included (the user's rule). ID, passport
// and visa numbers, bank details and address never leave saifsys.

const DATE = { type: 'string', description: 'YYYY-MM-DD. Work it out from the current date given to you.' };
const tool = (name, description, properties = {}, required = []) => ({
  name, description, input_schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
});

const LOOKUPS = [
  { action: 'employees', status: 'Looking up employees…', tool: tool('hr_employees',
    'A list of employees from the HR module of saifsys, every company. Each comes with code, name, job title, company, department, ' +
    'location, manager, status and join date; total is how many match, by_company the split. ' +
    'Use for "who works in Cleaning", "how many staff does ARS have", "who reports to Jessa", "who joined this year", "who left last month". ' +
    'Current staff only unless the user asks about people who left (status left) or everyone (all).',
    {
      q: { type: 'string', description: 'Part of a name, nickname, employee code or job title.' },
      company: { type: 'string', description: 'Company name, or part of it.' },
      department: { type: 'string', description: 'Department name, or part of it.' },
      manager: { type: 'string', description: 'A manager\'s name: returns the people who report to them.' },
      status: { type: 'string', enum: ['current', 'left', 'all', 'active', 'on_leave', 'notice_period', 'resigned', 'terminated', 'not_renewed', 'inactive'],
        description: 'current (default) = active, on leave or notice period; left = resigned, terminated, not renewed or inactive.' },
      joined_from: { ...DATE, description: 'Joined on or after this day.' },
      joined_to: { ...DATE, description: 'Joined on or before this day.' },
      left_from: { ...DATE, description: 'Exit date on or after this day. Use with status left.' },
      left_to: { ...DATE, description: 'Exit date on or before this day. Use with status left.' },
    }) },
  { action: 'employee', status: 'Opening the employee profile…', tool: tool('hr_employee',
    'One employee\'s full profile from saifsys HR: code, job title, company, department, location, manager, join date, status, ' +
    'phone, email, date of birth, salary (basic, allowance, bonus, total, WPS or cash), the people who report to them, and exit details for someone who left. ' +
    'Search by employee code, name, nickname, phone or email. Several matches come back as a list: ask which one, then look up by code.',
    { q: { type: 'string', description: 'Employee code, name, nickname, phone or email.' } }, ['q']) },
];

export const tools = LOOKUPS.map((l) => l.tool);

export const handlers = Object.fromEntries(LOOKUPS.map((l) => [l.tool.name, async (input) => {
  const { ok, ...answer } = await askSaifsys('hr', l.action, input);
  return JSON.stringify(answer);
}]));

export const status = Object.fromEntries(LOOKUPS.map((l) => [l.tool.name, l.status]));
