// A drawing inside a Reem reply: a floor plan, a layout, a flowchart, an org chart.
//
// The agent never draws a picture. It writes the drawing as a list of shapes, in JSON, in a
// ```drawing block, with real sizes when it has them ("unit": "m"). Everything else is made
// from that one list, so every copy matches: the picture in the chat (SVG, here), the PDF
// and the AutoCAD file (drawing.js, on the server) and the PNG (made from the SVG in the app).
//
// This file is shared: the server imports it, and so does the app (client/src/lib/drawing.js),
// so it may not import anything. Coordinates are the drawing's own - metres for a plan - with
// x to the right and y down. Text sizes are page sizes and never scale with the drawing.

const FENCE = /```drawing[^\S\n]*\n?([\s\S]*?)(\n```|$)/g;
const EXPORT = /<!--\s*export:(pdf|png|dxf)\s*-->/i;

export const COLORS = {
  green: { fill: '#dff3ea', line: '#1f6b4f', ink: '#174d39' },
  blue: { fill: '#e3eefa', line: '#3a7bd5', ink: '#1d3f73' },
  sand: { fill: '#efece6', line: '#8a8174', ink: '#2b2a28' },
  red: { fill: '#d64545', line: '#8f2323', ink: '#8f2323' },
  orange: { fill: '#f5c26b', line: '#b07a1c', ink: '#7a5210' },
  yellow: { fill: '#fbf1c7', line: '#a88a17', ink: '#6b570c' },
  purple: { fill: '#ece6f7', line: '#6b4fa8', ink: '#4a3380' },
  grey: { fill: '#eeeeee', line: '#8a8a8a', ink: '#444444' },
  black: { fill: '#ffffff', line: '#111111', ink: '#111111' },
};
const INK = '#1f1f1f';
const SOFT = '#666666';
const SIZE = { s: 11, m: 13, l: 16 };
const WEIGHT = { thin: 1, normal: 1.6, thick: 4 };
const DASH = [6, 4];

// ---------- reading it out of a reply ----------

/**
 * A reply cut into its text and its drawings, in order: { text } | { drawing } | { pending }.
 * `pending` is a block still arriving; `drawing` is null when a finished block would not read.
 */
export function splitDrawings(content) {
  const text = String(content || '');
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push(m[2] ? { drawing: readDrawing(m[1]) } : { pending: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** The last drawing in a reply that reads, or null. */
export const lastDrawing = (content) => splitDrawings(content).filter((p) => p.drawing).at(-1)?.drawing ?? null;

/** The reply with its drawings taken out: what is copied or read aloud. */
export const withoutDrawings = (content) => splitDrawings(content).filter((p) => p.text).map((p) => p.text).join('').trim();

/** The file a reply hands over for an earlier drawing ("convert into pdf"): 'pdf' | 'png' | 'dxf' | null. */
export const exportAsked = (content) => EXPORT.exec(String(content || ''))?.[1].toLowerCase() ?? null;

export function readDrawing(src) {
  try {
    return normalize(JSON.parse(src));
  } catch {
    return null;
  }
}

// ---------- checking what the agent wrote ----------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v
  : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : null);
const str = (v, max = 120) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
const pt = (p) => (Array.isArray(p) && num(p[0]) != null && num(p[1]) != null ? [num(p[0]), num(p[1])] : null);
const color = (c, fallback) => (COLORS[c] ? c : fallback);

function shape(s) {
  if (!s || typeof s !== 'object') return null;
  const base = { label: str(s.label, 60), dash: !!s.dash };
  switch (s.type) {
    case 'rect': {
      const [x, y, w, h] = [num(s.x), num(s.y), num(s.w), num(s.h)];
      if (x == null || y == null || !(w > 0) || !(h > 0)) return null;
      return { type: 'rect', x, y, w, h, ...base, note: str(s.note, 60), color: color(s.color, 'sand'), fill: s.fill !== false, round: s.round !== false };
    }
    case 'line': {
      const points = (Array.isArray(s.points) ? s.points : []).slice(0, 200).map(pt).filter(Boolean);
      if (points.length < 2) return null;
      return { type: 'line', points, ...base, color: color(s.color, 'black'), weight: WEIGHT[s.weight] ? s.weight : 'normal', arrow: !!s.arrow };
    }
    case 'circle': {
      const [x, y, r] = [num(s.x), num(s.y), num(s.r)];
      if (x == null || y == null || !(r > 0)) return null;
      return { type: 'circle', x, y, r, ...base, color: color(s.color, 'grey') };
    }
    case 'arc': {
      const [x, y, r, from, to] = [num(s.x), num(s.y), num(s.r), num(s.from) ?? 0, num(s.to) ?? 90];
      if (x == null || y == null || !(r > 0) || to === from) return null;
      return { type: 'arc', x, y, r, from: Math.min(from, to), to: Math.max(from, to), ...base, color: color(s.color, 'black') };
    }
    case 'text': {
      const [x, y] = [num(s.x), num(s.y)];
      const text = str(s.text ?? s.label, 120);
      if (x == null || y == null || !text) return null;
      return { type: 'text', x, y, text, size: SIZE[s.size] ? s.size : 'm', bold: !!s.bold, italic: !!s.italic,
        color: COLORS[s.color] ? s.color : null, align: ['start', 'middle', 'end'].includes(s.align) ? s.align : 'middle' };
    }
    case 'dim': {
      const [from, to] = [pt(s.from), pt(s.to)];
      if (!from || !to || (from[0] === to[0] && from[1] === to[1])) return null;
      return { type: 'dim', from, to, offset: num(s.offset) ?? 0, label: str(s.label, 30) };
    }
    default:
      return null;
  }
}

/** The drawing the agent wrote, checked and tidied, or null when there is nothing to draw. */
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const shapes = (Array.isArray(raw.shapes) ? raw.shapes : []).slice(0, 500).map(shape).filter(Boolean);
  if (!shapes.length) return null;
  const legend = (Array.isArray(raw.legend) ? raw.legend : []).slice(0, 12)
    .map((l) => ({ color: color(l?.color, null), label: str(l?.label, 40) })).filter((l) => l.color && l.label);
  return { title: str(raw.title, 100) || 'Drawing', subtitle: str(raw.subtitle, 160), unit: raw.unit === 'm' ? 'm' : '', shapes, legend, note: str(raw.note, 400) };
}

// ---------- size ----------

const arcPoint = (x, y, r, deg) => [x + r * Math.cos((deg * Math.PI) / 180), y + r * Math.sin((deg * Math.PI) / 180)];
function arcPoints(s) {
  const pts = [];
  for (let a = s.from; a < s.to; a += 10) pts.push(arcPoint(s.x, s.y, s.r, a));
  return [...pts, arcPoint(s.x, s.y, s.r, s.to)];
}

/**
 * A measurement line's ends, moved `offset` off what it measures: a plus offset moves a
 * level line down and an upright one right, whichever way round its ends were given.
 * `n` is the way a plus offset moves, `upright` whether it reads up the page.
 */
export function dimEnds(s) {
  const [dx, dy] = [s.to[0] - s.from[0], s.to[1] - s.from[1]];
  const len = Math.hypot(dx, dy);
  const upright = Math.abs(dy) > Math.abs(dx);
  let [nx, ny] = [-dy / len, dx / len];
  if ((upright ? nx : ny) < 0) [nx, ny] = [-nx, -ny];
  return { a: [s.from[0] + nx * s.offset, s.from[1] + ny * s.offset], b: [s.to[0] + nx * s.offset, s.to[1] + ny * s.offset], n: [nx, ny], upright };
}

/** Where the shapes reach, in the drawing's own units (text left out: its size is not in them). */
export function extent(d) {
  const pts = d.shapes.flatMap((s) => {
    if (s.type === 'rect') return [[s.x, s.y], [s.x + s.w, s.y + s.h]];
    if (s.type === 'line') return s.points;
    if (s.type === 'circle') return [[s.x - s.r, s.y - s.r], [s.x + s.r, s.y + s.r]];
    if (s.type === 'arc') return arcPoints(s);
    if (s.type === 'dim') { const { a, b } = dimEnds(s); return [a, b]; }
    return [[s.x, s.y]];
  });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return { x0, y0, x1, y1, w: Math.max(x1 - x0, 1e-6), h: Math.max(y1 - y0, 1e-6) };
}

/** Page units per drawing unit for the on-screen picture: about 760 across. */
export function screenScale(d) {
  const e = extent(d);
  return Math.min(760 / e.w, 900 / e.h);
}

// A guess at how wide text sets: good enough to keep labels on the page.
export const textWidth = (t, size, bold) => String(t).length * size * (bold ? 0.58 : 0.52);

// ---------- laid out on a page ----------

/**
 * The drawing as page items at `k` page units per drawing unit, its text at `text` times
 * the screen size, with where they all reach:
 * { items, box }. Items are { kind: 'path', d, fill, stroke, width, dash } and
 * { kind: 'text', x, y, text, size, bold, italic, color, anchor, rotate }, y down. The SVG
 * and the PDF are both drawn from these, so they cannot disagree.
 */
export function layout(d, k, { text: z = 1 } = {}) {
  // `z` sizes every word and gap, so a PDF shrunk to fit a scale shrinks its labels with it.
  const S = { s: SIZE.s * z, m: SIZE.m * z, l: SIZE.l * z };
  const items = [];
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const reach = (x0, y0, x1, y1) => {
    box.x0 = Math.min(box.x0, x0); box.y0 = Math.min(box.y0, y0);
    box.x1 = Math.max(box.x1, x1); box.y1 = Math.max(box.y1, y1);
  };
  const P = ([x, y]) => [x * k, y * k];
  const path = (dd, style, pts) => {
    items.push({ kind: 'path', d: dd, fill: null, stroke: null, width: 1, dash: null, ...style });
    const pad = (style.width || 0) / 2;
    for (const [x, y] of pts) reach(x - pad, y - pad, x + pad, y + pad);
  };
  const text = (x, y, t, { size = SIZE.m, bold = false, italic = false, color = INK, anchor = 'middle', rotate = 0 } = {}) => {
    if (!t) return;
    const w = textWidth(t, size, bold);
    const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    items.push({ kind: 'text', x, y, text: t, size, bold, italic, color, anchor, rotate });
    if (rotate) reach(x - size, y - w / 2, x + size, y + w / 2);
    else reach(x0, y - size * 0.8, x0 + w, y + size * 0.25);
  };
  const f = (n) => Math.round(n * 100) / 100;
  const poly = (pts, close) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')}${close ? ' Z' : ''}`;

  for (const s of d.shapes) {
    const c = COLORS[s.color] || COLORS.black;
    const dash = s.dash ? DASH : null;
    if (s.type === 'rect') {
      const [x, y] = P([s.x, s.y]);
      const [w, h] = [s.w * k, s.h * k];
      const r = s.round ? Math.min(6, w / 4, h / 4) : 0;
      const dd = r ? `M${f(x + r)} ${f(y)} H${f(x + w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)} V${f(y + h - r)} ` +
        `A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)} H${f(x + r)} A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)} ` +
        `V${f(y + r)} A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)} Z` : poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
      path(dd, { fill: s.fill ? c.fill : null, stroke: c.line, width: 1, dash }, [[x, y], [x + w, y + h]]);
      const lines = [s.label && [s.label, S.m, true], s.note && [s.note, S.s, false]].filter(Boolean);
      const tall = lines.reduce((n, [, size]) => n + size * 1.3, 0);
      let ty = y + h / 2 - tall / 2;
      for (const [t, size, bold] of lines) {
        ty += size * 1.3;
        // A label wider than its box is set smaller, down to two thirds, before it spills out.
        const fit = Math.max(size * 0.66, Math.min(size, (size * (w - 6)) / textWidth(t, size, bold)));
        text(x + w / 2, ty - size * 0.3, t, { size: fit, bold, color: c.ink });
      }
    } else if (s.type === 'line') {
      const pts = s.points.map(P);
      const width = WEIGHT[s.weight];
      path(poly(pts), { stroke: c.line, width, dash }, pts);
      if (s.arrow) {
        const [[ax, ay], [bx, by]] = pts.slice(-2);
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const [ux, uy] = [(bx - ax) / len, (by - ay) / len];
        const size = (7 + width * 1.5) * z;
        const head = [[bx, by], [bx - ux * size - uy * size * 0.5, by - uy * size + ux * size * 0.5], [bx - ux * size + uy * size * 0.5, by - uy * size - ux * size * 0.5]];
        path(poly(head, true), { fill: c.line }, head);
      }
      if (s.label) {
        const i = Math.floor((pts.length - 1) / 2);
        const [[ax, ay], [bx, by]] = [pts[i], pts[i + 1]];
        // Beside an upright line, above a level one.
        if (Math.abs(by - ay) > Math.abs(bx - ax)) text((ax + bx) / 2 + width / 2 + 6 * z, (ay + by) / 2 + 4 * z, s.label, { size: S.s, color: c.ink, anchor: 'start' });
        else text((ax + bx) / 2, (ay + by) / 2 - width / 2 - 6 * z, s.label, { size: S.s, color: c.ink });
      }
    } else if (s.type === 'circle') {
      const [x, y] = P([s.x, s.y]);
      const r = s.r * k;
      path(`M${f(x - r)} ${f(y)} A${f(r)} ${f(r)} 0 1 0 ${f(x + r)} ${f(y)} A${f(r)} ${f(r)} 0 1 0 ${f(x - r)} ${f(y)} Z`,
        { fill: c.fill, stroke: c.line, width: 1, dash }, [[x - r, y - r], [x + r, y + r]]);
      if (s.label) text(x + r + 6 * z, y + 4 * z, s.label, { size: S.s, anchor: 'start', color: INK });
    } else if (s.type === 'arc') {
      const pts = arcPoints(s).map(P);
      const r = s.r * k;
      const sweep = s.to - s.from;
      const dd = sweep >= 360
        ? `M${f(pts[0][0])} ${f(pts[0][1])} A${f(r)} ${f(r)} 0 1 1 ${f(2 * s.x * k - pts[0][0])} ${f(2 * s.y * k - pts[0][1])} A${f(r)} ${f(r)} 0 1 1 ${f(pts[0][0])} ${f(pts[0][1])}`
        : `M${f(pts[0][0])} ${f(pts[0][1])} A${f(r)} ${f(r)} 0 ${sweep > 180 ? 1 : 0} 1 ${f(pts.at(-1)[0])} ${f(pts.at(-1)[1])}`;
      path(dd, { stroke: c.line, width: 1, dash }, pts);
    } else if (s.type === 'text') {
      const [x, y] = P([s.x, s.y]);
      text(x, y, s.text, { size: S[s.size], bold: s.bold, italic: s.italic, color: s.color ? COLORS[s.color].ink : INK, anchor: s.align });
    } else if (s.type === 'dim') {
      const { a, b, n, upright } = dimEnds(s);
      const [pa, pb] = [P(a), P(b)];
      const t = 7 * z;
      path(`${poly([pa, pb])} ${poly([[pa[0] - n[0] * t, pa[1] - n[1] * t], [pa[0] + n[0] * t, pa[1] + n[1] * t]])} ` +
        poly([[pb[0] - n[0] * t, pb[1] - n[1] * t], [pb[0] + n[0] * t, pb[1] + n[1] * t]]), { stroke: '#333333', width: 1 }, [pa, pb]);
      const [mx, my] = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      // The label sits on the outer side of the line, away from what it measures.
      const side = s.offset < 0 ? -1 : 1;
      const [ox, oy] = [n[0] * side, n[1] * side];
      if (upright) {
        // Turned to read upwards, the letters stand on the right of their anchor.
        text(ox < 0 ? mx - 6 * z : mx + (6 + S.m * 0.8) * z, my, s.label, { size: S.m, rotate: -90 });
      } else text(mx, oy > 0 ? my + 18 * z : my - 6 * z, s.label, { size: S.m });
    }
  }

  // Title above, legend and note below, all lined up with the drawing's left edge.
  const body = { ...box };
  if (d.subtitle) text(body.x0, body.y0 - 22 * z, d.subtitle, { size: 12 * z, color: SOFT, anchor: 'start' });
  text(body.x0, body.y0 - (d.subtitle ? 44 : 22) * z, d.title, { size: 22 * z, bold: true, anchor: 'start' });
  let y = body.y1 + 28 * z;
  if (d.legend.length) {
    let x = body.x0;
    for (const l of d.legend) {
      const w = (22 + 18) * z + textWidth(l.label, S.s);
      if (x > body.x0 && x + w > Math.max(body.x1, body.x0 + 360 * z)) { x = body.x0; y += 22 * z; }
      const c = COLORS[l.color];
      const [top, q] = [y - 11 * z, 14 * z];
      path(poly([[x, top], [x + q, top], [x + q, top + q], [x, top + q]], true), { fill: c.fill, stroke: c.line, width: 1 }, [[x, top], [x + q, top + q]]);
      text(x + 20 * z, y, l.label, { size: S.s, anchor: 'start' });
      x += w;
    }
    y += 24 * z;
  }
  if (d.note) {
    const room = Math.max(body.x1 - body.x0, 360 * z);
    for (const line of wrap(d.note, room, S.s)) {
      text(body.x0, y, line, { size: S.s, italic: true, color: SOFT, anchor: 'start' });
      y += 16 * z;
    }
  }
  return { items, box };
}

function wrap(t, room, size) {
  const lines = [];
  let line = '';
  for (const word of t.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size) > room) { lines.push(line); line = word; } else line = next;
  }
  return line ? [...lines, line] : lines;
}

// ---------- as SVG ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The drawing as a self-contained SVG, on white: the picture in the chat and the PNG. */
export function toSvg(d) {
  const { items, box } = layout(d, screenScale(d));
  const pad = 24;
  const [x, y, w, h] = [box.x0 - pad, box.y0 - pad, box.x1 - box.x0 + pad * 2, box.y1 - box.y0 + pad * 2].map((n) => Math.round(n));
  const body = items.map((it) => {
    if (it.kind === 'path') {
      return `<path d="${it.d}" fill="${it.fill || 'none'}"${it.stroke ? ` stroke="${it.stroke}" stroke-width="${it.width}"` : ''}` +
        `${it.dash ? ` stroke-dasharray="${it.dash.join(' ')}"` : ''} stroke-linejoin="round"/>`;
    }
    return `<text x="${it.x.toFixed(1)}" y="${it.y.toFixed(1)}" font-size="${it.size}" fill="${it.color}" text-anchor="${it.anchor}"` +
      `${it.bold ? ' font-weight="bold"' : ''}${it.italic ? ' font-style="italic"' : ''}` +
      `${it.rotate ? ` transform="rotate(${it.rotate} ${it.x.toFixed(1)} ${it.y.toFixed(1)})"` : ''}>${esc(it.text)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}" ` +
    `font-family="Helvetica, Arial, sans-serif"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>${body}</svg>`;
}

/** A file name from the drawing's title that every phone's file system accepts. */
export const drawingFileName = (title, ext) =>
  `${String(title).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Drawing'}.${ext}`;
