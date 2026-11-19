import { Router } from 'express';
import { db } from './db.js';
import { ask } from './ai.js';
import { looseJson } from './files.js';
import { billAs } from './billing.js';
import { sendPush } from './push.js';
import { isMaster } from './access.js';
import { FAST_MODEL, ADVISOR_MODEL } from './config.js';
import { dubaiDate, dubaiHour } from './saifsys/client.js';

// Report checks: the boss's always-on reader of work reports.
//
// The reports already reach Reem as files. Francisca uploads Taj Khan's daily school site
// report, the boss shares the cleaning team's WhatsApp photos into a chat, and Reem has
// already read each one into text. Every few minutes this looks at the files that came in,
// picks out the ones that are a report it knows, and checks each against the list of what
// a complete report of that kind has. What is missing becomes a short message for the
// writer, which waits for the master: nothing here sends anything to the writer. The
// master copies it to WhatsApp, or dismisses it.
//
// It also tells the master things without being asked: a report with gaps, a report that
// is late, the same gap again and again, and a short summary at 19:00. Most of that is
// plain counting; the AI is only called when a file comes in.
//
// What each report says (the work done, materials, people) is kept as facts, for the
// monthly progress report.

// Telling a report from the other files, by titles only. Haiku 4.5, not 5.5: 5.5 thinks first, and on a
// batch of 80 files the thinking used up the whole reply, leaving it empty (6 of 15 batches on 2026-11-19).
const MATCH_MODEL = FAST_MODEL;
const CHECK_MODEL = ADVISOR_MODEL; // reading the report against its list: the careful one
const TICK_MS = 5 * 60_000;
const LOOK_BACK_DAYS = 3; // a file uploaded longer ago than this is not "new"
const MISSING_DAYS = 14; // how far back a late report is still worth a buzz
const SUMMARY_HOUR = 19;
const SUMMARY_UNTIL = 22; // a summary that could not go out by then waits for tomorrow's, not the middle of the night
const MAX_TEXT = 40_000;
const MAX_ITEMS = 30;
const MAX_ITEM = 200;
const DAY_MS = 86_400_000;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- days ----------
// Days are Dubai dates, 'YYYY-MM-DD'; the arithmetic is done at UTC midnight so a day is a day.

export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
export const niceDay = (day) => new Date(`${day}T00:00:00Z`)
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** A day's report is late once its due hour has passed the next day. */
export function isLate(type, day, now = Date.now()) {
  const today = dubaiDate(now);
  const due = addDays(day, 1);
  return today > due || (today === due && dubaiHour(now) >= type.due_hour);
}

const isWorkDay = (type, day) => String(type.work_days).includes(String(weekday(day)));

// ---------- the report types ----------

// The one Reem starts with, from what the boss asked Taj Khan to add on 14 Nov 2026
// (cumulative totals, waste %, the wall schedule) and what his reports already carry.
const SEEDS = [{
  seed: 'school',
  name: 'School site daily report',
  writer: 'Engr. Tajdar Khan',
  about: 'The daily progress report from the JVC School construction site (basement finishing, blockwork, steel and concrete works), ' +
    'written by the site engineer Tajdar Khan and usually uploaded by Francisca, the store keeper. A handwritten photo of it and the typed PDF both count. ' +
    'Not material requisition forms (MRF), LPOs, invoices, receipts, QA/QC site diaries or safety notes.',
  work_days: '0123456', // the site works every day (Francis, 2026-11-19); changed on the screen
  items: [
    'Date — the day the work was done',
    'Work done — each work today, with its quantity (m², m³, pieces)',
    'Running totals — total to date for each work, added up from day one',
    'Blocks — blocks laid today and blocks laid to date',
    'Waste % — blocks issued compared with blocks needed for the m² done',
    'Wall schedule — checked against the architectural wall schedule: areas behind or not matching',
    'Materials — each material used, with its quantity',
    'Manpower — names and which company',
    'Signature — approved and signed by the site engineer',
  ],
}];

const TYPE_COLS = 'id, name, writer, about, items, due_hour, work_days, daily_target, active, seed, starts_on, backfill, created_at';

/** Reem's own types, made once. Deleting one later does not bring it back. */
export async function ensureSeeds(now = Date.now()) {
  for (const s of SEEDS) {
    const mark = await db.prepare('INSERT INTO report_check_marks (key) VALUES (?) ON CONFLICT DO NOTHING RETURNING key').get(`seed:${s.seed}`);
    if (!mark) continue;
    await db.prepare(`INSERT INTO report_types (name, writer, about, items, work_days, seed, starts_on, created_at) VALUES (?, ?, ?, ?::jsonb, ?, ?, ?, ?)
                      ON CONFLICT (seed) DO NOTHING`)
      .run(s.name, s.writer, s.about, JSON.stringify(s.items), s.work_days, s.seed, dubaiDate(now), Math.floor(now / 1000));
  }
}

export const listTypes = () => db.prepare(`SELECT ${TYPE_COLS} FROM report_types ORDER BY id`).all();
export const getType = (id) => db.prepare(`SELECT ${TYPE_COLS} FROM report_types WHERE id = ?`).get(Number(id) || 0);

function cleanItems(items) {
  const out = (Array.isArray(items) ? items : []).map((i) => line(i, MAX_ITEM)).filter(Boolean);
  return [...new Set(out)].slice(0, MAX_ITEMS);
}

function cleanType(input, old = {}) {
  const t = {
    name: line(input.name ?? old.name, 120),
    writer: line(input.writer ?? old.writer, 120),
    about: String(input.about ?? old.about ?? '').trim().slice(0, 2000),
    items: input.items !== undefined ? cleanItems(input.items) : old.items,
    due_hour: input.due_hour !== undefined ? Number(input.due_hour) : old.due_hour ?? 12,
    work_days: input.work_days !== undefined ? [...new Set(String(input.work_days).replace(/[^0-6]/g, ''))].sort().join('') : old.work_days ?? '123456',
    active: input.active !== undefined ? !!input.active : old.active ?? true,
  };
  if (!t.name) throw bad('Give the report a name');
  // What it is, when nobody wrote it: said from the name, the writer and the points, which is
  // what the file sorting needs to recognise it (the boss found writing it himself hard).
  if (!t.about) {
    t.about = `${t.name}${t.writer ? `, written by ${t.writer}` : ''}. A report like this covers: ${t.items.map((i) => i.split(' — ')[0]).join(', ')}. ` +
      'A photo, a scan or a typed copy of it counts.';
  }
  if (!t.items?.length) throw bad('Add at least one thing a complete report has');
  if (!Number.isInteger(t.due_hour) || t.due_hour < 0 || t.due_hour > 23) throw bad('The due time is an hour from 0 to 23');
  if (!t.work_days) throw bad('Pick at least one day a report is expected');
  return t;
}

export async function createType(input, now = Date.now()) {
  const t = cleanType(input);
  const { id } = await db.prepare(`INSERT INTO report_types (name, writer, about, items, due_hour, work_days, active, starts_on, created_at)
                                   VALUES (?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?) RETURNING id`)
    .run(t.name, t.writer, t.about, JSON.stringify(t.items), t.due_hour, t.work_days, t.active, dubaiDate(now), Math.floor(now / 1000));
  return getType(id);
}

export async function updateType(id, input) {
  const old = await getType(id);
  if (!old) throw bad('That report type is gone', 404);
  const t = cleanType(input, old);
  await db.prepare('UPDATE report_types SET name = ?, writer = ?, about = ?, items = ?::jsonb, due_hour = ?, work_days = ?, active = ? WHERE id = ?')
    .run(t.name, t.writer, t.about, JSON.stringify(t.items), t.due_hour, t.work_days, t.active, old.id);
  return getType(old.id);
}

export async function deleteType(id) {
  const { changes } = await db.prepare('DELETE FROM report_types WHERE id = ?').run(Number(id) || 0);
  if (!changes) throw bad('That report type is gone', 404);
}

/** Name + what the report is → what a complete one has. `asker` is swapped in tests. */
export async function draftItems({ name, about }, asker = ask) {
  const n = line(name, 120);
  if (!n) throw bad('Give the report a name first');
  const out = await asker(`Report: ${n}\nWhat it is: ${String(about ?? '').trim().slice(0, 2000) || '(work it out from the name)'}`, {
    maxTokens: 1200,
    model: CHECK_MODEL,
    system: `A property and construction company in Dubai gets this work report from its staff every day.
List what a complete report of this kind must contain, so a manager can track the work month by month:
dates, quantities, totals to date, materials with quantities, people, photos, problems - whatever this kind of report needs.
5 to 12 points, each one thing, in plain English, written as a short label of 1-3 words, then " — ", then what exactly
(at most 15 words), e.g. "Waste % — blocks issued compared with blocks needed". Reply with ONLY JSON: {"items": ["<point>", "<point>"]}`,
  });
  try {
    const items = cleanItems(looseJson(out).items);
    if (!items.length) throw new Error('empty');
    return items;
  } catch {
    throw bad('Reem could not write the list this time. Try again, or write it yourself.', 502);
  }
}

// ---------- finding the reports among the files ----------

const DOC_COLS = 'd.id, d.user_id, d.name, d.title, d.folder, d.summary, d.doc_date, d.created_at';

// Files with text that a report could be. External people's files are their own business,
// and the notes Reem saves as facts are not reports.
const FILES = `FROM documents d JOIN users u ON u.id = d.user_id
  WHERE d.status = 'ready' AND d.kind IS DISTINCT FROM 'fact' AND NOT u.external
    AND EXISTS (SELECT 1 FROM document_texts t WHERE t.document_id = d.id)`;

/** New files nobody has looked at yet, oldest first. */
export async function newFiles(types, now = Date.now()) {
  if (!types.length) return [];
  const since = Math.max(Math.floor(now / 1000) - LOOK_BACK_DAYS * 86400, Math.min(...types.map((t) => Number(t.created_at))));
  return db.prepare(`SELECT ${DOC_COLS} ${FILES} AND d.created_at >= ?
                       AND NOT EXISTS (SELECT 1 FROM report_check_seen s WHERE s.document_id = d.id)
                     ORDER BY d.id LIMIT 80`).all(since);
}

const fileLine = (d) => `[${d.id}] ${line(d.title || d.name, 140)} | file: ${line(d.name, 80)} | ${d.folder || ''} | ${line(d.summary, 240)}`;

/** Which of these files is which report: [{ doc, type }]. One cheap call for the lot. */
export async function matchReports(docs, types, asker = ask) {
  if (!docs.length || !types.length) return [];
  const out = await asker([
    'Report types:',
    ...types.map((t) => `[${t.id}] ${t.name}: ${line(t.about, 600)}`),
    '',
    'Files:',
    ...docs.map(fileLine),
  ].join('\n'), {
    maxTokens: 2000,
    model: MATCH_MODEL,
    system: `You sort a company's newly uploaded files. Say which files are one of the report types listed, going by each file's title, name and summary.
Only a file that IS such a report (the report itself, a photo of it, or a scan) - not a file that only mentions one.
Most files are none of them: leave those out. Reply with ONLY JSON: {"matches": [{"file": <file id>, "type": <type id>}]}`,
  });
  const byDoc = new Map(docs.map((d) => [d.id, d]));
  const byType = new Map(types.map((t) => [t.id, t]));
  const seen = new Set();
  let list;
  try { list = looseJson(out).matches; } catch {
    // An answer cut off part-way (or with words around it) still names its matches: take each pair it got to.
    list = [...String(out ?? '').matchAll(/"file"\s*:\s*(\d+)\s*,\s*"type"\s*:\s*(\d+)/g)].map(([, file, type]) => ({ file, type }));
  }
  return (Array.isArray(list) ? list : []).flatMap((m) => {
    const doc = byDoc.get(Number(m?.file));
    const type = byType.get(Number(m?.type));
    if (!doc || !type || seen.has(doc.id)) return [];
    seen.add(doc.id);
    return [{ doc, type }];
  });
}

// ---------- checking one report ----------

const CHECK_SYSTEM = `You check one work report for a property and construction company in Dubai. The owner wants every report complete,
so you compare it with the list of what a complete report of this kind has, and say exactly what is missing or unclear.

Rules:
- An item is there only if the report really gives it: a number where a number is needed, a total where a total is asked for.
  "Materials used" with no quantities, or a total that is only today's figure, is a gap.
- Only the items on the list are gaps, plus a figure that is plainly wrong (a total to date smaller than the last report's).
- Do not guess what the writer meant and do not fill anything in yourself.

Reply with ONLY JSON:
{"is_report": true or false (false if this file is not a report of this kind at all),
 "report_date": "YYYY-MM-DD" (the day the work was done, as the report says),
 "summary": "one or two sentences: what was done that day",
 "gaps": [{"item": "<the list item, word for word>", "missing": "<what exactly is missing, at most 15 words>"}],
 "facts": {"work": [{"what": "", "qty": number or null, "unit": ""}],
           "materials": [{"what": "", "qty": number or null, "unit": ""}],
           "people": number or null,
           "units_done": number or null,
           "other": "anything else worth tracking month to month, or empty"},
 "note": "a WhatsApp message to the writer asking for the missing parts, or empty when nothing is missing"}

The note: short, polite, plain English. Start "Salam <first name>," then name the report and its date, list each missing part
as a numbered line, and ask for the updated report today. No sign-off.`;

const latestBefore = (typeId, day) => db.prepare(`SELECT report_date, facts FROM report_checks
  WHERE type_id = ? AND report_date < ? ORDER BY report_date DESC, id DESC LIMIT 1`).get(typeId, day);

// One line per list item: the same item named twice has its two notes joined.
export function cleanGaps(gaps, items) {
  // Word for word, or only its short label (the part before " — "): both are the list's item.
  const known = new Map(items.flatMap((i) => [[i.split(' — ')[0].toLowerCase(), i], [i.toLowerCase(), i]]));
  const out = new Map();
  for (const g of Array.isArray(gaps) ? gaps : []) {
    const item = known.get(line(g?.item, MAX_ITEM).toLowerCase()) || line(g?.item, MAX_ITEM);
    const missing = line(g?.missing, 200);
    if (!item && !missing) continue;
    const had = out.get(item);
    out.set(item, { item, missing: had ? line([had.missing, missing].filter(Boolean).join('; '), 400) : missing });
  }
  return [...out.values()].slice(0, MAX_ITEMS);
}

// How far before its upload a report's day can be. Handwriting is misread ("4/11/10" came back as
// 2010-11-04), so a date outside this is tried with the upload's year, then with day and month
// swapped, and failing that the day before the upload is taken.
const DATE_WINDOW_DAYS = 21;

export function plausibleDay(read, uploadDay) {
  const earliest = addDays(uploadDay, -DATE_WINDOW_DAYS);
  const ok = (d) => isDay(d) && d >= earliest && d <= uploadDay;
  const tries = [];
  if (isDay(read)) {
    const [, m, d] = read.split('-');
    const y = uploadDay.slice(0, 4);
    const prevY = String(Number(y) - 1); // a report from late December uploaded in January
    tries.push(read, `${y}-${m}-${d}`, `${prevY}-${m}-${d}`, `${read.slice(0, 4)}-${d}-${m}`, `${y}-${d}-${m}`);
  }
  return tries.find(ok) || null;
}

/**
 * Read one file as a report of this type, keep what it found, and tell the master.
 * Returns the check, or null when the file turned out not to be such a report.
 * quiet: no buzz. past: a report from before Reem was watching, whose note is kept but not waited on.
 */
export async function checkReport(type, doc, { asker = ask, pusher = sendPush, quiet = false, past = false } = {}) {
  const text = (await db.prepare('SELECT text FROM document_texts WHERE document_id = ?').get(doc.id))?.text;
  if (!text) return null;
  const uploadDay = dubaiDate(Number(doc.created_at) * 1000);
  const guess = plausibleDay(doc.doc_date, uploadDay) || addDays(uploadDay, -1);
  const before = await latestBefore(type.id, guess);
  const prompt = [
    `Report type: ${type.name}`,
    `Written by: ${type.writer || 'not known'}`,
    `What it is: ${type.about}`,
    '',
    'A complete report has:',
    ...type.items.map((i, k) => `${k + 1}. ${i}`),
    '',
    before ? `The last report before this one (${before.report_date}) gave: ${JSON.stringify(before.facts).slice(0, 3000)}` : 'There is no earlier report on file.',
    '',
    `File: ${doc.title || doc.name} (${doc.name}), dated about ${guess}`,
    '---',
    text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(cut short)` : text,
  ].join('\n');
  // Room to spare: a long report's facts, plus the model's thinking, cut a 2,500-token reply short
  // on 4 of 26 live reports. One more go before giving up.
  let r;
  for (let tries = 0; !r; tries++) {
    try { r = looseJson(await asker(prompt, { system: CHECK_SYSTEM, maxTokens: 8000, model: CHECK_MODEL })); } catch (e) {
      if (tries) throw new Error(`the check of file ${doc.id} came back unreadable`);
    }
  }
  if (r.is_report === false) return null;
  const day = plausibleDay(r.report_date, uploadDay) || guess;
  const gaps = cleanGaps(r.gaps, type.items);
  const note = gaps.length ? String(r.note || '').trim().slice(0, 3000) : '';
  const facts = r.facts && typeof r.facts === 'object' ? r.facts : {};

  // The day's earlier copy, if any: this one replaces it, and its note no longer needs sending.
  const earlier = await db.prepare(`SELECT id, gaps FROM report_checks WHERE type_id = ? AND report_date = ? AND document_id IS DISTINCT FROM ?
                                    ORDER BY id DESC LIMIT 1`).get(type.id, day, doc.id);
  const { id } = await db.prepare(`INSERT INTO report_checks (type_id, document_id, report_date, title, summary, gaps, facts, note, note_state)
      VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)
    ON CONFLICT (type_id, document_id) DO UPDATE SET report_date = EXCLUDED.report_date, title = EXCLUDED.title, summary = EXCLUDED.summary,
      gaps = EXCLUDED.gaps, facts = EXCLUDED.facts, note = EXCLUDED.note, note_state = EXCLUDED.note_state, checked_at = EXCLUDED.checked_at
    RETURNING id`)
    .run(type.id, doc.id, day, line(doc.title || doc.name, 200), line(r.summary, 600), JSON.stringify(gaps),
      JSON.stringify(facts).slice(0, 20000), note, !gaps.length ? 'none' : past ? 'past' : 'waiting');
  await db.prepare(`UPDATE report_checks SET note_state = 'replaced' WHERE type_id = ? AND report_date = ? AND id <> ? AND note_state = 'waiting'`)
    .run(type.id, day, id);
  const check = await getCheck(id);

  if (!quiet) {
    const title = `${type.name} · ${niceDay(day)}`;
    const url = `/?reportchecks=${id}`;
    const tag = `report-${type.id}-${day}`;
    if (gaps.length) {
      const streak = await longestStreak(type.id, day, gaps);
      const lead = streak.count >= 3 ? `${streak.count} reports in a row without: ${streak.item}. ` : '';
      await pusher(await masters(), { title, body: `${lead}${gaps.length} missing: ${gaps.map((g) => g.missing || g.item).join('; ')}`, url, tag });
    } else if (earlier?.gaps?.length) {
      await pusher(await masters(), { title, body: 'The new copy is complete: nothing missing now.', url, tag });
    }
  }
  return check;
}

/** The gap item missing from the most reports in a row, counting this one. */
async function longestStreak(typeId, day, gaps) {
  const past = await db.prepare(`SELECT DISTINCT ON (report_date) report_date, gaps FROM report_checks
    WHERE type_id = ? AND report_date < ? ORDER BY report_date DESC, id DESC LIMIT 10`).all(typeId, day);
  let best = { item: '', count: 0 };
  for (const g of gaps) {
    let count = 1;
    for (const p of past) {
      if (!(p.gaps || []).some((x) => x.item === g.item)) break;
      count++;
    }
    if (count > best.count) best = { item: g.item, count };
  }
  return best;
}

const masters = async () => (await db.prepare("SELECT id FROM users WHERE role = 'master' AND NOT disabled").all()).map((u) => u.id);

// ---------- reading for the screen ----------

const CHECK_COLS = `c.id, c.type_id, c.document_id, c.report_date, c.title, c.summary, c.gaps, c.facts, c.note, c.note_state, c.checked_at,
  d.name AS file_name`;

export const getCheck = (id) => db.prepare(`SELECT ${CHECK_COLS} FROM report_checks c LEFT JOIN documents d ON d.id = c.document_id WHERE c.id = ?`)
  .get(Number(id) || 0);

/**
 * The last `days` days of one type, newest first: each day's report (its newest copy, with the
 * earlier ones under it), and the work days with no report at all.
 */
export async function reportDays(typeId, { days = 30, now = Date.now() } = {}) {
  const type = await getType(typeId);
  if (!type) throw bad('That report type is gone', 404);
  const n = Math.min(Math.max(Number(days) || 30, 1), 120);
  const today = dubaiDate(now);
  const from = addDays(today, -n);
  const checks = await db.prepare(`SELECT ${CHECK_COLS} FROM report_checks c LEFT JOIN documents d ON d.id = c.document_id
    WHERE c.type_id = ? AND c.report_date >= ? ORDER BY c.report_date DESC, c.id DESC`).all(type.id, from);
  const byDay = new Map();
  for (const c of checks) {
    if (!byDay.has(c.report_date)) byDay.set(c.report_date, { date: c.report_date, check: c, earlier: [] });
    else byDay.get(c.report_date).earlier.push(c);
  }
  // Days with no report are shown from the first report on file, even before Reem was watching
  // (the boss sees the gap of 14-18 Nov); the buzzes about them only count from starts_on.
  const first = checks.length ? checks.at(-1).report_date : type.starts_on;
  const shownFrom = [from, first < type.starts_on ? first : type.starts_on].sort()[1];
  for (let d = shownFrom; d < today; d = addDays(d, 1)) {
    if (!byDay.has(d) && isWorkDay(type, d)) byDay.set(d, { date: d, missing: true, late: isLate(type, d, now) });
  }
  return { type, days: [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1)) };
}

/** The master's answer to a note: sent (copied to WhatsApp), or dismissed. The text can be edited first. */
export async function setNote(id, { state, note }) {
  const c = await getCheck(id);
  if (!c) throw bad('That report check is gone', 404);
  if (!['sent', 'dismissed', 'waiting'].includes(state)) throw bad('A note is sent, dismissed or waiting');
  const text = note === undefined ? c.note : String(note).trim().slice(0, 3000);
  await db.prepare('UPDATE report_checks SET note_state = ?, note = ? WHERE id = ?').run(state, text, c.id);
  return getCheck(c.id);
}

// ---------- the watch ----------

async function markOnce(key) {
  return !!(await db.prepare('INSERT INTO report_check_marks (key) VALUES (?) ON CONFLICT DO NOTHING RETURNING key').get(key));
}

/** New files: find the reports and check them. */
export async function watchFiles({ now = Date.now(), asker = ask, pusher = sendPush } = {}) {
  const types = (await listTypes()).filter((t) => t.active);
  const docs = await newFiles(types, now);
  if (!docs.length) return [];
  const already = new Set((await db.prepare('SELECT type_id, document_id FROM report_checks WHERE document_id = ANY(?::int[])')
    .all(docs.map((d) => d.id))).map((r) => `${r.type_id}:${r.document_id}`));
  const matches = (await matchReports(docs, types, asker)).filter((m) => !already.has(`${m.type.id}:${m.doc.id}`));
  // Seen once the sorting is done: a check that fails is tried again from the screen, not every five minutes.
  await db.prepare('INSERT INTO report_check_seen (document_id) SELECT unnest(?::int[]) ON CONFLICT DO NOTHING').run(docs.map((d) => d.id));
  const done = [];
  for (const { doc, type } of matches) {
    try {
      const c = await checkReport(type, doc, { asker, pusher });
      if (c) done.push(c);
    } catch (e) { console.error('[report checks]', doc.id, e.message); }
  }
  return done;
}

const missingDays = async (type, now) => {
  const today = dubaiDate(now);
  const start = addDays(today, -MISSING_DAYS) > type.starts_on ? addDays(today, -MISSING_DAYS) : type.starts_on;
  const have = new Set((await db.prepare('SELECT DISTINCT report_date FROM report_checks WHERE type_id = ? AND report_date >= ?')
    .all(type.id, start)).map((r) => r.report_date));
  const out = [];
  for (let d = start; d < today; d = addDays(d, 1)) {
    if (isWorkDay(type, d) && !have.has(d) && isLate(type, d, now)) out.push(d);
  }
  return out;
};

/** The buzzes nobody asked for: a late report (once per day), and the 19:00 summary (once a day). */
export async function watchAlerts({ now = Date.now(), pusher = sendPush } = {}) {
  const types = (await listTypes()).filter((t) => t.active);
  const to = await masters();
  const sent = [];
  for (const type of types) {
    const fresh = [];
    for (const d of await missingDays(type, now)) if (await markOnce(`missing:${type.id}:${d}`)) fresh.push(d);
    if (!fresh.length) continue;
    const body = `No report yet for ${fresh.map(niceDay).join(', ')}.${type.writer ? ` Writer: ${type.writer}.` : ''}`;
    await pusher(to, { title: type.name, body, url: '/?reportchecks=list', tag: `report-missing-${type.id}` });
    sent.push({ type: type.id, days: fresh });
  }

  const today = dubaiDate(now);
  if (types.length && dubaiHour(now) >= SUMMARY_HOUR && dubaiHour(now) < SUMMARY_UNTIL) {
    const parts = [];
    for (const type of types) {
      const start = Math.floor(Date.parse(`${today}T00:00:00+04:00`) / 1000);
      const { n } = await db.prepare('SELECT count(*)::int n FROM report_checks WHERE type_id = ? AND checked_at >= ?').get(type.id, start);
      const { w } = await db.prepare(`SELECT count(*)::int w FROM report_checks WHERE type_id = ? AND note_state = 'waiting'`).get(type.id);
      const missing = (await missingDays(type, now)).length;
      if (!n && !w && !missing) continue;
      parts.push(`${type.name}: ${[n && `${n} checked`, w && `${w} note${w === 1 ? '' : 's'} to send`, missing && `${missing} missing`].filter(Boolean).join(', ')}`);
    }
    if (parts.length && await markOnce(`summary:${today}`)) {
      await pusher(to, { title: 'Reports today', body: parts.join(' · '), url: '/?reportchecks=list', tag: 'report-summary' });
      sent.push({ summary: today });
    }
  }
  return sent;
}

// ---------- the past ----------

const running = new Set();

/**
 * Check this type's reports among the files of the last `days` days, quietly: for the reports
 * that came before the type existed, or after its list changed. Runs in the background; the
 * type's `backfill` shows how far it got.
 */
export async function backfill(typeId, { days = 30, asker = ask, now = Date.now() } = {}) {
  const type = await getType(typeId);
  if (!type) throw bad('That report type is gone', 404);
  if (running.has(type.id)) throw bad('Reem is already going through the past reports');
  running.add(type.id);
  const n = Math.min(Math.max(Number(days) || 30, 1), 90);
  const save = (b) => db.prepare('UPDATE report_types SET backfill = ?::jsonb WHERE id = ?').run(JSON.stringify(b), type.id);
  const state = { state: 'running', days: n, files: 0, found: 0, checked: 0, at: Math.floor(now / 1000) };
  try {
    const since = Math.floor(now / 1000) - n * 86400;
    const docs = await db.prepare(`SELECT ${DOC_COLS} ${FILES} AND d.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM report_checks c WHERE c.type_id = ? AND c.document_id = d.id) ORDER BY d.id`).all(since, type.id);
    state.files = docs.length;
    await save(state);
    const found = [];
    for (let i = 0; i < docs.length; i += 80) {
      // One batch the model fumbles is skipped, not the whole month.
      try { found.push(...await matchReports(docs.slice(i, i + 80), [type], asker)); } catch (e) { console.error('[report checks] sorting', e.message); }
    }
    state.found = found.length;
    await save(state);
    for (const { doc } of found) {
      try { if (await checkReport(type, doc, { asker, quiet: true, past: true })) state.checked++; } catch (e) { console.error('[report checks]', doc.id, e.message); }
      await save(state);
    }
    state.state = 'done';
  } catch (e) {
    state.state = 'failed';
    state.error = e.message;
    throw e;
  } finally {
    running.delete(type.id);
    await save(state).catch(() => {});
  }
  return state;
}

/** Check one report again (after its list changed, say). Quiet: the master is looking at it. */
export async function recheck(id, { asker = ask } = {}) {
  const c = await getCheck(id);
  if (!c) throw bad('That report check is gone', 404);
  if (!c.document_id) throw bad('The file of this report was deleted');
  const [type, doc] = await Promise.all([getType(c.type_id), db.prepare(`SELECT ${DOC_COLS} FROM documents d WHERE d.id = ?`).get(c.document_id)]);
  const again = await checkReport(type, doc, { asker, quiet: true });
  if (!again) {
    await db.prepare('DELETE FROM report_checks WHERE id = ?').run(c.id);
    return null;
  }
  return again;
}

let timer = null;
let busy = false;

export function startReportChecks() {
  if (timer) return;
  const run = () => {
    if (busy) return;
    busy = true;
    billAs({ userId: null, job: 'report_checks' }, async () => {
      await ensureSeeds();
      await watchFiles();
      await watchAlerts();
    }).catch((e) => console.error('[report checks]', e.message)).finally(() => { busy = false; });
  };
  timer = setInterval(run, TICK_MS);
  timer.unref();
  run();
}

// ---------- routes (behind the report_checks module) ----------
// Whoever holds the module reads; changing the lists and answering notes is the master's.

export const reportCheckRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const masterOnly = (req, res, next) => (isMaster(req.user) ? next() : res.status(403).json({ error: 'Only the master can change this' }));

reportCheckRoutes.get('/', wrap(async (req, res) => {
  await ensureSeeds();
  const types = await listTypes();
  const waiting = await db.prepare(`SELECT type_id, count(*)::int n FROM report_checks WHERE note_state = 'waiting' GROUP BY type_id`).all();
  const w = new Map(waiting.map((r) => [r.type_id, r.n]));
  res.json({ master: isMaster(req.user), types: types.map((t) => ({ ...t, waiting: w.get(t.id) || 0 })) });
}));

reportCheckRoutes.get('/types/:id/days', wrap(async (req, res) => res.json(await reportDays(req.params.id, { days: req.query.days }))));
reportCheckRoutes.get('/checks/:id', wrap(async (req, res) => {
  const c = await getCheck(req.params.id);
  if (!c) throw bad('That report check is gone', 404);
  res.json(c);
}));

reportCheckRoutes.post('/types', masterOnly, wrap(async (req, res) => res.json(await createType(req.body || {}))));
reportCheckRoutes.post('/draft-items', masterOnly, wrap(async (req, res) => res.json({ items: await draftItems(req.body || {}) })));
reportCheckRoutes.patch('/types/:id', masterOnly, wrap(async (req, res) => res.json(await updateType(req.params.id, req.body || {}))));
reportCheckRoutes.delete('/types/:id', masterOnly, wrap(async (req, res) => { await deleteType(req.params.id); res.json({ ok: true }); }));
reportCheckRoutes.post('/types/:id/backfill', masterOnly, wrap(async (req, res) => {
  const type = await getType(req.params.id);
  if (!type) throw bad('That report type is gone', 404);
  if (running.has(type.id)) throw bad('Reem is already going through the past reports');
  // Answered at once; the screen watches the type's backfill to see it finish.
  backfill(type.id, { days: req.body?.days }).catch((e) => console.error('[report checks] backfill', e.message));
  res.json({ ok: true });
}));
reportCheckRoutes.post('/checks/:id/note', masterOnly, wrap(async (req, res) => res.json(await setNote(req.params.id, req.body || {}))));
reportCheckRoutes.post('/checks/:id/recheck', masterOnly, wrap(async (req, res) => res.json({ check: await recheck(req.params.id) })));
