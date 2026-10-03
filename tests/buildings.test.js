import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import {
  listBuildings, saveBuilding, deleteBuilding, searchStaff, teamJobs, teamJob, changes, watchBuildings, buildingKit,
} from '../server/buildings.js';

test.after(() => closeDb());

// A stand-in for saifsys: its buildings, its HR, and the jobs it would return for a scope.
const SITES = [{ id: 3, name: 'Park Place' }, { id: 7, name: 'Townhouse A' }, { id: 8, name: 'Townhouse B' }];
const STAFF = {
  E00021: { code: 'E00021', name: 'Karina Lopez', position: 'Cleaner', company: 'Heroes Zone', status: 'Active' },
  E00034: { code: 'E00034', name: 'Usman Khan', position: 'Technician', company: 'Heroes Zone', status: 'Active' },
};
const job = (over = {}) => ({
  id: 1, type: 'cleaning', title: 'Clean unit 304', location: null, assignee: { name: 'Karina Lopez', code: 'E00021' },
  date: '2026-10-03', time: '09:00', priority: 'normal', status: 'open', status_label: 'Not started', paused: false,
  late: false, late_note: null, duration: null, needs_materials: false, source: 'staff', source_label: 'Raised by staff',
  photos: { before: 0, after: 0 }, messages: 0, places: ['Park Place — 304'], building_ids: [3], last_message: null, problems: null,
  ...over,
});

function saifsys(jobs = []) {
  const asked = [];
  const ask = async (module, action, params = {}) => {
    asked.push({ module, action, params });
    if (module === 'operations' && action === 'buildings') return { ok: true, buildings: SITES };
    if (module === 'hr' && action === 'employee') return STAFF[params.q] ? { found: 1, employee: STAFF[params.q] } : { found: 0 };
    if (module === 'hr' && action === 'employees') return { employees: [...Object.values(STAFF), { code: null, name: 'No Code' }].filter((e) => e.name.toLowerCase().includes(params.q.toLowerCase())) };
    if (module === 'operations' && action === 'jobs') {
      return { ok: true, today: '2026-10-03', from: params.from || '2026-10-03', to: params.to || '2026-10-03', total: jobs.length, more: false, counts: {}, staff: [], jobs };
    }
    if (module === 'operations' && action === 'job') {
      const j = jobs.find((x) => x.id === params.id);
      if (!j) throw Object.assign(new Error('saifsys said: No such job in these buildings.'), { status: 502 });
      return { ok: true, job: { ...j, description: 'Deep clean', photo_list: [{ id: 5, when: 'before', kind: 'photo' }], message_list: [] } };
    }
    throw new Error(`unexpected ${module}/${action}`);
  };
  return { ask, asked };
}

async function people() {
  await reset();
  return {
    master: { id: await makeUser('Owner'), role: 'master' },
    jessa: { id: await makeUser('Jessa'), role: 'user' },
    sabha: { id: await makeUser('Sabha'), role: 'user' },
    shireen: { id: await makeUser('Shireen'), role: 'user' },
  };
}

test('the master sets a building up; names come from saifsys, not from what was typed', async () => {
  const { master, jessa, shireen } = await people();
  const { ask } = saifsys();

  const b = await saveBuilding(master, null, {
    name: '  Park   Place ', admin_id: jessa.id, renewals_id: shireen.id,
    sites: [{ id: 3, name: 'whatever' }], staff: [{ code: ' e00021 ', kind: 'cleaner' }, { code: 'E00034', kind: 'technician' }],
  }, ask);
  assert.equal(b.name, 'Park Place');
  assert.deepEqual(b.admin, { id: jessa.id, name: 'Jessa' });
  assert.deepEqual(b.renewals, { id: shireen.id, name: 'Shireen' });
  assert.deepEqual(b.sites, [{ id: 3, name: 'Park Place' }]);
  assert.deepEqual(b.staff, [{ code: 'E00021', name: 'Karina Lopez', kind: 'cleaner' }, { code: 'E00034', name: 'Usman Khan', kind: 'technician' }]);

  await assert.rejects(saveBuilding(master, null, { name: '' }, ask), /Give the building a name/);
  await assert.rejects(saveBuilding(master, null, { name: 'X', sites: [99] }, ask), /no building with id 99/);
  await assert.rejects(saveBuilding(master, null, { name: 'X', staff: [{ code: 'E99999', kind: 'cleaner' }] }, ask), /no employee with code E99999/);
  await assert.rejects(saveBuilding(master, null, { name: 'X', staff: [{ code: 'E00021', kind: 'manager' }] }, ask), /cleaner or a technician/);
  await assert.rejects(saveBuilding(master, null, { name: 'X', admin_id: 9999 }, ask), /Pick the administrator/);

  // Saving again replaces the lot: one name can cover several saifsys buildings, and a
  // cleaner can be in more than one building.
  const t = await saveBuilding(master, null, { name: 'Townhouses', admin_id: jessa.id, sites: [7, 8], staff: [{ code: 'E00021', kind: 'cleaner' }] }, ask);
  assert.deepEqual(t.sites.map((s) => s.id), [7, 8]);
  const changed = await saveBuilding(master, b.id, { name: 'Park Place', admin_id: jessa.id, sites: [3], staff: [{ code: 'E00021', kind: 'cleaner' }] }, ask);
  assert.equal(changed.renewals, null);
  assert.deepEqual(changed.staff.map((s) => s.code), ['E00021']);
  assert.equal(await saveBuilding(master, 999, { name: 'Nope' }, ask), null);

  assert.equal(await deleteBuilding(t.id), true);
  assert.equal((await listBuildings(master)).length, 1);
});

test('an administrator sees only their own buildings; everyone else sees none', async () => {
  const { master, jessa, sabha, shireen } = await people();
  const { ask } = saifsys([job()]);
  const park = await saveBuilding(master, null, { name: 'Park Place', admin_id: jessa.id, renewals_id: shireen.id, sites: [3] }, ask);
  const ayla = await saveBuilding(master, null, { name: 'Ayla', admin_id: sabha.id, sites: [7] }, ask);

  assert.deepEqual((await listBuildings(master)).map((b) => b.name), ['Ayla', 'Park Place']);
  assert.deepEqual((await listBuildings(jessa)).map((b) => b.name), ['Park Place']);
  assert.deepEqual(await listBuildings(shireen), [], 'handling renewals does not show the jobs');

  assert.equal((await teamJobs(jessa, park.id, {}, ask)).jobs.length, 1);
  assert.equal(await teamJobs(jessa, ayla.id, {}, ask), null);
  assert.equal(await teamJob(jessa, ayla.id, 1, ask), null);
  assert.equal(await teamJobs(shireen, park.id, {}, ask), null);
  assert.equal((await teamJobs(master, ayla.id, {}, ask)).jobs.length, 1);
});

test('saifsys is only ever asked inside the building\'s own scope', async () => {
  const { master, jessa } = await people();
  const { ask, asked } = saifsys([job()]);
  const b = await saveBuilding(master, null, { name: 'Townhouses', admin_id: jessa.id, sites: [7, 8], staff: [{ code: 'E00021', kind: 'cleaner' }, { code: 'E00034', kind: 'technician' }] }, ask);

  await teamJobs(jessa, b.id, { from: '2026-10-01', to: '2026-10-02', late: false }, ask);
  assert.deepEqual(asked.at(-1).params, { buildings: '7,8', codes: 'E00021,E00034', from: '2026-10-01', to: '2026-10-02', late: undefined, code: undefined, status: undefined, type: undefined });
  await assert.rejects(teamJobs(jessa, b.id, { from: 'yesterday' }, ask), /Dates look like/);

  const one = await teamJob(jessa, b.id, 1, ask);
  assert.equal(one.description, 'Deep clean');
  assert.deepEqual(asked.at(-1).params, { buildings: '7,8', codes: 'E00021,E00034', id: 1 });
  assert.equal(await teamJob(jessa, b.id, 42, ask), null, 'a job outside the building is simply not found');

  // A building with nothing set asks saifsys nothing at all.
  const empty = await saveBuilding(master, null, { name: 'Empty', admin_id: jessa.id }, ask);
  const before = asked.length;
  const out = await teamJobs(jessa, empty.id, {}, ask);
  assert.equal(out.unset, true);
  assert.equal(asked.length, before);
});

test('searching HR for someone to add leaves out people with no code', async () => {
  const { ask } = saifsys();
  assert.deepEqual((await searchStaff('kar', ask)).map((e) => e.code), ['E00021']);
  assert.deepEqual(await searchStaff('no co', ask), []);
  assert.deepEqual(await searchStaff('k', ask), [], 'one letter is not a search');
});

test('what counts as news on a job', () => {
  const kinds = (prev, j) => changes(prev, j).map((e) => e.kind);
  const seen = { status: 'open', late: false, needs_materials: false, problems: false, last_message_id: 0 };

  assert.deepEqual(kinds(seen, job()), [], 'nothing changed');
  assert.deepEqual(kinds(undefined, job()), [], 'a new job the office raised is not news');
  assert.deepEqual(kinds(undefined, job({ source: 'tenant_maintenance' })), ['request']);
  assert.deepEqual(kinds(undefined, job({ source: 'cleaner_report' })), ['problem']);
  assert.deepEqual(kinds(seen, job({ late: true, late_note: 'Not started' })), ['late']);
  assert.deepEqual(kinds({ ...seen, late: true }, job({ late: true })), [], 'late is said once');
  assert.deepEqual(kinds({ ...seen, status: 'in_progress' }, job({ status: 'done', duration: '1h 10m' })), ['done']);
  assert.deepEqual(kinds({ ...seen, status: 'done' }, job({ status: 'done' })), []);

  // Asking for materials is one buzz, not one for the flag and one for the message.
  const asking = { id: 9, from_staff: true, text: 'No bleach left', material_request: true };
  assert.deepEqual(kinds(seen, job({ needs_materials: true, last_message: asking })), ['materials']);
  assert.equal(changes(seen, job({ needs_materials: true, last_message: asking }))[0].body, 'No bleach left');

  const msg = { id: 12, from_staff: true, text: 'Tenant is not home', material_request: false };
  assert.deepEqual(kinds(seen, job({ last_message: msg })), ['message']);
  assert.deepEqual(kinds({ ...seen, last_message_id: 12 }, job({ last_message: msg })), []);
  assert.deepEqual(kinds(seen, job({ last_message: { ...msg, from_staff: false } })), [], 'the office\'s own message is not news');

  const leak = { found: ['Water leak'], note: 'Under the sink', maintenance_job_id: null };
  assert.deepEqual(kinds(seen, job({ problems: leak })), ['problem']);
  assert.deepEqual(kinds(seen, job({ problems: { ...leak, maintenance_job_id: 77 } })), [], 'that one buzzes as its own job');
  assert.match(changes(seen, job({ status: 'done' }))[0].title, /^Karina finished: Clean unit 304$/);
});

test('the watcher buzzes the administrator once per change, and never on its first look', async () => {
  const { master, jessa, sabha } = await people();
  const jobs = [job({ id: 1, late: true }), job({ id: 2, title: 'Fix AC', status: 'in_progress' })];
  const { ask } = saifsys(jobs);
  const pushes = [];
  const push = async (to, n) => { pushes.push({ to, ...n }); };
  const b = await saveBuilding(master, null, { name: 'Park Place', admin_id: jessa.id, sites: [3] }, ask);
  await saveBuilding(master, null, { name: 'No admin', sites: [7] }, ask);
  await saveBuilding(master, null, { name: 'Nothing set', admin_id: sabha.id }, ask);

  assert.deepEqual(await watchBuildings({ ask, push }), [], 'the first look only writes down what is there');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM building_jobs_seen').get()).n, 2, 'and only for a building with an administrator and something set');

  assert.deepEqual(await watchBuildings({ ask, push }), [], 'nothing changed');

  jobs[1] = job({ id: 2, title: 'Fix AC', status: 'done', duration: '45m' });
  jobs.push(job({ id: 3, title: 'AC not cooling', source: 'tenant_maintenance', assignee: null }));
  const sent = await watchBuildings({ ask, push });
  assert.deepEqual(sent.map((s) => s.title), ['Karina finished: Fix AC', 'New request: AC not cooling']);
  assert.deepEqual(pushes.map((p) => p.to), [[jessa.id], [jessa.id]]);
  assert.equal(pushes[0].url, `/?building=${b.id}&job=2`);
  assert.deepEqual(await watchBuildings({ ask, push }), [], 'and not again');

  // A burst is one line, not a row of buzzes.
  for (let id = 10; id < 16; id++) jobs.push(job({ id, title: `Request ${id}`, source: 'tenant_cleaning' }));
  const burst = await watchBuildings({ ask, push });
  assert.equal(burst.length, 1);
  assert.equal(burst[0].title, 'Park Place: 6 updates');
  assert.equal(burst[0].url, `/?building=${b.id}`);
});

test('Reem: anyone can ask who runs a building; only its people can ask about its jobs', async () => {
  const { master, jessa, sabha, shireen } = await people();
  const { ask } = saifsys([job({ status: 'done', status_label: 'Completed' })]);
  await saveBuilding(master, null, { name: 'Park Place', admin_id: jessa.id, sites: [3], staff: [{ code: 'E00021', kind: 'cleaner' }] }, ask);
  await saveBuilding(master, null, { name: 'Ladies Camp', admin_id: sabha.id, renewals_id: shireen.id, sites: [7] }, ask);
  const prev = process.env.SAIFSYS_API_KEY;
  process.env.SAIFSYS_API_KEY = 'test';
  try {
    const call = async (user, name, input = {}) => (await (await buildingKit(user, ask)).run({ id: 't', name, input }));

    const stranger = await buildingKit(shireen, ask);
    assert.deepEqual(stranger.definitions.map((d) => d.name), ['building_teams']);
    const dir = (await call(shireen, 'building_teams')).content;
    assert.match(dir, /Park Place\n  Administrator: Jessa\n  Renewals: Jessa\n  Cleaners: Karina Lopez \[HR E00021\]\n  Technicians: none yet/);
    assert.match(dir, /Ladies Camp\n  Administrator: Sabha\n  Renewals: Shireen/);
    assert.match((await call(shireen, 'building_teams', { building: 'ladies' })).content, /^Ladies Camp/);
    assert.equal((await call(shireen, 'team_jobs')).is_error, true, 'not a tool she has');

    assert.deepEqual((await buildingKit(jessa, ask)).definitions.map((d) => d.name), ['building_teams', 'team_jobs', 'team_job']);
    const mine = JSON.parse((await call(jessa, 'team_jobs', { person: 'karina' })).content);
    assert.deepEqual(mine.map((b) => b.building), ['Park Place']);
    assert.equal(mine[0].jobs[0].status_label, 'Completed');
    assert.match((await call(jessa, 'team_jobs', { building: 'ladies' })).content, /No building of yours matches/);
    assert.match((await call(jessa, 'team_jobs', { person: 'nobody' })).content, /Nobody called "nobody"/);

    assert.equal(JSON.parse((await call(jessa, 'team_job', { id: 1 })).content).building, 'Park Place');
    assert.match((await call(jessa, 'team_job', { id: 42 })).content, /no job 42/);
    assert.equal(JSON.parse((await call(master, 'team_jobs')).content).length, 2, 'the master gets every building');
  } finally {
    if (prev === undefined) delete process.env.SAIFSYS_API_KEY; else process.env.SAIFSYS_API_KEY = prev;
  }
});
