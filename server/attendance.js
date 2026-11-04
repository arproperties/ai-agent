import { Router } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { db, tx } from './db.js';
import { UPLOADS, STATUSES, importDir, kick, nameKey } from './attendanceRead.js';

// Attendance, the checking half: each pay period (26th to 25th), every person who was on a
// list, one by one. To verify / Verified / Skipped, and the report.
//
// "Complete" is the rule the office used by hand on the first period: a person is complete
// when they are on a list every day of the period, except single days on their own (the
// weekly day off). Two or more days in a row on no list means someone has to look. How many
// days were present, absences, or moving company do not matter to it.
//
// Several lists can say the same day (two companies, a typed list and a photo of it): the
// day shows the best of them (present over absent over off), and a change made here by hand
// wins over everything read. The reading is server/attendanceRead.js.

export const PERIOD_START_DAY = 26;
export const CODES = { present: 'P', late: 'L', absent: 'A', vacation: 'V', off: 'O', sick: 'S', other: '?' };
const RANK = { present: 0, late: 1, sick: 2, absent: 3, vacation: 4, off: 5, other: 6 };
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- pay periods ----------

const ymd = (d) => d.toISOString().slice(0, 10);
const utc = (s) => new Date(`${s}T00:00:00Z`);
export const addDays = (s, n) => ymd(new Date(utc(s).getTime() + n * 86400000));

/** The pay period a day falls in: { start: 'YYYY-MM-26', end: next month's 25th }. */
export function periodOf(day) {
  const d = utc(day);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDate() < PERIOD_START_DAY) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const start = ymd(new Date(Date.UTC(y, m, PERIOD_START_DAY)));
  const end = ymd(new Date(Date.UTC(y, m + 1, PERIOD_START_DAY - 1)));
  return { start, end };
}

export function daysOf(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------- one period ----------

/** Several entries of one day -> what the day says. A change made by hand wins. */
export function mergeDay(entries) {
  const manual = entries.filter((e) => e.source === 'manual');
  const use = manual.length ? manual.slice(-1) : entries;
  const status = use.map((e) => e.status).sort((a, b) => RANK[a] - RANK[b])[0];
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  return {
    status,
    hours: uniq(use.map((e) => e.hours)).join(' / '),
    note: uniq(use.map((e) => e.note)).join(' / '),
    companies: uniq(use.map((e) => e.company)),
    posted_by: uniq(use.map((e) => e.posted_by)),
    manual: manual.length > 0,
  };
}

/**
 * Completeness by the office's rule, over the days the lists cover so far (a period still
 * running is judged up to the last day anything was read for).
 */
export function judge(days, listed) {
  const gaps = [];
  let run = null;
  for (const d of days) {
    if (listed.has(d)) { if (run) { gaps.push(run); run = null; } continue; }
    run = run ? { ...run, to: d, n: run.n + 1 } : { from: d, to: d, n: 1 };
  }
  if (run) gaps.push(run);
  const long = gaps.filter((g) => g.n >= 2);
  return { complete: long.length === 0, longest: Math.max(0, ...gaps.map((g) => g.n)), gaps: long };
}

const short = (d) => utc(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const span = (g) => (g.from === g.to ? short(g.from) : `${short(g.from)} – ${short(g.to)}`);

/** Everyone on a list in the period, with each day, whether they are complete, and why not. */
export async function getPeriod(start) {
  if (!DATE.test(start)) throw bad('Not a period');
  const { end } = periodOf(start);
  const latest = (await db.prepare('SELECT max(work_date) AS d FROM attendance_entries WHERE work_date <= ?').get(end))?.d;
  const coverEnd = latest && latest < end ? latest : end;
  const days = daysOf(start, end);
  const covered = days.filter((d) => d <= coverEnd);
  const entries = await db.prepare(`SELECT e.person_id, e.work_date, e.company, e.status, e.hours, e.note, e.posted_by, e.source
    FROM attendance_entries e WHERE e.work_date BETWEEN ? AND ? ORDER BY e.id`).all(start, end);
  const ids = [...new Set(entries.map((e) => e.person_id))];
  const people = ids.length ? await db.prepare('SELECT id, name FROM attendance_people WHERE id = ANY(?::int[])').all(ids) : [];
  const reviews = new Map((await db.prepare(`SELECT r.person_id, r.state, r.note, r.at, u.name AS by_name FROM attendance_reviews r
    LEFT JOIN users u ON u.id = r.by_user WHERE r.period = ?`).all(start)).map((r) => [r.person_id, r]));

  const byPerson = new Map();
  for (const e of entries) {
    const p = byPerson.get(e.person_id) || byPerson.set(e.person_id, new Map()).get(e.person_id);
    (p.get(e.work_date) || p.set(e.work_date, []).get(e.work_date)).push(e);
  }
  const out = people.map((p) => {
    const mine = byPerson.get(p.id);
    const merged = new Map([...mine].map(([d, es]) => [d, mergeDay(es)]));
    const { complete, longest, gaps } = judge(covered, new Set(merged.keys()));
    const counts = Object.fromEntries(Object.keys(CODES).map((k) => [k, 0]));
    for (const v of merged.values()) counts[v.status]++;
    const companies = [...new Set([...merged.values()].flatMap((v) => v.companies))];
    const reasons = gaps.map((g) => `Not on any list ${span(g)} (${g.n} days)`);
    const both = [...merged].filter(([, v]) => v.companies.length > 1).map(([d]) => short(d));
    if (both.length) reasons.push(`On two companies' lists: ${both.slice(0, 4).join(', ')}${both.length > 4 ? '…' : ''}`);
    const r = reviews.get(p.id);
    return {
      id: p.id, name: p.name, companies, complete, longest, reasons,
      state: r?.state || 'to_verify', review: r ? { note: r.note, at: r.at, by: r.by_name } : null,
      counts: { ...counts, missing: covered.length - merged.size },
      days: days.map((d) => {
        const v = merged.get(d);
        return v ? { d, s: CODES[v.status], h: v.hours, c: v.companies.join(' / '), m: v.manual || undefined } : { d, s: d <= coverEnd ? '' : null };
      }),
    };
  });
  // Complete ones first (a tap each), then those that need a look; by name within.
  out.sort((a, b) => (b.complete - a.complete) || a.name.localeCompare(b.name));
  return { start, end, coverEnd, days, people: out };
}

/** Periods that have anything in them, newest first, with how far the checking has got. */
export async function listPeriods() {
  const rows = await db.prepare(`SELECT DISTINCT work_date FROM attendance_entries`).all();
  const starts = [...new Set(rows.map((r) => periodOf(r.work_date).start))].sort().reverse();
  return Promise.all(starts.map(async (start) => {
    const { end } = periodOf(start);
    const c = await db.prepare(`SELECT count(DISTINCT e.person_id)::int AS people,
        count(DISTINCT e.person_id) FILTER (WHERE r.state = 'verified')::int AS verified,
        count(DISTINCT e.person_id) FILTER (WHERE r.state = 'skipped')::int AS skipped
      FROM attendance_entries e LEFT JOIN attendance_reviews r ON r.person_id = e.person_id AND r.period = ?
      WHERE e.work_date BETWEEN ? AND ?`).get(start, start, end);
    return { start, end, ...c };
  }));
}

/** One person's day as it was read: every list that said it, with the words or photo it came from. */
export async function getDay(personId, day) {
  const person = await db.prepare('SELECT id, name FROM attendance_people WHERE id = ?').get(Number(personId) || 0);
  if (!person || !DATE.test(day)) return null;
  const entries = await db.prepare(`SELECT e.id, e.company, e.section, e.written_name, e.status, e.hours, e.note, e.posted_by,
      e.source, e.source_day, e.source_time, e.photo, e.created_at, u.name AS edited_by
    FROM attendance_entries e LEFT JOIN users u ON u.id = e.edited_by WHERE e.person_id = ? AND e.work_date = ? ORDER BY e.id`).all(person.id, day);
  for (const e of entries) {
    if (e.source !== 'chat' || !e.source_time) continue;
    const d = await db.prepare('SELECT messages FROM attendance_chat_days WHERE day = ?').get(day);
    const msg = (d?.messages || []).find((m) => m.time === e.source_time && m.who === e.posted_by && m.day === (e.source_day || day))
      || (d?.messages || []).find((m) => m.who === e.posted_by && nameKey(m.text).includes(nameKey(e.written_name)));
    e.message = msg ? { day: msg.day, time: msg.time, who: msg.who, text: msg.text.slice(0, 4000) } : null;
  }
  // Team photos sent that day by the people who post this person's lists: a headcount, no names.
  const posters = [...new Set(entries.map((e) => e.posted_by).filter(Boolean))];
  const photos = posters.length ? await db.prepare(`SELECT name, sent, posted_by, headcount, stamp_time, place FROM attendance_photos
    WHERE work_date = ? AND kind = 'team_photo' AND posted_by = ANY(?::text[]) ORDER BY sent`).all(day, posters) : [];
  return { person, day, entries, merged: entries.length ? mergeDay(entries) : null, photos };
}

// ---------- changes ----------

/** Set a day by hand (it wins over every list), or status '' to take the change back. */
export async function setDay(user, personId, day, { status, hours = '', note = '' }) {
  const person = await db.prepare('SELECT id FROM attendance_people WHERE id = ? AND merged_into IS NULL').get(Number(personId) || 0);
  if (!person || !DATE.test(day)) return null;
  if (status && !STATUSES.includes(status)) throw bad('Not a status');
  await tx(async () => {
    await db.prepare(`DELETE FROM attendance_entries WHERE person_id = ? AND work_date = ? AND source = 'manual'`).run(person.id, day);
    if (!status) return;
    const last = await db.prepare(`SELECT company, section FROM attendance_entries WHERE person_id = ? AND work_date <= ?
      ORDER BY work_date DESC, id DESC LIMIT 1`).get(person.id, day)
      || await db.prepare('SELECT company, section FROM attendance_entries WHERE person_id = ? ORDER BY work_date, id LIMIT 1').get(person.id);
    await db.prepare(`INSERT INTO attendance_entries (person_id, work_date, company, section, written_name, status, hours, note, posted_by, source, edited_by)
      SELECT ?, ?, ?, ?, name, ?, ?, ?, ?, 'manual', ? FROM attendance_people WHERE id = ?`)
      .run(person.id, day, last?.company || '', last?.section || '', status, String(hours).slice(0, 80), String(note).slice(0, 300), user.name || '', user.id, person.id);
  });
  return getDay(person.id, day);
}

export async function setReview(user, personId, period, state, note = '') {
  if (!DATE.test(period) || periodOf(period).start !== period) throw bad('Not a period');
  const id = Number(personId) || 0;
  if (state === 'to_verify') {
    await db.prepare('DELETE FROM attendance_reviews WHERE person_id = ? AND period = ?').run(id, period);
    return { ok: true };
  }
  if (!['verified', 'skipped'].includes(state)) throw bad('Verified or skipped');
  const p = await db.prepare('SELECT id FROM attendance_people WHERE id = ? AND merged_into IS NULL').get(id);
  if (!p) return null;
  await db.prepare(`INSERT INTO attendance_reviews (person_id, period, state, note, by_user, at) VALUES (?, ?, ?, ?, ?, extract(epoch from now())::bigint)
    ON CONFLICT (person_id, period) DO UPDATE SET state = EXCLUDED.state, note = EXCLUDED.note, by_user = EXCLUDED.by_user, at = EXCLUDED.at`)
    .run(id, period, state, String(note).slice(0, 300), user.id);
  return { ok: true };
}

/**
 * Two people who are one: everything of `from` moves to `into`, and how `from` was written
 * is remembered as `into`, so next month's lists land on one person. A review of either is
 * taken back for the periods both were in, since the days being checked have changed.
 */
export async function mergePeople(fromId, intoId) {
  const from = Number(fromId) || 0, into = Number(intoId) || 0;
  if (from === into) throw bad('That is the same person');
  const both = await db.prepare('SELECT id FROM attendance_people WHERE id = ANY(?::int[]) AND merged_into IS NULL').all([from, into]);
  if (both.length !== 2) return null;
  await tx(async () => {
    const periods = (await db.prepare('SELECT DISTINCT work_date FROM attendance_entries WHERE person_id = ?').all(from)).map((r) => periodOf(r.work_date).start);
    await db.prepare('UPDATE attendance_entries SET person_id = ? WHERE person_id = ?').run(into, from);
    await db.prepare('UPDATE attendance_names SET person_id = ? WHERE person_id = ?').run(into, from);
    await db.prepare('DELETE FROM attendance_reviews WHERE person_id = ?').run(from);
    if (periods.length) await db.prepare('DELETE FROM attendance_reviews WHERE person_id = ? AND period = ANY(?::text[])').run(into, [...new Set(periods)]);
    await db.prepare('UPDATE attendance_people SET merged_into = ? WHERE id = ?').run(into, from);
  });
  return { ok: true, into };
}

export async function renamePerson(personId, name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!n) throw bad('Give a name');
  const { changes } = await db.prepare('UPDATE attendance_people SET name = ? WHERE id = ? AND merged_into IS NULL').run(n, Number(personId) || 0);
  return changes ? { ok: true } : null;
}

/**
 * The opposite of a merge: one company's days of a person were someone else with the same
 * name (two Franciscas). They become a new person, and that company's spellings go with them.
 */
export async function splitPerson(personId, company) {
  const id = Number(personId) || 0;
  const co = String(company || '');
  const p = await db.prepare('SELECT id, name FROM attendance_people WHERE id = ? AND merged_into IS NULL').get(id);
  if (!p) return null;
  const companies = (await db.prepare('SELECT DISTINCT company FROM attendance_entries WHERE person_id = ?').all(id)).map((r) => r.company);
  if (!companies.includes(co) || companies.length < 2) throw bad("Only a person on more than one company's lists can be split");
  return tx(async () => {
    const made = await db.prepare('INSERT INTO attendance_people (name) VALUES (?) RETURNING id').run(`${p.name} (${co})`);
    await db.prepare('UPDATE attendance_entries SET person_id = ? WHERE person_id = ? AND company = ?').run(made.id, id, co);
    await db.prepare('UPDATE attendance_names SET person_id = ? WHERE person_id = ? AND company = ?').run(made.id, id, co);
    await db.prepare('DELETE FROM attendance_reviews WHERE person_id = ?').run(id);
    return { ok: true, id: made.id };
  });
}

/** Every list Reem has sorted: who posts it, the label it gives, and the company it went to. */
export const listTeams = () => db.prepare(`SELECT t.poster, t.team, t.company, t.section,
    (SELECT count(*)::int FROM attendance_entries e WHERE e.posted_by = t.poster AND e.team = t.team) AS rows
  FROM attendance_teams t ORDER BY t.company, t.poster, t.team`).all();

/**
 * Put a list under another company. Its days move with it; the people on it keep their
 * spellings under the new company too, so next month's lists still land on them.
 */
export async function setTeam({ poster, team, company, section = '' }) {
  const co = String(company || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const sec = String(section || '').trim().slice(0, 80);
  if (!co) throw bad('Give the company');
  const old = await db.prepare('SELECT company FROM attendance_teams WHERE poster = ? AND team = ?').get(String(poster ?? ''), String(team ?? ''));
  if (!old) return null;
  await tx(async () => {
    await db.prepare('UPDATE attendance_teams SET company = ?, section = ? WHERE poster = ? AND team = ?').run(co, sec, poster, team);
    const written = await db.prepare(`SELECT DISTINCT written_name, person_id FROM attendance_entries WHERE posted_by = ? AND team = ? AND source <> 'manual'`).all(poster, team);
    for (const w of written) {
      await db.prepare('INSERT INTO attendance_names (company, written, person_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(co, nameKey(w.written_name), w.person_id);
    }
    await db.prepare('UPDATE attendance_entries SET company = ?, section = ? WHERE posted_by = ? AND team = ?').run(co, sec, poster, team);
  });
  return listTeams();
}

/** Everyone, for "Same person as…": with the companies and days they were last seen. */
export async function listPeople() {
  return db.prepare(`SELECT p.id, p.name, string_agg(DISTINCT e.company, ', ') AS companies, max(e.work_date) AS last
    FROM attendance_people p JOIN attendance_entries e ON e.person_id = p.id
    WHERE p.merged_into IS NULL GROUP BY p.id ORDER BY lower(p.name)`).all();
}

// ---------- imports ----------

const KINDS = ['whatsapp', 'sheet', 'pdf', 'photo'];

export async function createImport(user, { kind, file_name, company, list_date }) {
  if (!KINDS.includes(kind)) throw bad('Send a WhatsApp export, an Excel or CSV file, a PDF or a photo');
  if (list_date && !DATE.test(list_date)) throw bad('Not a date');
  const { id } = await db.prepare(`INSERT INTO attendance_imports (user_id, kind, file_name, company, list_date) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .run(user.id, kind, String(file_name || '').slice(0, 200), String(company || '').trim().slice(0, 80) || null, list_date || null);
  mkdirSync(importDir(id), { recursive: true });
  return getImport(id);
}

export const getImport = (id) => db.prepare(`SELECT i.id, i.kind, i.file_name, i.company, i.list_date, i.status, i.step, i.done, i.total, i.found,
    i.error, i.created_at, i.finished_at, u.name AS by_name FROM attendance_imports i LEFT JOIN users u ON u.id = i.user_id WHERE i.id = ?`).get(Number(id) || 0);

export const listImports = () => db.prepare(`SELECT i.id, i.kind, i.file_name, i.status, i.step, i.done, i.total, i.found, i.error, i.created_at,
    i.finished_at, u.name AS by_name FROM attendance_imports i LEFT JOIN users u ON u.id = i.user_id ORDER BY i.id DESC LIMIT 20`).all();

export async function startImport(id) {
  const imp = await db.prepare(`SELECT id FROM attendance_imports WHERE id = ? AND status = 'uploading'`).get(Number(id) || 0);
  if (!imp) return null;
  if (!existsSync(importDir(imp.id))) throw bad('Nothing was sent for this import');
  await db.prepare(`UPDATE attendance_imports SET status = 'queued', step = 'Waiting to be read' WHERE id = ?`).run(imp.id);
  kick(imp.id);
  return getImport(imp.id);
}

/** Of the photos in an export, the ones not read before: only those are sent. */
export async function newPhotos(names) {
  const list = (Array.isArray(names) ? names : []).map(String).filter((n) => /-PHOTO-/.test(n)).slice(0, 20000);
  if (!list.length) return [];
  const seen = new Set((await db.prepare('SELECT name FROM attendance_photos WHERE name = ANY(?::text[])').all(list)).map((r) => r.name));
  return list.filter((n) => !seen.has(n));
}

// ---------- routes ----------

export const attendanceRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));
const safeName = (s) => path.basename(String(s || '')).replace(/[^\w.\- ()]+/g, '_').slice(0, 160) || 'file';
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, importDir(Number(req.params.id) || 0)),
    filename: (req, file, cb) => cb(null, safeName(file.originalname)),
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 60 },
});

attendanceRoutes.get('/periods', wrap(async (req, res) => res.json(await listPeriods())));
attendanceRoutes.get('/periods/:start', wrap(async (req, res) => res.json(await getPeriod(req.params.start))));
attendanceRoutes.get('/periods/:start/report', wrap(async (req, res) => {
  const { sendReport } = await import('./attendanceReport.js');
  await sendReport(res, await getPeriod(req.params.start));
}));
attendanceRoutes.put('/periods/:start/people/:id/review', wrap(async (req, res) =>
  send(res, await setReview(req.user, req.params.id, req.params.start, req.body?.state, req.body?.note))));

attendanceRoutes.get('/people', wrap(async (req, res) => res.json(await listPeople())));
attendanceRoutes.put('/people/:id', wrap(async (req, res) => send(res, await renamePerson(req.params.id, req.body?.name))));
attendanceRoutes.post('/people/:id/merge', wrap(async (req, res) => send(res, await mergePeople(req.params.id, req.body?.into))));
attendanceRoutes.post('/people/:id/split', wrap(async (req, res) => send(res, await splitPerson(req.params.id, req.body?.company))));
attendanceRoutes.get('/teams', wrap(async (req, res) => res.json(await listTeams())));
attendanceRoutes.put('/teams', wrap(async (req, res) => send(res, await setTeam(req.body || {}))));
attendanceRoutes.get('/people/:id/days/:day', wrap(async (req, res) => send(res, await getDay(req.params.id, req.params.day))));
attendanceRoutes.put('/people/:id/days/:day', wrap(async (req, res) => send(res, await setDay(req.user, req.params.id, req.params.day, req.body || {}))));

attendanceRoutes.get('/imports', wrap(async (req, res) => res.json(await listImports())));
attendanceRoutes.post('/imports', wrap(async (req, res) => res.json(await createImport(req.user, req.body || {}))));
attendanceRoutes.post('/imports/new-photos', wrap(async (req, res) => res.json({ names: await newPhotos(req.body?.names) })));
attendanceRoutes.get('/imports/:id', wrap(async (req, res) => send(res, await getImport(req.params.id))));
attendanceRoutes.post('/imports/:id/files', wrap(async (req, res, next) => {
  const imp = await db.prepare(`SELECT id FROM attendance_imports WHERE id = ? AND status = 'uploading'`).get(Number(req.params.id) || 0);
  if (!imp) return res.status(404).json({ error: 'Not found' });
  mkdirSync(importDir(imp.id), { recursive: true });
  upload.array('files', 60)(req, res, (e) => (e ? next(bad(e.message)) : res.json({ ok: true, files: (req.files || []).length })));
}));
attendanceRoutes.post('/imports/:id/start', wrap(async (req, res) => send(res, await startImport(req.params.id))));

// A photo a day was read from. Only photos of lists are kept, under their WhatsApp name.
attendanceRoutes.get('/photos/:name', wrap(async (req, res) => {
  const file = path.join(UPLOADS, 'photos', path.basename(req.params.name));
  existsSync(file) ? res.sendFile(file) : res.status(404).json({ error: 'Not found' });
}));
