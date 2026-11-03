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

/**
 * A CAD drawing (.dwg or .dxf) as text Reem can read: its layers, then every note, label,
 * dimension and title-block entry, grouped by layer and with repeats counted.
 *
 * A DWG is first turned into DXF by LibreDWG's dwg2dxf, free and on our own server: nothing
 * leaves the machine and no AI is used, so opening a drawing costs nothing. The DXF is read
 * line by line rather than loaded whole: a 30 MB drawing becomes a 200 MB DXF.
 *
 * Lines and shapes with no text on them are left out: a pipe is only as readable as its label.
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

async function scan(path) {
  const layers = new Map();     // layer -> { notes: Map(text -> count), dims: Map, blocks: Map }
  const titles = new Map();     // attribute tag -> value, from blocks (title blocks carry these)
  const counts = new Map();     // entity type -> count, for a one-line overview
  const inside = new Map();     // block name -> Map(text -> count): labels drawn inside a symbol
  const placed = new Set();     // blocks placed anywhere, in the drawing or inside another block
  let section = null, ent = null, code = null, prevZero = false, block = null;

  const layerOf = (l) => {
    if (!layers.has(l)) layers.set(l, { notes: new Map(), dims: new Map(), blocks: new Map() });
    return layers.get(l);
  };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  const finish = () => {
    if (!ent) return;
    if (ent.type === 'BLOCK') { block = ent.name?.startsWith('*') ? null : ent.name; return; }
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
    if (!ent) continue;
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
  return { layers, titles, counts, inside };
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

function summarise({ layers, titles, counts, inside }, name) {
  const out = [`CAD drawing: ${name}`];
  const total = (k) => counts.get(k) || 0;
  out.push(`Contains ${total('TEXT') + total('MTEXT')} text notes, ${total('DIMENSION')} dimensions, ${total('INSERT')} placed symbols/blocks, ` +
    `${total('LINE') + total('LWPOLYLINE') + total('POLYLINE') + total('ARC') + total('CIRCLE')} lines/arcs. ` +
    'Only text, dimensions, symbol names and layer names are readable here; plain lines and shapes are not, so lengths without a dimension cannot be measured.');
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
