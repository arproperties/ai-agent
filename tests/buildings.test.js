import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import {
  listBuildings, syncBuildings, setBuilding, teamJobs, teamJob, changes, watchBuildings, buildingKit,
} from '../server/buildings.js';

test.after(() => closeDb());

// A stand-in for saifsys: its buildings, and the jobs it would return for a scope.
const SITES = [{ id: 3, name: 'Park Place' }, { id: 7, name: 'Ladies Camp' }, { id: 8, name: 'Sharjah Villa' }, { id: 9, name: 'TEST BUILDING' }];
const job = (over = {}) => ({
  id: 1, type: 'cleaning', title: 'Clean unit 304', location: null, assignee: { name: 'Karina Lopez', code: 'E00021' },
  date: '2026-10-03', time: '09:00', priority: 'normal', status: 'open', status_label: 'Not started', paused: false,
  late: false, late_note: null, duration: null, needs_materials: false, source: 'staff', source_label: 'Raised by staff',
  photos: { before: 0, after: 0 }, messages: 0, places: ['Park Place — 304'], building_ids: [3], last_message: null, problems: null,
  ...over,
});

function saifsys(jobs = [], sites = SITES) {
  const asked = [];
  const state = { sites };
  const ask = async (module, action, params = {}) => {
    asked.push({ module, action, params });
    if (module === 'operations' && action === 'buildings') return { ok: true, buildings: state.sites };
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
  return { ask, asked, state };
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

/** The buildings as saifsys has them, by name, after one look. */
async function buildings(master, ask) {
  await syncBuildings(ask);
  return Object.fromEntries((await listBuildings(master)).map((b) => [b.name, b]));
}

test('the buildings are the ones saifsys has, under its names; the master only says who runs each', async () => {
  const { master, jessa, shireen } = await people();
  const { ask, state } = saifsys();

  const all = await buildings(master, ask);
  assert.deepEqual(Object.keys(all), ['Ladies Camp', 'Park Place', 'Sharjah Villa'], 'a made-up building for trying things out is left out');
  assert.deepEqual({ ...all['Park Place'], id: 0 }, { id: 0, site_id: 3, name: 'Park Place', admin: null, renewals: null });

  const b = await setBuilding(master, all['Park Place'].id, { admin_id: jessa.id, renewals_id: shireen.id });
  assert.deepEqual(b.admin, { id: jessa.id, name: 'Jessa' });
  assert.deepEqual(b.renewals, { id: shireen.id, name: 'Shireen' });
  await assert.rejects(setBuilding(master, b.id, { admin_id: 9999 }), /Pick the administrator/);
  await assert.rejects(setBuilding(master, b.id, { renewals_id: 9999 }), /Pick who handles renewals/);
  assert.equal(await setBuilding(master, 999, { admin_id: jessa.id }), null);
  assert.equal((await setBuilding(master, b.id, { admin_id: jessa.id })).renewals, null, 'the end state is what is sent');

  // saifsys renames one, adds one and drops one: the list follows, and who runs a building stays.
  state.sites = [{ id: 3, name: 'PARK PLACE' }, { id: 7, name: 'Ladies Camp' }, { id: 12, name: 'Ayla Residence' }];
  const now = await buildings(master, ask);
  assert.deepEqual(Object.keys(now), ['Ayla Residence', 'Ladies Camp', 'PARK PLACE']);
  assert.deepEqual([now['PARK PLACE'].id, now['PARK PLACE'].admin], [b.id, { id: jessa.id, name: 'Jessa' }]);

  // An empty answer changes nothing.
  state.sites = [];
  assert.equal(Object.keys(await buildings(master, ask)).length, 3);
});

test('an administrator sees only their own buildings; everyone else sees none', async () => {
  const { master, jessa, sabha, shireen } = await people();
  const { ask } = saifsys([job()]);
  const all = await buildings(master, ask);
  const park = await setBuilding(master, all['Park Place'].id, { admin_id: jessa.id, renewals_id: shireen.id });
  const camp = await setBuilding(master, all['Ladies Camp'].id, { admin_id: sabha.id });

  assert.deepEqual((await listBuildings(master)).map((b) => b.name), ['Ladies Camp', 'Park Place', 'Sharjah Villa']);
  assert.deepEqual((await listBuildings(jessa)).map((b) => b.name), ['Park Place']);
  assert.deepEqual(await listBuildings(shireen), [], 'handling renewals does not show the jobs');

  assert.equal((await teamJobs(jessa, park.id, {}, ask)).jobs.length, 1);
  assert.equal(await teamJobs(jessa, camp.id, {}, ask), null);
  assert.equal(await teamJob(jessa, camp.id, 1, ask), null);
  assert.equal(await teamJobs(shireen, park.id, {}, ask), null);
  assert.equal((await teamJobs(master, camp.id, {}, ask)).jobs.length, 1);
  assert.equal((await teamJobs(master, all['Sharjah Villa'].id, {}, ask)).jobs.length, 1, 'the master needs no administrator set');
});

test('saifsys is only ever asked inside the one building', async () => {
  const { master, jessa } = await people();
  const { ask, asked } = saifsys([job()]);
  const b = await setBuilding(master, (await buildings(master, ask))['Ladies Camp'].id, { admin_id: jessa.id });

  await teamJobs(jessa, b.id, { from: '2026-10-01', to: '2026-10-02', late: false }, ask);
  assert.deepEqual(asked.at(-1).params, { buildings: '7', from: '2026-10-01', to: '2026-10-02', late: undefined, status: undefined, type: undefined });
  await assert.rejects(teamJobs(jessa, b.id, { from: 'yesterday' }, ask), /Dates look like/);

  const one = await teamJob(jessa, b.id, 1, ask);
  assert.equal(one.description, 'Deep clean');
  assert.deepEqual(asked.at(-1).params, { buildings: '7', id: 1 });
  assert.equal(await teamJob(jessa, b.id, 42, ask), null, 'a job outside the building is simply not found');
});

test('entries from before become one row per saifsys building, once', async () => {
  const { master, jessa, sabha, shireen } = await people();
  // As it was: a name of the office's own over one or several saifsys buildings, and HR staff.
  await db.exec(`
    ALTER TABLE buildings ALTER COLUMN site_id DROP NOT NULL;
    DROP TABLE IF EXISTS building_sites, building_staff;
    CREATE TABLE building_sites (building_id INTEGER NOT NULL, site_id INTEGER NOT NULL, name TEXT NOT NULL);
    CREATE TABLE building_staff (building_id INTEGER NOT NULL, employee_code TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL);
  `);
  const old = async (name, adminId, renewalsId, sites) => {
    const { id } = await db.prepare('INSERT INTO buildings (name, admin_id, renewals_id, watched_at) VALUES (?, ?, ?, 1) RETURNING id').run(name, adminId, renewalsId);
    for (const [siteId, siteName] of sites) await db.prepare('INSERT INTO building_sites (building_id, site_id, name) VALUES (?, ?, ?)').run(id, siteId, siteName);
    return id;
  };
  const ayla = await old('Ayla Building', jessa.id, shireen.id, [[1, 'AYLA RESIDENCE']]);
  await old('Townhouses', sabha.id, null, [[8, 'Townhouse B'], [7, 'Townhouse A']]);
  await old('Also Ayla', sabha.id, null, [[1, 'AYLA RESIDENCE']]);
  await old('Nothing ticked', jessa.id, null, []);
  await db.prepare(`INSERT INTO building_staff VALUES (?, 'E00021', 'Karina Lopez', 'cleaner')`).run(ayla);
  await db.prepare(`INSERT INTO building_jobs_seen (building_id, job_id, status) VALUES (?, 5, 'open')`).run(ayla);

  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  const start = source.indexOf('  ALTER TABLE buildings ADD COLUMN IF NOT EXISTS site_id INTEGER;');
  const moves = source.slice(start, source.indexOf('`);', start));
  await db.exec(moves);
  await db.exec(moves); // boots again: nothing moves twice

  assert.deepEqual((await listBuildings(master)).map((b) => [b.name, b.site_id, b.admin?.name, b.renewals?.name]), [
    ['AYLA RESIDENCE', 1, 'Jessa', 'Shireen'],
    ['Townhouse A', 7, 'Sabha', undefined],
    ['Townhouse B', 8, 'Sabha', undefined],
  ]);
  const rows = await listBuildings(master);
  assert.equal(rows[0].id, ayla, 'an entry keeps its number, so a notification already sent still opens it');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM building_jobs_seen WHERE building_id = ?').get(ayla)).n, 1, 'and what the watcher had seen');
  assert.equal((await db.prepare(`SELECT to_regclass('building_sites') AS a, to_regclass('building_staff') AS b`).get()).a, null);
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
  const { master, jessa } = await people();
  const jobs = [job({ id: 1, late: true }), job({ id: 2, title: 'Fix AC', status: 'in_progress' })];
  const { ask } = saifsys(jobs);
  const pushes = [];
  const push = async (to, n) => { pushes.push({ to, ...n }); };
  // Ladies Camp and Sharjah Villa have no administrator: nobody to buzz, so they are not looked at.
  const b = await setBuilding(master, (await buildings(master, ask))['Park Place'].id, { admin_id: jessa.id });

  assert.deepEqual(await watchBuildings({ ask, push }), [], 'the first look only writes down what is there');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM building_jobs_seen').get()).n, 2, 'and only for a building with an administrator');

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
  const all = await buildings(master, ask);
  await setBuilding(master, all['Park Place'].id, { admin_id: jessa.id });
  await setBuilding(master, all['Ladies Camp'].id, { admin_id: sabha.id, renewals_id: shireen.id });
  const prev = process.env.SAIFSYS_API_KEY;
  process.env.SAIFSYS_API_KEY = 'test';
  try {
    const call = async (user, name, input = {}) => (await (await buildingKit(user, ask)).run({ id: 't', name, input }));

    const stranger = await buildingKit(shireen, ask);
    assert.deepEqual(stranger.definitions.map((d) => d.name), ['building_teams']);
    const dir = (await call(shireen, 'building_teams')).content;
    assert.match(dir, /Park Place\n  Administrator: Jessa\n  Renewals: Jessa/);
    assert.match(dir, /Ladies Camp\n  Administrator: Sabha\n  Renewals: Shireen/);
    assert.match(dir, /Sharjah Villa\n  Administrator: not set\n  Renewals: not set/);
    assert.doesNotMatch(dir, /Cleaners|Technicians/);
    assert.match((await call(shireen, 'building_teams', { building: 'ladies' })).content, /^Ladies Camp/);
    assert.equal((await call(shireen, 'team_jobs')).is_error, true, 'not a tool she has');

    assert.deepEqual((await buildingKit(jessa, ask)).definitions.map((d) => d.name), ['building_teams', 'team_jobs', 'team_job']);
    const mine = JSON.parse((await call(jessa, 'team_jobs', { person: 'karina' })).content);
    assert.deepEqual(mine.map((b) => b.building), ['Park Place']);
    assert.equal(mine[0].jobs[0].status_label, 'Completed');
    assert.equal(mine[0].total, 1, 'the person is found by the name saifsys put on the job');
    assert.match((await call(jessa, 'team_jobs', { building: 'ladies' })).content, /No building of yours matches/);
    assert.match((await call(jessa, 'team_jobs', { person: 'nobody' })).content, /Nobody called "nobody"/);

    assert.equal(JSON.parse((await call(jessa, 'team_job', { id: 1 })).content).building, 'Park Place');
    assert.match((await call(jessa, 'team_job', { id: 42 })).content, /no job 42/);
    assert.equal(JSON.parse((await call(master, 'team_jobs')).content).length, 3, 'the master gets every building');
  } finally {
    if (prev === undefined) delete process.env.SAIFSYS_API_KEY; else process.env.SAIFSYS_API_KEY = prev;
  }
});
