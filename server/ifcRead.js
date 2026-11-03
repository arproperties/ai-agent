/**
 * Reads one IFC model and prints what Reem should know about it, as text, in the same spirit
 * as a DWG reading (dwg.js): the measured numbers first, then the counts, and plainly which
 * quantities the file does not have. Nothing is estimated.
 *
 * Run as its own process by readIfc() in ifc.js, never inside Reem: web-ifc works in one go
 * and cannot be stopped half way, and a big model holds a few hundred MB while it is open.
 * A process of its own can be stopped when it takes too long, and gives all of its memory
 * back when it ends.
 *
 *   node server/ifcRead.js <file.ifc> <name shown to people>
 * prints one line of JSON: { text, peakMB } or { error }.
 */
import * as W from 'web-ifc';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES, categoryOf, sayType, readUnits, readLayout, readQuantities, readElements, readSizes,
  openingSize, uniqueQuantities,
} from './ifcCore.js';

const UNIT_WORD = { 0.001: 'millimetres', 0.01: 'centimetres', 1: 'metres', 0.3048: 'feet', 0.0254: 'inches' };

// Quantities that add up across elements. A width, height, depth, thickness, perimeter or
// elevation of one wall says nothing when added to the next one's.
const ADDS_UP = (q) => q.kind === 'area' || q.kind === 'volume' || q.kind === 'count' || q.kind === 'weight'
  || (q.kind === 'length' && /^(net|gross)?\s*length$/i.test(q.name.trim()));

// What a quantity survey of each kind needs, so the reading can say what the file lacks.
const EXPECTED = {
  walls: [['length', 'length'], ['area', 'area'], ['volume', 'volume']],
  slabs: [['area', 'area'], ['volume', 'volume']],
  structure: [['length', 'length'], ['volume', 'volume']],
  pipes: [['length', 'length']],
};

// The standard IFC quantity names come first, in the order a quantity surveyor reads them;
// a program's own extra quantities follow, and only the first few are kept.
const STANDARD = ['length', 'netsidearea', 'grosssidearea', 'netarea', 'grossarea', 'area', 'netfootprintarea', 'netvolume', 'grossvolume', 'volume', 'count', 'netweight', 'grossweight'];
const rank = (t) => {
  const i = STANDARD.indexOf(t.name.toLowerCase().replace(/[\s_]+/g, ''));
  return i < 0 ? STANDARD.length : i;
};
const round = (n) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : (Math.round(n * 100) / 100).toString());
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function summarise(api, model, name) {
  const units = readUnits(api, W, model);
  const layout = readLayout(api, W, model, units);
  const quantities = readQuantities(api, W, model, units);
  const elements = readElements(api, W, model);
  // A damaged file opens as an empty model; that is not a building with nothing in it.
  if (!elements.length) throw new Error('no building elements could be read from it; it may be damaged or cut short');
  const label = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
  const head = api.GetHeaderLine?.(model, W.FILE_SCHEMA)?.arguments?.[0]?.[0]?.value;

  const out = [`IFC building model: ${name}`];
  out.push([
    head ? `IFC version: ${head}.` : '',
    layout.project ? `Project: ${layout.project}.` : '',
    layout.site ? `Site: ${layout.site}.` : '',
    layout.building ? `Building: ${layout.building}.` : '',
  ].filter(Boolean).join(' '));
  out.push(units.length != null
    ? `The model is drawn in ${UNIT_WORD[units.length] || `units of ${units.length} m`}; every length below is given in metres.`
    : 'The model does not say its length unit, so its numbers are given in model units, not metres.');
  out.push(`${plural(elements.length, 'building element')} in all. Opens in 3D with "View in 3D" on the file.`);

  // ---- measured numbers first ----
  const byCat = new Map(); // category -> { n, withQ, totals: Map(name|unit -> { name, unit, value, n }) }
  for (const e of elements) {
    const cat = categoryOf(e.type);
    if (!byCat.has(cat)) byCat.set(cat, { n: 0, withQ: 0, totals: new Map(), kinds: new Set() });
    const c = byCat.get(cat);
    c.n++;
    const qs = uniqueQuantities(quantities.get(e.id) || []);
    if (qs.length) c.withQ++;
    for (const q of qs) {
      c.kinds.add(q.kind);
      if (!ADDS_UP(q)) continue;
      const k = `${q.name.toLowerCase().replace(/[\s_]+/g, '')}|${q.unit}`;
      const t = c.totals.get(k) || { name: q.name, unit: q.unit, value: 0, n: 0 };
      t.value += q.value;
      t.n++;
      c.totals.set(k, t);
    }
  }
  const order = CATEGORIES.map((c) => c.key);
  const cats = [...byCat].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  const anyQ = cats.some(([, c]) => c.withQ);
  out.push('', '## Quantity totals (from the model\'s own quantity sets)');
  if (!anyQ) {
    out.push('The file has no quantity sets at all (it was exported without base quantities), so no lengths, areas or volumes can be given from it. ' +
      'Do not work them out from the 3D shapes. Ask the consultant to export the IFC again with "Export base quantities" (Revit) or "Quantity take-off" (ArchiCAD) switched on.');
  } else {
    out.push('Added up from the quantities each element carries in the file, element by element, in metres. Where only some elements of a kind carry a quantity, it says how many: the total covers those only.');
    for (const [cat, c] of cats) {
      if (!c.totals.size) continue;
      const parts = [...c.totals.values()].sort((a, b) => rank(a) - rank(b) || b.n - a.n || a.name.localeCompare(b.name)).slice(0, 10)
        .map((t) => `${t.name} ${round(t.value)}${t.unit ? ` ${t.unit}` : ''}${t.n < c.n ? ` (from ${t.n} of ${c.n})` : ''}`);
      out.push(`${label[cat]} (${c.n}): ${parts.join('; ')}`);
    }
  }

  // Doors and windows by size, from their own width and height.
  for (const [cat, word] of [['doors', 'Door'], ['windows', 'Window']]) {
    const list = elements.filter((e) => categoryOf(e.type) === cat);
    if (!list.length) continue;
    const sizes = new Map();
    let unsized = 0;
    for (const e of list) {
      const s = openingSize(api, model, e.id, units);
      if (s) sizes.set(s, (sizes.get(s) || 0) + 1); else unsized++;
    }
    const listed = [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([s, n]) => `${s} (×${n})`);
    out.push(`${word}s: ${list.length} in all${listed.length ? `; sizes (width × height): ${listed.join(', ')}` : ''}${unsized ? `; ${unsized} with no size in the file` : ''}.`);
  }

  // Pipes and ducts: length by size, where both are in the file.
  const runs = elements.filter((e) => categoryOf(e.type) === 'pipes');
  if (runs.length) {
    const sizes = readSizes(api, W, model, units, new Set(runs.map((e) => e.id)));
    const bySize = new Map();
    let noSize = 0, noLength = 0;
    for (const e of runs) {
      const len = uniqueQuantities(quantities.get(e.id) || []).find((q) => q.kind === 'length' && /^(net|gross)?\s*length$/i.test(q.name.trim()) && q.unit === 'm');
      const size = sizes.get(e.id);
      if (!len) { noLength++; continue; }
      if (!size) { noSize++; continue; }
      const key = `${sayType(e.type)} ${size}`;
      const t = bySize.get(key) || { len: 0, n: 0 };
      t.len += len.value; t.n++;
      bySize.set(key, t);
    }
    if (bySize.size) {
      out.push('Pipe and duct length by size (segments and fittings that carry both a length and a size):',
        ...[...bySize].sort((a, b) => b[1].len - a[1].len).slice(0, 40).map(([k, t]) => `- ${k}: ${round(t.len)} m (${plural(t.n, 'piece')})`));
    }
    if (anyQ && (noSize || noLength)) {
      const have = (n) => (n === 1 ? '1 has' : `${n} have`);
      out.push(`Of ${plural(runs.length, 'pipe/duct piece')}, ${noLength ? `${have(noLength)} no length in the file` : ''}${noLength && noSize ? ' and ' : ''}${noSize ? `${have(noSize)} a length but no size` : ''}, so ${noLength + noSize === 1 ? 'it is' : 'they are'} not in any length by size.`);
    }
  }

  // ---- what the file does not contain ----
  const missing = [];
  if (anyQ) {
    for (const [cat, c] of cats) {
      for (const [kind, word] of EXPECTED[cat] || []) {
        if (!c.kinds.has(kind)) missing.push(`${label[cat]}: no ${word} in the file`);
      }
      if (EXPECTED[cat] && c.withQ < c.n) missing.push(`${label[cat]}: ${c.n - c.withQ} of ${c.n} ${c.n - c.withQ === 1 ? 'has' : 'have'} no quantities at all`);
    }
  }
  if (missing.length) {
    out.push('', '## Not in the file',
      'These were not in the model. Say so when asked; never estimate them from the 3D shapes or from other numbers.',
      ...missing.map((m) => `- ${m}`));
  }

  // ---- counts ----
  out.push('', '## Storeys (lowest first)');
  if (!layout.storeys.length) out.push('The model has no storeys.');
  for (const s of layout.storeys) out.push(`- ${s.name}${s.elevation != null ? `: level ${s.elevation >= 0 ? '+' : ''}${s.elevation.toFixed(2)} m` : ''}`);

  out.push('', '## Elements by storey');
  const perStorey = new Map(); // storey id|null -> Map(type -> n)
  for (const e of elements) {
    const s = layout.storeyOf.get(e.id) ?? null;
    if (!perStorey.has(s)) perStorey.set(s, new Map());
    const m = perStorey.get(s);
    const t = sayType(e.type);
    m.set(t, (m.get(t) || 0) + 1);
  }
  const say = (m) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => `${t} ${n}`).join(', ');
  for (const s of layout.storeys) if (perStorey.has(s.id)) out.push(`${s.name}: ${say(perStorey.get(s.id))}`);
  if (perStorey.has(null)) out.push(`Not placed on a storey: ${say(perStorey.get(null))}`);
  return out.join('\n');
}

async function main() {
  const [path, name] = process.argv.slice(2);
  const api = new W.IfcAPI();
  await api.Init();
  // No geometry is made here, only the data is read; the memory limit stops a huge model
  // from taking the server down with it.
  const model = api.OpenModel(new Uint8Array(readFileSync(path)), { MEMORY_LIMIT: 1024 * 1024 * 1024 });
  if (model < 0) throw new Error('not a readable IFC model');
  const text = summarise(api, model, name || path);
  api.CloseModel(model);
  const peakMB = Math.round(process.resourceUsage().maxRSS / 1024);
  process.stdout.write(`${JSON.stringify({ text, peakMB })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stdout.write(`${JSON.stringify({ error: String(e?.message || e) })}\n`);
    process.exitCode = 1;
  });
}
