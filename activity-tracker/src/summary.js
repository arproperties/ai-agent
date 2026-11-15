// The day summary: the spans of one date boiled down to the JSON Reem's door expects
// (see docs/superpowers/plans/2026-11-15-activity-tracker.md, "The contract"). Only this
// summary leaves the PC; the spans themselves stay in the local database and are pruned.

// Dubai is UTC+4 all year with no summer time, so fixed arithmetic is exact and cheap.
const OFFSET = 4 * 3600;
const shifted = (epoch) => new Date((epoch + OFFSET) * 1000).toISOString();

/** 'YYYY-MM-DD' in Dubai for an epoch in seconds. */
export const dubaiDate = (epoch) => shifted(epoch).slice(0, 10);
/** 'HH:MM' in Dubai for an epoch in seconds. */
export const dubaiTime = (epoch) => shifted(epoch).slice(11, 16);

/** [start, end) of a Dubai date as epoch seconds. */
export function dayBounds(date) {
  const [y, m, d] = date.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d) / 1000 - OFFSET;
  return [start, start + 86400];
}

/** The epoch second at which the Dubai day after `epoch` begins. */
function nextMidnight(epoch) {
  const [y, m, d] = dubaiDate(epoch).split('-').map(Number);
  return Date.UTC(y, m - 1, d + 1) / 1000 - OFFSET;
}

/**
 * A span that crosses Dubai midnight becomes two, one per date, so someone working at
 * half past midnight is counted on each day correctly and never as a 25-hour day.
 */
export function splitAtMidnight(spans) {
  const out = [];
  for (const s of spans) {
    let cur = s;
    for (;;) {
      const mid = nextMidnight(cur.startedAt);
      if (cur.endedAt <= mid) { out.push(cur); break; }
      out.push({ ...cur, endedAt: mid });
      cur = { ...cur, startedAt: mid };
    }
  }
  return out;
}

// Programs that put their own name at the end of every window title.
const SUFFIXES = ['Google Chrome', 'Mozilla Firefox', 'Microsoft Edge', 'Microsoft Excel', 'Excel', 'Microsoft Word', 'Word',
  'Microsoft PowerPoint', 'PowerPoint', 'Microsoft Outlook', 'Outlook', 'Visual Studio Code', 'Notepad', 'Brave', 'Opera'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A window title as the office would say it: without the program's name tacked on the end
 * ("… - Google Chrome", "… — Mozilla Firefox") and without a site's padding after " | ".
 */
export function cleanTitle(app, title) {
  let t = String(title || '').trim();
  const names = [...new Set([app, ...SUFFIXES].filter(Boolean))].map(escapeRe).join('|');
  t = t.replace(new RegExp(`\\s+[-–—]\\s+(${names})$`, 'i'), '');
  const bar = t.indexOf(' | ');
  if (bar > 0) t = t.slice(0, bar);
  return t.trim();
}

const length = (s) => s.endedAt - s.startedAt;

/**
 * One date's spans and running segments as the contract JSON. Spans are split at midnight
 * and only those on `date` count; `apps` and `active_seconds` come from active spans alone.
 */
export function summarise(spans, running, date) {
  const all = splitAtMidnight(spans).filter((s) => dubaiDate(s.startedAt) === date && s.endedAt > s.startedAt);
  // The day runs from the first to the last sign of a person (active or idle). A PC locked
  // overnight is not fourteen hours "away": away counts only between those two marks.
  const present = all.filter((s) => s.kind !== 'away');
  if (!present.length) return { date, first_seen: '00:00', last_seen: '00:00', active_seconds: 0, idle_seconds: 0, away_seconds: 0, running: [], apps: [] };
  const first = Math.min(...present.map((s) => s.startedAt));
  const last = Math.max(...present.map((s) => s.endedAt));
  const day = all.filter((s) => s.kind !== 'away' || (s.startedAt >= first && s.endedAt <= last));
  const seconds = (kind) => day.filter((s) => s.kind === kind).reduce((n, s) => n + length(s), 0);

  const byApp = {};
  for (const s of day.filter((s) => s.kind === 'active')) {
    const app = (byApp[s.app] ||= { name: s.app, seconds: 0, titles: {} });
    app.seconds += length(s);
    const title = cleanTitle(s.app, s.title);
    app.titles[title] = (app.titles[title] || 0) + length(s);
  }
  const apps = Object.values(byApp).sort((a, b) => b.seconds - a.seconds).map((a) => ({
    name: a.name, seconds: a.seconds,
    titles: Object.entries(a.titles).map(([title, secs]) => ({ title, seconds: secs })).sort((x, y) => y.seconds - x.seconds).slice(0, 5),
  }));

  // Running segments clipped to this day; one still open closes at the day's last activity.
  const [dayStart, dayEnd] = dayBounds(date);
  const segments = (running || [])
    .map(([from, to]) => [from, to ?? last])
    .map(([from, to]) => [Math.max(from, dayStart), Math.min(to, dayEnd)])
    .filter(([from, to]) => to > from)
    .map(([from, to]) => [dubaiTime(from), dubaiTime(to)]);

  return {
    date, first_seen: dubaiTime(first), last_seen: dubaiTime(last),
    active_seconds: seconds('active'), idle_seconds: seconds('idle'), away_seconds: seconds('away'),
    running: segments, apps,
  };
}
