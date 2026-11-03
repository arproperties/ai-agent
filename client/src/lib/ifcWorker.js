// Opens an IFC model in the person's own browser, off the main thread so the screen keeps
// moving (and the progress bar keeps filling) while a big model is read. The server only
// hands over the file: reading IFC there for the viewer would cost the 2 GB server memory
// for every person who taps "View in 3D".
//
// The model's triangles are grouped by element type and storey, one group per pair, so a
// phone draws a few dozen meshes instead of thousands. Each triangle keeps the id of the
// element it belongs to, which is how a tap finds what was touched.
import { IfcAPI } from 'web-ifc';
import * as W from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';
import { CATEGORIES, categoryOf, readUnits, readLayout, readQuantities, describeElement } from '../../../server/ifcCore.js';

let api = null;
let model = null;
let ctx = null;

// Typed arrays that grow by doubling: a model's triangles are not known until all are read.
class Grow {
  constructor(Kind) { this.Kind = Kind; this.a = new Kind(4096); this.n = 0; }
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) { const b = new this.Kind(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
  push1(x) {
    if (this.n + 1 > this.a.length) { const b = new this.Kind(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x;
  }
  done() { return this.a.slice(0, this.n); }
}

// Volumes that describe the building rather than being part of it: a room or zone drawn as a
// solid box hides everything inside it, and openings are the holes, not the walls.
const HIDDEN = new Set(['IFCSPACE', 'IFCSPATIALZONE', 'IFCZONE', 'IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE', 'IFCVIRTUALELEMENT', 'IFCSITE', 'IFCANNOTATION']);

/** One element's centre and size, from the points it just added. */
function boxOf(pos, start) {
  const a = pos.a;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = start * 3; i < pos.n; i += 3) {
    x0 = Math.min(x0, a[i]); x1 = Math.max(x1, a[i]);
    y0 = Math.min(y0, a[i + 1]); y1 = Math.max(y1, a[i + 1]);
    z0 = Math.min(z0, a[i + 2]); z1 = Math.max(z1, a[i + 2]);
  }
  if (!(x1 >= x0)) return null;
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2];
  return c.every(Number.isFinite) ? c : null;
}

/**
 * Where to point the camera: the box around the building itself. A survey marker or a site
 * object placed far away would otherwise shrink the building to a dot, so elements whose
 * centre is much further out than nearly all the others are left out of the framing (they
 * are still drawn).
 */
function frame(centres) {
  if (!centres.length) return null;
  const med = (k) => [...centres].map((c) => c[k]).sort((p, q) => p - q)[Math.floor(centres.length / 2)];
  const m = [med(0), med(1), med(2)];
  const dist = centres.map((c) => Math.hypot(c[0] - m[0], c[1] - m[1], c[2] - m[2]));
  const sorted = [...dist].sort((p, q) => p - q);
  const reach = Math.max(sorted[Math.floor(sorted.length * 0.9)] * 1.5, 1);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  centres.forEach((c, i) => {
    if (dist[i] > reach) return;
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], c[k] - c[3]); max[k] = Math.max(max[k], c[k] + c[3]); }
  });
  return { min, max };
}

const say = (msg) => self.postMessage(msg);
// A model too big for the phone usually fails inside web-ifc as an "abort" or out of memory.
const tooBig = (e) => /memory|abort|allocation|RangeError|Invalid array length/i.test(String(e?.message || e));

async function open(buffer) {
  if (!api) {
    api = new IfcAPI();
    // The file is served from our own build, under its hashed name; one thread, because many
    // threads need the page to be isolated in ways the rest of the app is not.
    await api.Init(() => wasmUrl, true);
  }
  model = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: true });
  buffer = null;
  const units = readUnits(api, W, model);
  const layout = readLayout(api, W, model, units);
  ctx = { ...layout, quantities: readQuantities(api, W, model, units) };
  say({ type: 'layout', storeys: layout.storeys, project: layout.project, building: layout.building, lengthKnown: units.length != null });

  const groups = new Map(); // "category|storey" -> { pos, nor, idx, tri }
  const typeCache = new Map();
  const catOf = (id) => {
    const t = api.GetLineType(model, id);
    if (!typeCache.has(t)) {
      const name = String(api.GetNameFromTypeCode(t)).toUpperCase();
      typeCache.set(t, HIDDEN.has(name) ? null : categoryOf(name));
    }
    return typeCache.get(t);
  };
  const centres = []; // [x, y, z, radius] per element, to frame the building (see frame())
  let last = 0;
  api.StreamAllMeshes(model, (mesh, i, total) => {
    const id = mesh.expressID;
    const cat = catOf(id);
    if (!cat) return;
    const key = `${cat}|${ctx.storeyOf.get(id) ?? 'none'}`;
    if (!groups.has(key)) groups.set(key, { pos: new Grow(Float32Array), nor: new Grow(Float32Array), idx: new Grow(Uint32Array), tri: new Grow(Uint32Array) });
    const g = groups.get(key);
    const start = g.pos.n / 3;
    for (let k = 0; k < mesh.geometries.size(); k++) {
      const placed = mesh.geometries.get(k);
      const geo = api.GetGeometry(model, placed.geometryExpressID);
      const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
      const ix = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
      const t = placed.flatTransformation;
      const base = g.pos.n / 3;
      for (let j = 0; j < v.length; j += 6) {
        const x = v[j], y = v[j + 1], z = v[j + 2], nx = v[j + 3], ny = v[j + 4], nz = v[j + 5];
        g.pos.push3(t[0] * x + t[4] * y + t[8] * z + t[12], t[1] * x + t[5] * y + t[9] * z + t[13], t[2] * x + t[6] * y + t[10] * z + t[14]);
        g.nor.push3(t[0] * nx + t[4] * ny + t[8] * nz, t[1] * nx + t[5] * ny + t[9] * nz, t[2] * nx + t[6] * ny + t[10] * nz);
      }
      for (let j = 0; j < ix.length; j++) g.idx.push1(base + ix[j]);
      for (let j = 0; j < ix.length; j += 3) g.tri.push1(id);
      geo.delete?.();
    }
    const c = boxOf(g.pos, start);
    if (c) centres.push(c); // an element with no shape of its own adds nothing
    const now = Date.now();
    if (now - last > 120) { last = now; say({ type: 'progress', done: i + 1, total }); }
  });

  const out = [];
  const transfer = [];
  for (const [key, g] of groups) {
    const [category, storey] = key.split('|');
    const item = { category, storey: storey === 'none' ? null : Number(storey), position: g.pos.done(), normal: g.nor.done(), index: g.idx.done(), triIds: g.tri.done() };
    if (!item.index.length) continue;
    out.push(item);
    transfer.push(item.position.buffer, item.normal.buffer, item.index.buffer, item.triIds.buffer);
  }
  groups.clear();
  self.postMessage({ type: 'groups', groups: out, fit: frame(centres), categories: CATEGORIES.map(({ key, label, color, opacity }) => ({ key, label, color, opacity })) }, transfer);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.cmd === 'open') await open(data.buffer);
    else if (data.cmd === 'info') say({ type: 'info', info: describeElement(api, W, model, data.id, ctx) });
    else if (data.cmd === 'close') { if (model != null) api.CloseModel(model); model = null; ctx = null; }
  } catch (e) {
    say({ type: 'error', tooBig: tooBig(e), message: String(e?.message || e) });
  }
};
