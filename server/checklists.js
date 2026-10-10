import { Router } from 'express';
import { db, tx } from './db.js';
import { ask } from './ai.js';
import { requireMaster } from './auth.js';

// Checklists: the fixed points of one job, ticked off each time the job is done.
// Deliberately not todos and not routines - a todo is one thing done once, a routine is
// one thing that comes back, and a checklist is several steps that belong together.
//
// A person writes a title and a description, Reem decides the points (draftItems), and
// they change whatever they like before saving. Each person makes their own.
//
// Two kinds:
//   daily    - the same points come back empty every morning; one go per day.
//   ondemand - started whenever the job comes up ("Unit 304 move-out"), as often as needed.
//
// Every go is a run, and a run keeps its own copy of the points. So changing the
// checklist later never rewrites what was ticked last week, and the master - who can see
// everyone's progress but never tick for them - reads the history as it happened.

const MAX_TITLE = 120;
const MAX_DESC = 2000;
const MAX_ITEM = 300;
const MAX_ITEMS = 40;
const RUNS_SHOWN = 30;
export const KINDS = ['daily', 'ondemand'];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const secs = () => Math.floor(Date.now() / 1000);

// Asia/Dubai, no daylight saving: "today" is the user's day, not the server's (UTC).
const OFFSET = 4 * 3600;
export const dayOf = (at) => new Date((at + OFFSET) * 1000).toISOString().slice(0, 10);

function cleanItems(items) {
  const out = (Array.isArray(items) ? items : [])
    .map((i) => (typeof i === 'string' ? { text: i } : i || {}))
    .map((i) => ({ id: Number(i.id) || null, text: line(i.text, MAX_ITEM) }))
    .filter((i) => i.text)
    .slice(0, MAX_ITEMS);
  if (!out.length) throw bad('Add at least one point');
  return out;
}

function clean({ title, description, kind }) {
  const out = { title: line(title, MAX_TITLE), description: String(description ?? '').trim().slice(0, MAX_DESC), kind };
  if (!out.title) throw bad('Give it a title');
  if (!KINDS.includes(out.kind)) throw bad('A checklist is either daily or started when needed');
  return out;
}

// ---------- Reem decides the points ----------

/** Title + description → the points, as many as the job needs. `asker` is swapped in tests. */
export async function draftItems({ title, description }, asker = ask) {
  const t = line(title, MAX_TITLE);
  const d = String(description ?? '').trim().slice(0, MAX_DESC);
  if (!t) throw bad('Give it a title first');
  const out = await asker(`Title: ${t}\nDescription: ${d || '(none - work it out from the title)'}`, {
    maxTokens: 1500,
    system: `You turn a job into a checklist for someone in a small office in the UAE.
List the points they tick off, in the order they are done. You decide how many: as few as cover the job properly,
usually 3 to 12 and never more than 25. Each point is one action, starts with a verb, and is at most 12 words.
Only what the title and description call for - no filler such as "review the checklist". Write in the language they wrote in.
Reply with ONLY JSON: {"items": ["<point>", "<point>"]}`,
  });
  try {
    return cleanItems(JSON.parse(out.match(/\{[\s\S]*\}/)[0]).items).map((i) => i.text);
  } catch {
    throw bad('Reem could not make the points this time. Try again, or add them yourself.', 502);
  }
}

// ---------- reading ----------

const RUN_COLS = 'r.id, r.checklist_id, r.user_id, r.label, r.day, r.started_at, r.finished_at';
const RUN_ITEMS = 'SELECT id, run_id, item_id, text, done_at FROM checklist_run_items';

/** One go with its points. The person it belongs to, or the master, may read it. */
export async function getRun(user, id) {
  const run = await db.prepare(`SELECT ${RUN_COLS}, c.title, c.kind FROM checklist_runs r
    JOIN checklists c ON c.id = r.checklist_id WHERE r.id = ?`).get(Number(id) || 0);
  if (!run || (run.user_id !== user.id && user.role !== 'master')) return null;
  const items = await db.prepare(`${RUN_ITEMS} WHERE run_id = ? ORDER BY position, id`).all(run.id);
  return { ...run, items, done: items.filter((i) => i.done_at).length, total: items.length };
}

/**
 * Everything one person has, each checklist carrying what the screen needs:
 *   items - the points as they stand now
 *   today - (daily) today's go; id is null until the first tick of the day
 *   week  - (daily) the last seven days, oldest first, for the row of dots
 *   runs  - the most recent goes, newest first
 */
export async function listChecklists(userId, now = secs()) {
  const lists = await db.prepare('SELECT id, title, description, kind, created_at, updated_at FROM checklists WHERE user_id = ? ORDER BY id')
    .all(userId);
  if (!lists.length) return [];
  const ids = lists.map((c) => c.id);
  const items = await db.prepare('SELECT id, checklist_id, text FROM checklist_items WHERE checklist_id = ANY(?::int[]) ORDER BY position, id').all(ids);
  const runs = await db.prepare(`SELECT ${RUN_COLS}, count(i.id)::int AS total, count(i.done_at)::int AS done
    FROM checklist_runs r LEFT JOIN checklist_run_items i ON i.run_id = r.id
    WHERE r.checklist_id = ANY(?::int[]) GROUP BY r.id ORDER BY r.id DESC`).all(ids);
  const today = dayOf(now);
  const todays = runs.filter((r) => r.day === today).map((r) => r.id);
  const ticked = todays.length ? await db.prepare(`${RUN_ITEMS} WHERE run_id = ANY(?::int[]) ORDER BY position, id`).all(todays) : [];

  return lists.map((c) => {
    const mine = items.filter((i) => i.checklist_id === c.id).map(({ id, text }) => ({ id, text }));
    const goes = runs.filter((r) => r.checklist_id === c.id).map(({ checklist_id, user_id, ...r }) => r);
    const out = { ...c, items: mine, runs: goes.slice(0, RUNS_SHOWN), today: null, week: null };
    if (c.kind !== 'daily') return out;
    const run = goes.find((r) => r.day === today);
    const points = run
      ? ticked.filter((i) => i.run_id === run.id).map(({ run_id, ...i }) => i)
      : mine.map((i) => ({ id: null, item_id: i.id, text: i.text, done_at: null }));
    out.today = { id: run?.id ?? null, done: points.filter((i) => i.done_at).length, total: points.length, items: points };
    out.week = [6, 5, 4, 3, 2, 1, 0].map((back) => {
      const day = dayOf(now - back * 86400);
      const r = goes.find((g) => g.day === day);
      return { day, run_id: r?.id ?? null, done: r?.done ?? 0, total: r?.total ?? 0 };
    });
    return out;
  });
}

/** The master's view: everyone else who has a checklist, with the same detail they see. */
export async function teamChecklists(master, now = secs()) {
  const people = await db.prepare(`SELECT u.id, u.name FROM users u
    WHERE NOT u.disabled AND u.id <> ? AND EXISTS (SELECT 1 FROM checklists c WHERE c.user_id = u.id)
    ORDER BY lower(u.name)`).all(master.id);
  return Promise.all(people.map(async (p) => ({ ...p, checklists: await listChecklists(p.id, now) })));
}

const one = async (userId, id, now) => (await listChecklists(userId, now)).find((c) => c.id === Number(id)) || null;
const owned = (userId, id) => db.prepare('SELECT * FROM checklists WHERE id = ? AND user_id = ?').get(Number(id) || 0, userId);

// ---------- writing ----------

export async function createChecklist(userId, input) {
  const c = clean(input);
  const items = cleanItems(input.items);
  const id = await tx(async () => {
    const row = await db.prepare('INSERT INTO checklists (user_id, title, description, kind) VALUES (?, ?, ?, ?) RETURNING id')
      .run(userId, c.title, c.description, c.kind);
    for (const [n, i] of items.entries()) {
      await db.prepare('INSERT INTO checklist_items (checklist_id, position, text) VALUES (?, ?, ?)').run(row.id, n, i.text);
    }
    return row.id;
  });
  return one(userId, id);
}

// A run is finished the moment its last point is ticked, and not finished again the
// moment one is unticked. Worked out from the points every time, never set by hand.
const settle = (runId, now) => db.prepare(`UPDATE checklist_runs SET finished_at = CASE
    WHEN EXISTS (SELECT 1 FROM checklist_run_items WHERE run_id = ?)
     AND NOT EXISTS (SELECT 1 FROM checklist_run_items WHERE run_id = ? AND done_at IS NULL)
    THEN COALESCE(finished_at, ?::bigint) ELSE NULL END WHERE id = ?`).run(runId, runId, now, runId);

export async function updateChecklist(userId, id, input, now = secs()) {
  const old = await owned(userId, id);
  if (!old) return null;
  const c = clean({ title: input.title ?? old.title, description: input.description ?? old.description, kind: input.kind ?? old.kind });
  const items = 'items' in input ? cleanItems(input.items) : null;
  await tx(async () => {
    await db.prepare('UPDATE checklists SET title = ?, description = ?, kind = ?, updated_at = ? WHERE id = ?')
      .run(c.title, c.description, c.kind, now, old.id);
    if (!items) return;
    const have = (await db.prepare('SELECT id FROM checklist_items WHERE checklist_id = ?').all(old.id)).map((r) => r.id);
    const keep = items.filter((i) => have.includes(i.id)).map((i) => i.id);
    await db.prepare('DELETE FROM checklist_items WHERE checklist_id = ? AND NOT (id = ANY(?::int[]))').run(old.id, keep);
    for (const [n, i] of items.entries()) {
      if (keep.includes(i.id)) await db.prepare('UPDATE checklist_items SET position = ?, text = ? WHERE id = ?').run(n, i.text, i.id);
      else await db.prepare('INSERT INTO checklist_items (checklist_id, position, text) VALUES (?, ?, ?)').run(old.id, n, i.text);
    }
    // Today's go of a daily checklist follows the change, keeping the ticks already made.
    // Earlier days, and goes of a when-needed checklist, stay as they were started.
    const run = await db.prepare('SELECT id FROM checklist_runs WHERE checklist_id = ? AND day = ?').get(old.id, dayOf(now));
    if (!run) return;
    await db.prepare('DELETE FROM checklist_run_items WHERE run_id = ? AND item_id IS NULL').run(run.id);
    await db.prepare(`UPDATE checklist_run_items ri SET position = i.position, text = i.text
      FROM checklist_items i WHERE ri.run_id = ? AND i.id = ri.item_id`).run(run.id);
    await db.prepare(`INSERT INTO checklist_run_items (run_id, item_id, position, text)
      SELECT ?, i.id, i.position, i.text FROM checklist_items i WHERE i.checklist_id = ?
        AND NOT EXISTS (SELECT 1 FROM checklist_run_items ri WHERE ri.run_id = ? AND ri.item_id = i.id)`).run(run.id, old.id, run.id);
    await settle(run.id, now);
  });
  return one(userId, old.id, now);
}

export const deleteChecklist = async (userId, id) =>
  (await db.prepare('DELETE FROM checklists WHERE id = ? AND user_id = ?').run(Number(id) || 0, userId)).changes > 0;

/**
 * Start a go. A daily checklist has one per day, so starting it twice gives the same
 * one back; a when-needed checklist gets a new one every time, named by `label`.
 */
export async function startRun(user, id, { label } = {}, now = secs()) {
  const c = await owned(user.id, id);
  if (!c) return null;
  const day = c.kind === 'daily' ? dayOf(now) : null;
  const runId = await tx(async () => {
    const made = await db.prepare(`INSERT INTO checklist_runs (checklist_id, user_id, label, day, started_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (checklist_id, day) DO NOTHING RETURNING id`).run(c.id, user.id, day ? null : line(label, MAX_TITLE) || null, day, now);
    if (!made.id) return (await db.prepare('SELECT id FROM checklist_runs WHERE checklist_id = ? AND day = ?').get(c.id, day)).id;
    await db.prepare(`INSERT INTO checklist_run_items (run_id, item_id, position, text)
      SELECT ?, id, position, text FROM checklist_items WHERE checklist_id = ? ORDER BY position, id`).run(made.id, c.id);
    return made.id;
  });
  return getRun(user, runId);
}

/** Tick or untick one point. Only the person whose go it is - the master looks, never ticks. */
export async function tick(user, runId, itemId, done, now = secs()) {
  const run = await db.prepare('SELECT id, day FROM checklist_runs WHERE id = ? AND user_id = ?').get(Number(runId) || 0, user.id);
  if (!run) return null;
  // A day that has passed is a record of that day; changing it later would make it a wish.
  if (run.day && run.day !== dayOf(now)) throw bad('That day has passed and can no longer be changed.', 409);
  const { changes } = await db.prepare('UPDATE checklist_run_items SET done_at = ? WHERE id = ? AND run_id = ?')
    .run(done ? now : null, Number(itemId) || 0, run.id);
  if (!changes) return null;
  await settle(run.id, now);
  return getRun(user, run.id);
}

export const deleteRun = async (userId, id) =>
  (await db.prepare('DELETE FROM checklist_runs WHERE id = ? AND user_id = ?').run(Number(id) || 0, userId)).changes > 0;

// ---------- routes ----------

export const checklistRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));

checklistRoutes.get('/', wrap(async (req, res) => res.json(await listChecklists(req.user.id))));
checklistRoutes.post('/', wrap(async (req, res) => res.json(await createChecklist(req.user.id, req.body || {}))));
checklistRoutes.post('/draft', wrap(async (req, res) => res.json({ items: await draftItems(req.body || {}) })));
// Everyone's progress, for the master. Before '/:id', so "team" is never read as an id.
checklistRoutes.get('/team', requireMaster, wrap(async (req, res) => res.json(await teamChecklists(req.user))));

checklistRoutes.get('/runs/:id', wrap(async (req, res) => send(res, await getRun(req.user, req.params.id))));
checklistRoutes.post('/runs/:id/items/:item', wrap(async (req, res) =>
  send(res, await tick(req.user, req.params.id, req.params.item, req.body?.done !== false))));
checklistRoutes.delete('/runs/:id', wrap(async (req, res) => send(res, (await deleteRun(req.user.id, req.params.id)) && { ok: true })));

checklistRoutes.put('/:id', wrap(async (req, res) => send(res, await updateChecklist(req.user.id, req.params.id, req.body || {}))));
checklistRoutes.delete('/:id', wrap(async (req, res) => send(res, (await deleteChecklist(req.user.id, req.params.id)) && { ok: true })));
checklistRoutes.post('/:id/start', wrap(async (req, res) => send(res, await startRun(req.user, req.params.id, req.body || {}))));
