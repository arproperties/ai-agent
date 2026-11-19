import { createHash } from 'node:crypto';
import { db } from './db.js';
import { ask } from './ai.js';
import { sendPush } from './push.js';
import { renderPdf, pdfName } from './replyDoc.js';
import { ADVISOR_MODEL } from './config.js';
import { dubaiDate, dubaiHour } from './saifsys/client.js';

// The monthly progress report of one kind of work report (server/reportChecks.js): what the boss
// asked for, "keep this information and make monthly progress reports so we can track our
// operations better". For a month it counts the reports, the days with none and what was missing,
// adds up the work and materials the reports gave, compares with the month before, and has Reem
// write a few plain lines on top. It is a PDF: opened from Report checks for any month, and sent
// to the master's phone on the 1st for the month that just ended.
//
// Reem's lines are the only paid part, and they are kept (report_monthly) until the month's
// numbers change, so opening the same PDF twice does not pay twice.

const SUMMARY_MODEL = ADVISOR_MODEL;
const SEND_HOUR = 8; // on the 1st, Dubai
const DAY_MS = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const niceDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const label = (item) => String(item).split(' — ')[0];
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
export const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const prevMonth = (m) => {
  const y = Number(m.slice(0, 4));
  const n = Number(m.slice(5, 7));
  return n === 1 ? `${y - 1}-12` : `${y}-${String(n - 1).padStart(2, '0')}`;
};
const lastDay = (m) => addDays(`${nextMonth(m)}-01`, -1);
const nextMonth = (m) => {
  const y = Number(m.slice(0, 4));
  const n = Number(m.slice(5, 7));
  return n === 12 ? `${y + 1}-01` : `${y}-${String(n + 1).padStart(2, '0')}`;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null);
const round = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/** The months this type has reports in, newest first. */
export async function reportMonths(typeId) {
  const rows = await db.prepare(`SELECT DISTINCT substr(report_date, 1, 7) m FROM report_checks WHERE type_id = ? ORDER BY m DESC`).all(Number(typeId) || 0);
  return rows.map((r) => r.m);
}

// Each day's newest copy: the report of that day.
const dayReports = (typeId, from, to) => db.prepare(`SELECT DISTINCT ON (report_date) report_date, gaps, facts, note_state
  FROM report_checks WHERE type_id = ? AND report_date >= ? AND report_date <= ? ORDER BY report_date, id DESC`).all(typeId, from, to);

/** Work or materials from every report, added up by name and unit. */
function addUp(reports, key) {
  const sums = new Map();
  for (const r of reports) {
    for (const x of Array.isArray(r.facts?.[key]) ? r.facts[key] : []) {
      const what = String(x?.what || '').replace(/\s+/g, ' ').trim();
      if (!what) continue;
      const unit = String(x?.unit || '').trim();
      const k = `${what.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, ' ').trim()}|${unit.toLowerCase()}`;
      const s = sums.get(k) || { what, unit, total: 0, counted: 0, days: 0 };
      s.days++;
      const q = num(x?.qty);
      if (q !== null) { s.total += q; s.counted++; }
      sums.set(k, s);
    }
  }
  return [...sums.values()].sort((a, b) => b.days - a.days || b.total - a.total);
}

/** One month in numbers. Days with no report count from the first report on file or the day watching began. */
export async function monthData(typeId, month, now = Date.now()) {
  if (!isMonth(month)) throw bad('A month is written YYYY-MM');
  const type = await db.prepare('SELECT id, name, writer, items, work_days, starts_on FROM report_types WHERE id = ?').get(Number(typeId) || 0);
  if (!type) throw bad('That report type is gone', 404);
  const first = `${month}-01`;
  const today = dubaiDate(now);
  const end = lastDay(month) < today ? lastDay(month) : addDays(today, -1);
  const reports = first <= end ? await dayReports(type.id, first, end) : [];
  const earliest = (await db.prepare('SELECT min(report_date) d FROM report_checks WHERE type_id = ?').get(type.id))?.d;
  const from = [first, [earliest || type.starts_on, type.starts_on].sort()[0]].sort()[1];

  const have = new Set(reports.map((r) => r.report_date));
  const missing = [];
  for (let d = from; d <= end; d = addDays(d, 1)) if (String(type.work_days).includes(String(weekday(d))) && !have.has(d)) missing.push(d);

  const withGaps = reports.filter((r) => (r.gaps || []).length);
  const count = new Map();
  for (const r of reports) for (const g of r.gaps || []) count.set(label(g.item), (count.get(label(g.item)) || 0) + 1);
  const often = [...count].map(([item, n]) => ({ item, n })).sort((a, b) => b.n - a.n);
  const people = reports.map((r) => num(r.facts?.people)).filter((n) => n !== null);
  const units = reports.map((r) => num(r.facts?.units_done)).filter((n) => n !== null);

  const prev = prevMonth(month);
  const prevReports = await dayReports(type.id, `${prev}-01`, lastDay(prev));

  return {
    type: { id: type.id, name: type.name, writer: type.writer, items: type.items },
    month, partial: end < lastDay(month), through: end,
    reports: reports.length,
    complete: reports.length - withGaps.length,
    withGaps: withGaps.length,
    missing,
    notesSent: reports.filter((r) => r.note_state === 'sent').length,
    often,
    days: reports.map((r) => ({ date: r.report_date, gaps: (r.gaps || []).map((g) => label(g.item)) })),
    work: addUp(reports, 'work').slice(0, 20),
    materials: addUp(reports, 'materials').slice(0, 20),
    people: people.length ? round(people.reduce((a, b) => a + b, 0) / people.length) : null,
    units: units.length ? units.reduce((a, b) => a + b, 0) : null,
    other: reports.map((r) => String(r.facts?.other || '').trim()).filter(Boolean).slice(0, 40),
    before: prevReports.length ? {
      month: prev, reports: prevReports.length,
      withGaps: prevReports.filter((r) => (r.gaps || []).length).length,
    } : null,
  };
}

const SUMMARY_SYSTEM = `You write the top of a monthly progress report for the owner of a property and construction company in Dubai.
You are given one month of a work report's numbers: how many reports came in, the days with none, what was missing and how often,
the work and materials the reports added up to, and last month's numbers. Write exactly 5 bullet points in plain English, each ONE sentence of at most 30 words, no lists inside a bullet:
1. what got done, with the two or three biggest figures;
2. how complete the reporting was (reports in, days with none);
3. better or worse than last month, or that there is no last month to compare;
4. what the writer keeps leaving out;
5. the one thing the owner should ask for next month.
Use only the numbers given; say "the reports did not give" rather than guessing. Each bullet starts with "- ". No heading, no sign-off.`;
// Bumped when the instructions change, so a kept summary is written again in the new way.
const SUMMARY_VERSION = 2;

/** Reem's lines for the month, kept until the numbers change. */
export async function monthSummary(data, asker = ask) {
  if (!data.reports && !data.missing.length) return '';
  const hash = createHash('sha256').update(`${SUMMARY_VERSION}:${JSON.stringify(data)}`).digest('hex').slice(0, 32);
  const kept = await db.prepare('SELECT summary FROM report_monthly WHERE type_id = ? AND month = ? AND hash = ?').get(data.type.id, data.month, hash);
  if (kept) return kept.summary;
  const out = String(await asker(JSON.stringify({ ...data, type: { name: data.type.name, writer: data.type.writer } }).slice(0, 30000), {
    system: SUMMARY_SYSTEM, maxTokens: 4000, model: SUMMARY_MODEL,
  })).trim();
  const summary = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).slice(0, 6).join('\n').slice(0, 3000);
  await db.prepare(`INSERT INTO report_monthly (type_id, month, hash, summary) VALUES (?, ?, ?, ?)
    ON CONFLICT (type_id, month) DO UPDATE SET hash = EXCLUDED.hash, summary = EXCLUDED.summary, made_at = EXCLUDED.made_at`)
    .run(data.type.id, data.month, hash, summary);
  return summary;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
const qty = (s) => (s.counted ? `${round(s.total).toLocaleString('en-US')}${s.unit ? ` ${s.unit}` : ''}` : 'not given');

/** The month as the PDF's text: number boxes and bars, Reem's lines, then the tables. */
export function monthMarkdown(d, summary) {
  const expected = d.reports + d.missing.length;
  const dash = {
    tiles: [
      { label: 'Reports in', value: `${d.reports}${expected ? ` of ${expected}` : ''}`, color: 'blue' },
      { label: 'Complete', value: String(d.complete), color: 'green' },
      { label: 'Something missing', value: String(d.withGaps), color: d.withGaps ? 'orange' : 'green' },
      { label: 'Days with no report', value: String(d.missing.length), color: d.missing.length ? 'red' : 'green' },
      ...(d.before ? [{ label: `With gaps in ${monthName(d.before.month).split(' ')[0]}`, value: `${pct(d.before.withGaps, d.before.reports)}%`,
        note: `now ${pct(d.withGaps, d.reports)}%`, color: pct(d.withGaps, d.reports) <= pct(d.before.withGaps, d.before.reports) ? 'green' : 'red' }] : []),
      ...(d.people !== null ? [{ label: 'People a day (avg)', value: String(d.people), color: 'grey' }] : []),
    ],
    charts: d.often.length ? [{ type: 'bar', title: 'Missing most often (reports)', items: d.often.slice(0, 8).map((o) => ({ label: o.item, value: o.n, color: 'orange' })) }] : [],
  };
  const lines = [
    // The PDF prints the title itself; this is the line under it.
    `${d.type.writer ? `Written by ${d.type.writer}. ` : ''}${d.partial ? `So far: up to ${niceDay(d.through)}.` : 'The whole month.'}`,
    '',
    '```dashboard',
    JSON.stringify(dash),
    '```',
    '',
  ];
  if (summary) lines.push('## In short', '', summary, '');
  if (d.work.length) {
    lines.push('## Work done this month', '', '| Work | Total | Days |', '|---|---|---|');
    for (const w of d.work) lines.push(`| ${cell(w.what)} | ${cell(qty(w))} | ${w.days} |`);
    lines.push('');
  }
  if (d.materials.length) {
    lines.push('## Materials used', '', '| Material | Total | Days |', '|---|---|---|');
    for (const m of d.materials) lines.push(`| ${cell(m.what)} | ${cell(qty(m))} | ${m.days} |`);
    lines.push('');
  }
  if (d.units !== null) lines.push(`Units done in the month: **${d.units}**`, '');
  lines.push('## Day by day', '', '| Day | Report | Missing |', '|---|---|---|');
  const all = [...d.days.map((x) => ({ ...x, had: true })), ...d.missing.map((date) => ({ date, had: false }))].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const x of all) {
    lines.push(`| ${niceDay(x.date)} | ${x.had ? (x.gaps.length ? '🟠 Gaps' : '🟢 Complete') : '🔴 None'} | ${x.had ? cell(x.gaps.join(', ')) : 'No report came in'} |`);
  }
  lines.push('', `Made by Reem from the reports checked in Report checks, ${dubaiDate()}.`);
  return lines.join('\n');
}

/** The month's PDF: { bytes, name }. */
export async function monthlyPdf(typeId, month, { asker = ask, now = Date.now() } = {}) {
  const data = await monthData(typeId, month, now);
  const summary = await monthSummary(data, asker);
  const title = `${data.type.name} - ${monthName(month)}`;
  return { bytes: Buffer.from(await renderPdf({ title, markdown: monthMarkdown(data, summary), date: new Date(now) })), name: pdfName(title) };
}

/**
 * On the 1st, from 08:00 Dubai: last month's report for each active type that had reports, and a
 * buzz to the master that opens it. Once per type and month.
 */
export async function watchMonthly({ now = Date.now(), asker = ask, pusher = sendPush } = {}) {
  const today = dubaiDate(now);
  if (today.slice(8) !== '01' || dubaiHour(now) < SEND_HOUR) return [];
  const month = prevMonth(today.slice(0, 7));
  const types = await db.prepare('SELECT id, name FROM report_types WHERE active ORDER BY id').all();
  const to = (await db.prepare("SELECT id FROM users WHERE role = 'master' AND NOT disabled").all()).map((u) => u.id);
  const sent = [];
  for (const t of types) {
    const d = await monthData(t.id, month, now);
    if (!d.reports) continue;
    const mark = await db.prepare('INSERT INTO report_check_marks (key) VALUES (?) ON CONFLICT DO NOTHING RETURNING key').get(`monthly:${t.id}:${month}`);
    if (!mark) continue;
    await monthSummary(d, asker).catch((e) => console.error('[report checks] monthly', e.message));
    await pusher(to, {
      title: `${t.name} · ${monthName(month)}`,
      body: `Monthly report: ${d.reports} report${d.reports === 1 ? '' : 's'}, ${d.withGaps} with something missing, ${d.missing.length} day${d.missing.length === 1 ? '' : 's'} with none. Tap to open.`,
      url: `/api/report-checks/types/${t.id}/monthly?month=${month}`,
      tag: `report-monthly-${t.id}`,
    });
    sent.push({ type: t.id, month });
  }
  return sent;
}
