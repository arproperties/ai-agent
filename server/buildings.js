import { Router } from 'express';
import { Readable } from 'node:stream';
import { db, tx } from './db.js';
import { requireMaster } from './auth.js';
import { sendPush } from './push.js';
import { lookupCode } from './hrLinks.js';
import { askSaifsys, fileFromSaifsys, saifsysConfigured, dubaiHour } from './saifsys/client.js';

// Buildings: who runs each one, and the cleaners and technicians given to them.
//
// The master sets it up: a building has one administrator (a Reem account), someone for
// renewals when that is not the administrator, and its field staff by HR employee code.
// The field staff have no Reem account - they do their jobs on the saifsys staff app.
// This is the administrator's window onto that work: the jobs in their building, with
// the photos, the checklist and the messages, and a buzz when something needs them.
//
// Nothing here writes to saifsys. The jobs come from its Operations module through
// api/jarvis/v1/modules/operations.php, which answers only for the scope it is sent:
// the saifsys buildings behind this one, and its staff (for their jobs that carry no
// building). So an administrator can never be shown another building's work.

const MAX_NAME = 80;
export const KINDS = ['cleaner', 'technician'];
const NOW = 'extract(epoch from now())::bigint';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isMaster = (user) => user?.role === 'master';

// ---------- reading ----------

/**
 * The buildings this person sees: all of them for the master, their own for an
 * administrator, none for anyone else.
 */
export async function listBuildings(user) {
  const rows = await db.prepare(`SELECT b.id, b.name, b.admin_id, a.name AS admin_name, b.renewals_id, r.name AS renewals_name
    FROM buildings b LEFT JOIN users a ON a.id = b.admin_id LEFT JOIN users r ON r.id = b.renewals_id
    ${isMaster(user) ? '' : 'WHERE b.admin_id = ?'} ORDER BY lower(b.name), b.id`).all(...(isMaster(user) ? [] : [user.id]));
  if (!rows.length) return [];
  const ids = rows.map((b) => b.id);
  const sites = await db.prepare('SELECT building_id, site_id AS id, name FROM building_sites WHERE building_id = ANY(?::int[]) ORDER BY lower(name)').all(ids);
  const staff = await db.prepare(`SELECT building_id, employee_code AS code, name, kind FROM building_staff
    WHERE building_id = ANY(?::int[]) ORDER BY kind, lower(name)`).all(ids);
  const of = (list, id) => list.filter((x) => x.building_id === id).map(({ building_id, ...x }) => x);
  return rows.map((b) => ({
    id: b.id,
    name: b.name,
    admin: b.admin_id ? { id: b.admin_id, name: b.admin_name } : null,
    // Renewals fall to the administrator unless someone else is named.
    renewals: b.renewals_id ? { id: b.renewals_id, name: b.renewals_name } : null,
    sites: of(sites, b.id),
    staff: of(staff, b.id),
  }));
}

const visible = async (user, id) => (await listBuildings(user)).find((b) => b.id === Number(id)) || null;

/** What saifsys is asked to stay inside for this building. null when it has nothing set. */
function scopeOf(b) {
  if (!b.sites.length && !b.staff.length) return null;
  return { buildings: b.sites.map((s) => s.id).join(','), codes: b.staff.map((s) => s.code).join(',') };
}

// ---------- writing (master) ----------

/**
 * Create a building (id null) or replace one. The caller sends the end state.
 * Every saifsys building and every employee code is checked against saifsys first, and
 * the names kept are the ones saifsys has, so a typo cannot quietly attach the wrong one.
 */
export async function saveBuilding(master, id, input, ask = askSaifsys) {
  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad('Give the building a name');
  const person = async (v, what) => {
    if (v === null || v === undefined || v === '') return null;
    const u = await db.prepare('SELECT id FROM users WHERE id = ? AND NOT disabled').get(Number(v) || 0);
    if (!u) throw bad(`Pick ${what} from the people in Reem`);
    return u.id;
  };
  const adminId = await person(input.admin_id, 'the administrator');
  const renewalsId = await person(input.renewals_id, 'who handles renewals');

  const old = id ? await db.prepare('SELECT id FROM buildings WHERE id = ?').get(Number(id) || 0) : null;
  if (id && !old) return null;

  const wantSites = [...new Set((Array.isArray(input.sites) ? input.sites : []).map((s) => Number(s?.id ?? s)).filter(Boolean))];
  let sites = [];
  if (wantSites.length) {
    const known = new Map((await ask('operations', 'buildings')).buildings.map((s) => [s.id, s.name]));
    const unknown = wantSites.find((s) => !known.has(s));
    if (unknown) throw bad(`saifsys has no building with id ${unknown}.`);
    sites = wantSites.map((s) => ({ id: s, name: known.get(s) }));
  }

  const have = new Map(old
    ? (await db.prepare('SELECT employee_code, name FROM building_staff WHERE building_id = ?').all(old.id)).map((s) => [s.employee_code, s.name])
    : []);
  const staff = new Map();
  for (const s of Array.isArray(input.staff) ? input.staff : []) {
    const code = String(s?.code ?? '').trim().toUpperCase();
    if (!code) continue;
    if (!KINDS.includes(s.kind)) throw bad('Each person is either a cleaner or a technician');
    // Someone already in this building was checked when they were added.
    const hrName = have.get(code) ?? (await lookupCode(code, ask)).name;
    staff.set(code, { code, name: hrName, kind: s.kind });
  }

  const savedId = await tx(async () => {
    const bid = old
      ? (await db.prepare(`UPDATE buildings SET name = ?, admin_id = ?, renewals_id = ?, updated_at = ${NOW} WHERE id = ? RETURNING id`)
        .run(name, adminId, renewalsId, old.id)).id
      : (await db.prepare('INSERT INTO buildings (name, admin_id, renewals_id) VALUES (?, ?, ?) RETURNING id').run(name, adminId, renewalsId)).id;
    await db.prepare('DELETE FROM building_sites WHERE building_id = ?').run(bid);
    for (const s of sites) await db.prepare('INSERT INTO building_sites (building_id, site_id, name) VALUES (?, ?, ?)').run(bid, s.id, s.name);
    await db.prepare('DELETE FROM building_staff WHERE building_id = ?').run(bid);
    for (const s of staff.values()) {
      await db.prepare('INSERT INTO building_staff (building_id, employee_code, name, kind) VALUES (?, ?, ?, ?)').run(bid, s.code, s.name, s.kind);
    }
    return bid;
  });
  return visible(master, savedId);
}

export const deleteBuilding = async (id) =>
  (await db.prepare('DELETE FROM buildings WHERE id = ?').run(Number(id) || 0)).changes > 0;

/** For the editor: the saifsys buildings to tick, and the people who can be picked. */
export async function options(ask = askSaifsys) {
  const [sites, people] = await Promise.all([
    ask('operations', 'buildings').then((a) => a.buildings),
    db.prepare('SELECT id, name FROM users WHERE NOT disabled ORDER BY lower(name)').all(),
  ]);
  return { sites, people };
}

/** HR employees by part of a name or code, for adding a cleaner or technician. */
export async function searchStaff(q, ask = askSaifsys) {
  const want = line(q, 60);
  if (want.length < 2) return [];
  const answer = await ask('hr', 'employees', { q: want });
  return (answer.employees || []).filter((e) => e.code).slice(0, 20)
    .map((e) => ({ code: e.code, name: e.name, position: e.position, company: e.company }));
}

// ---------- the jobs ----------

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY = { total: 0, more: false, counts: { open: 0, in_progress: 0, done: 0, cancelled: 0, late: 0, needs_materials: 0 }, staff: [], jobs: [] };

/**
 * The staff jobs of one building for a day or a span of days (today when none is given).
 * With `late`, the unfinished ones from before are included too. null: not their building.
 */
export async function teamJobs(user, buildingId, { from, to, late = true, code, status, type } = {}, ask = askSaifsys) {
  const b = await visible(user, buildingId);
  if (!b) return null;
  const scope = scopeOf(b);
  if (!scope) return { ...EMPTY, building: b, unset: true };
  for (const d of [from, to]) if (d && !DAY.test(d)) throw bad('Dates look like 2026-10-03');
  const { ok, ...answer } = await ask('operations', 'jobs', { ...scope, from, to, late: late ? 1 : undefined, code, status, type });
  return { ...answer, building: b };
}

/** One job in full, if it is inside this building. */
export async function teamJob(user, buildingId, jobId, ask = askSaifsys) {
  const b = await visible(user, buildingId);
  const scope = b && scopeOf(b);
  if (!scope) return null;
  try {
    return (await ask('operations', 'job', { ...scope, id: Number(jobId) || 0 })).job;
  } catch (e) {
    if (e.status === 502 && /No such job/.test(e.message)) return null;
    throw e;
  }
}

// ---------- the watcher: a buzz when a job needs the administrator ----------

const EVERY = 3 * 60_000;
// Field staff work in the day. A job that goes late at midnight is news for the morning,
// not for 00:03, so outside these hours nothing is looked at and the morning's first look
// finds it all at once.
const FROM_HOUR = 7;
const TO_HOUR = 21;
// More than this for one building in one look is said as one line, not a row of buzzes.
const MAX_BUZZES = 4;

const where = (job) => job.places?.[0] || job.location || '';
const who = (job) => job.assignee?.name?.split(' ')[0] || 'Someone';
const REQUESTS = ['tenant_maintenance', 'tenant_cleaning', 'ars_checkout', 'tenant_move_out', 'customer_booking'];

/** What changed on one job since it was last seen. `prev` is undefined for a new job. */
export function changes(prev, job) {
  const was = prev || { status: 'open', late: false, needs_materials: false, problems: false, last_message_id: 0 };
  const out = [];
  const at = where(job);
  if (!prev && job.source === 'cleaner_report') out.push({ kind: 'problem', title: `Problem reported: ${job.title}`, body: at });
  else if (!prev && job.status === 'open' && REQUESTS.includes(job.source)) out.push({ kind: 'request', title: `New request: ${job.title}`, body: at });
  if (job.status === 'done' && was.status !== 'done') {
    out.push({ kind: 'done', title: `${who(job)} finished: ${job.title}`, body: [at, job.duration].filter(Boolean).join(' · ') });
  }
  if (job.late && !was.late) out.push({ kind: 'late', title: `Late: ${job.title}`, body: [at, job.late_note].filter(Boolean).join(' · ') });
  const asked = job.needs_materials && !was.needs_materials;
  if (asked) out.push({ kind: 'materials', title: `${who(job)} needs materials`, body: job.last_message?.text || [job.title, at].filter(Boolean).join(' · ') });
  // A problem that raised its own maintenance job buzzes as that job, above.
  if (job.problems && !was.problems && !job.problems.maintenance_job_id) {
    out.push({ kind: 'problem', title: `Problem reported: ${job.problems.found.join(', ')}`, body: [at, job.problems.note].filter(Boolean).join(' · ') });
  }
  const m = job.last_message;
  if (m && m.id > was.last_message_id && m.from_staff && !(asked && m.material_request)) {
    out.push({ kind: 'message', title: `${who(job)}: ${job.title}`, body: m.text || 'Sent a photo or voice note' });
  }
  return out;
}

/**
 * One look at every building that has an administrator. Returns the buzzes it sent.
 * The first look at a building only writes down what is there: nobody wants a buzz for
 * every job that was already late on the day the building was set up.
 */
export async function watchBuildings({ ask = askSaifsys, push = sendPush } = {}) {
  const all = await listBuildings({ role: 'master' });
  const sent = [];
  for (const b of all) {
    const scope = scopeOf(b);
    if (!b.admin || !scope) continue;
    let answer;
    try { answer = await ask('operations', 'jobs', { ...scope, late: 1 }); } catch (e) { console.warn('[buildings]', b.name, e.message); continue; }
    const { watched_at: watched } = await db.prepare('SELECT watched_at FROM buildings WHERE id = ?').get(b.id);
    const seen = new Map((await db.prepare('SELECT * FROM building_jobs_seen WHERE building_id = ?').all(b.id)).map((s) => [s.job_id, s]));
    const events = [];
    for (const job of answer.jobs) {
      if (watched) for (const e of changes(seen.get(job.id), job)) events.push({ ...e, job });
      await db.prepare(`INSERT INTO building_jobs_seen (building_id, job_id, status, late, needs_materials, problems, last_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (building_id, job_id) DO UPDATE SET status = EXCLUDED.status, late = EXCLUDED.late,
          needs_materials = EXCLUDED.needs_materials, problems = EXCLUDED.problems,
          last_message_id = EXCLUDED.last_message_id, seen_at = ${NOW}`)
        .run(b.id, job.id, job.status, !!job.late, !!job.needs_materials, !!job.problems, job.last_message?.id || 0);
    }
    if (!watched) await db.prepare(`UPDATE buildings SET watched_at = ${NOW} WHERE id = ?`).run(b.id);

    const notices = events.length > MAX_BUZZES
      ? [{ title: `${b.name}: ${events.length} updates`, body: events.slice(0, 3).map((e) => e.title).join(' · '), url: `/?building=${b.id}`, tag: `reem-building-${b.id}` }]
      : events.map((e) => ({ title: e.title, body: e.body || b.name, url: `/?building=${b.id}&job=${e.job.id}`, tag: `reem-job-${e.job.id}-${e.kind}` }));
    for (const n of notices) {
      sent.push({ to: b.admin.id, ...n });
      await Promise.resolve(push([b.admin.id], n)).catch((e) => console.warn('[buildings] push', e.message));
    }
  }
  return sent;
}

let timer = null;
let busy = false;

/** Does nothing until saifsys is connected and a building has an administrator. */
export function startBuildings() {
  if (timer) return;
  const tick = async () => {
    const hour = dubaiHour();
    if (busy || !saifsysConfigured() || hour < FROM_HOUR || hour >= TO_HOUR) return;
    busy = true;
    try { await watchBuildings(); } catch (e) { console.warn('[buildings]', e.message); } finally { busy = false; }
  };
  timer = setInterval(tick, EVERY);
  setTimeout(tick, 30_000);
}

// ---------- Reem in chat ----------

const DATE = { type: 'string', description: 'YYYY-MM-DD. Work it out from the current date given to you.' };
const DEFS = {
  building_teams: {
    name: 'building_teams',
    description: 'Who runs each building: its administrator, who handles its renewals, and the cleaners and technicians given to it. ' +
      'Use for "who is the admin of Ayla?", "who handles renewals at Ladies Camp?", "who cleans Park Place?", "which buildings does Jessa have?". ' +
      'Renewals are handled by the administrator unless someone else is named. Leave building empty for all of them.',
    input_schema: { type: 'object', properties: { building: { type: 'string', description: 'Optional. A building name, or part of it.' } } },
  },
  team_jobs: {
    name: 'team_jobs',
    description: 'The cleaning and maintenance jobs the field staff are doing on the staff app, for the buildings this user looks after. ' +
      'Each job has its title, place, who it is assigned to, date and time, status (Not started, In progress, Paused, Completed), ' +
      'whether it is late and by how much, whether materials were asked for, any problem the cleaner reported, the photo counts and the last message. ' +
      'Use for "what did Karina do today?", "which jobs are late?", "is unit 304 cleaned?", "how is my team doing?", "what was done at Ayla this week?". ' +
      'With no dates it is today plus anything unfinished from before. At most 31 days at a time. ' +
      'View only: you cannot assign, change or message a job yet - say so if asked.',
    input_schema: {
      type: 'object',
      properties: {
        building: { type: 'string', description: 'Optional. A building name, or part of it. Empty = every building the user has.' },
        person: { type: 'string', description: 'Optional. A cleaner\'s or technician\'s name: only their jobs.' },
        from: DATE,
        to: DATE,
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'], description: 'Optional. open = not started.' },
        type: { type: 'string', enum: ['cleaning', 'maintenance'] },
      },
    },
  },
  team_job: {
    name: 'team_job',
    description: 'One staff job in full, by the id from team_jobs: description, places, how many before and after photos, ' +
      'the checklist as the cleaner answered it, problems reported, completion notes and every message in its thread.',
    input_schema: { type: 'object', properties: { id: { type: 'integer', description: 'The job id from team_jobs.' } }, required: ['id'] },
  },
};
const STATUS = { building_teams: 'Checking the buildings…', team_jobs: 'Looking at the team\'s jobs…', team_job: 'Opening the job…' };

const has = (text, part) => String(text).toLowerCase().includes(String(part ?? '').trim().toLowerCase());

/** Everyone may ask who runs what; it is the company's structure, not a secret. */
async function directory(input) {
  const all = (await listBuildings({ role: 'master' })).filter((b) => !input.building || has(b.name, input.building));
  if (!all.length) return input.building ? `No building matches "${input.building}".` : 'No buildings have been set up yet.';
  return all.map((b) => {
    const names = (kind) => b.staff.filter((s) => s.kind === kind).map((s) => `${s.name} [HR ${s.code}]`).join(', ') || 'none yet';
    return `${b.name}\n  Administrator: ${b.admin?.name || 'not set'}\n  Renewals: ${(b.renewals || b.admin)?.name || 'not set'}` +
      `\n  Cleaners: ${names('cleaner')}\n  Technicians: ${names('technician')}`;
  }).join('\n\n');
}

async function jobsForChat(user, input, ask) {
  const mine = (await listBuildings(user)).filter((b) => !input.building || has(b.name, input.building));
  if (!mine.length) return input.building ? `No building of yours matches "${input.building}".` : 'This user has no buildings.';
  const out = [];
  for (const b of mine) {
    let code;
    if (input.person) {
      const match = b.staff.filter((s) => has(s.name, input.person));
      if (!match.length) continue;
      if (match.length > 1) return `Several people match "${input.person}" in ${b.name}: ${match.map((s) => s.name).join(', ')}. Ask which one.`;
      code = match[0].code;
    }
    const a = await teamJobs(user, b.id, { from: input.from, to: input.to, late: !input.from, code, status: input.status, type: input.type }, ask);
    out.push({
      building: b.name, from: a.from, to: a.to, total: a.total, more: a.more || undefined, counts: a.counts,
      jobs: a.jobs.map(({ building_ids, created_at, source, status, paused, ...j }) => j),
    });
  }
  if (!out.length) return `Nobody called "${input.person}" is in these buildings.`;
  return JSON.stringify(out);
}

async function jobForChat(user, input, ask) {
  for (const b of await listBuildings(user)) {
    const job = await teamJob(user, b.id, input.id, ask);
    if (job) {
      const { photo_list: photos, building_ids, created_at, ...rest } = job;
      return JSON.stringify({ building: b.name, ...rest });
    }
  }
  return `There is no job ${input.id} in this user's buildings.`;
}

/**
 * The buildings tools, same shape as todoKit() so chat.js routes calls by name.
 * Everyone gets the directory; the jobs only go to the master and to administrators.
 */
export async function buildingKit(user, ask = askSaifsys) {
  const seesJobs = saifsysConfigured() && (await listBuildings(user)).length > 0;
  const handlers = {
    building_teams: (input) => directory(input),
    ...(seesJobs && {
      team_jobs: (input) => jobsForChat(user, input, ask),
      team_job: (input) => jobForChat(user, input, ask),
    }),
  };
  return {
    definitions: Object.keys(handlers).map((n) => DEFS[n]),
    status: (name) => STATUS[name] || null,
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

// ---------- routes ----------

export const buildingRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));

buildingRoutes.get('/', wrap(async (req, res) => res.json(await listBuildings(req.user))));
buildingRoutes.get('/options', requireMaster, wrap(async (req, res) => res.json(await options())));
buildingRoutes.get('/staff-search', requireMaster, wrap(async (req, res) => res.json(await searchStaff(req.query.q))));
buildingRoutes.post('/', requireMaster, wrap(async (req, res) => res.json(await saveBuilding(req.user, null, req.body || {}))));
buildingRoutes.put('/:id', requireMaster, wrap(async (req, res) => send(res, await saveBuilding(req.user, req.params.id, req.body || {}))));
buildingRoutes.delete('/:id', requireMaster, wrap(async (req, res) => send(res, (await deleteBuilding(req.params.id)) && { ok: true })));

buildingRoutes.get('/:id/jobs', wrap(async (req, res) => {
  const { from, to } = req.query;
  send(res, await teamJobs(req.user, req.params.id, { from: from ? String(from) : undefined, to: to ? String(to) : undefined, late: !from }));
}));
buildingRoutes.get('/:id/jobs/:job', wrap(async (req, res) => send(res, await teamJob(req.user, req.params.id, req.params.job))));

// A job's photo or video ('photo') or a message's attachment ('media'), passed straight
// through from saifsys, which checks again that the file belongs to this building.
const file = (what) => wrap(async (req, res) => {
  const b = await visible(req.user, req.params.id);
  const scope = b && scopeOf(b);
  if (!scope) return res.status(404).json({ error: 'Not found' });
  const got = await fileFromSaifsys('operations', what, { ...scope, id: Number(req.params.file) || 0 }, req.headers.range);
  res.status(got.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    if (got.headers.get(h)) res.setHeader(h, got.headers.get(h));
  }
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  Readable.fromWeb(got.body).on('error', () => res.destroy()).pipe(res);
});
buildingRoutes.get('/:id/photo/:file', file('photo'));
buildingRoutes.get('/:id/media/:file', file('media'));
