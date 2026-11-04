import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { db, tx } from './db.js';
import { claude } from './ai.js';
import { billAs } from './billing.js';
import { DATA_DIR } from './config.js';
import { pdfPages } from './knowledge.js';

// Attendance, the reading half: turns what teams post into one row per person per day.
//
//   WhatsApp export - the phone exports the group chat; the browser opens the zip itself and
//                     sends only the chat text and the photos not read before (client/src/lib/zip.js),
//                     so a month's export is a small upload even when the zip is half a gigabyte.
//   Excel / CSV     - read as rows of text.
//   PDF             - typed or scanned, read by Claude a few pages at a time.
//   Photo           - a photo or screenshot of a list.
//
// Lists are read by Haiku (cheap, and it reads a list as well as Sonnet did on the real
// group). Sorting lists into companies and joining spellings of one person are Sonnet's,
// and are learnt once: attendance_teams and attendance_names remember the answer, so a new
// month only asks about lists and names never seen before.
//
// Lessons from the first real group, kept as rules here:
//   - The export has Windows line endings; a parser that splits on "\n" alone glues
//     messages together and loses whole lists.
//   - A list is sometimes posted with yesterday's date copied at the top. When that poster
//     already sent a list for yesterday, it is today's list (29 Sep, 3 Oct); otherwise it is
//     a late list for the day written.
//   - Two names on the same list on the same day are two people, whatever their spelling.
//   - A person moving company stops on one list the day they start on another, with the
//     same hours. The names step is shown everyone already known so it can join them.

export const UPLOADS = path.join(DATA_DIR, 'attendance');
const PHOTOS = path.join(UPLOADS, 'photos');
const READ_MODEL = 'claude-haiku-5-5';
const SORT_MODEL = 'claude-sonnet-5-5';
const AT_ONCE = 4;
const MAX_PHOTO = 4.5 * 1024 * 1024; // Claude takes up to 5 MB per picture; WhatsApp sends far less
export const STATUSES = ['present', 'late', 'absent', 'vacation', 'off', 'sick', 'other'];

const sha = (s) => createHash('sha1').update(s).digest('hex');
const iso = (d, m, y) => `${y.length === 2 ? `20${y}` : y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dayMs = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);

/** A WhatsApp name without the marks WhatsApp and people add: "~ 🌹francis🌹" -> "francis". */
export const cleanPoster = (s) => String(s || '')
  .replace(/[‎‏⁨⁩️]/g, '').replace(/^~\s*/, '').replace(/\p{Extended_Pictographic}/gu, '').trim();
const plain = (s) => String(s || '').replace(/[‎‏⁨⁩]/g, '');
export const nameKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- the WhatsApp chat ----------

const LINE = /^‎?\[(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):\d{2}\] ([^:]+): ?(.*)$/;

/** _chat.txt -> messages { day, time, who, text, attached }. */
export function parseChat(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(LINE);
    if (m) {
      cur = { day: iso(m[1], m[2], m[3]), time: `${m[4]}:${m[5]}`, who: cleanPoster(m[6]), text: plain(m[7]) };
      out.push(cur);
    } else if (cur) cur.text += `\n${plain(line)}`;
  }
  // The group's own notices ("Messages and calls are end-to-end encrypted", "X added Y")
  // come from the group's name.
  const group = out.find((m) => /end-to-end encrypted/.test(m.text))?.who;
  for (const m of out) {
    const a = m.text.match(/<attached: ([^>]+)>/);
    m.attached = a ? a[1].trim() : null;
    m.system = m.who === group;
  }
  return out;
}

// A date written at the top of a list: 28/09/2026, 28.09.2026, 28-9-26, "Date: 8/06/2026".
const headDate = (text) => {
  const top = text.split('\n').slice(0, 4).join('\n');
  const x = top.match(/\b(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2}|\d{4})\b/);
  if (!x || +x[2] > 12 || +x[1] > 31) return null;
  return iso(x[1], x[2], x[3]);
};
const isList = (m) => !m.system && !m.attached && m.text.split('\n').length >= 4;

/**
 * Which day each message is about. Normally the day it was sent; a list headed with an
 * earlier date (up to 3 days back) is that day's list only when its poster has not already
 * sent a list for that day - otherwise the date was copied over and it is today's.
 */
export function workDays(messages) {
  for (const m of messages) {
    m.work = m.day;
    if (!isList(m)) continue;
    const h = headDate(m.text);
    if (!h || h >= m.day || daysBetween(h, m.day) > 3) continue;
    // Its poster's other lists, not this one: does yesterday already have a list from them?
    const already = messages.some((o) => o !== m && isList(o) && o.who === m.who && (headDate(o.text) || o.day) === h);
    if (already) {
      m.text = m.text.replace(/\b\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*(?:\d{4}|\d{2})\b/, m.day.split('-').reverse().join('/'));
    } else {
      m.work = h;
    }
  }
  return messages;
}

/** The typed words of one day, as Haiku reads them. */
const dayText = (msgs) => msgs
  .filter((m) => !m.system && !m.attached && !/This message was deleted/.test(m.text) && m.text.trim())
  .map((m) => `[${m.time}] ${m.who}: ${m.text}`).join('\n');

// ---------- Claude ----------

const ROWS = {
  type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['date', 'time', 'posted_by', 'team', 'name', 'status', 'hours', 'note'],
    properties: {
      date: { type: 'string', description: 'Day worked, YYYY-MM-DD' },
      time: { type: 'string', description: 'HH:MM of the message the row comes from; empty for a file' },
      posted_by: { type: 'string', description: 'Who posted it (WhatsApp name); empty for a file' },
      team: { type: 'string', description: 'Company / shop / team / section the list gives, e.g. "Bakery", "Ladies Camp"; empty if none' },
      name: { type: 'string', description: 'Worker name exactly as written' },
      status: { type: 'string', enum: STATUSES },
      hours: { type: 'string', description: 'Working hours as written, e.g. "10am-10pm" or "4am-8am, 4pm-10pm"; empty if none' },
      note: { type: 'string', description: 'Anything else worth keeping, short; empty if none' },
    },
  },
};
const schema = (properties) => ({ type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } });

const LIST_RULES = `You read attendance lists of a company in the UAE. List every worker whose attendance is stated: one row per worker per list.
- Only use what is written. Never guess names or hours.
- Go through EVERY list: several shops and teams post their own lists the same day, and each counts.
- If the same list is posted again (a correction or an edit), keep only the latest version.
- Short messages such as "Today only Sarjeet is absent" are rows too.
- Questions, thanks and instructions from managers are not rows.
- "On vacation"/"leave" is vacation, "day off"/"off" is off, a time range alone is present.
- If nothing is attendance, return no rows.`;

async function readJson(content, { system, format, maxTokens = 16000, model = READ_MODEL, effort = 'medium' }) {
  const msg = await claude.messages.stream({
    model, max_tokens: maxTokens, system,
    output_config: { effort, format },
    messages: [{ role: 'user', content }],
  }).finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude would not read this');
  if (msg.stop_reason === 'max_tokens') throw new Error('The list was too long to read in one go');
  return JSON.parse(msg.content.find((b) => b.type === 'text').text);
}

/** One chat day -> rows. */
export async function readChatDay(day, text, read = readJson) {
  const out = await read(`Date: ${day}\n\n${text}`, { system: `${LIST_RULES}\nEvery row's date is ${day}.`, format: schema({ rows: ROWS }) });
  return out.rows.map((r) => ({ ...r, date: day }));
}

const PHOTO = schema({
  kind: { type: 'string', enum: ['team_photo', 'written_list', 'screenshot', 'other'] },
  headcount: { type: 'integer', description: 'People visible in a team photo; 0 otherwise' },
  stamp_time: { type: 'string', description: 'Time printed on the photo by a camera app, 24h HH:MM; empty if none' },
  place: { type: 'string', description: 'Place/address printed on the photo, short; empty if none' },
  list_date: { type: 'string', description: 'For a list or screenshot: the date written on it, YYYY-MM-DD (dates are day/month); empty if none' },
  rows: ROWS,
  note: { type: 'string', description: 'Short, only if useful; empty otherwise' },
});

/** One photo -> what it is; a photo of a list also gives its rows. */
export async function readPhoto(buffer, mimetype, read = readJson) {
  return read([
    { type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } },
    { type: 'text', text: 'An attendance photo from a company WhatsApp group in the UAE. Count every person visible in a team photo, including the one taking a selfie; never try to identify anyone by face. For a written list, sheet or screenshot, give its rows (leave date, time and posted_by empty).' },
  ], { system: LIST_RULES, format: PHOTO, effort: 'low' });
}

/** Rows of a sheet as text (CSV, or an Excel sheet turned into tab-separated lines). */
export async function readSheetText(text, { name, listDate } = {}, read = readJson) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.replace(/[\s,;\t]/g, ''));
  const head = lines.slice(0, 3).join('\n');
  const rows = [];
  // A few dozen lines a time: a grid of people by days gives one row per cell.
  for (let i = 3; i < Math.max(lines.length, 4); i += 30) {
    const part = [head, ...lines.slice(i, i + 30)].join('\n');
    const got = await read(`File: ${name}\n${listDate ? `Date of this list if the file has none: ${listDate}\n` : ''}\n${part}`, {
      system: `${LIST_RULES}
This is a spreadsheet; the first lines are its header and are repeated with each part.
- A grid with one column per day of the month gives one row per person per day with a mark; use the header for the month and year.
- Codes: P present, A absent, L late, V/VL/AL vacation, O/OFF day off, S/SL sick, unless the file says otherwise.
- Leave time and posted_by empty.`,
      format: schema({ rows: ROWS }), maxTokens: 32000,
    });
    rows.push(...got.rows);
  }
  return rows;
}

/** A PDF, four pages a read; scans and typed lists alike. */
export async function readPdf(buffer, { name, listDate, pages } = {}, read = readJson) {
  const rows = [];
  for (let from = 0; from < pages; from += 4) {
    const part = await pdfPages(buffer, from, Math.min(from + 4, pages));
    const got = await read([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: part.toString('base64') } },
      { type: 'text', text: `Attendance file "${name}".${listDate ? ` Date of this list if it has none: ${listDate}.` : ''} Give its rows (leave time and posted_by empty).` },
    ], { system: `${LIST_RULES}\nA grid with one column per day gives one row per person per day with a mark.`, format: schema({ rows: ROWS }), maxTokens: 32000 });
    rows.push(...got.rows);
  }
  return rows;
}

// ---------- companies and people, learnt once ----------

const TEAMS = schema({
  teams: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['line', 'company', 'section'], properties: {
    line: { type: 'integer' },
    company: { type: 'string', description: 'One of the known companies when it fits, spelt the same; otherwise a new short name' },
    section: { type: 'string', description: 'Part of the company (Ladies Camp, Drivers, Bakery…); empty if none. Never a status such as Absent.' },
  } } },
});

// Sorting asks Claude about what is new and remembers the answer; two reads side by side
// must not both ask about the same new name, or one person would be made twice.
let sorting = Promise.resolve();
const oneAtATime = (fn) => { const run = sorting.then(fn); sorting = run.catch(() => {}); return run; };

// Claude is asked about this many new lists or names at a time; each batch sees what the
// batches before it decided, so one new person spread over two batches is still one person.
const BATCH = 150;

/** Every new "poster | team" -> company and section, remembered in attendance_teams. */
export async function sortTeams(rows, read = readJson) {
  const have = new Set((await db.prepare('SELECT poster, team FROM attendance_teams').all()).map((k) => `${k.poster}|${k.team}`));
  const fresh = new Map();
  for (const r of rows) {
    const k = `${r.posted_by}|${r.team}`;
    if (have.has(k)) continue;
    const f = fresh.get(k) || { poster: r.posted_by, team: r.team, n: 0, names: new Set() };
    f.n++; f.names.add(r.name); fresh.set(k, f);
  }
  const list = [...fresh.values()].sort((a, b) => b.n - a.n);
  for (let i = 0; i < list.length; i += BATCH) await sortTeamBatch(list.slice(i, i + BATCH), read);
}

async function sortTeamBatch(list, read) {
  const known = await db.prepare('SELECT poster, team, company, section FROM attendance_teams ORDER BY company').all();
  const companies = [...new Set(known.map((k) => k.company))];
  const examples = known.slice(0, 200).map((k) => `${k.poster || '(file)'} | ${k.team || '(no label)'} -> ${k.company}${k.section ? ` / ${k.section}` : ''}`);
  const got = await read(list.map((f, i) => `${i + 1}. ${f.n} rows | ${f.poster || '(file)'} | ${f.team || '(no label)'} | e.g. ${[...f.names].slice(0, 6).join(', ')}`).join('\n'), {
    model: SORT_MODEL, effort: 'high', format: TEAMS, maxTokens: 32000,
    system: `Attendance lists of a UAE property group. Each line: rows | who posted | the team label the list gave (often messy or empty) | sample names.
Give each line its company and section.
Known companies: ${companies.join(', ') || '(none yet)'}.
How lists were sorted before:\n${examples.join('\n') || '(none)'}
- Keep to the known companies with the same spelling; add a new company only when a list clearly belongs to none of them.
- Use a short, fixed set of companies with one spelling each; sections (Ladies Camp, Drivers, Clients…) are parts of a company, not companies.
- An empty or "not stated" label: decide from the poster, the names and how that poster was sorted before.
- If you truly cannot tell, company "Unclear".`,
  });
  for (const t of got.teams) {
    const f = list[t.line - 1];
    if (!f) continue;
    const section = /^(absent|vacation|leave|day ?off|off|suspended|sick|present)$/i.test(t.section.trim()) ? '' : t.section.trim();
    await db.prepare(`INSERT INTO attendance_teams (poster, team, company, section) VALUES (?, ?, ?, ?)
      ON CONFLICT (poster, team) DO NOTHING`).run(f.poster, f.team, t.company.trim() || 'Unclear', section);
  }
}

const NAMES = schema({
  names: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['line', 'person_id', 'name'], properties: {
    line: { type: 'integer' },
    person_id: { type: 'integer', description: 'The known person this is, or 0 for someone new' },
    name: { type: 'string', description: 'For someone new: one clean full name in Title Case. New lines that are the same new person get exactly the same name; two different new people never do.' },
  } } },
});

/**
 * Every new (company, written name) -> a person, remembered in attendance_names. Shown
 * everyone already known, with where and when they worked, so a spelling ("Tajhdar") or a
 * move to another company lands on the same person. Rows carry their company already.
 */
export async function sortNames(rows, read = readJson) {
  const have = new Set((await db.prepare('SELECT company, written FROM attendance_names').all()).map((k) => `${k.company}|${k.written}`));
  const fresh = new Map();
  for (const r of rows) {
    const k = `${r.company}|${nameKey(r.name)}`;
    if (have.has(k)) continue;
    const f = fresh.get(k) || { company: r.company, written: nameKey(r.name), shown: r.name.trim(), days: new Set(), hours: new Set(), sections: new Set() };
    f.days.add(r.date); if (r.hours) f.hours.add(r.hours); if (r.section) f.sections.add(r.section);
    fresh.set(k, f);
  }
  // By company, so the spellings of one person sit in the same batch.
  const list = [...fresh.values()].sort((a, b) => a.company.localeCompare(b.company) || a.written.localeCompare(b.written));
  for (let i = 0; i < list.length; i += BATCH) await sortNameBatch(list.slice(i, i + BATCH), read);
}

async function sortNameBatch(list, read) {
  const people = await db.prepare(`SELECT p.id, p.name, string_agg(DISTINCT n.company, ', ') AS companies,
      min(e.work_date) AS first, max(e.work_date) AS last, (array_agg(e.hours ORDER BY e.work_date DESC))[1] AS hours
    FROM attendance_people p LEFT JOIN attendance_names n ON n.person_id = p.id LEFT JOIN attendance_entries e ON e.person_id = p.id
    WHERE p.merged_into IS NULL GROUP BY p.id ORDER BY p.name`).all();
  const span = (f) => { const d = [...f.days].sort(); return `${d.length} days, ${d[0]} to ${d.at(-1)}`; };
  const got = await read(list.map((f, i) => `${i + 1}. ${f.shown} | ${f.company}${f.sections.size ? ` / ${[...f.sections][0]}` : ''} | ${span(f)} | ${[...f.hours].slice(0, 2).join(', ')}`).join('\n'), {
    model: SORT_MODEL, effort: 'high', format: NAMES, maxTokens: 32000,
    system: `Worker names as typed in attendance lists of a UAE property group. Each line: name as written | company | when | hours.
Known people (id | name | companies | first and last day | usual hours):
${people.map((p) => `${p.id} | ${p.name} | ${p.companies || '-'} | ${p.first || '-'} to ${p.last || '-'} | ${p.hours || ''}`).join('\n') || '(none yet)'}
For each line give the known person it is (person_id), or 0 and a clean name for someone new.
- The same person is often typed differently: short vs full name, spelling, case, a role added ("driver").
- People move between companies: someone who stops on one company's lists and starts on another's the next days, with the same hours, is the same person.
- Join only when confident. A common first name alone (Ahmad, Ali, Francisca) is not enough: if two are different people, name them apart, e.g. "Ahmad (JVC School)".`,
  });
  const ids = new Set(people.map((p) => p.id));
  await tx(async () => {
    const made = new Map();
    for (const n of got.names) {
      const f = list[n.line - 1];
      if (!f) continue;
      let id = ids.has(n.person_id) ? n.person_id : null;
      if (!id) {
        const name = (n.name || f.shown).trim();
        id = made.get(nameKey(name)) || (await db.prepare('INSERT INTO attendance_people (name) VALUES (?) RETURNING id').run(name)).id;
        made.set(nameKey(name), id);
      }
      await db.prepare('INSERT INTO attendance_names (company, written, person_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(f.company, f.written, id);
    }
  });
}

/** Rows -> their company and section, from what attendance_teams has learnt. */
async function placeRows(rows) {
  const teams = new Map((await db.prepare('SELECT * FROM attendance_teams').all()).map((t) => [`${t.poster}|${t.team}`, t]));
  for (const r of rows) {
    const t = teams.get(`${r.posted_by}|${r.team}`);
    r.company = t?.company || 'Unclear';
    r.section = t?.section || '';
  }
}

/** Sort everything new in a whole import at once: a few Sonnet calls instead of one per day. */
export const sortAll = (rows, read = readJson) => oneAtATime(async () => {
  await sortTeams(rows, read);
  await placeRows(rows);
  await sortNames(rows, read);
});

/** A person's id, following merges. */
export async function personOf(company, written) {
  const row = await db.prepare('SELECT person_id FROM attendance_names WHERE company = ? AND written = ?').get(company, nameKey(written));
  let id = row?.person_id;
  for (let i = 0; id && i < 10; i++) {
    const p = await db.prepare('SELECT merged_into FROM attendance_people WHERE id = ?').get(id);
    if (!p?.merged_into) break;
    id = p.merged_into;
  }
  return id || null;
}

/**
 * Rows -> entries. Companies and names are sorted first (only what is new is asked about).
 * Two names on one list on one day are two people: if they were joined, the second gets a
 * person of its own, and that is remembered too. `before` runs first in the same
 * transaction (clearing what a day said last time).
 */
export async function saveRows(importId, rows, { source, photo = null, read = readJson, before } = {}) {
  rows = rows.filter((r) => r.name?.trim() && !/^(unknown|n\/a|-)$/i.test(r.name.trim()) && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  await oneAtATime(async () => {
    if (!rows.length) return;
    await sortTeams(rows, read);
    await placeRows(rows);
    await sortNames(rows, read);
  });
  let saved = 0;
  await tx(async () => {
    if (before) await before();
    const onList = new Map();
    for (const r of rows) {
      let person = await personOf(r.company, r.name);
      if (!person) continue;
      const list = `${r.date}|${r.posted_by}|${r.team}|${r.time}`;
      const seen = onList.get(list) || new Map();
      if (seen.has(person) && seen.get(person) !== nameKey(r.name)) {
        person = (await db.prepare('INSERT INTO attendance_people (name) VALUES (?) RETURNING id').run(r.name.trim())).id;
        await db.prepare(`INSERT INTO attendance_names (company, written, person_id) VALUES (?, ?, ?)
          ON CONFLICT (company, written) DO UPDATE SET person_id = EXCLUDED.person_id`).run(r.company, nameKey(r.name), person);
      }
      seen.set(person, nameKey(r.name)); onList.set(list, seen);
      await db.prepare(`INSERT INTO attendance_entries (import_id, person_id, work_date, company, section, team, written_name, status, hours, note,
          posted_by, source, source_day, source_time, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(importId, person, r.date, r.company, r.section, r.team || '', r.name.trim(), STATUSES.includes(r.status) ? r.status : 'other',
          String(r.hours || '').slice(0, 80), String(r.note || '').slice(0, 300), r.posted_by || '', source, r.sourceDay || null, r.time || null, photo);
      saved++;
    }
  });
  return saved;
}

// ---------- one import, start to end ----------

const dirOf = (id) => path.join(UPLOADS, 'imports', String(id));
const step = (id, s, done = 0, total = 0) => db.prepare('UPDATE attendance_imports SET step = ?, done = ?, total = ? WHERE id = ?').run(s, done, total, id);
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

async function pool(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: AT_ONCE }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function readWhatsapp(imp, dir, read) {
  const messages = workDays(parseChat(readFileSync(path.join(dir, '_chat.txt'), 'utf8')));
  // Days whose words changed since last time (a new day, or a list edited or posted late).
  const byDay = new Map();
  for (const m of messages) (byDay.get(m.work) || byDay.set(m.work, []).get(m.work)).push(m);
  const seen = new Map((await db.prepare('SELECT day, hash FROM attendance_chat_days').all()).map((d) => [d.day, d.hash]));
  const days = [...byDay].map(([day, msgs]) => ({ day, msgs, text: dayText(msgs) }))
    .filter((d) => d.text.trim() && seen.get(d.day) !== sha(d.text)).sort((a, b) => a.day.localeCompare(b.day));
  const already = new Set((await db.prepare('SELECT name FROM attendance_photos').all()).map((p) => p.name));
  const photos = messages.filter((m) => m.attached && /-PHOTO-/.test(m.attached) && !already.has(m.attached) && existsSync(path.join(dir, m.attached)));
  const total = days.length + photos.length;
  let done = 0;

  // 1. Each day's lists and each photo, read side by side.
  await step(imp.id, 'Reading the lists', done, total);
  await pool(days, async (d) => {
    d.rows = await readChatDay(d.day, d.text, read);
    for (const r of d.rows) {
      r.posted_by = cleanPoster(r.posted_by);
      r.sourceDay = d.msgs.find((m) => m.time === r.time && m.who === r.posted_by)?.day || d.day;
    }
    await step(imp.id, 'Reading the lists', ++done, total);
  });
  await step(imp.id, 'Looking at the photos', done, total);
  await pool(photos, async (m) => {
    const ext = m.attached.split('.').pop().toLowerCase();
    const buf = readFileSync(path.join(dir, m.attached));
    m.read = MIME[ext] && buf.length <= MAX_PHOTO ? await readPhoto(buf, MIME[ext], read) : { kind: 'other', headcount: 0, stamp_time: '', place: '', list_date: '', rows: [], note: 'Not read: not a picture Claude takes' };
    if (m.read.kind === 'written_list' || m.read.kind === 'screenshot') {
      // A list's own date, when it is the day sent or just before; otherwise the day sent.
      const l = m.read.list_date;
      const day = l && l <= m.day && daysBetween(l, m.day) <= 3 ? l : m.day;
      m.rows = m.read.rows.map((r) => ({ ...r, date: day, time: m.time, posted_by: m.who, sourceDay: m.day }));
    }
    await step(imp.id, 'Looking at the photos', ++done, total);
  });

  // 2. Everything new sorted into companies and people, in a few calls for the whole export.
  await step(imp.id, 'Sorting companies and names', done, total);
  await sortAll([...days.flatMap((d) => d.rows), ...photos.flatMap((m) => m.rows || [])], read);

  // 3. Saved day by day. A day read again replaces what it said before (a manual change stays).
  await step(imp.id, 'Saving', done, total);
  let found = 0;
  for (const d of days) {
    found += await saveRows(imp.id, d.rows, { source: 'chat', read, before: async () => {
      await db.prepare(`DELETE FROM attendance_entries WHERE source = 'chat' AND work_date = ?`).run(d.day);
      await db.prepare(`INSERT INTO attendance_chat_days (day, hash, messages) VALUES (?, ?, ?)
        ON CONFLICT (day) DO UPDATE SET hash = EXCLUDED.hash, messages = EXCLUDED.messages`)
        .run(d.day, sha(d.text), JSON.stringify(d.msgs.filter((m) => !m.system && !m.attached).map(({ day, time, who, text }) => ({ day, time, who, text }))));
    } });
  }
  mkdirSync(PHOTOS, { recursive: true });
  for (const m of photos) {
    const p = m.read;
    if (m.rows?.length) {
      renameSync(path.join(dir, m.attached), path.join(PHOTOS, m.attached));
      found += await saveRows(imp.id, m.rows, { source: 'photo', photo: m.attached, read });
    }
    // A team photo belongs to the company its poster's lists are for.
    const company = m.rows?.[0]?.company || (await db.prepare(`SELECT company, count(*) AS n FROM attendance_entries
      WHERE posted_by = ? GROUP BY company ORDER BY n DESC LIMIT 1`).get(m.who))?.company || '';
    await db.prepare(`INSERT INTO attendance_photos (name, import_id, work_date, sent, posted_by, company, kind, headcount, stamp_time, place, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING`)
      .run(m.attached, imp.id, m.day, m.time, m.who, company, p.kind, p.kind === 'team_photo' ? p.headcount : 0, p.stamp_time, p.place, p.note);
  }
  return found;
}

async function readFiles(imp, dir, read) {
  const files = readdirSync(dir);
  await step(imp.id, 'Reading the file', 0, files.length);
  let found = 0, done = 0;
  for (const f of files) {
    const buf = readFileSync(path.join(dir, f));
    const ext = f.split('.').pop().toLowerCase();
    const who = imp.company ? '' : f;
    const team = imp.company || '';
    let rows = [];
    if (imp.kind === 'sheet') {
      rows = await readSheetText(ext === 'xlsx' ? await sheetToText(buf) : buf.toString('utf8'), { name: f, listDate: imp.list_date }, read);
    } else if (imp.kind === 'pdf') {
      const { getDocumentProxy } = await import('unpdf');
      const pages = (await getDocumentProxy(new Uint8Array(buf))).numPages;
      rows = await readPdf(buf, { name: f, listDate: imp.list_date, pages }, read);
    } else if (MIME[ext]) {
      const p = await readPhoto(buf, MIME[ext], read);
      const day = p.list_date || imp.list_date;
      rows = p.rows.map((r) => ({ ...r, date: r.date || day }));
      mkdirSync(PHOTOS, { recursive: true });
      const keep = `${imp.id}-${f}`;
      renameSync(path.join(dir, f), path.join(PHOTOS, keep));
      found += await saveRows(imp.id, rows.map((r) => ({ ...r, posted_by: who, team: r.team || team })), { source: 'photo', photo: keep, read });
      await step(imp.id, 'Reading the file', ++done, files.length);
      continue;
    }
    found += await saveRows(imp.id, rows.map((r) => ({ ...r, posted_by: who, team: r.team || team })), { source: imp.kind, read });
    await step(imp.id, 'Reading the file', ++done, files.length);
  }
  return found;
}

/** An Excel workbook as lines of text, sheet by sheet. */
export async function sheetToText(buffer) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet((ws) => {
    out.push(`# Sheet: ${ws.name}`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (c) => {
        const v = c.value;
        cells.push(v instanceof Date ? v.toISOString().slice(0, 10) : v && typeof v === 'object' ? (v.result ?? v.text ?? v.richText?.map((t) => t.text).join('') ?? '') : (v ?? ''));
      });
      out.push(cells.join('\t'));
    });
  });
  return out.join('\n');
}

/** Read one import. `read` is swapped in tests. */
export async function runImport(id, read = readJson) {
  const imp = await db.prepare('SELECT * FROM attendance_imports WHERE id = ?').get(id);
  if (!imp) return;
  const dir = dirOf(id);
  await db.prepare(`UPDATE attendance_imports SET status = 'reading', error = NULL WHERE id = ?`).run(id);
  try {
    const found = await billAs({ userId: imp.user_id, job: 'attendance', note: imp.file_name }, () =>
      imp.kind === 'whatsapp' ? readWhatsapp(imp, dir, read) : readFiles(imp, dir, read));
    await db.prepare(`UPDATE attendance_imports SET status = 'ready', step = '', found = ?, finished_at = extract(epoch from now())::bigint WHERE id = ?`).run(found, id);
  } catch (e) {
    console.error('[attendance]', id, e);
    await db.prepare(`UPDATE attendance_imports SET status = 'failed', error = ? WHERE id = ?`).run(String(e.message || e).slice(0, 300), id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One import at a time: they share what is learnt about companies and names.
let running = Promise.resolve();
export const kick = (id) => { running = running.then(() => runImport(id)).catch(() => {}); return running; };

/** On boot: an import the server stopped in the middle of cannot be finished; it is sent again. */
export async function startAttendance() {
  await db.prepare(`UPDATE attendance_imports SET status = 'failed', error = 'The server restarted while this was being read. Send it again; only what is new is read.'
    WHERE status IN ('queued', 'reading')`).run();
  await db.prepare(`DELETE FROM attendance_imports WHERE status = 'uploading' AND created_at < extract(epoch from now())::bigint - 86400`).run();
}

export const importDir = dirOf;
