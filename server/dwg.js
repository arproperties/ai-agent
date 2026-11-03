import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

const run = promisify(execFile);

export const DRAWING_EXT = ['dwg', 'dxf'];
export const isDrawing = (name) => DRAWING_EXT.includes(String(name).split('.').pop().toLowerCase());

// Drawings are bigger than other files, so they get their own limit. dwg2dxf holds the whole
// drawing in memory, about 20 times its size (a 31 MB drawing took 590 MB), and the server
// has under 2 GB: past this a single drawing could starve Reem itself.
export const MAX_DRAWING_MB = 35;

// A drawing set saved as PDF runs large too: a 51-page Trakhees building-permit set exported
// from CAD came to 32.6 MB. Every reading splits a PDF into groups of pages that fit one
// request, so a big file is read the same way as a small one. Nginx takes 50 MB.
export const MAX_PDF_MB = 40;
export const MAX_UPLOAD_MB = 25;
// A whole building as an IFC model is the biggest file people send. It is opened in the
// person's browser, not on the server, so it can be larger; nginx takes 50 MB per request.
export const MAX_IFC_MB = 45;
/** How big one uploaded file may be: models, drawings and PDFs get more room than photos and videos. */
export const uploadLimitMB = (name) => {
  const ext = String(name).split('.').pop().toLowerCase();
  return ext === 'ifc' ? MAX_IFC_MB : isDrawing(name) ? MAX_DRAWING_MB : ext === 'pdf' ? MAX_PDF_MB : MAX_UPLOAD_MB;
};

/**
 * A CAD drawing (.dwg or .dxf) as text Reem can read: its layers, then every note, label,
 * dimension and title-block entry, grouped by layer and with repeats counted.
 *
 * A DWG is first turned into DXF by LibreDWG's dwg2dxf, free and on our own server: nothing
 * leaves the machine and no AI is used, so opening a drawing costs nothing. The DXF is read
 * line by line rather than loaded whole: a 30 MB drawing becomes a 200 MB DXF.
 *
 * Lines are measured too, totalled per layer: a pipe or wall drawn without a dimension still
 * has a length, the same one AutoCAD's measure tool gives. Only what is drawn in the drawing
 * itself counts, not the paper-space sheet frame or the lines inside symbols.
 */
export function readDrawing(buffer, name) {
  if (buffer.length > MAX_DRAWING_MB * 1024 * 1024) {
    return Promise.reject(new Error(`${name} is too big to read — drawings can be up to ${MAX_DRAWING_MB} MB. Purge it or send one sheet/layout.`));
  }
  // One at a time, for the same memory reason: two people sending drawings at once must
  // not convert two side by side.
  return oneAtATime(() => convertAndRead(buffer, name));
}
let queue = Promise.resolve();

/**
 * Runs heavy file readings one after another: a drawing conversion and an IFC model reading
 * (ifc.js) each take a few hundred MB, and the server has under 2 GB.
 */
export function oneAtATime(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

/** A DXF already on disk, read as readDrawing reads one (used to check a large drawing by hand). */
export async function readDxfFile(path, name) {
  return summarise(await scan(path), name);
}

async function convertAndRead(buffer, name) {
  // On disk under data/, not the system temp folder: on the server that is held in memory,
  // and the DXF of a large drawing runs to hundreds of MB.
  mkdirSync(join(DATA_DIR, 'tmp'), { recursive: true });
  const dir = mkdtempSync(join(DATA_DIR, 'tmp', 'dwg-'));
  try {
    const dxf = join(dir, 'in.dxf');
    if (/\.dwg$/i.test(name)) {
      const dwg = join(dir, 'in.dwg');
      writeFileSync(dwg, buffer);
      try {
        await run('dwg2dxf', ['-y', '-o', dxf, dwg], { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
      } catch (e) {
        if (e.code === 'ENOENT') throw new Error(`Cannot open the drawing ${name}: reading DWG is not set up on this server yet`);
        if (e.killed) throw new Error(`${name} took too long to open`);
        // Otherwise dwg2dxf is complaining about parts it skipped; the file it wrote is still read.
      }
    } else writeFileSync(dxf, buffer);
    return summarise(await scan(dxf), name);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`Could not open the drawing ${name}: it may be damaged or a DWG version that cannot be read`);
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What each kind of entity carries that a person would read.
const WORDS = new Set(['TEXT', 'MTEXT', 'ATTRIB', 'DIMENSION', 'MULTILEADER', 'MLEADER']);

// $INSUNITS: what one drawing unit is, in metres. 0 (unitless) and the rarer ones are left as
// "drawing units" rather than guessed.
const UNIT_M = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 };
const UNIT_NAME = { 1: 'inches', 2: 'feet', 4: 'millimetres', 5: 'centimetres', 6: 'metres' };

// One stretch of a polyline. A bulge makes it an arc: bulge = tan(angle/4), so the arc's length
// follows from the straight distance between the two points.
function segment(a, b) {
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (!a.bulge) return chord;
  const angle = 4 * Math.atan(Math.abs(a.bulge));
  return chord && (chord / (2 * Math.sin(angle / 2))) * angle;
}

function polylineLength(pts, closed) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += segment(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) n += segment(pts[pts.length - 1], pts[0]);
  return n;
}

/** How long a drawn entity is, in drawing units; null for anything that is not a line. */
export function lengthOf(ent) {
  const p = ent.pts || [];
  switch (ent.type) {
    case 'LINE': return ent.x1 == null ? null : Math.hypot(ent.x2 - ent.x1, ent.y2 - ent.y1);
    case 'ARC': {
      const sweep = (((ent.a2 - ent.a1) % 360) + 360) % 360 || 360;
      return ent.r * (sweep * Math.PI) / 180;
    }
    case 'LWPOLYLINE': return polylineLength(p, ent.flags & 1);
    case 'POLYLINE': return ent.flags & (16 | 64) ? null : polylineLength(p, ent.flags & 1); // 16/64: 3D meshes, not lines
    case 'MLINE': return polylineLength(p, ent.flags & 2);
    case 'SPLINE': { const s = splinePoints(ent); return s.length > 1 ? polylineLength(s, false) : null; }
    default: return null;
  }
}

/**
 * Points along a spline, close enough together that the sum of the straight steps between
 * them is its length to well under a millimetre per metre. A spline with control points is
 * worked out exactly (de Boor, with weights when it has them); one saved with only the points
 * it passes through is followed through those.
 */
export function splinePoints(e) {
  if (e.sampled) return e.sampled;
  const ctrl = e.ctrl || [], knots = e.knots || [], p = e.degree || 3;
  let out = [];
  if (ctrl.length > p && knots.length === ctrl.length + p + 1) {
    const w = e.weights?.length === ctrl.length ? e.weights : ctrl.map(() => 1);
    const lo = knots[p], hi = knots[ctrl.length];
    const steps = Math.min(4000, Math.max(64, ctrl.length * 32));
    for (let i = 0; i <= steps; i++) {
      const u = lo + ((hi - lo) * i) / steps;
      let k = p;
      while (k < ctrl.length - 1 && u >= knots[k + 1]) k++;
      const d = [];
      for (let j = 0; j <= p; j++) {
        const c = ctrl[k - p + j], wt = w[k - p + j];
        d.push([c.x * wt, c.y * wt, wt]);
      }
      for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
          const a0 = knots[j + k - p], a1 = knots[j + 1 + k - r];
          const a = a1 === a0 ? 0 : (u - a0) / (a1 - a0);
          d[j] = d[j].map((v, q) => (1 - a) * d[j - 1][q] + a * v);
        }
      }
      out.push({ x: d[p][0] / d[p][2], y: d[p][1] / d[p][2] });
    }
  } else if (e.fit?.length > 1) out = e.fit;
  e.sampled = out;
  return out;
}

/** The points a piece runs through, for finding which label sits next to it. */
function pointsOf(e) {
  switch (e.type) {
    case 'LINE': return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
    case 'ARC': {
      if (e.cx == null) return [];
      const sweep = (((e.a2 - e.a1) % 360) + 360) % 360 || 360;
      return Array.from({ length: 9 }, (_, i) => {
        const a = ((e.a1 + (sweep * i) / 8) * Math.PI) / 180;
        return { x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) };
      });
    }
    case 'SPLINE': return splinePoints(e);
    default: {
      const p = e.pts || [];
      return (e.flags & (e.type === 'MLINE' ? 2 : 1)) && p.length > 2 ? [...p, p[0]] : p;
    }
  }
}

/** The area inside a closed polyline, arcs (bulges) included. */
export function areaOf(e) {
  const p = e.pts || [];
  if (!['LWPOLYLINE', 'POLYLINE'].includes(e.type) || !(e.flags & 1) || p.length < 2 || (p.length < 3 && !p.some((q) => q.bulge))) return 0; // two bulged points can close a circle
  let twice = 0, arcs = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    twice += a.x * b.y - b.x * a.y;
    if (a.bulge) {
      // The sliver between the straight edge and the arc, on the side the bulge's sign says.
      const chord = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = 4 * Math.atan(Math.abs(a.bulge));
      const r = chord / (2 * Math.sin(angle / 2));
      arcs += Math.sign(a.bulge) * (r * r / 2) * (angle - Math.sin(angle));
    }
  }
  return Math.abs(twice / 2 + arcs);
}

async function scan(path) {
  const layers = new Map();     // layer -> { notes: Map(text -> count), dims: Map, blocks: Map, length, pieces }
  const titles = new Map();     // attribute tag -> value, from blocks (title blocks carry these)
  const counts = new Map();     // entity type -> count, for a one-line overview
  const inside = new Map();     // block name -> Map(text -> count): labels drawn inside a symbol
  const placed = new Set();     // blocks placed anywhere, in the drawing or inside another block
  let section = null, ent = null, code = null, prevZero = false, block = null;
  let headerVar = null, units = null, poly = null;
  const pieces = [];            // every measured piece in the drawing: { layer, len, pts }
  const labels = [];            // every note in the drawing with where it sits: { text, x, y, h, rot }

  const layerOf = (l) => {
    if (!layers.has(l)) layers.set(l, { notes: new Map(), dims: new Map(), blocks: new Map(), length: 0, pieces: 0, area: 0, shapes: 0 });
    return layers.get(l);
  };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const measure = (e) => {
    // Code 67 = 1 is paper space: the sheet frame and title block, drawn at a different scale.
    if (section !== 'ENTITIES' || e.paper) return;
    const len = lengthOf(e);
    if (!(len > 0) || !Number.isFinite(len)) return;
    const L = layerOf(e.layer || '0');
    L.length += len;
    L.pieces += 1;
    const piece = { layer: e.layer || '0', len, pts: pointsOf(e) };
    pieces.push(piece);
    const area = areaOf(e);
    if (area > 0) { L.area += area; L.shapes += 1; }
    if (!L.longest || len > L.longest.len) L.longest = { len, box: box(e), area, piece };
  };

  const finish = () => {
    if (!ent) return;
    // An old-style POLYLINE is followed by its VERTEX entities and closed by SEQEND.
    if (ent.type === 'POLYLINE') { poly = ent; ent.pts = []; }
    else if (ent.type === 'VERTEX' && poly) { if (ent.x != null) poly.pts.push({ x: ent.x, y: ent.y, bulge: ent.bulge || 0 }); return; }
    else if (ent.type === 'SEQEND' && poly) { measure(poly); poly = null; return; }
    if (ent.type === 'BLOCK') { block = ent.name?.startsWith('*') ? null : ent.name; return; }
    if (ent.type !== 'POLYLINE') measure(ent);
    if (ent.type === 'INSERT' && ent.block) placed.add(ent.block);
    if (section === 'BLOCKS') {
      // A symbol's own labels ("FCO", "MH-3") are drawn inside its definition. Anonymous
      // blocks (*D, *U…) are dimensions and hatches, already read where they are placed.
      if (!block || !['TEXT', 'MTEXT', 'ATTDEF'].includes(ent.type)) return;
      const t = clean((ent.more || '') + (ent.text || ''));
      if (t) { if (!inside.has(block)) inside.set(block, new Map()); bump(inside.get(block), t); }
      return;
    }
    bump(counts, ent.type);
    const L = layerOf(ent.layer || '0');
    if (ent.type === 'INSERT' && ent.block && !ent.block.startsWith('*')) bump(L.blocks, ent.block);
    if (!WORDS.has(ent.type)) return;
    if (ent.type === 'DIMENSION') {
      // Code 1 is what the drawer typed over the dimension ("<>" means the measured value);
      // code 42 is the measured value itself.
      const typed = clean(ent.text || '');
      const measured = ent.measure != null ? round(ent.measure) : '';
      const v = typed && typed !== '<>' ? typed.replace('<>', measured) : measured;
      if (v !== '') bump(L.dims, String(v));
      return;
    }
    const t = clean((ent.more || '') + (ent.text || ''));
    if (!t) return;
    if (ent.type === 'ATTRIB' && ent.tag) titles.set(ent.tag, t);
    bump(L.notes, t);
    if ((ent.type === 'TEXT' || ent.type === 'MTEXT') && !ent.paper && ent.x != null) {
      labels.push({ text: t, x: ent.x, y: ent.y, h: ent.h || 0, rot: ent.rot || 0 });
    }
  };

  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of lines) {
    if (code === null) { code = raw.trim(); continue; }
    const value = raw.replace(/\r$/, '');
    const c = code;
    code = null;
    if (c === '0') {
      finish();
      if (value === 'ENDSEC') section = null;
      ent = section === 'ENTITIES' || section === 'BLOCKS' ? { type: value } : null;
      prevZero = value === 'SECTION';
      continue;
    }
    if (c === '2' && prevZero) { section = value; prevZero = false; continue; }
    prevZero = false;
    if (section === 'HEADER') {
      if (c === '9') headerVar = value;
      else if (c === '70' && headerVar === '$INSUNITS') units = Number(value);
      continue;
    }
    if (!ent) continue;
    if (GEOMETRY.has(ent.type) && shape(ent, c, value)) continue;
    if ((ent.type === 'TEXT' || ent.type === 'MTEXT') && placeText(ent, c, value)) continue;
    if (c === '8') ent.layer = value;
    else if (c === '1') ent.text = (ent.text || '') + value;
    else if (c === '3' && ent.type === 'MTEXT') ent.more = (ent.more || '') + value; // long notes arrive in pieces before code 1
    else if (c === '2' && (ent.type === 'INSERT' || ent.type === 'BLOCK')) ent[ent.type === 'BLOCK' ? 'name' : 'block'] = value;
    else if (c === '2' && ent.type === 'ATTRIB') ent.tag = value;
    else if (c === '304' && /LEADER/.test(ent.type)) ent.text = (ent.text || '') + value;
    else if (c === '42' && ent.type === 'DIMENSION') ent.measure = Number(value);
  }
  finish();
  for (const name of inside.keys()) if (!placed.has(name)) inside.delete(name); // drawn nowhere
  return { layers, titles, counts, inside, units, sizes: pipeSizes(pieces, labels, units, layers) };
}

const GEOMETRY = new Set(['LINE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'VERTEX', 'MLINE', 'SPLINE']);
const num = (v) => Number(v);

/** Where a note sits and which way it reads. True when the code was one of those. */
function placeText(e, c, v) {
  if (c === '67') { e.paper = v.trim() === '1'; return true; }
  if (c === '10') e.x = num(v); else if (c === '20') e.y = num(v);
  else if (c === '40') e.h = num(v);
  else if (c === '50') e.rot = num(v);
  // MTEXT may give its direction as a vector instead of an angle.
  else if (c === '11' && e.type === 'MTEXT') e.dx = num(v);
  else if (c === '21' && e.type === 'MTEXT') { e.rot = (Math.atan2(num(v), e.dx || 0) * 180) / Math.PI; }
  else return false;
  return true;
}

// A pipe size as drawers write it: "110MM W.PIPE", "Ø160", "82MM", '4"Ø'. Openings, sleeves and
// levels carry sizes too but are not pipes.
// A foot-and-inch dimension (3'-0") is not a pipe size, hence no ' or - before the inches.
const SIZE = /(^|[^\dX.'-])(Ø\s*\d{2,3}\b|\d{2,3}\s*MM\b|\d{1,2}\s*("|'')\s*Ø?)/i;
const NOT_PIPE = /SLEEVE|OPENING|LEVEL|DEPTH|BOP|COVER|THICK|\d\s*[X×]\s*\d|mm²|SIZE/i;

/**
 * One name per pipe: "EACH 110MM RW.PIPE(F/A)", "110 MM RW.PIPE" and "110MM RW .PIPE" are all
 * "110MM RW.PIPE". The size, then what follows it up to the word PIPE; just the size if PIPE
 * does not follow it ("U.P.V.C PIPE 200MM Ø" is "200MM").
 */
export function pipeKey(text) {
  const t = text.toUpperCase().replace(/\s+/g, ' ').trim();
  const m = t.match(SIZE);
  if (!m) return t;
  const size = m[2].replace(/\s+/g, '').replace(/^Ø(\d+)$/, '$1MM').replace(/''/, '"').replace(/"Ø$/, '"');
  const rest = t.slice(m.index + m[0].length);
  const pipe = rest.match(/^(.*?PIPE)\b/);
  return pipe ? `${size} ${pipe[1].trim().replace(/\s+(?=\.)/g, '')}`.trim() : size;
}

// Layers whose lines are never pipes: dimensions, text, frames, grids.
const NOT_PIPE_LAYER = /dim|text|txt|frame|title|grid|axis|^ax\d|hatch|area/i;

/**
 * Pipe length per size, from the size labels drawn beside the pipes. A label belongs to the
 * nearest line that runs the same way within three text heights of it; the length then
 * follows the whole run that line is part of (pieces on the same layer meeting end to end),
 * since a run is labelled once, not on every piece. A run with two different sizes on it
 * goes to the size most of its labels give, and is counted as mixed.
 */
function pipeSizes(pieces, labels, units, layers) {
  const sized = labels.filter((l) => SIZE.test(l.text) && !NOT_PIPE.test(l.text) && l.h > 0);
  if (!sized.length) return null;
  const strays = new Set([...layers.values()].map((L) => stray(L, units) && L.longest.piece).filter(Boolean));
  const cand = pieces.filter((p) => !NOT_PIPE_LAYER.test(p.layer) && !strays.has(p) && p.pts.length > 1);

  // Runs: pieces on one layer whose ends meet, within a centimetre.
  const tol = UNIT_M[units] ? 0.01 / UNIT_M[units] : 1;
  const parent = cand.map((_, i) => i);
  const root = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const ends = new Map();
  cand.forEach((p, i) => {
    for (const q of [p.pts[0], p.pts[p.pts.length - 1]]) {
      const k = `${p.layer}|${Math.round(q.x / tol)}|${Math.round(q.y / tol)}`;
      if (ends.has(k)) parent[root(i)] = root(ends.get(k)); else ends.set(k, i);
    }
  });

  // Each label to its nearest same-direction line. A grid keeps this quick on big drawings.
  const cell = Math.max(...sized.map((l) => l.h)) * 6;
  const grid = new Map();
  cand.forEach((p, i) => {
    for (let s = 1; s < p.pts.length; s++) {
      const a = p.pts[s - 1], b = p.pts[s];
      const x0 = Math.floor(Math.min(a.x, b.x) / cell), x1 = Math.floor(Math.max(a.x, b.x) / cell);
      const y0 = Math.floor(Math.min(a.y, b.y) / cell), y1 = Math.floor(Math.max(a.y, b.y) / cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) continue; // a segment crossing the whole drawing is not a labelled pipe
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = `${gx}|${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push([i, a, b]);
      }
    }
  });
  const votes = new Map(); // run -> Map(size -> labels)
  let matched = 0;
  for (const l of sized) {
    const r = (l.rot * Math.PI) / 180;
    const along = l.text.length * l.h * 0.4; // the middle of the words, not their start
    const mx = l.x + Math.cos(r) * along - Math.sin(r) * l.h / 2;
    const my = l.y + Math.sin(r) * along + Math.cos(r) * l.h / 2;
    const gx = Math.floor(mx / cell), gy = Math.floor(my / cell);
    let best = null, bestD = 3 * l.h;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const [i, a, b] of grid.get(`${gx + dx}|${gy + dy}`) || []) {
        const segAngle = Math.atan2(b.y - a.y, b.x - a.x);
        const diff = Math.abs(((segAngle - r) % Math.PI + Math.PI) % Math.PI);
        if (Math.min(diff, Math.PI - diff) > (20 * Math.PI) / 180) continue;
        const d = toSegment(mx, my, a, b);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best == null) continue;
    matched++;
    const run = root(best), key = pipeKey(l.text);
    if (!votes.has(run)) votes.set(run, new Map());
    votes.get(run).set(key, (votes.get(run).get(key) || 0) + 1);
  }
  const runLength = new Map();
  cand.forEach((p, i) => { const r = root(i); runLength.set(r, (runLength.get(r) || 0) + p.len); });
  const sizes = new Map(); // size -> { len, runs, mixed }
  for (const [run, v] of votes) {
    const [key] = [...v].sort((a, b) => b[1] - a[1])[0];
    const s = sizes.get(key) || { len: 0, runs: 0, mixed: 0 };
    s.len += runLength.get(run); s.runs += 1; if (v.size > 1) s.mixed += 1;
    sizes.set(key, s);
  }
  return { sizes, matched, labelled: sized.length };
}

function toSegment(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/** The group codes that place a line, arc or polyline. True when the code was one of them. */
function shape(e, c, v) {
  if (c === '67') { e.paper = v.trim() === '1'; return true; }
  switch (e.type) {
    case 'LINE':
      if (c === '10') e.x1 = num(v); else if (c === '20') e.y1 = num(v);
      else if (c === '11') e.x2 = num(v); else if (c === '21') e.y2 = num(v);
      else return false;
      return true;
    case 'ARC':
      if (c === '40') e.r = num(v); else if (c === '50') e.a1 = num(v); else if (c === '51') e.a2 = num(v);
      else if (c === '10') e.cx = num(v); else if (c === '20') e.cy = num(v);
      else return false;
      return true;
    case 'SPLINE':
      if (c === '71') e.degree = num(v);
      else if (c === '40') (e.knots ||= []).push(num(v));
      else if (c === '41') (e.weights ||= []).push(num(v));
      else if (c === '10') (e.ctrl ||= []).push({ x: num(v), y: 0 });
      else if (c === '20' && e.ctrl?.length) e.ctrl[e.ctrl.length - 1].y = num(v);
      else if (c === '11') (e.fit ||= []).push({ x: num(v), y: 0 });
      else if (c === '21' && e.fit?.length) e.fit[e.fit.length - 1].y = num(v);
      else return false;
      return true;
    case 'LWPOLYLINE':
      // Each vertex starts with its x (10); its y (20) and bulge (42) follow.
      e.pts ||= [];
      if (c === '10') e.pts.push({ x: num(v), y: 0, bulge: 0 });
      else if (c === '20' && e.pts.length) e.pts[e.pts.length - 1].y = num(v);
      else if (c === '42' && e.pts.length) e.pts[e.pts.length - 1].bulge = num(v);
      else if (c === '70') e.flags = num(v);
      else return false;
      return true;
    case 'POLYLINE':
      if (c === '70') { e.flags = num(v); return true; }
      return false;
    case 'VERTEX':
      if (c === '10') e.x = num(v); else if (c === '20') e.y = num(v); else if (c === '42') e.bulge = num(v);
      else return false;
      return true;
    case 'MLINE':
      // A multiline (often a wall) is measured along its vertices, codes 11/21.
      e.pts ||= [];
      if (c === '11') e.pts.push({ x: num(v), y: 0, bulge: 0 });
      else if (c === '21' && e.pts.length) e.pts[e.pts.length - 1].y = num(v);
      else if (c === '71') e.flags = num(v);
      else return false;
      return true;
    default: return false;
  }
}

/**
 * One piece that is most of a layer is usually a frame or boundary drawn on the wrong layer
 * (the school drainage drawing had a 1,958 × 344 m rectangle on its rain-pipe layer). It is
 * pointed out, with the total without it, rather than quietly trusted or dropped.
 */
function stray(L, units) {
  const big = L.longest;
  if (!big || L.pieces < 10 || big.len < 0.4 * L.length) return null; // a layer of a few pieces is often one long run
  return { len: big.len, shape: big.box ? `a closed shape ${sayLength(big.box.w, units)} × ${sayLength(big.box.h, units)}` : 'one line' };
}

/**
 * What the person who drew this should fix so Reem (and anyone else) can read it properly.
 * Only what the file shows for certain; each point says what to do, in site language.
 */
function draftsmanList({ layers, titles, counts, units }, measured) {
  const fixes = [];
  const total = (k) => counts.get(k) || 0;
  const drawn = total('LINE') + total('LWPOLYLINE') + total('POLYLINE') + total('ARC') + total('MLINE');
  if (!UNIT_M[units] && drawn) {
    fixes.push('The drawing units are not set, so lengths cannot be given in metres. Please set the units (UNITS command, e.g. millimetres) and save again.');
  }
  for (const [layer, L] of measured) {
    const big = stray(L, units);
    if (big) fixes.push(`Layer "${layer}" has ${big.shape} (${sayLength(big.len, units)} of line). Is it a frame or outline? Please move it to its own layer.`);
  }
  const all = measured.reduce((n, [, L]) => n + L.length, 0);
  const zero = layers.get('0')?.length || 0;
  if (zero && zero >= 0.15 * all) {
    fixes.push(`${sayLength(zero, units)} of lines are on layer "0", which has no meaning. Please put them on named layers (pipe, wall, kerb…) so they can be measured by type.`);
  }
  // A drawing number is a title-block value with a digit in it under a tag like DWG_NO or DRAWING NO.
  const number = [...titles].some(([tag, v]) => /dwg|draw|sheet|^no\.?$|num/i.test(tag) && /\d/.test(v) && v.length >= 3);
  if (drawn && !number) {
    fixes.push(`No clear drawing number was found in the title block${titles.size ? '' : ' (it has no filled-in fields)'}. Please fill in the drawing number and revision.`);
  }
  if (drawn > 200 && total('DIMENSION') < 5) {
    fixes.push(`The drawing has only ${total('DIMENSION')} dimension${total('DIMENSION') === 1 ? '' : 's'}. Please add dimensions for the main sizes, so they do not have to be measured off the drawing.`);
  }
  return fixes;
}

/** A closed polyline's width and height, so a stray frame on a pipe layer can be described. */
function box(e) {
  const p = e.pts || [];
  if (!['LWPOLYLINE', 'POLYLINE'].includes(e.type) || !(e.flags & 1) || p.length < 3) return null;
  const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** A length in drawing units, said in metres when the drawing gives its units. */
function sayLength(n, units) {
  const m = UNIT_M[units];
  if (!m) return `${Math.round(n).toLocaleString('en-US')} drawing units`;
  const metres = n * m;
  return `${metres >= 100 ? Math.round(metres).toLocaleString('en-US') : metres.toFixed(1)} m`;
}

// MTEXT carries its formatting inline: font switches, paragraph breaks, stacked fractions.
function clean(s) {
  return s
    .replace(/\\P/g, ' ')
    .replace(/\\[ACcFfHhQqTtWwp][^;]*;/g, '')
    .replace(/\\S([^;^/#]*)[\^/#]([^;]*);/g, '$1/$2')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoO]/g, '')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

const round = (n) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);

const listed = (m) => [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
  .map(([k, n]) => (n > 1 ? `${k} (×${n})` : k));

/** An area in square drawing units, said in square metres when the drawing gives its units. */
function sayArea(n, units) {
  const m = UNIT_M[units];
  if (!m) return `${Math.round(n).toLocaleString('en-US')} square drawing units`;
  const sq = n * m * m;
  return `${sq >= 100 ? Math.round(sq).toLocaleString('en-US') : sq.toFixed(1)} m²`;
}

function summarise({ layers, titles, counts, inside, units, sizes }, name) {
  const out = [`CAD drawing: ${name}`];
  const total = (k) => counts.get(k) || 0;
  out.push(`Contains ${total('TEXT') + total('MTEXT')} text notes, ${total('DIMENSION')} dimensions, ${total('INSERT')} placed symbols/blocks, ` +
    `${total('LINE') + total('LWPOLYLINE') + total('POLYLINE') + total('ARC') + total('CIRCLE') + total('MLINE') + total('SPLINE')} lines/arcs. ` +
    `Drawing units: ${UNIT_NAME[units] || 'not given in the file'}.`);
  // The measured numbers come first: a long drawing is cut short where it is shown in a chat,
  // and these are what quantities are taken from.
  const measured = [...layers].filter(([, L]) => L.length > 0).sort((a, b) => b[1].length - a[1].length);
  if (measured.length) {
    out.push('', '## Line lengths by layer',
      'Total length of the lines, polylines, arcs, splines and multilines on each layer, measured from the drawing itself (as AutoCAD measures them). ' +
      'The whole drawing is counted, so if it shows the same thing twice (a plan and an enlarged part of it) that is in the total twice. ' +
      'A wall or pipe drawn as two parallel lines counts twice. Lines inside symbols/blocks are not included (symbols are counted by number instead).',
      ...measured.slice(0, 80).map(([layer, L]) => {
        const line = `${layer}: ${sayLength(L.length, units)} (${L.pieces} pieces)`;
        const big = stray(L, units);
        if (!big) return line;
        return `${line}. CHECK: ${big.shape} alone is ${sayLength(big.len, units)}, likely a frame or outline on the wrong layer; ` +
          `without it the layer is ${sayLength(L.length - big.len, units)}. Ask the draftsman.`;
      }));
    if (measured.length > 80) out.push(`…and ${measured.length - 80} more layers with shorter totals.`);
  }
  if (sizes?.sizes.size) {
    out.push('', '## Pipe lengths by size',
      `Worked out from the size labels drawn beside the pipes: each label is matched to the line it sits along, and the length is that line's whole run ` +
      `(the pieces on its layer that join end to end). ${sizes.matched} of ${sizes.labelled} size labels were matched to a line. ` +
      'A pipe with no size label beside it is not in this list, so treat these as the labelled pipes, and say so when giving them. ' +
      '"Mixed" runs had labels of more than one size on them and are counted under the size most of their labels give.',
      ...[...sizes.sizes].sort((a, b) => b[1].len - a[1].len).slice(0, 60)
        .map(([k, s]) => `${k}: ${sayLength(s.len, units)} (${s.runs} run${s.runs === 1 ? '' : 's'}${s.mixed ? `, ${s.mixed} mixed` : ''})` +
          // Mostly mixed: the labels sit where lines of other sizes meet, so this total is a guess.
          (s.runs >= 4 && s.mixed > s.runs / 2 ? '. UNSURE: most of these runs carry other sizes too; do not give this as a firm quantity.' : '')));
  }
  const shaped = [...layers].filter(([, L]) => L.area > 0).sort((a, b) => b[1].area - a[1].area);
  if (shaped.length) {
    out.push('', '## Areas of closed shapes by layer',
      'The area inside every closed polyline on each layer (rooms, slabs, plots, openings), added up per layer, arcs included.',
      ...shaped.slice(0, 50).map(([layer, L]) => {
        const line = `${layer}: ${sayArea(L.area, units)} (${L.shapes} shape${L.shapes === 1 ? '' : 's'})`;
        const big = stray(L, units);
        return big && L.longest.area ? `${line}; without the CHECK shape above: ${sayArea(L.area - L.longest.area, units)}` : line;
      }));
  }
  const fixes = draftsmanList({ layers, titles, counts, units }, measured);
  if (fixes.length) {
    out.push('', '## Tell the draftsman',
      'Things in this drawing that make it hard to read or measure, found by checking the file (no guessing). ' +
      'When this drawing has just been sent, end your reply with these points under the heading "Tell the draftsman", ' +
      'in short plain lines the person can copy and send to whoever made the drawing.',
      ...fixes.map((f, i) => `${i + 1}. ${f}`));
  }
  if (titles.size) out.push('', '## Title block / attributes', ...[...titles].map(([k, v]) => `${k}: ${v}`));
  const used = [...layers].filter(([, L]) => L.notes.size || L.dims.size || L.blocks.size);
  out.push('', `## Layers (${layers.size})`, [...layers.keys()].join(', '));
  for (const [layer, L] of used.sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push('', `## Layer: ${layer}`);
    if (L.notes.size) out.push(`Text: ${listed(L.notes).join(' | ')}`);
    if (L.dims.size) out.push(`Dimensions: ${listed(L.dims).join(', ')}`);
    if (L.blocks.size) out.push(`Symbols/blocks: ${listed(L.blocks).join(', ')}`);
  }
  if (inside.size) {
    out.push('', '## Text inside symbols/blocks');
    for (const [b, m] of [...inside].sort((a, c) => a[0].localeCompare(c[0]))) out.push(`${b}: ${listed(m).join(' | ')}`);
  }
  return out.join('\n');
}
