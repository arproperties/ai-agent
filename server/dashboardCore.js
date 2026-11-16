// A dashboard inside a Reem reply: number boxes and charts (bars, donut rings, trend lines,
// gauges, a timeline) over the answer's data, picked by the agent to suit the question.
//
// Asked for "a chart of each case, how many rooms, status colour-coded", the agent could only
// write a table, and its colour key named colours the rows did not show. Now it writes the
// numbers as JSON in a ```dashboard block and the app draws them: the boxes and bars in the
// chat (DashboardCard.jsx) and the same in the reply's PDF (replyDoc.js). The colour key is
// cut down to the colours the bars and boxes really use, so it cannot name one that is not there.
//
// It is a one-off picture of that answer: nothing is saved or refreshed by itself.
//
// This file is shared: the server imports it, and so does the app, so it may not import anything.

const FENCE = /```dashboard[^\S\n]*\n?([\s\S]*?)(\n```|$)/g;

// The same eight colours as the table row marks (🟢 🟡 🟠 🔴 🩷 🔵 🟣 ⚪), so a bar and its
// table row are the same colour. Values are "r, g, b".
export const COLORS = {
  green: '34, 197, 94',
  yellow: '250, 204, 21',
  orange: '249, 115, 22',
  red: '239, 68, 68',
  pink: '236, 72, 153',
  blue: '59, 130, 246',
  purple: '168, 85, 247',
  grey: '148, 163, 184',
};
const DEFAULT = 'blue';
const ALIAS = { gray: 'grey', amber: 'orange', gold: 'yellow', violet: 'purple', white: 'grey' };

const str = (v, max) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
const colorOf = (c) => {
  const k = str(c, 20).toLowerCase();
  return COLORS[k] ? k : ALIAS[k] || null;
};
// "24", "AED 201,600" and 24 all count; a bar with no number is left out.
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /-?\d[\d,]*(\.\d+)?/.exec(String(v ?? ''));
  return m ? Number(m[0].replace(/,/g, '')) : null;
};

const TYPES = ['bar', 'donut', 'line', 'gauge', 'timeline'];
// "2026-11-23", "23/11/2026" and "23 Nov 2026" all sort; anything else keeps its place.
const when = (v) => {
  const t = str(v, 40);
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return Date.UTC(+m[1], m[2] - 1, +m[3]);
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t))) return Date.UTC(+m[3], m[2] - 1, +m[1]);
  const d = Date.parse(t);
  return Number.isNaN(d) ? null : d;
};

// One chart, by its type. The model may call the list "items" or "bars"; both are read.
function chartOf(c) {
  const type = TYPES.includes(str(c?.type, 12).toLowerCase()) ? str(c.type, 12).toLowerCase() : 'bar';
  const raw = (Array.isArray(c?.items) ? c.items : Array.isArray(c?.bars) ? c.bars : []).slice(0, type === 'line' ? 60 : 40);
  const base = { type, title: str(c?.title, 80), unit: str(c?.unit, 20) };
  if (type === 'timeline') {
    const items = raw.map((i, n) => ({ date: str(i?.date, 30), label: str(i?.label, 80), note: str(i?.note, 120), color: colorOf(i?.color) || DEFAULT, at: when(i?.date), n }))
      .filter((i) => i.label);
    items.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.n - b.n);
    return { ...base, items: items.map(({ at, n, ...i }) => i) };
  }
  const items = raw.map((i) => ({
    label: str(i?.label, 60), value: num(i?.value), note: str(i?.note, 80), color: colorOf(i?.color) || colorOf(c?.color) || DEFAULT,
    ...(type === 'gauge' && { max: num(i?.max) }),
  })).filter((i) => i.label && i.value !== null && (type === 'line' || i.value >= 0));
  // A gauge needs something to be out of: its own max, else 100 for a percentage.
  if (type === 'gauge') items.forEach((i) => { if (!(i.max > 0)) i.max = Math.max(100, i.value); });
  return { ...base, items, ...(type === 'line' && { color: colorOf(c?.color) || DEFAULT }) };
}

/** A dashboard read from the model's JSON, cut to what can be drawn. Null when nothing can be. */
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tiles = (Array.isArray(raw.tiles) ? raw.tiles : []).slice(0, 8)
    .map((t) => ({ label: str(t?.label, 60), value: str(t?.value, 30), note: str(t?.note, 80), color: colorOf(t?.color) }))
    .filter((t) => t.label && t.value);
  const charts = (Array.isArray(raw.charts) ? raw.charts : []).slice(0, 6).map(chartOf)
    .filter((c) => c.items.length >= (c.type === 'line' ? 2 : 1));
  if (!tiles.length && !charts.length) return null;
  const used = new Set([...tiles.map((t) => t.color), ...charts.flatMap((c) => [c.color, ...c.items.map((i) => i.color)])]);
  const seen = new Set();
  const legend = (Array.isArray(raw.legend) ? raw.legend : [])
    .map((l) => ({ color: colorOf(l?.color), label: str(l?.label, 80) }))
    .filter((l) => l.color && l.label && used.has(l.color) && !seen.has(l.color) && seen.add(l.color));
  return { title: str(raw.title, 100), subtitle: str(raw.subtitle, 160), tiles, charts, legend };
}

export function readDashboard(src) {
  try { return normalize(JSON.parse(String(src || '').trim())); } catch { return null; }
}

/**
 * A text cut into its words and its dashboards, in order: { text } | { dashboard } | { pending }.
 * `pending` is a block still arriving; `dashboard` is null when a finished block would not read.
 */
export function splitDashboards(content) {
  const text = String(content || '');
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push(m[2] ? { dashboard: readDashboard(m[1]) } : { pending: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** The text with its dashboards taken out: what is copied. */
export const withoutDashboards = (content) => splitDashboards(content).filter((p) => p.text).map((p) => p.text).join('').trim();

/** How long each bar is, 0–1, against the longest in its chart. */
export const barShare = (chart, bar) => {
  const max = Math.max(...chart.items.map((b) => b.value));
  return max > 0 ? bar.value / max : 0;
};

/** A number as shown: 201600 → "201,600", with the chart's unit after it. */
export const barValue = (chart, bar) => `${bar.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${chart.unit ? ` ${chart.unit}` : ''}`;

/** A donut's slices as fractions of the whole, each { ...item, from, to } in 0–1. */
export function slices(chart) {
  const total = chart.items.reduce((a, i) => a + i.value, 0);
  let at = 0;
  return chart.items.map((i) => {
    const from = at;
    at += total > 0 ? i.value / total : 0;
    return { ...i, from, to: at, share: total > 0 ? i.value / total : 0 };
  });
}

/** An SVG path for a ring segment from fraction `from` to `to`, centred at cx, cy (clockwise from 12 o'clock). */
export function arcPath(cx, cy, r, from, to) {
  const span = Math.min(to - from, 0.99999);
  const pt = (f) => [cx + r * Math.sin(f * 2 * Math.PI), cy - r * Math.cos(f * 2 * Math.PI)];
  const [x1, y1] = pt(from);
  const [x2, y2] = pt(from + span);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${span > 0.5 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** A line chart's points in a w × h box: [{ x, y, ...item }], lowest value at the bottom. */
export function linePoints(chart, w, h) {
  const vals = chart.items.map((i) => i.value);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const n = chart.items.length;
  return chart.items.map((i, k) => ({ ...i, x: n > 1 ? (k / (n - 1)) * w : w / 2, y: h - ((i.value - lo) / span) * h }));
}

/** What a tap on one part of the dashboard asks Reem. */
export function askAbout(d, chart, item) {
  const where = [d?.title, chart?.title].filter(Boolean).join(' — ');
  const what = item.date ? `${item.date}: ${item.label}` : chart?.type === 'gauge' ? `${item.label} (${item.value} of ${item.max})`
    : item.value !== undefined ? `${item.label} (${barValue(chart || {}, item)})` : item.label;
  return `In the dashboard "${where || 'above'}", explain "${what}" in two or three short lines: what it is, why it has that colour, and what to do next.`;
}
