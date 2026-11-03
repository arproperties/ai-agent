/**
 * Reading an IFC building model with web-ifc: its storeys, which storey each element is on,
 * what type each element is, and the quantities the model itself carries (IfcElementQuantity,
 * the Qto_… sets a designer's software writes). Shared by the 3D viewer, which runs it in the
 * person's browser (client/src/lib/ifcWorker.js), and by Reem's own reading of a model for
 * chats and the Shelf (server/ifc.js), so the numbers a person taps on and the numbers Reem
 * quotes always come from the same code.
 *
 * Nothing here estimates: a quantity is either in the file or it is not.
 *
 * `api` is a web-ifc IfcAPI with the model open; `W` is the web-ifc module, for its type codes.
 * Neither is imported here because the browser and Node load web-ifc differently.
 */

// What each element type is shown and counted as. Colours are for the viewer, on its dark
// background: walls light, slabs grey, doors brown, windows blue glass, pipes and ducts green.
export const CATEGORIES = [
  { key: 'walls', label: 'Walls', color: 0xe6e1d3, types: ['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE', 'IFCCURTAINWALL'] },
  { key: 'slabs', label: 'Slabs & roofs', color: 0x9aa3ad, types: ['IFCSLAB', 'IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE', 'IFCROOF'] },
  { key: 'doors', label: 'Doors', color: 0xb07a4a, types: ['IFCDOOR', 'IFCDOORSTANDARDCASE'] },
  { key: 'windows', label: 'Windows', color: 0x6fb7e8, opacity: 0.55, types: ['IFCWINDOW', 'IFCWINDOWSTANDARDCASE'] },
  { key: 'pipes', label: 'Pipes & ducts', color: 0x4fc28a, types: ['IFCPIPESEGMENT', 'IFCPIPEFITTING', 'IFCDUCTSEGMENT', 'IFCDUCTFITTING', 'IFCFLOWSEGMENT', 'IFCFLOWFITTING'] },
  { key: 'structure', label: 'Columns & beams', color: 0xc9b37e, types: ['IFCCOLUMN', 'IFCCOLUMNSTANDARDCASE', 'IFCBEAM', 'IFCBEAMSTANDARDCASE', 'IFCMEMBER', 'IFCMEMBERSTANDARDCASE', 'IFCFOOTING', 'IFCPILE'] },
  { key: 'stairs', label: 'Stairs & railings', color: 0xa58fd0, types: ['IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAMP', 'IFCRAMPFLIGHT', 'IFCRAILING'] },
  { key: 'other', label: 'Other', color: 0x8d8aa0, types: [] },
];
const CATEGORY_OF = new Map(CATEGORIES.flatMap((c) => c.types.map((t) => [t, c.key])));
export const categoryOf = (typeName) => CATEGORY_OF.get(String(typeName).toUpperCase()) || 'other';

/** "IFCWALLSTANDARDCASE" → "Wall standard case", the way a person would say it. */
export function sayType(typeName) {
  const t = String(typeName || '').toUpperCase().replace(/^IFC/, '');
  const words = { STANDARDCASE: ' standard case', ELEMENTEDCASE: ' elemented case', BUILDINGELEMENTPROXY: 'building element (other)', FLOWSEGMENT: 'flow segment', FLOWFITTING: 'flow fitting', FLOWTERMINAL: 'flow terminal' };
  for (const [k, v] of Object.entries(words)) if (t.endsWith(k) && t !== k) return cap(t.slice(0, -k.length).toLowerCase().replace(/segment$|fitting$/, (m) => ` ${m}`) + v);
  if (words[t]) return cap(words[t]);
  return cap(t.toLowerCase().replace(/(segment|fitting|terminal|flight|element|covering|opening)$/, ' $1').trim());
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// SI prefixes, as IFC writes them.
const PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 };
const DIMS = { LENGTHUNIT: 1, AREAUNIT: 2, VOLUMEUNIT: 3 };

const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const ref = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : null);
const refs = (x) => (Array.isArray(x) ? x.map(ref).filter((n) => n != null) : ref(x) != null ? [ref(x)] : []);
const text = (x) => {
  const v = val(x);
  return typeof v === 'string' ? v.trim() : '';
};

function line(api, model, id) {
  try { return api.GetLine(model, id, false); } catch { return null; }
}
function ids(api, model, type) {
  if (type == null) return [];
  const v = api.GetLineIDsWithType(model, type);
  const out = [];
  for (let i = 0; i < v.size(); i++) out.push(v.get(i));
  return out;
}
const typeName = (api, model, id) => {
  try { return api.GetNameFromTypeCode(api.GetLineType(model, id)); } catch { return ''; }
};

/**
 * How many metres (m², m³) one of the model's own length (area, volume) units is. A model
 * from Revit is usually in millimetres for lengths and square metres for areas; `null` where
 * the file does not say, so a number is never given in metres when it might not be.
 */
function unitFactor(api, W, model, unitId, depth = 0) {
  const u = line(api, model, unitId);
  if (!u || depth > 4) return null;
  const t = typeName(api, model, unitId).toUpperCase();
  const kind = text(u.UnitType);
  const dim = DIMS[kind] || 1;
  if (t === 'IFCSIUNIT') {
    const name = text(u.Name);
    // An area or volume unit can be named SQUARE_METRE / CUBIC_METRE: its prefix is then
    // already squared or cubed by name, so the prefix applies to the length and is raised.
    if (!/METRE$/.test(name)) return null;
    return (PREFIX[text(u.Prefix)] || 1) ** dim;
  }
  if (t === 'IFCCONVERSIONBASEDUNIT' || t === 'IFCCONVERSIONBASEDUNITWITHOFFSET') {
    const m = line(api, model, ref(u.ConversionFactor));
    if (!m) return null;
    const v = Number(val(m.ValueComponent));
    const inner = unitFactor(api, W, model, ref(m.UnitComponent), depth + 1);
    return Number.isFinite(v) && inner ? v * inner : null;
  }
  return null;
}

/** The model's own units: { length, area, volume }, each a factor to metres or null. */
export function readUnits(api, W, model) {
  const out = { length: null, area: null, volume: null };
  for (const a of ids(api, model, W.IFCUNITASSIGNMENT).slice(0, 1)) {
    for (const uid of refs(line(api, model, a)?.Units)) {
      const u = line(api, model, uid);
      const kind = text(u?.UnitType);
      const key = { LENGTHUNIT: 'length', AREAUNIT: 'area', VOLUMEUNIT: 'volume' }[kind];
      if (key && out[key] == null) out[key] = unitFactor(api, W, model, uid);
    }
  }
  // A file that gives its length unit but not its area or volume unit means them in that
  // length unit, squared and cubed, as the IFC standard says.
  if (out.length != null) {
    out.area ??= out.length ** 2;
    out.volume ??= out.length ** 3;
  }
  return out;
}

/**
 * The model's layout: names, storeys (lowest first, elevations in metres where the units are
 * known), and which storey each element sits on. Elements inside another (a stair's flights,
 * a curtain wall's panels) and elements placed in a room are put on that room's storey.
 */
export function readLayout(api, W, model, units = readUnits(api, W, model)) {
  const name = (type) => {
    const id = ids(api, model, type)[0];
    if (id == null) return '';
    const l = line(api, model, id);
    return text(l?.LongName) || text(l?.Name);
  };
  const storeys = ids(api, model, W.IFCBUILDINGSTOREY).map((id) => {
    const l = line(api, model, id);
    const elev = Number(val(l?.Elevation));
    return {
      id,
      name: text(l?.LongName) || text(l?.Name) || `Storey #${id}`,
      elevation: Number.isFinite(elev) && units.length != null ? elev * units.length : null,
    };
  }).sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  const storeySet = new Set(storeys.map((s) => s.id));

  // Up the tree: each thing's parent, from containment (element in storey or room) and from
  // aggregation (storey in building, room in storey, flight in stair).
  const parent = new Map();
  for (const r of ids(api, model, W.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
    const l = line(api, model, r);
    const to = ref(l?.RelatingStructure);
    for (const e of refs(l?.RelatedElements)) parent.set(e, to);
  }
  for (const r of ids(api, model, W.IFCRELAGGREGATES)) {
    const l = line(api, model, r);
    const to = ref(l?.RelatingObject);
    for (const e of refs(l?.RelatedObjects)) if (!parent.has(e)) parent.set(e, to);
  }
  const storeyOf = new Map();
  const find = (id) => {
    let at = id;
    for (let i = 0; i < 12 && at != null; i++) {
      if (storeySet.has(at)) return at;
      if (storeyOf.has(at)) return storeyOf.get(at);
      at = parent.get(at);
    }
    return null;
  };
  for (const id of parent.keys()) {
    const s = find(id);
    if (s != null) storeyOf.set(id, s);
  }
  return { project: name(W.IFCPROJECT), site: name(W.IFCSITE), building: name(W.IFCBUILDING), storeys, storeyOf };
}

// The quantity kinds IFC has, with the field each keeps its number in and what it is measured in.
const QUANTITY = {
  IFCQUANTITYLENGTH: ['LengthValue', 'length', 'm'],
  IFCQUANTITYAREA: ['AreaValue', 'area', 'm²'],
  IFCQUANTITYVOLUME: ['VolumeValue', 'volume', 'm³'],
  IFCQUANTITYCOUNT: ['CountValue', 'count', ''],
  IFCQUANTITYWEIGHT: ['WeightValue', 'weight', 'kg'],
};

/**
 * Every quantity the model carries, by element: Map(elementId → [{ set, name, kind, value,
 * unit }]). Lengths, areas and volumes are turned into metres; where the file does not say
 * its units the number is kept as written and `unit` says "model units".
 */
export function readQuantities(api, W, model, units = readUnits(api, W, model)) {
  const out = new Map();
  for (const r of ids(api, model, W.IFCRELDEFINESBYPROPERTIES)) {
    const rel = line(api, model, r);
    for (const defId of refs(rel?.RelatingPropertyDefinition)) {
      if (typeName(api, model, defId).toUpperCase() !== 'IFCELEMENTQUANTITY') continue;
      const qto = line(api, model, defId);
      const set = text(qto?.Name) || 'Quantities';
      const list = [];
      for (const qid of refs(qto?.Quantities)) {
        const t = typeName(api, model, qid).toUpperCase();
        const spec = QUANTITY[t];
        if (!spec) continue;
        const q = line(api, model, qid);
        const raw = Number(val(q?.[spec[0]]));
        if (!Number.isFinite(raw)) continue;
        const own = ref(q?.Unit) != null ? unitFactor(api, W, model, ref(q.Unit)) : null;
        const f = spec[1] === 'count' || spec[1] === 'weight' ? 1 : own ?? units[spec[1]];
        list.push({ set, name: text(q?.Name) || spec[1], kind: spec[1], value: f == null ? raw : raw * f, unit: f == null ? 'model units' : spec[2] });
      }
      if (!list.length) continue;
      for (const e of refs(rel?.RelatedObjects)) {
        if (!out.has(e)) out.set(e, []);
        out.get(e).push(...list);
      }
    }
  }
  return out;
}

// Never counted as part of the building: holes cut for doors, windows and sleeves, and the
// helper shapes some programs add.
// The places elements sit in (site, building, storey, room, zone) are not elements either.
const NOT_ELEMENTS = new Set(['IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE', 'IFCVIRTUALELEMENT', 'IFCANNOTATION', 'IFCGRID',
  'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE', 'IFCSPATIALZONE', 'IFCZONE', 'IFCFACILITY', 'IFCFACILITYPART',
  'IFCBRIDGE', 'IFCROAD', 'IFCRAILWAY', 'IFCMARINEFACILITY', 'IFCEXTERNALSPATIALELEMENT']);

/** Every building element in the model, with its type name: [{ id, type }]. */
export function readElements(api, W, model) {
  const out = [];
  for (const t of api.GetAllTypesOfModel(model)) {
    const tn = String(t.typeName || api.GetNameFromTypeCode(t.typeID)).toUpperCase();
    if (NOT_ELEMENTS.has(tn) || !api.IsIfcElement(t.typeID)) continue;
    for (const id of ids(api, model, t.typeID)) out.push({ id, type: tn });
  }
  return out;
}

// Some programs write the same quantity twice, in the standard set and in their own
// ("NetVolume" in BaseQuantities, "Net Volume" in ArchiCADQuantities): shown once.
function once(list) {
  const seen = new Set();
  return list.filter((q) => {
    const k = `${q.name.toLowerCase().replace(/[\s_]+/g, '')}|${q.unit}|${Math.round(q.value * 1000)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** What the viewer shows when an element is tapped: its type, name, storey and quantities. */
export function describeElement(api, W, model, id, { storeys, storeyOf, quantities }) {
  const l = line(api, model, id);
  const tn = typeName(api, model, id);
  const storey = storeys.find((s) => s.id === storeyOf.get(id));
  return {
    id,
    type: sayType(tn),
    category: categoryOf(tn),
    name: text(l?.Name) || '',
    tag: text(l?.Tag) || '',
    storey: storey?.name || '',
    quantities: once(quantities.get(id) || []).map(({ set, name, value, unit }) => ({ set, name, value, unit })),
  };
}
