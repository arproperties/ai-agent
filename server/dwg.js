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
/** How big one uploaded file may be: drawings and PDFs get more room than photos and videos. */
export const uploadLimitMB = (name) => {
  const ext = String(name).split('.').pop().toLowerCase();
  return isDrawing(name) ? MAX_DRAWING_MB : ext === 'pdf' ? MAX_PDF_MB : MAX_UPLOAD_MB;
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
  const next = queue.then(() => convertAndRead(buffer, name));
  queue = next.catch(() => {});
  return next;
}
let queue = Promise.resolve();

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
    default: return null;
  }
}

async function scan(path) {
  const layers = new Map();     // layer -> { notes: Map(text -> count), dims: Map, blocks: Map, length, pieces }
  const titles = new Map();     // attribute tag -> value, from blocks (title blocks carry these)
  const counts = new Map();     // entity type -> count, for a one-line overview
  const inside = new Map();     // block name -> Map(text -> count): labels drawn inside a symbol
  const placed = new Set();     // blocks placed anywhere, in the drawing or inside another block
  let section = null, ent = null, code = null, prevZero = false, block = null;
  let headerVar = null, units = null, poly = null;

  const layerOf = (l) => {
    if (!layers.has(l)) layers.set(l, { notes: new Map(), dims: new Map(), blocks: new Map(), length: 0, pieces: 0 });
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
    if (!L.longest || len > L.longest.len) L.longest = { len, box: box(e) };
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
  return { layers, titles, counts, inside, units };
}

const GEOMETRY = new Set(['LINE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'VERTEX', 'MLINE']);
const num = (v) => Number(v);

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

function summarise({ layers, titles, counts, inside, units }, name) {
  const out = [`CAD drawing: ${name}`];
  const total = (k) => counts.get(k) || 0;
  out.push(`Contains ${total('TEXT') + total('MTEXT')} text notes, ${total('DIMENSION')} dimensions, ${total('INSERT')} placed symbols/blocks, ` +
    `${total('LINE') + total('LWPOLYLINE') + total('POLYLINE') + total('ARC') + total('CIRCLE') + total('MLINE')} lines/arcs. ` +
    `Drawing units: ${UNIT_NAME[units] || 'not given in the file'}.`);
  if (titles.size) out.push('', '## Title block / attributes', ...[...titles].map(([k, v]) => `${k}: ${v}`));
  const measured = [...layers].filter(([, L]) => L.length > 0).sort((a, b) => b[1].length - a[1].length);
  if (measured.length) {
    out.push('', '## Line lengths by layer',
      'Total length of the lines, polylines, arcs and multilines on each layer, measured from the drawing itself (as AutoCAD measures them). ' +
      'The whole drawing is counted, so if it shows the same thing twice (a plan and an enlarged part of it) that is in the total twice. ' +
      'A wall or pipe drawn as two parallel lines counts twice. Lines inside symbols/blocks and curves drawn as splines are not included.',
      ...measured.slice(0, 80).map(([layer, L]) => {
        const line = `${layer}: ${sayLength(L.length, units)} (${L.pieces} pieces)`;
        // One piece that is most of a layer is usually a frame or boundary drawn on the wrong
        // layer (the school drainage drawing had a 1,958 × 344 m rectangle on its rain-pipe
        // layer). Say so, with the total without it, rather than quietly trust or drop it.
        const big = L.longest;
        if (L.pieces < 10 || big.len < 0.4 * L.length) return line; // a layer of a few pieces is often one long run
        const shape = big.box ? `a closed shape ${sayLength(big.box.w, units)} × ${sayLength(big.box.h, units)}` : 'one line';
        return `${line}. CHECK: ${shape} alone is ${sayLength(big.len, units)}, likely a frame or outline on the wrong layer; ` +
          `without it the layer is ${sayLength(L.length - big.len, units)}. Ask the draftsman.`;
      }));
    if (measured.length > 80) out.push(`…and ${measured.length - 80} more layers with shorter totals.`);
  }
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
