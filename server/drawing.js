// A drawing from a Jarvis reply as a file: an A4 PDF, or a DXF that AutoCAD opens. (The
// PNG is made in the app, from the same picture it shows.) What a drawing is, and how it is
// laid out, is drawingCore.js; this is the files and who may have them.
//
// A plan drawn in metres goes on the PDF at a standard scale - 1:25, 1:50 - so it can be
// measured with a ruler once printed at actual size. Anything else is fitted to the page.
// The DXF keeps the drawing's own units, so a plan arrives in AutoCAD in metres.
import { Router } from 'express';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { db } from './db.js';
import { lastDrawing, extent, layout, screenScale, dimEnds, drawingFileName } from './drawingCore.js';
import { sanitize } from './replyDoc.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- PDF ----------

const A4 = [841.89, 595.28]; // landscape; turned when the drawing is taller than wide
const MARGIN = 36;
const FOOT = 22; // room kept at the bottom for the scale line
const PT_PER_MM = 72 / 25.4;
const SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000, 20000, 50000];

const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const fits = (box, w, h) => box.x1 - box.x0 <= w && box.y1 - box.y0 <= h;

/** The biggest the drawing goes on a page `w` × `h`: { k, scale, laid } (scale is N of 1:N, or null). */
export function fitPage(d, w, h) {
  // Labels shrink with the drawing so they keep their place in it, but never past half
  // size, where they stop being readable on paper.
  const screen = screenScale(d);
  const lay = (k) => layout(d, k, { text: Math.min(1.2, Math.max(0.5, k / screen)) });
  if (d.unit === 'm') {
    for (const n of SCALES) {
      const k = (1000 / n) * PT_PER_MM;
      const laid = lay(k);
      if (fits(laid.box, w, h)) return { k, scale: n, laid };
    }
  }
  // Text stops shrinking at half size while the shapes go on, so fitting takes a few goes.
  const e = extent(d);
  let k = Math.min(w / e.w, h / e.h);
  let laid = lay(k);
  for (let i = 0; i < 40 && !fits(laid.box, w, h); i++) laid = lay((k *= 0.92));
  return { k, scale: null, laid };
}

/** The drawing on one A4 page. `date` is the reply's, so the same reply always gives the same file. */
export async function drawingPdf(d, { date = new Date() } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(sanitize(d.title));
  pdf.setCreator('Jarvis');
  pdf.setProducer('Jarvis');
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
  const F = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };

  const tries = [A4, [A4[1], A4[0]]].map(([pw, ph]) => ({ pw, ph, ...fitPage(d, pw - MARGIN * 2, ph - MARGIN * 2 - FOOT) }));
  const best = tries.reduce((a, b) => (b.k > a.k ? b : a));
  const { pw, ph, laid, scale } = best;
  const page = pdf.addPage([pw, ph]);
  const { box, items } = laid;
  // Centred in the space above the scale line.
  const ox = MARGIN + (pw - MARGIN * 2 - (box.x1 - box.x0)) / 2 - box.x0;
  const oy = MARGIN + (ph - MARGIN * 2 - FOOT - (box.y1 - box.y0)) / 2 - box.y0;

  for (const it of items) {
    if (it.kind === 'path') {
      page.drawSvgPath(it.d, {
        x: ox, y: ph - oy,
        ...(it.fill && { color: hex(it.fill) }),
        ...(it.stroke && { borderColor: hex(it.stroke), borderWidth: it.width, borderLineCap: 1 }),
        ...(it.dash && { borderDashArray: it.dash }),
      });
    } else {
      const font = it.bold ? F.bold : it.italic ? F.italic : F.regular;
      const t = sanitize(it.text);
      const w = font.widthOfTextAtSize(t, it.size);
      const shift = it.anchor === 'middle' ? w / 2 : it.anchor === 'end' ? w : 0;
      // pdf-lib turns anticlockwise with y up; the layout's -90 is the same turn with y down.
      const a = (-it.rotate * Math.PI) / 180;
      page.drawText(t, {
        x: ox + it.x - shift * Math.cos(a), y: ph - oy - it.y - shift * Math.sin(a),
        size: it.size, font, color: hex(it.color), ...(it.rotate && { rotate: degrees(-it.rotate) }),
      });
    }
  }

  const foot = [scale && `Scale 1:${scale} on A4 - print at actual size`, date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })]
    .filter(Boolean).join('   |   ');
  page.drawText(foot, { x: MARGIN, y: MARGIN - 12, size: 8, font: F.regular, color: hex('#888888') });
  return pdf.save();
}

// ---------- DXF ----------

// AutoCAD's own colour numbers, closest to the drawing's.
const ACI = { green: 3, blue: 5, sand: 9, red: 1, orange: 30, yellow: 2, purple: 6, grey: 8, black: 7 };

// DXF text is plain ANSI: anything else goes as AutoCAD's \U+XXXX.
const dxfText = (s) => [...String(s)].map((c) => (c.codePointAt(0) < 128 ? c : `\\U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)).join('');

/**
 * The drawing as a DXF (release 12, which every AutoCAD reads). In the drawing's own units
 * with y turned up the way CAD has it; one layer per colour, and text on its own layer.
 */
export function drawingDxf(d) {
  const out = [];
  const g = (...pairs) => { for (let i = 0; i < pairs.length; i += 2) out.push(String(pairs[i]), String(pairs[i + 1])); };
  const n = (v) => Number(v.toFixed(6));
  const Y = (y) => n(-y);
  const k = screenScale(d); // text as tall as it looks on screen
  const h = (size) => n((size * 0.72) / k);
  const layer = (c) => (c ? c.toUpperCase() : 'TEXT');
  const lt = (dash) => (dash ? 'DASHED' : 'CONTINUOUS');
  // A thick line (a wall, a window) is a polyline with a width: R12 has no line weights.
  const line = (pts, c, closed = false, dash = false, thick = false) => {
    if (pts.length === 2 && !closed && !thick) {
      g(0, 'LINE', 8, layer(c), 6, lt(dash), 62, ACI[c], 10, n(pts[0][0]), 20, Y(pts[0][1]), 11, n(pts[1][0]), 21, Y(pts[1][1]));
      return;
    }
    g(0, 'POLYLINE', 8, layer(c), 6, lt(dash), 62, ACI[c], 66, 1, 70, closed ? 1 : 0);
    if (thick) g(40, n(4 / k), 41, n(4 / k));
    for (const [x, y] of pts) g(0, 'VERTEX', 8, layer(c), 10, n(x), 20, Y(y));
    g(0, 'SEQEND', 8, layer(c));
  };
  // align: 0 left, 1 centre, 2 right; middle: 0 on the baseline, 2 centred on the point.
  const text = (x, y, t, { size = 13, align = 1, middle = 0, rotate = 0 } = {}) => {
    if (!t) return;
    g(0, 'TEXT', 8, 'TEXT', 62, 7, 10, n(x), 20, Y(y), 40, h(size), 1, dxfText(t));
    if (rotate) g(50, rotate);
    if (align || middle) g(72, align, 73, middle, 11, n(x), 21, Y(y));
  };

  g(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009');
  if (d.unit === 'm') g(9, '$INSUNITS', 70, 6);
  g(0, 'ENDSEC', 0, 'SECTION', 2, 'TABLES');
  // Dashes as long as they look on screen.
  g(0, 'TABLE', 2, 'LTYPE', 70, 2,
    0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0,
    0, 'LTYPE', 2, 'DASHED', 70, 0, 3, 'Dashed', 72, 65, 73, 2, 40, n(10 / k), 49, n(6 / k), 49, n(-4 / k), 0, 'ENDTAB');
  const layers = [...new Set([...d.shapes.filter((s) => s.color).map((s) => s.color)])];
  g(0, 'TABLE', 2, 'LAYER', 70, layers.length + 2);
  for (const [name, color] of [...layers.map((c) => [layer(c), ACI[c]]), ['TEXT', 7], ['DIMS', 7]]) g(0, 'LAYER', 2, name, 70, 0, 62, color, 6, 'CONTINUOUS');
  g(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  for (const s of d.shapes) {
    if (s.type === 'rect') {
      line([[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]], s.color, true, s.dash);
      if (s.label && s.note) {
        text(s.x + s.w / 2, s.y + s.h / 2 - h(13) * 0.7, s.label, { middle: 2 });
        text(s.x + s.w / 2, s.y + s.h / 2 + h(11) * 0.9, s.note, { size: 11, middle: 2 });
      } else text(s.x + s.w / 2, s.y + s.h / 2, s.label || s.note, { middle: 2 });
    } else if (s.type === 'line') {
      line(s.points, s.color, false, s.dash, s.weight === 'thick');
      if (s.arrow) {
        const [[ax, ay], [bx, by]] = s.points.slice(-2);
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const [ux, uy, size] = [(bx - ax) / len, (by - ay) / len, 9 / k];
        line([[bx - ux * size - uy * size * 0.5, by - uy * size + ux * size * 0.5], [bx, by], [bx - ux * size + uy * size * 0.5, by - uy * size - ux * size * 0.5]], s.color);
      }
      if (s.label) {
        const i = Math.floor((s.points.length - 1) / 2);
        const [[ax, ay], [bx, by]] = [s.points[i], s.points[i + 1]];
        if (Math.abs(by - ay) > Math.abs(bx - ax)) text((ax + bx) / 2 + 8 / k, (ay + by) / 2, s.label, { size: 11, align: 0, middle: 2 });
        else text((ax + bx) / 2, (ay + by) / 2 - 8 / k, s.label, { size: 11 });
      }
    } else if (s.type === 'circle') {
      g(0, 'CIRCLE', 8, layer(s.color), 6, lt(s.dash), 62, ACI[s.color], 10, n(s.x), 20, Y(s.y), 40, n(s.r));
      if (s.label) text(s.x + s.r + 6 / k, s.y, s.label, { size: 11, align: 0, middle: 2 });
    } else if (s.type === 'arc') {
      // y down turns clockwise into y up anticlockwise, so the ends swap and flip.
      if (s.to - s.from >= 360) g(0, 'CIRCLE', 8, layer(s.color), 6, lt(s.dash), 62, ACI[s.color], 10, n(s.x), 20, Y(s.y), 40, n(s.r));
      else g(0, 'ARC', 8, layer(s.color), 6, lt(s.dash), 62, ACI[s.color], 10, n(s.x), 20, Y(s.y), 40, n(s.r), 50, n(-s.to), 51, n(-s.from));
    } else if (s.type === 'text') {
      text(s.x, s.y, s.text, { size: { s: 11, m: 13, l: 16 }[s.size], align: { start: 0, middle: 1, end: 2 }[s.align] });
    } else if (s.type === 'dim') {
      const { a, b, n: [nx, ny], upright } = dimEnds(s);
      g(0, 'LINE', 8, 'DIMS', 62, 7, 10, n(a[0]), 20, Y(a[1]), 11, n(b[0]), 21, Y(b[1]));
      // The label goes on the outer side, away from what it measures.
      const out = ((s.offset < 0 ? -1 : 1) * 10) / k;
      text((a[0] + b[0]) / 2 + nx * out, (a[1] + b[1]) / 2 + ny * out, s.label, { rotate: upright ? 90 : 0, middle: 2 });
    }
  }
  const e = extent(d);
  text(e.x0, e.y0 - 30 / k, d.title, { size: 22, align: 0 });
  g(0, 'ENDSEC', 0, 'EOF');
  return `${out.join('\r\n')}\r\n`;
}

// ---------- routes ----------

/** The last drawing in message `messageId`, for its owner only. */
async function find(userId, messageId) {
  const m = await db.prepare(`SELECT m.content, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND c.user_id = ? AND m.role = 'assistant'`).get(Number(messageId) || 0, userId);
  if (!m) throw bad('That message was not found', 404);
  const drawing = lastDrawing(m.content);
  if (!drawing) throw bad('There is no drawing in that message');
  return { drawing, date: new Date(Number(m.created_at) * 1000) };
}

const attach = (res, name) => res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);

export const drawingRoutes = Router();

drawingRoutes.get('/:id/drawing/pdf', wrap(async (req, res) => {
  const { drawing, date } = await find(req.user.id, req.params.id);
  attach(res, drawingFileName(drawing.title, 'pdf'));
  res.type('application/pdf').send(Buffer.from(await drawingPdf(drawing, { date })));
}));

drawingRoutes.get('/:id/drawing/dxf', wrap(async (req, res) => {
  const { drawing } = await find(req.user.id, req.params.id);
  attach(res, drawingFileName(drawing.title, 'dxf'));
  res.type('application/dxf').send(drawingDxf(drawing));
}));
