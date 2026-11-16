// A dashboard inside a Reem reply: a few number boxes and bar charts over the answer's data.
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

/** A dashboard read from the model's JSON, cut to what can be drawn. Null when nothing can be. */
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tiles = (Array.isArray(raw.tiles) ? raw.tiles : []).slice(0, 8)
    .map((t) => ({ label: str(t?.label, 60), value: str(t?.value, 30), note: str(t?.note, 80), color: colorOf(t?.color) }))
    .filter((t) => t.label && t.value);
  const charts = (Array.isArray(raw.charts) ? raw.charts : []).slice(0, 4).map((c) => ({
    title: str(c?.title, 80),
    unit: str(c?.unit, 20),
    bars: (Array.isArray(c?.bars) ? c.bars : []).slice(0, 40)
      .map((b) => ({ label: str(b?.label, 60), value: num(b?.value), note: str(b?.note, 60), color: colorOf(b?.color) || DEFAULT }))
      .filter((b) => b.label && b.value !== null && b.value >= 0),
  })).filter((c) => c.bars.length);
  if (!tiles.length && !charts.length) return null;
  const used = new Set([...tiles.map((t) => t.color), ...charts.flatMap((c) => c.bars.map((b) => b.color))]);
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
  const max = Math.max(...chart.bars.map((b) => b.value));
  return max > 0 ? bar.value / max : 0;
};

/** A bar's number as shown: 201600 → "201,600", with the chart's unit after it. */
export const barValue = (chart, bar) => `${bar.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${chart.unit ? ` ${chart.unit}` : ''}`;
