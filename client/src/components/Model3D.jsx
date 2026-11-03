import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { X, Layers, Ruler, Loader2, AlertTriangle, Box } from 'lucide-react';

/**
 * The full-screen 3D view of a building, made for a phone first: one finger turns it, two
 * pinch and move it, a tap says what was touched.
 *
 * Two kinds of model come here:
 * - an IFC file, read in the browser (lib/ifcWorker.js). It is the designer's real model,
 *   so the measure tool and the quantities the file carries are offered;
 * - a "rough" model made by the server from a 2D DWG/DXF plan (walls pushed up to a storey
 *   height). That is only a picture of the plan: the warning at the top cannot be closed,
 *   and nothing can be measured or looked up on it.
 *
 * This file is loaded only when someone opens a model, so three.js and web-ifc never weigh
 * on the rest of the app.
 */
export default function Model3D({ doc, rough = false, onClose }) {
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
        highlight(hit.id);
        worker?.postMessage({ cmd: 'info', id: hit.id });
      },
    });
    if (!v) { setError({ tooBig: true, noGl: true }); return; }
    view.current = v;

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
    const highlight = (id) => {
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
      v.scene.add(v.picked);
      v.render();
    };
    v.clearPick = () => { if (v.picked) { v.scene.remove(v.picked); v.picked.geometry.dispose(); v.picked = null; v.render(); } };

    const fail = (e) => alive && setError({ tooBig: !!e?.tooBig, message: e?.message || String(e) });

    if (rough) {
      fetchJson(`/api/documents/${doc.id}/rough3d`, (pct) => alive && setStage({ label: 'Making the rough 3D view…', pct }))
        .then((r) => {
          if (!alive) return;
          if (r.error) return setError({ message: r.error });
          const groups = roughGroups(r);
          setCats([{ key: 'walls', label: 'Walls', color: 0xe6e1d3 }]);
          setNote(r.note);
          v.load(groups, [{ key: 'walls', label: 'Walls', color: 0xe6e1d3 }]);
          setStage(null);
        }).catch(fail);
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
  }, [doc.id, rough]); // eslint-disable-line react-hooks/exhaustive-deps

  // Storeys and element types switched on and off.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    for (const m of v.meshes) m.visible = !hidden.has(m.userData.storey ?? 'none') && !hiddenCats.has(m.userData.category);
    v.clearPick?.();
    setInfo(null);
    v.render();
  }, [hidden, hiddenCats, stage]);

  useEffect(() => {
    if (!measure && view.current) { clearMeasure(view.current); view.current.render(); }
    setDistance(null);
    setInfo(null);
    view.current?.clearPick?.();
  }, [measure]);

  const toggle = (set, setter, k) => setter(new Set(set.has(k) ? [...set].filter((x) => x !== k) : [...set, k]));
  const unplaced = view.current?.meshes.some((m) => m.userData.storey == null) && storeys.length > 0;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col bg-[#0b0a1a] text-txt">
      <header className="on-dark flex items-center gap-2 px-3 pb-2 pt-safe md:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-p1/25 text-p1"><Box size={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{doc.title || doc.name}</p>
          <p className="truncate text-xs text-white/60">{rough ? 'Rough 3D from a 2D drawing' : '3D model'}</p>
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
        <div className="on-dark mx-3 mb-2 flex items-start gap-2 rounded-xl bg-amber-400/15 px-3 py-2 text-[13px] leading-snug text-amber-200 md:mx-5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>Rough 3D made from a 2D drawing, for viewing only. Heights and details may be wrong; do not measure from it.{note ? ` ${note}` : ''}</span>
        </div>
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

async function fetchJson(url, onPct) {
  onPct(20);
  const res = await fetch(url, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error || 'The rough 3D view could not be made.' };
  onPct(90);
  return body;
}

/**
 * The server sends rough walls as flat lists of numbers in metres: [x1, y1, x2, y2, …] and a
 * height. Each becomes a thin box standing on the floor, grouped into one mesh.
 */
function roughGroups({ walls, height, thickness = 0.2 }) {
  const pos = [], nor = [], idx = [];
  const h = height;
  const t = thickness / 2;
  for (let i = 0; i < walls.length; i += 4) {
    const x1 = walls[i], z1 = -walls[i + 1], x2 = walls[i + 2], z2 = -walls[i + 3]; // plan y runs "north", into the screen
    const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
    if (!len) continue;
    const nx = (-dz / len) * t, nz = (dx / len) * t;
    const c = [[x1 + nx, z1 + nz], [x2 + nx, z2 + nz], [x2 - nx, z2 - nz], [x1 - nx, z1 - nz]];
    const quad = (a, b, cc, d, n) => {
      const base = pos.length / 3;
      for (const p of [a, b, cc, d]) { pos.push(...p); nor.push(...n); }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const side = (a, b) => {
      const ex = b[0] - a[0], ez = b[1] - a[1], l = Math.hypot(ex, ez) || 1;
      quad([a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], h, b[1]], [a[0], h, a[1]], [ez / l, 0, -ex / l]);
    };
    for (let k = 0; k < 4; k++) side(c[k], c[(k + 1) % 4]);
    quad([c[0][0], h, c[0][1]], [c[1][0], h, c[1][1]], [c[2][0], h, c[2][1]], [c[3][0], h, c[3][1]], [0, 1, 0]);
  }
  return [{ category: 'walls', storey: null, position: new Float32Array(pos), normal: new Float32Array(nor), index: new Uint32Array(idx), triIds: new Uint32Array(idx.length / 3) }];
}

/** The three.js scene. Null when the device has no WebGL at all. */
function setup(el, { onLost, onTap }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2, powerPreference: 'high-performance' });
  } catch { return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0b0a1a);
  el.appendChild(renderer.domElement);
  // A phone that runs out of graphics memory drops the drawing surface rather than crashing.
  renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); onLost(); });

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404060, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;

  const v = { scene, camera, renderer, controls, meshes: [], size: 10, measure: { points: [], objects: [] }, picked: null };
  let frame = 0;
  v.render = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; renderer.render(scene, camera); });
  };
  controls.addEventListener('change', v.render);

  const resize = () => {
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
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
    const hit = raycaster.intersectObjects(v.meshes.filter((m) => m.visible), false)[0];
    onTap(hit ? { point: hit.point, id: hit.object.userData.triIds?.[hit.faceIndex] } : null);
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);

  v.load = (groups, categories, fit = null) => {
    const look = new Map(categories.map((c) => [c.key, c]));
    const materials = new Map();
    const box = new THREE.Box3();
    for (const g of groups) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(g.normal, 3));
      geo.setIndex(new THREE.BufferAttribute(g.index, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      if (!materials.has(g.category)) {
        const c = look.get(g.category) || look.get('other') || { color: 0x8d8aa0 };
        materials.set(g.category, new THREE.MeshLambertMaterial({
          color: c.color, side: THREE.DoubleSide,
          transparent: !!c.opacity, opacity: c.opacity || 1, depthWrite: !c.opacity,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        }));
      }
      const mesh = new THREE.Mesh(geo, materials.get(g.category));
      mesh.userData = { category: g.category, storey: g.storey, triIds: g.triIds };
      scene.add(mesh);
      v.meshes.push(mesh);
      box.union(geo.boundingBox);
    }
    if (box.isEmpty()) throw new Error('The model has no shapes to show.');
    if (fit && [...fit.min, ...fit.max].every(Number.isFinite)) box.set(new THREE.Vector3(...fit.min), new THREE.Vector3(...fit.max)); // the building, not a far-off marker
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    v.size = Math.max(size.x, size.y, size.z) || 10;
    camera.near = v.size / 1000;
    camera.far = v.size * 20;
    camera.position.set(centre.x + v.size * 1.1, centre.y + v.size * 0.8, centre.z + v.size * 1.1);
    camera.updateProjectionMatrix();
    controls.target.copy(centre);
    controls.update();
    v.render();
  };

  v.dispose = () => {
    ro.disconnect();
    controls.dispose();
    for (const m of v.meshes) { m.geometry.dispose(); m.material.dispose(); }
    if (v.picked) v.picked.geometry.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
  };
  return v;
}
