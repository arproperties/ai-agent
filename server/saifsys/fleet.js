import { askSaifsys } from './client.js';

// saifsys → Fleet: how the Driver app is used. Matches api/jarvis/v1/modules/fleet.php on
// the saifsys side, which shares its numbers with Operations → Fleet → Usage Report.
//
// View only: three lookups, carried by the agents of anyone who has the Fleet module
// (the master always; others only when ticked).

const DATE = { type: 'string', description: 'YYYY-MM-DD. Work it out from the current date given to you.' };
const tool = (name, description, properties = {}, required = []) => ({
  name, description, input_schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
});
const PERIOD = {
  from: { ...DATE, description: 'First day. Default: 30 days ago. "This month" = the 1st of this month.' },
  to: { ...DATE, description: 'Last day. Default: today.' },
};

const LOOKUPS = [
  { action: 'usage', status: 'Checking the driver app report…', tool: tool('fleet_usage',
    'The Driver app usage report from saifsys (vehicle tracking): for a period, the totals (trips, km, hours, active drivers, ' +
    'vehicles used, daily safety-check rate, share of trips that saved 0 km, check problems not seen), then by driver ' +
    '(trips, km, hours, days driven, trips in the last 7 days, 0 km share, checks done, active or stopped), by vehicle ' +
    '(trips, km, main drivers, last used, never used), by week, and trips over 10 hours. ' +
    'Use for "how are the drivers doing", "fleet report this month", "who drove the most", "which cars are not used", ' +
    '"did everyone do the daily check", "is tracking working". `meaning` explains each number: use it, e.g. say a 0 km trip ' +
    'usually means the phone was locked. Lead with what needs attention (stopped drivers, high 0 km share, problems not seen).',
    { ...PERIOD, company: { type: 'string', description: 'Company name or part of it, e.g. "Prime Elite". Leave out for all companies.' } }) },
  { action: 'driver', status: 'Looking up the driver…', tool: tool('fleet_driver',
    'One driver\'s numbers from the Driver app for a period: trips, km, hours, days driven, 0 km share, daily checks done, ' +
    'active or stopped, last trip, the vehicles they drove, their latest 10 trips and their check problems not yet seen. ' +
    'Use for "how is Gul Alam doing", "when did Nikdar last drive", "Arslan\'s trips this week".',
    { q: { type: 'string', description: 'Part of the driver\'s name.' }, ...PERIOD }, ['q']) },
  { action: 'problems', status: 'Checking reported vehicle problems…', tool: tool('fleet_check_problems',
    'Problems drivers reported in the daily safety check that nobody in the office has marked as seen yet, any date, newest first: ' +
    'date, driver, vehicle plate and what is wrong. Use for "any vehicle problems", "what did the drivers report", "tyre problems". ' +
    'They are cleared in saifsys under Operations → Fleet → Daily Checks.',
    { company: { type: 'string', description: 'Company name or part of it. Leave out for all companies.' } }) },
];

export const tools = LOOKUPS.map((l) => l.tool);

export const handlers = Object.fromEntries(LOOKUPS.map((l) => [l.tool.name, async (input) => {
  const { ok, ...answer } = await askSaifsys('fleet', l.action, input);
  return JSON.stringify(answer);
}]));

export const status = Object.fromEntries(LOOKUPS.map((l) => [l.tool.name, l.status]));
