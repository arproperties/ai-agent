import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { X, Layers, Ruler, Loader2, AlertTriangle, Box, UnfoldVertical, RotateCw, Sun, Sparkles } from 'lucide-react';

const LOOK_KEY = 'reem:3d-look'; // the look last chosen, kept on this device only
const savedLook = () => { try { return localStorage.getItem(LOOK_KEY) === 'reem' ? 'reem' : 'day'; } catch { return 'day'; } };

/**
 * The full-screen 3D view of a building, made for a phone first: one finger turns it, two
 * pinch and move it, a tap says what was touched.
 *
 * Two kinds of model come here:
 * - an IFC file, read in the browser (lib/ifcWorker.js). It is the designer's real model,
 *   so the measure tool and the quantities the file carries are offered;
 * - a "rough" model made from a 2D plan: a DWG/DXF from its own lines, a PDF or a picture of a
 *   plan as Reem traced it (server: rough3d.js, plan3d.js), or a floor plan Reem drew in a chat
 *   (handed in as `plan`, no server). Walls are pushed up to a storey
 *   height). That is only a picture of the plan: the warning at the top cannot be closed,
 *   and nothing can be measured or looked up on it.
 *
 * This file is loaded only when someone opens a model, so three.js and web-ifc never weigh
 * on the rest of the app.
 */
export default function Model3D({ doc = null, rough = false, plan = null, title = null, onClose }) {
  rough = rough || !!plan;
  const host = useRef(null);
  const view = useRef(null); // three.js things that live as long as the sheet
  const [stage, setStage] = useState({ label: 'Downloading the model…', pct: 0 });
  const [error, setError] = useState(null);
  const [storeys, setStoreys] = useState([]);
  const [hidden, setHidden] = useState(() => new Set()); // storey ids (or 'none') switched off
  const [cats, setCats] = useState([]);
  const [hiddenCats, setHiddenCats] = useState(() => new Set());
  const [panel, setPanel] = useState(false);
  const [measure, setMeasure] = useState(false);
  const [distance, setDistance] = useState(null);
  const [info, setInfo] = useState(null);
  const [note, setNote] = useState(null); // what rough mode was built from (height used, etc.)
  const [noteOpen, setNoteOpen] = useState(false);
  // The show: floors lifted apart, one floor alone, the slow turn, and the look.
  const [apart, setApart] = useState(false);
  const [focus, setFocus] = useState(null);
  const [spin, setSpin] = useState(true);
  const [look, setLook] = useState(savedLook);
  const measureRef = useRef(false);
  measureRef.current = measure;

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    let worker = null;
    const v = setup(host.current, {
      onLost: () => alive && setError({ tooBig: true }),
      onTap: (hit) => {
        if (!alive || !hit) return;
        if (measureRef.current) return addPoint(hit.point);
        if (rough || hit.id == null) return;
        highlight(hit.id, hit.mesh);
        worker?.postMessage({ cmd: 'info', id: hit.id });
      },
    });
    if (!v) { setError({ tooBig: true, noGl: true }); return; }
    view.current = v;
    v.look = look;
    v.spin = spin;
    v.onSpin = (on) => alive && setSpin(on); // a touch stops the turn

    const addPoint = (p) => {
      const m = v.measure;
      if (m.points.length >= 2) clearMeasure(v);
      m.points.push(p.clone());
      const dot = new THREE.Mesh(new THREE.SphereGeometry(v.size * 0.006, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfacc15, depthTest: false }));
      dot.position.copy(p);
      dot.renderOrder = 10;
      v.scene.add(dot);
      m.objects.push(dot);
      if (m.points.length === 2) {
        const geo = new THREE.BufferGeometry().setFromPoints(m.points);
        const ln = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xfacc15, depthTest: false }));
        ln.renderOrder = 10;
        v.scene.add(ln);
        m.objects.push(ln);
        setDistance(m.points[0].distanceTo(m.points[1]));
      } else setDistance(null);
      v.render();
    };
    const highlight = (id, touched) => {
      if (v.picked) { v.scene.remove(v.picked); v.picked.geometry.dispose(); v.picked = null; }
      const parts = [];
      for (const mesh of v.meshes) {
        if (!mesh.visible) continue;
        const tri = mesh.userData.triIds, idx = mesh.geometry.index.array, pos = mesh.geometry.attributes.position.array;
        for (let t = 0; t < tri.length; t++) {
          if (tri[t] !== id) continue;
          for (let k = 0; k < 3; k++) { const i = idx[t * 3 + k] * 3; parts.push(pos[i], pos[i + 1], pos[i + 2]); }
        }
      }
      if (!parts.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(parts, 3));
      geo.computeVertexNormals();
      v.picked = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.6, depthTest: false }));
      v.picked.renderOrder = 5;
      v.picked.userData.level = touched.userData.level; // it rides with its floor when the floors open up
      v.scene.add(v.picked);
      v.render();
    };
    v.clearPick = () => { if (v.picked) { v.scene.remove(v.picked); v.picked.geometry.dispose(); v.picked = null; v.render(); } };

    const fail = (e) => alive && setError({ tooBig: !!e?.tooBig, message: e?.message || String(e) });

    if (rough) {
      const show = (r) => {
        if (!alive) return;
        if (r.error) return setError({ message: r.error });
        const { groups, floors } = roughGroups(r);
        if (floors.length > 1) setStoreys(floors);
        setNote(r.note);
        v.load(groups, ROUGH_PARTS);
        setCats(ROUGH_PARTS.filter((c) => groups.some((g) => g.category === c.key)));
        setStage(null);
      };
      if (plan) show(plan);
      else {
        fetchModel(`/api/documents/${doc.id}/rough3d`, (label, pct) => alive && setStage({ label, pct }), () => alive)
          .then(show).catch(fail);
      }
    } else {
      worker = new Worker(new URL('../lib/ifcWorker.js', import.meta.url), { type: 'module' });
      // web-ifc's own complaints are programmer's words; the person is told what it means.
      const unreadable = 'This file could not be opened as a 3D model. It may be damaged, or not a full IFC export: ask for it to be exported again.';
      worker.onerror = () => fail({ message: unreadable });
      worker.onmessage = ({ data }) => {
        if (!alive) return;
        if (data.type === 'progress') setStage({ label: `Reading the model… ${data.done} of ${data.total} parts`, pct: 50 + (50 * data.done) / data.total });
        else if (data.type === 'layout') setStoreys(data.storeys);
        else if (data.type === 'groups') {
          try {
            v.load(data.groups, data.categories, data.fit);
            setCats(data.categories.filter((c) => data.groups.some((g) => g.category === c.key)));
            setStage(null);
          } catch (e) { fail({ tooBig: /memory|allocat|Invalid array/i.test(e.message), message: e.message }); }
        } else if (data.type === 'info') { setPanel(false); setInfo(data.info); }
        else if (data.type === 'error') fail({ tooBig: data.tooBig, message: unreadable });
      };
      fetchBuffer(`/api/documents/${doc.id}/file?download=1`, (pct) => alive && setStage({ label: 'Downloading the model…', pct: pct / 2 }))
        .then((buffer) => {
          if (!alive) return;
          setStage({ label: 'Reading the model…', pct: 50 });
          worker.postMessage({ cmd: 'open', buffer }, [buffer]);
        }).catch(fail);
    }
    return () => {
      alive = false;
      worker?.terminate();
      v.dispose();
      view.current = null;
    };
  }, [doc?.id, rough, plan]); // eslint-disable-line react-hooks/exhaustive-deps

  // Storeys and element types switched on and off.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.setOff((m) => hidden.has(m.userData.storey ?? 'none') || hiddenCats.has(m.userData.category));
    v.clearPick?.();
    setInfo(null);
  }, [hidden, hiddenCats, stage]);

  useEffect(() => { view.current?.setSpin(spin); }, [spin]);
  useEffect(() => { if (!stage) view.current?.setApart(apart); }, [apart]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!stage) { view.current?.setFocus(focus); view.current?.clearPick?.(); setInfo(null); } }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    view.current?.setLook(look);
    try { localStorage.setItem(LOOK_KEY, look); } catch { /* private window: it is only a preference */ }
  }, [look]);

  useEffect(() => {
    // A distance is only true with the building whole and standing still.
    if (measure) { setApart(false); setSpin(false); }
    if (!measure && view.current) { clearMeasure(view.current); view.current.render(); }
    setDistance(null);
    setInfo(null);
    view.current?.clearPick?.();
  }, [measure]);

  const toggle = (set, setter, k) => setter(new Set(set.has(k) ? [...set].filter((x) => x !== k) : [...set, k]));
  const unplaced = view.current?.meshes.some((m) => m.userData.storey == null) && storeys.length > 0;
  // The floors that have something drawn on them, lowest first, for the floor buttons.
  const floors = stage ? [] : storeys.filter((st) => view.current?.levels.some((l) => l.key === st.id));
  const pill = (on) => `pointer-events-auto flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium shadow-lg backdrop-blur transition-colors ${on ? 'bg-p1 text-white' : 'bg-[#141128]/80 text-white/85 hover:bg-[#141128]'}`;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col bg-[#0b0a1a] text-txt">
      <header className="on-dark flex items-center gap-2 px-3 pb-2 pt-safe md:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-p1/25 text-p1"><Box size={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{title || doc?.title || doc?.name}</p>
          <p className="truncate text-xs text-white/60">{rough ? '3D from a 2D drawing' : '3D model'}</p>
        </div>
        {!stage && !error && (
          <>
            {!rough && (
              <button onClick={() => setMeasure((m) => !m)} aria-label="Measure" title="Measure"
                className={`grid size-10 place-items-center rounded-full ${measure ? 'bg-amber-400 text-[#141128]' : 'text-white/70 hover:bg-white/10'}`}><Ruler size={19} /></button>
            )}
            <button onClick={() => { setPanel((p) => !p); setInfo(null); }} aria-label="Floors and parts" title="Floors and parts"
              className={`grid size-10 place-items-center rounded-full ${panel ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10'}`}><Layers size={19} /></button>
          </>
        )}
        <button onClick={onClose} aria-label="Close" title="Close" className="grid size-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"><X size={20} /></button>
      </header>

      {rough && (
        // Always there and cannot be closed: a person must never take a size off this picture.
        // Folded to two lines so the building keeps the screen; a tap shows where the size came from.
        <button onClick={() => setNoteOpen((o) => !o)} className="on-dark mx-3 mb-2 flex items-start gap-2 rounded-xl bg-amber-400/15 px-3 py-2 text-left text-[13px] leading-snug text-amber-200 md:mx-5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span className={noteOpen ? '' : 'line-clamp-2'}>{note ? `${note} ` : ''}3D made from a 2D drawing, for viewing only: details may differ from the drawing.</span>
        </button>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0 touch-none" />

        {stage && !error && (
          <div className="on-dark absolute inset-0 grid place-items-center bg-[#0b0a1a]">
            <div className="w-64 text-center">
              <Loader2 size={22} className="mx-auto mb-3 animate-spin text-white/70" />
              <p className="mb-2 text-sm text-white/80">{stage.label}</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-gradient-to-r from-p1 to-p2 transition-[width]" style={{ width: `${Math.max(3, Math.min(100, stage.pct))}%` }} />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="on-dark absolute inset-0 grid place-items-center bg-[#0b0a1a] px-6">
            <div className="max-w-sm text-center">
              <AlertTriangle size={26} className="mx-auto mb-3 text-amber-300" />
              <p className="text-[15px] text-white">
                {error.noGl ? 'This device cannot show 3D models.'
                  : error.tooBig ? 'This model is too big to open on this phone.'
                    : error.message || 'The model could not be opened.'}
              </p>
              {(error.tooBig || error.noGl) && <p className="mt-2 text-sm text-white/60">Please open it on a computer instead: Reem on a laptop or desktop shows the same view.</p>}
              <button onClick={onClose} className="mt-5 rounded-full bg-white/10 px-5 py-2 text-sm text-white hover:bg-white/20">Close</button>
            </div>
          </div>
        )}

        {!stage && !error && measure && (
          <div className="on-dark pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <span className="rounded-full bg-black/70 px-4 py-2 text-sm text-white">
              {distance != null ? <>Distance: <b>{distance.toFixed(2)} m</b> · tap again to start over</> : 'Tap two points to measure between them'}
            </span>
          </div>
        )}

        {!stage && !error && !info && !measure && (
          <div className="on-dark pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-3">
            {floors.length > 1 && (
              <div className="flex max-w-full gap-1.5 overflow-x-auto pb-0.5">
                <button onClick={() => setFocus(null)} aria-pressed={focus == null} className={pill(focus == null)}>All floors</button>
                {floors.map((st) => (
                  <button key={st.id} onClick={() => { setFocus(focus === st.id ? null : st.id); setSpin(false); }} aria-pressed={focus === st.id} className={pill(focus === st.id)}>{st.name}</button>
                ))}
              </div>
            )}
            <div className="flex max-w-full gap-1.5 overflow-x-auto pb-0.5">
              {floors.length > 1 && (
                <button onClick={() => setApart((x) => !x)} aria-pressed={apart} className={pill(apart)}><UnfoldVertical size={15} /> Open up</button>
              )}
              <button onClick={() => setSpin((x) => !x)} aria-pressed={spin} className={pill(spin)}><RotateCw size={15} className={spin ? 'animate-[spin_4s_linear_infinite]' : ''} /> Turn</button>
              <div className="pointer-events-auto flex h-9 shrink-0 items-center rounded-full bg-[#141128]/80 p-1 shadow-lg backdrop-blur" role="group" aria-label="Look">
                {[['day', Sun, 'Daylight'], ['reem', Sparkles, 'Reem']].map(([k, Icon, label]) => (
                  <button key={k} onClick={() => setLook(k)} aria-pressed={look === k}
                    className={`flex h-7 items-center gap-1 rounded-full px-2.5 text-[13px] font-medium ${look === k ? 'bg-white text-[#141128]' : 'text-white/80'}`}><Icon size={14} /> {label}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {panel && !stage && !error && (
          <div className="on-dark absolute right-3 top-3 max-h-[70%] w-60 overflow-auto rounded-2xl border border-white/10 bg-[#141128]/95 p-3 text-sm shadow-2xl">
            {storeys.length > 0 && (
              <>
                <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-white/50">FLOORS</p>
                {[...storeys].reverse().map((s) => (
                  <label key={s.id} className="flex items-center gap-2 py-1 text-white/90">
                    <input type="checkbox" checked={!hidden.has(s.id)} onChange={() => toggle(hidden, setHidden, s.id)} className="size-4 accent-violet-400" />
                    <span className="flex-1 truncate">{s.name}</span>
                    {s.elevation != null && <span className="text-xs text-white/40">{s.elevation >= 0 ? '+' : ''}{s.elevation.toFixed(2)}</span>}
                  </label>
                ))}
                {unplaced && (
                  <label className="flex items-center gap-2 py-1 text-white/70">
                    <input type="checkbox" checked={!hidden.has('none')} onChange={() => toggle(hidden, setHidden, 'none')} className="size-4 accent-violet-400" />
                    <span>Not on a floor</span>
                  </label>
                )}
              </>
            )}
            <p className="mb-1.5 mt-3 text-[11px] font-semibold tracking-wide text-white/50">PARTS</p>
            {cats.map((c) => (
              <label key={c.key} className="flex items-center gap-2 py-1 text-white/90">
                <input type="checkbox" checked={!hiddenCats.has(c.key)} onChange={() => toggle(hiddenCats, setHiddenCats, c.key)} className="size-4 accent-violet-400" />
                <span className="size-3 rounded-sm" style={{ background: `#${c.color.toString(16).padStart(6, '0')}` }} />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        )}

        {info && !rough && !measure && (
          <div className="on-dark absolute inset-x-3 bottom-3 max-h-[45%] overflow-auto rounded-2xl border border-white/10 bg-[#141128]/95 p-4 text-sm shadow-2xl md:left-auto md:w-96">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-white">{info.type}</p>
                {info.name && <p className="text-white/70">{info.name}</p>}
                {info.storey && <p className="text-xs text-white/50">On {info.storey}</p>}
              </div>
              <button onClick={() => { setInfo(null); view.current?.clearPick?.(); }} aria-label="Close" className="grid size-8 place-items-center rounded-full text-white/60 hover:bg-white/10"><X size={16} /></button>
            </div>
            {info.quantities.length ? (
              <table className="mt-2 w-full text-[13px]">
                <tbody>
                  {info.quantities.map((q, i) => (
                    <tr key={i} className="border-t border-white/5">
                      <td className="py-1 pr-2 text-white/60">{q.name}</td>
                      <td className="whitespace-nowrap py-1 text-right text-white">{fmtQ(q)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="mt-2 text-xs text-white/50">The file has no quantities for this part.</p>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

const fmtQ = (q) => {
  const n = Math.abs(q.value) >= 100 ? Math.round(q.value).toLocaleString() : (Math.round(q.value * 1000) / 1000).toString();
  return q.unit ? `${n} ${q.unit}` : n;
};

function clearMeasure(v) {
  for (const o of v.measure.objects) { v.scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
  v.measure = { points: [], objects: [] };
}

/** Download with a progress bar: the size comes from the server's Content-Length. */
async function fetchBuffer(url, onPct) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(res.status === 404 ? 'This file could not be found, or you cannot open it.' : 'The model could not be downloaded.');
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > out.length) return new Blob([out.slice(0, at), value]).arrayBuffer(); // size was wrong; fall back
    out.set(value, at);
    at += value.length;
    onPct((100 * at) / total);
  }
  return out.buffer.slice(0, at);
}

/**
 * A rough model from the server. A PDF or picture plan takes a while the first time (Reem
 * reads it): the server says how far it has got, and is asked again until it is done.
 */
async function fetchModel(url, onStage, alive) {
  onStage('Making the 3D view…', 15);
  for (let tries = 0; tries < 200 && alive(); tries++) {
    const res = await fetch(url, { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 202) {
      onStage(body.step || 'Reading the plan…', Math.min(90, 20 + tries * 2));
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }
    if (!res.ok) return { error: body.error || 'The 3D view could not be made.' };
    onStage('Making the 3D view…', 95);
    return body;
  }
  return { error: 'Reading this drawing is taking too long. Please try again in a minute.' };
}

const ROUGH_PARTS = [
  { key: 'walls', label: 'Walls', color: 0xe6e1d3 },
  { key: 'slabs', label: 'Floors', color: 0x9aa3ad },
];
const SLAB_M = 0.15;

/**
 * The server sends rough walls as flat lists of numbers in metres: [x1, y1, x2, y2, …], plan
 * y running north, either for one storey ({ walls, height }) or floor by floor ({ floors:
 * [{ name, base, height, walls }] }). Each wall becomes a thin box standing on its floor, and
 * each floor gets a slab under it the size of its walls, so floors read as floors.
 */
function roughGroups(model) {
  const list = model.floors || [{ name: null, base: 0, height: model.height, walls: model.walls }];
  const t = (model.thickness || 0.2) / 2;
  const groups = [];
  const prism = (into, c, y0, y1) => { // a box from its four plan corners (x, z), between two heights
    const quad = (a, b, cc, d, n) => {
      const base = into.pos.length / 3;
      for (const p of [a, b, cc, d]) { into.pos.push(...p); into.nor.push(...n); }
      into.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4], ex = b[0] - a[0], ez = b[1] - a[1], l = Math.hypot(ex, ez) || 1;
      quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [ez / l, 0, -ex / l]);
    }
    quad(...c.map((p) => [p[0], y1, p[1]]), [0, 1, 0]);
    quad(...[...c].reverse().map((p) => [p[0], y0, p[1]]), [0, -1, 0]);
  };
  const pack = (into, category, storey) => groups.push({ category, storey, position: new Float32Array(into.pos), normal: new Float32Array(into.nor), index: new Uint32Array(into.idx), triIds: new Uint32Array(into.idx.length / 3) });
  const floors = [];
  list.forEach((f, i) => {
    const storey = list.length > 1 ? `f${i}` : null;
    const w = { pos: [], nor: [], idx: [] };
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < f.walls.length; k += 4) {
      const x1 = f.walls[k], z1 = -f.walls[k + 1], x2 = f.walls[k + 2], z2 = -f.walls[k + 3]; // plan y runs "north", into the screen
      const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
      if (!len) continue;
      const nx = (-dz / len) * t, nz = (dx / len) * t;
      prism(w, [[x1 + nx, z1 + nz], [x2 + nx, z2 + nz], [x2 - nx, z2 - nz], [x1 - nx, z1 - nz]], f.base, f.base + f.height - (list.length > 1 ? SLAB_M : 0));
      minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2); minZ = Math.min(minZ, z1, z2); maxZ = Math.max(maxZ, z1, z2);
    }
    if (!w.idx.length) return;
    pack(w, 'walls', storey);
    const slab = { pos: [], nor: [], idx: [] };
    prism(slab, [[minX - t, maxZ + t], [maxX + t, maxZ + t], [maxX + t, minZ - t], [minX - t, minZ - t]], f.base - SLAB_M, f.base);
    pack(slab, 'slabs', storey);
    if (storey) floors.push({ id: storey, name: f.name, elevation: f.base });
  });
  return { groups, floors };
}

// How each kind of part looks: matte walls, concrete slabs, wood doors, clear glass, a little
// shine on pipes and steel. The colours themselves come with the categories (the same ones
// the Floors and parts list shows), so the list and the model always agree.
const FINISH = {
  walls: { roughness: 0.92, metalness: 0 },
  slabs: { roughness: 0.85, metalness: 0 },
  doors: { roughness: 0.6, metalness: 0 },
  windows: { roughness: 0.05, metalness: 0.1, envMapIntensity: 1.6 },
  pipes: { roughness: 0.35, metalness: 0.4 },
  structure: { roughness: 0.8, metalness: 0.05 },
  stairs: { roughness: 0.7, metalness: 0.1 },
};
// Shadows and outlines are what make the model look real, and also what slows a phone down.
// Past these sizes (triangles in the whole model) they are left off, so a big model still turns smoothly.
const OUTLINE_UP_TO = 400_000;
const SHADOWS_UP_TO = 900_000;
const SKY_TOP = '#6fa3dc', SKY_HORIZON = '#e8eef4', GROUND = 0xdfe3e6;

/**
 * A soft sky dome: blue overhead fading to near white at the horizon, where the ground fades
 * into it. Drawn as a big sphere round the building so the horizon always sits level.
 */
function skyDome() {
  const geo = new THREE.SphereGeometry(1, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(SKY_TOP) }, horizon: { value: new THREE.Color(SKY_HORIZON) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vDir; void main() { gl_FragColor = vec4(mix(horizon, top, pow(clamp(vDir.y, 0.0, 1.0), 0.55)), 1.0);\n#include <colorspace_fragment>\n}',
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.raycast = () => {};
  sky.renderOrder = -1;
  return sky;
}

// The two looks. Daylight: the building outdoors on a bright day. Reem: the app's own night,
// glassy parts with violet glowing edges, as the building view in Leasing draws its towers.
const LOOKS = {
  day: {
    skyTop: SKY_TOP, skyHorizon: SKY_HORIZON, ground: GROUND, groundOpacity: 0.88, grid: 0xbfc6cc, gridOpacity: 0.45,
    sun: 3, fill: 0.5, env: 0.45, edge: 0x2b2f38, edgeOpacity: 0.45,
  },
  reem: {
    skyTop: '#241a4d', skyHorizon: '#0b0a1a', ground: 0x110e24, groundOpacity: 0.92, grid: 0x7c6cf0, gridOpacity: 0.3,
    sun: 1.1, fill: 0.55, env: 0.3, edge: 0xb4a2ff, edgeOpacity: 1, tint: 0x4a3a9e, mix: 0.72, glow: 0.35, glass: 0.74,
  },
};
const GHOST = 0.06; // how much of a floor shows while another one is looked at alone

/** The three.js scene. Null when the device has no WebGL at all. */
function setup(el, { onLost, onTap }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2, powerPreference: 'high-performance' });
  } catch { return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps whites white and colours true, as for a product shot
  renderer.shadowMap.type = THREE.PCFShadowMap;
  el.appendChild(renderer.domElement);
  // A phone that runs out of graphics memory drops the drawing surface rather than crashing.
  renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); onLost(); });

  const scene = new THREE.Scene();
  const sky = skyDome();
  scene.add(sky);
  // Soft light from every side, as if the building stood outdoors on a bright day; it is also
  // what the glass reflects.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  room.dispose?.();
  const fill = new THREE.HemisphereLight(0xdbe8ff, 0x8a7f6a, 0.5);
  const sun = new THREE.DirectionalLight(0xfff1dc, 3);
  scene.add(fill, sun, sun.target);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  // Damping lets the model glide to a stop after a swipe instead of halting dead.
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  controls.autoRotateSpeed = 0.8;

  const v = {
    scene, camera, renderer, controls, meshes: [], extras: [], levels: [], size: 10,
    measure: { points: [], objects: [] }, picked: null,
    look: 'day', apart: false, focus: null, spin: false,
  };
  let frame = 0, last = 0, intro = null, fly = null, ground = null, grid = null, home = null;

  // Each frame moves whatever is still moving (the camera's glide in, floors dropping into
  // place or opening apart, a flight to a floor, the slow turn) and asks for the next one
  // only while something is; a model standing still costs the phone nothing.
  const tick = (now) => {
    frame = 0;
    const dt = Math.min((now - (last || now)) / 1000, 0.05);
    last = now;
    let busy = false;
    if (intro) {
      const k = Math.min(1, (now - (intro.start ??= now)) / intro.ms);
      camera.position.copy(intro.from).lerp(intro.to, 1 - (1 - k) ** 3);
      if (k >= 1) intro = null;
      busy = true;
    }
    const glide = 1 - Math.exp(-dt * 6); // the same speed whatever the frame rate
    for (const l of v.levels) {
      if (!l.shown) {
        if ((l.wait -= dt) > 0) { busy = true; continue; }
        l.shown = true;
        for (const m of l.meshes) m.visible = !m.userData.off;
      }
      l.drop += (0 - l.drop) * glide;
      l.lift += ((v.apart ? l.index * v.gap : 0) - l.lift) * glide;
      if (Math.abs(l.drop) < v.size * 1e-4) l.drop = 0;
      if (Math.abs(l.lift - (v.apart ? l.index * v.gap : 0)) < v.size * 1e-4) l.lift = v.apart ? l.index * v.gap : 0;
      else busy = true;
      if (l.drop) busy = true;
      for (const m of l.meshes) m.position.y = l.drop + l.lift;
    }
    if (v.picked) v.picked.position.y = v.picked.userData.level.lift;
    if (fly) {
      const k = 1 - Math.exp(-dt * 4);
      camera.position.lerp(fly.at, k);
      controls.target.lerp(fly.look, k);
      if (camera.position.distanceTo(fly.at) < v.size * 0.002) fly = null;
      busy = true;
    }
    controls.autoRotate = v.spin && !intro;
    if (controls.autoRotate) busy = true;
    if (controls.update(dt)) busy = true;
    renderer.render(scene, camera);
    if (busy) v.render();
  };
  v.render = () => { if (!frame) frame = requestAnimationFrame(tick); };
  controls.addEventListener('change', v.render);
  // A touch takes over from anything moving the camera on its own.
  controls.addEventListener('start', () => { intro = null; fly = null; if (v.spin) { v.spin = false; v.onSpin?.(false); } });

  // The buttons along the bottom cover part of the picture: the view is drawn as if the
  // screen ran that much lower, so the building sits in the middle of what is left.
  const PAD = 90;
  const resize = () => {
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / (h + PAD);
    camera.setViewOffset(w, h + PAD, 0, PAD, w, h);
    camera.updateProjectionMatrix();
    v.render();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();

  // A tap is a short touch that hardly moved; anything else is turning or moving the model.
  let down = null;
  const raycaster = new THREE.Raycaster();
  const onDown = (e) => { down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: Date.now() } : null; };
  const onUp = (e) => {
    if (!down || !e.isPrimary) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = Date.now() - down.t < 500;
    down = null;
    if (moved > 8 || !quick) return;
    const r = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    // A faded floor is only there to show where the others are: taps go through it.
    const hit = raycaster.intersectObjects(v.meshes.filter((m) => m.visible && !m.userData.level.ghost), false)[0];
    onTap(hit ? { point: hit.point, id: hit.object.userData.triIds?.[hit.faceIndex], mesh: hit.object } : null);
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);

  /** Where the camera stands to have every corner of `box` on screen, looking along `dir`. */
  const view = (box, dir) => {
    const centre = box.getCenter(new THREE.Vector3());
    const fwd = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), tanH = tanV * camera.aspect;
    let dist = 0;
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(centre);
      const near = c.dot(dir);
      dist = Math.max(dist, near + Math.abs(c.dot(right)) / tanH, near + Math.abs(c.dot(up)) / tanV);
    }
    dist = (dist || v.size) * 1.08;
    return { at: dir.clone().multiplyScalar(dist).add(centre), look: centre, dist };
  };
  // The camera's present direction from what it looks at, raised to `rise` at the least.
  const facing = (rise) => {
    const d = camera.position.clone().sub(controls.target);
    d.y = 0;
    if (d.lengthSq() < 1e-9) d.set(1, 0, 1);
    d.normalize().multiplyScalar(Math.cos(rise));
    d.y = Math.sin(rise);
    return d.normalize();
  };
  /** The building as it stands now: lifted apart or not, a picked floor or all of it. */
  const standing = () => {
    const b = new THREE.Box3();
    for (const l of v.levels) {
      if (v.focus != null && l.key !== v.focus) continue;
      const lb = l.box.clone();
      const y = v.apart ? l.index * v.gap : 0;
      lb.min.y += y; lb.max.y += y;
      b.union(lb);
    }
    return b.isEmpty() ? home.clone() : v.focus == null ? b.intersect(home.clone().expandByVector(new THREE.Vector3(0, v.apart ? v.gap * v.levels.length : 0, 0))) : b;
  };
  const flyTo = (rise) => { fly = view(standing(), facing(rise)); v.render(); };

  // How a part looks, from the look chosen and whether its floor is faded out.
  const dress = (m) => {
    const L = LOOKS[v.look], b = m.userData.base, mat = m.material, ghost = m.userData.level.ghost;
    mat.color.copy(b.color);
    mat.emissive.setRGB(0, 0, 0);
    let opacity = b.opacity;
    if (L.tint) {
      mat.color.lerp(new THREE.Color(L.tint), m.userData.category === 'windows' ? 0.2 : L.mix);
      mat.emissive.copy(mat.color).multiplyScalar(L.glow);
      opacity = Math.min(opacity, L.glass);
    }
    if (ghost) opacity = GHOST;
    mat.transparent = opacity < 1;
    mat.opacity = opacity;
    mat.depthWrite = opacity > 0.6;
    mat.needsUpdate = true;
    const edge = m.children[0]?.material;
    if (edge) { edge.color.set(L.edge); edge.opacity = ghost ? GHOST * 2 : L.edgeOpacity; }
    m.castShadow = v.shadows && opacity > 0.6;
  };

  v.load = (groups, categories, fit = null) => {
    const look = new Map(categories.map((c) => [c.key, c]));
    const triangles = groups.reduce((n, g) => n + g.index.length / 3, 0);
    const outlines = triangles <= OUTLINE_UP_TO;
    v.shadows = triangles <= SHADOWS_UP_TO;
    const box = new THREE.Box3();
    const levels = new Map();
    for (const g of groups) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(g.normal, 3));
      geo.setIndex(new THREE.BufferAttribute(g.index, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const c = look.get(g.category) || look.get('other') || { color: 0x8d8aa0 };
      // Each piece has its own material, so one floor can fade while the others stay.
      const mat = new THREE.MeshStandardMaterial({
        color: c.color, side: THREE.DoubleSide, roughness: 0.8, metalness: 0, ...FINISH[g.category],
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const key = g.storey ?? 'none';
      if (!levels.has(key)) levels.set(key, { key, meshes: [], box: new THREE.Box3(), drop: 0, lift: 0, ghost: false, shown: false });
      const level = levels.get(key);
      mesh.userData = { category: g.category, storey: g.storey, triIds: g.triIds, level, base: { color: new THREE.Color(c.color), opacity: c.opacity || 1 } };
      mesh.receiveShadow = v.shadows;
      mesh.visible = false; // until its floor drops into place
      // Thin lines on the corners, like an architect's card model. A child of the mesh, so
      // switching a floor or a part off hides its lines too.
      if (outlines) mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ transparent: true })));
      level.meshes.push(mesh);
      level.box.union(geo.boundingBox);
      scene.add(mesh);
      v.meshes.push(mesh);
      box.union(geo.boundingBox);
    }
    v.extras.push(sky.geometry, sky.material);
    if (box.isEmpty()) throw new Error('The model has no shapes to show.');
    // The worker's frame leaves out far-off markers but is generous (it adds each part's
    // reach); where the two overlap is the building itself.
    if (fit && [...fit.min, ...fit.max].every(Number.isFinite)) {
      const framed = new THREE.Box3(new THREE.Vector3(...fit.min), new THREE.Vector3(...fit.max));
      const tight = box.clone().intersect(framed);
      box.copy(tight.isEmpty() ? framed : tight);
    }
    home = box.clone();
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    v.size = Math.max(size.x, size.y, size.z) || 10;
    const s = v.size;
    // Floors from the bottom up: each drops into place a moment after the one below, and
    // "Open up" lifts each a step further than the one below it.
    v.levels = [...levels.values()].sort((a, b) => a.box.min.y - b.box.min.y);
    v.levels.forEach((l, i) => { l.index = i; l.wait = 0.25 + i * 0.22; l.drop = s * 0.35; });
    v.gap = Math.max(s * 0.14, size.y / Math.max(v.levels.length, 1) * 0.9);
    // The ground is at the foot of the walls (or of whatever the model has), so the building
    // stands on it; anything lower, like a drain or footings, shows faintly through it.
    const feet = new THREE.Box3();
    for (const m of v.meshes) if (m.userData.category === 'walls' || m.userData.category === 'doors') feet.union(m.geometry.boundingBox);
    const groundY = Math.max(feet.isEmpty() ? box.min.y : feet.min.y, box.min.y);

    const groundGeo = new THREE.CircleGeometry(s * 12, 64).rotateX(-Math.PI / 2);
    ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ roughness: 1, transparent: true, depthWrite: false }));
    ground.position.set(centre.x, groundY - s * 0.001, centre.z);
    ground.receiveShadow = v.shadows;
    ground.raycast = () => {}; // taps go through it: only the building can be picked or measured
    scene.add(ground);
    scene.fog = new THREE.Fog(SKY_HORIZON, s * 3, s * 11);
    sky.scale.setScalar(s * 20);
    sky.position.set(centre.x, groundY, centre.z);
    // A faint site grid gives the ground scale and depth.
    const step = 10 ** Math.floor(Math.log10(s / 4));
    const lines = Math.round((s * 3) / step);
    grid = new THREE.GridHelper(lines * step, lines);
    grid.material.vertexColors = false;
    grid.material.transparent = true;
    grid.position.set(centre.x, groundY, centre.z);
    grid.raycast = () => {};
    scene.add(grid);
    v.extras.push(groundGeo, ground.material, grid.geometry, grid.material);

    // The sun high and over the viewer's left shoulder: the front face lit, the side in shade,
    // and the shadow falling where it can be seen, with its size fitted to the building.
    sun.position.set(centre.x - s * 0.5, centre.y + s * 1.5, centre.z + s * 1.1);
    sun.target.position.copy(centre);
    if (v.shadows) {
      renderer.shadowMap.enabled = true;
      sun.castShadow = true;
      const sc = sun.shadow.camera, r = s * 1.1;
      sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
      sc.near = s * 0.1; sc.far = s * 5;
      sc.updateProjectionMatrix();
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = s * 0.0008;
      sun.shadow.radius = 3;
    }
    v.setLook(v.look);

    // Far enough back that every corner of the building is on screen (a phone held upright is
    // narrow), seen from the usual three-quarter view; it glides in from further out and a
    // little round while the floors drop into place.
    const { at: to, dist } = view(box, new THREE.Vector3(1, 0.5, 1).normalize());
    camera.near = s / 1000;
    camera.far = Math.max(s * 30, dist * 4);
    camera.updateProjectionMatrix();
    controls.target.copy(centre);
    controls.maxPolarAngle = Math.PI * 0.495; // never under the ground
    const from = to.clone().sub(centre).applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.7).multiplyScalar(1.6).add(centre);
    from.y = Math.max(from.y, centre.y + dist * 0.9);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      camera.position.copy(to);
      for (const l of v.levels) { l.wait = 0; l.drop = 0; }
    } else {
      camera.position.copy(from);
      intro = { from, to, ms: 1600 };
    }
    controls.update();
    v.render();
  };

  /** 'day' or 'reem'. */
  v.setLook = (name) => {
    v.look = LOOKS[name] ? name : 'day';
    const L = LOOKS[v.look];
    sky.material.uniforms.top.value.set(L.skyTop);
    sky.material.uniforms.horizon.value.set(L.skyHorizon);
    scene.fog?.color.set(L.skyHorizon);
    if (ground) { ground.material.color.set(L.ground); ground.material.opacity = L.groundOpacity; }
    if (grid) { grid.material.color.set(L.grid); grid.material.opacity = L.gridOpacity; grid.material.needsUpdate = true; }
    sun.intensity = L.sun;
    fill.intensity = L.fill;
    scene.environmentIntensity = L.env;
    for (const m of v.meshes) dress(m);
    v.render();
  };
  /** The floors lifted apart, a step each, or back together. */
  v.setApart = (on) => {
    v.apart = !!on;
    if (home) flyTo(v.focus == null ? 0.42 : 0.85);
  };
  /** One floor alone (its key, from the worker's storeys) with the others faded, or null for all. */
  v.setFocus = (key) => {
    v.focus = v.levels.some((l) => l.key === key) ? key : null;
    for (const l of v.levels) l.ghost = v.focus != null && l.key !== v.focus;
    for (const m of v.meshes) dress(m);
    if (home) flyTo(v.focus == null ? 0.42 : 0.85);
  };
  v.setSpin = (on) => { v.spin = !!on; v.render(); };
  /** Switched off by the person in the Floors and parts list. */
  v.setOff = (test) => {
    for (const m of v.meshes) {
      m.userData.off = test(m);
      if (m.userData.level.shown) m.visible = !m.userData.off;
    }
    v.render();
  };

  v.dispose = () => {
    ro.disconnect();
    controls.dispose();
    if (frame) cancelAnimationFrame(frame);
    for (const m of v.meshes) { m.geometry.dispose(); m.material.dispose(); for (const c of m.children) { c.geometry.dispose(); c.material.dispose(); } }
    for (const x of v.extras) x.dispose();
    if (v.picked) v.picked.geometry.dispose();
    scene.environment?.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
  };
  return v;
}
