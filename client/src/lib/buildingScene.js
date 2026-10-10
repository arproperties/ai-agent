import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// The building drawn in 3D: a tower of floors, each a row or two of units, that can be
// turned, pulled apart floor by floor, and tapped. It knows nothing of leasing: the
// component (Building3D.jsx) says how each unit is painted, and is told what is pointed at.
//
//   floors: bottom floor first, each { label, units: [{ id, label }] }
//   shape:  given when the building has a floor plan: { W, D }, its footprint. Each unit then
//     has `rect`, where it really is ({ x, z, w, d }, from the middle of the floor, +z the
//     front), and a floor may have `commons`, what is there besides the units: the same
//     rectangles, each with a `kind` (corridor, core, lobby, service, open) and a `label`.
//   paint:  unit id → { color, dim, pulse, beacon }
//     dim: a unit that is there but not the point (vacant, or outside what is being looked at)
//     pulse: it breathes, to be noticed; beacon: a light on its face (a repair is open)

const UNIT_H = 1; // a storey
const SLAB = 0.1; // the floor between two storeys
const UNIT_W = 1.5; // the least a unit is wide
const UNIT_D = 2.2;
const HALL = 0.9; // the corridor between the front row and the back
const SPREAD = 1.3; // how far the floors lift apart
const ease = (from, to, k) => from + (to - from) * k;

/** The unit's number, written on its outward face. */
function plate(text, ink) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = ink;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 76;
  do { g.font = `600 ${size}px system-ui, sans-serif`; size -= 4; } while (g.measureText(text).width > 224 && size > 20);
  g.fillText(text, 128, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function createBuildingScene(el, { onHover, onPick, onTurn, light = false, ink = '#ffffff', tagInk = ink, line = '#a78bfa' } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  el.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 500);
  scene.add(new THREE.HemisphereLight(0xffffff, light ? 0xb8b4d0 : 0x1a1638, light ? 1.5 : 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, light ? 1.6 : 1.2);
  sun.position.set(6, 12, 9);
  scene.add(sun);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.04; // never from under the ground
  controls.autoRotateSpeed = 0.7;
  controls.addEventListener('start', () => onTurn?.());

  let tower = null; // everything of the building on screen, replaced whole when another is shown
  let floors = []; // { group, y, units, slab, tag, wait }
  let units = []; // { id, floor, mesh, edges, face, lid, beacon, home, out, color, opacity, edge, pulse, dim }
  let view = { explode: false, floor: null, selected: null };
  let home = null; // where the camera starts for this building
  let fly = null; // where it is being taken to
  const lineColor = new THREE.Color(line);

  function clear() {
    if (!tower) return;
    scene.remove(tower);
    tower.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) { m.map?.dispose(); m.dispose(); }
    });
    tower = null; floors = []; units = [];
  }

  /** Draw a building. Its floors rise into place one after another. */
  function setData(list, shape) {
    clear();
    tower = new THREE.Group();
    scene.add(tower);
    const rows = list.some((f) => f.units.length > 2) ? 2 : 1;
    const perRow = Math.max(1, ...list.map((f) => Math.ceil(f.units.length / rows)));
    const W = shape ? shape.W : Math.min(Math.max(perRow * UNIT_W, 4.5), 20);
    const D = shape ? shape.D : rows === 2 ? UNIT_D * 2 + HALL : UNIT_D;
    const pitch = UNIT_H + SLAB;
    const H = Math.max(1, list.length) * pitch;

    // The ground it stands on.
    const grid = new THREE.GridHelper(Math.max(W, D) * 3.2, 28, lineColor, lineColor);
    grid.material.transparent = true; grid.material.opacity = light ? 0.22 : 0.13;
    grid.position.y = -0.06;
    tower.add(grid);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(W + 1.1, 0.1, D + 1.1), new THREE.MeshStandardMaterial({ color: lineColor, transparent: true, opacity: 0.28 }));
    pad.position.y = -0.05;
    tower.add(pad);

    const slabGeo = new THREE.BoxGeometry(W + 0.3, SLAB, D + 0.3);
    list.forEach((f, i) => {
      const group = new THREE.Group();
      group.position.y = i * pitch - 4; // from below, see step()
      tower.add(group);
      const slab = new THREE.Mesh(slabGeo, new THREE.MeshStandardMaterial({ color: light ? 0x8e88b8 : 0x4a4470, transparent: true, opacity: 0 }));
      slab.position.y = SLAB / 2;
      group.add(slab);
      // The floor's name, standing off its left end.
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: plate(f.label, tagInk), transparent: true, opacity: 0, depthWrite: false }));
      tag.scale.set(1.5, 0.75, 1);
      tag.position.set(-W / 2 - 1.2, SLAB + UNIT_H / 2, D / 2);
      group.add(tag);
      const floor = { group, y: i * pitch, slab, tag, units: [], parts: [], wait: i * 3, shown: 0 };
      floors.push(floor);

      // What is on the floor besides the units. A corridor or a terrace is a mat on the slab; the rest stand a storey high.
      for (const c of (shape && f.commons) || []) {
        const flat = c.kind === 'corridor' || c.kind === 'open';
        const h = flat ? 0.03 : UNIT_H - 0.1;
        const geo = new THREE.BoxGeometry(c.w - 0.1, h, c.d - 0.1);
        const o = { corridor: 0.3, open: 0.14, core: 0.5, lobby: 0.26, service: 0.3 }[c.kind];
        const box = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: c.kind === 'core' || c.kind === 'service' ? (light ? 0x8e88b8 : 0x6a6494) : lineColor, transparent: true, opacity: 0, depthWrite: false }));
        box.position.set(c.x, SLAB + h / 2, c.z);
        floor.parts.push({ material: box.material, o });
        if (!flat) {
          const rim = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0 }));
          box.add(rim);
          floor.parts.push({ material: rim.material, o: 0.45 });
        }
        if (c.label) {
          const w = Math.min(c.w - 0.3, 2.4);
          const name = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 2), new THREE.MeshBasicMaterial({ map: plate(c.label, tagInk), transparent: true, opacity: 0, depthWrite: false }));
          name.rotation.x = -Math.PI / 2;
          name.position.y = h / 2 + 0.012;
          box.add(name);
          floor.parts.push({ material: name.material, o: 0.8, open: true });
        }
        group.add(box);
      }

      const front = rows === 2 ? Math.ceil(f.units.length / 2) : f.units.length;
      f.units.forEach((u, n) => {
        // From the plan, where it really is; with none, an equal share of the front row or the back.
        const back = shape ? u.rect.z < 0 : n >= front;
        const count = back ? f.units.length - front : front;
        const w = shape ? u.rect.w : W / count;
        const d = shape ? u.rect.d : UNIT_D;
        const x = shape ? u.rect.x : -W / 2 + w * ((back ? n - front : n) + 0.5);
        const z = shape ? u.rect.z : rows === 2 ? (back ? -1 : 1) * (HALL / 2 + UNIT_D / 2) : 0;
        const geo = new THREE.BoxGeometry(w - 0.1, UNIT_H - 0.1, d - 0.1);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x888888, transparent: true, opacity: 0, roughness: 0.45, metalness: 0.1 }));
        mesh.position.set(x, SLAB + UNIT_H / 2, z);
        mesh.userData.unit = u.id;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
        mesh.add(edges);
        const face = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w - 0.25, 1.5), Math.min((w - 0.25) / 2, 0.75)),
          new THREE.MeshBasicMaterial({ map: plate(u.label, ink), transparent: true, opacity: 0, depthWrite: false }));
        face.position.z = (d - 0.1) / 2 + 0.012;
        if (back) { face.position.z *= -1; face.rotation.y = Math.PI; }
        mesh.add(face);
        // And again on its top, to be read from above once the floors are apart.
        const lid = new THREE.Mesh(face.geometry, new THREE.MeshBasicMaterial({ map: face.material.map, transparent: true, opacity: 0, depthWrite: false }));
        lid.rotation.x = -Math.PI / 2;
        lid.position.y = (UNIT_H - 0.1) / 2 + 0.012;
        mesh.add(lid);
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0 }));
        beacon.position.set(Math.min(w / 2 - 0.25, 0.9), UNIT_H / 2 - 0.2, (back ? -1 : 1) * ((d - 0.1) / 2 + 0.1));
        beacon.visible = false;
        mesh.add(beacon);
        group.add(mesh);
        const unit = { id: u.id, floor: i, mesh, edges, face, lid, beacon, home: z, out: back ? -1 : 1, color: new THREE.Color(0x888888), opacity: 0.9, edge: 0.5, pulse: false };
        floor.units.push(unit);
        units.push(unit);
      });
    });

    // The roof, and the plant room on it.
    const top = new THREE.Group();
    const roof = new THREE.Mesh(slabGeo, new THREE.MeshStandardMaterial({ color: light ? 0x8e88b8 : 0x4a4470, transparent: true, opacity: 0 }));
    roof.position.y = SLAB / 2;
    const plant = new THREE.Mesh(new THREE.BoxGeometry(Math.min(W * 0.3, 2.2), 0.45, Math.min(D * 0.4, 1.6)), new THREE.MeshStandardMaterial({ color: lineColor, transparent: true, opacity: 0 }));
    plant.position.set(W * 0.18, SLAB + 0.22, 0);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.3), new THREE.MeshBasicMaterial({ color: lineColor, transparent: true, opacity: 0 }));
    mast.position.set(W * 0.18, SLAB + 1.1, 0);
    top.add(roof, plant, mast);
    top.position.y = H - 4;
    tower.add(top);
    floors.push({ group: top, y: H, slab: roof, extras: [plant, mast], units: [], wait: list.length * 3, shown: 0, roof: true });

    home = { H, W, D, tall: H + (list.length - 1) * SPREAD };
    const start = whole(H);
    camera.position.copy(start.at);
    controls.target.copy(start.look);
    controls.minDistance = 4;
    controls.maxDistance = whole(home.tall).at.length() * 2.2;
    fly = null;
    setPaint(new Map());
  }

  /** How each unit is coloured. */
  function setPaint(paint) {
    for (const u of units) {
      const p = paint.get(u.id) || {};
      u.color.set(p.color || '#888888');
      u.opacity = p.dim ? (light ? 0.45 : 0.2) : 0.94;
      u.edge = p.dim ? 0.35 : 0.6;
      u.pulse = !!p.pulse;
      u.beacon.visible = !!p.beacon;
      u.dim = !!p.dim;
    }
  }

  /** Where the camera stands to take in a building this tall: far enough back, a little above and to one side. */
  function whole(H) {
    const reach = Math.max(H * 1.25, home.W * 1.1, 7) / Math.tan((camera.fov * Math.PI) / 360) / 1.9 + home.D;
    return { at: new THREE.Vector3(reach * 0.62, H * 0.5 + reach * 0.34, reach * 0.78), look: new THREE.Vector3(0, H * 0.45, 0) };
  }
  const all = () => whole(view.explode ? home.tall : home.H);

  /** explode: the floors lift apart. floor: only this one is solid. selected: this unit steps out. */
  function setView(next) {
    const before = view;
    view = { ...view, ...next };
    if (!home) return;
    if (view.floor !== before.floor || view.explode !== before.explode) {
      // Look at the floor that was picked, from higher up, so its back row shows too; or at the whole again.
      if (view.floor == null) fly = all();
      else {
        const y = floorY(view.floor);
        const d = whole(home.H).at.length() * 0.62;
        const turn = Math.atan2(camera.position.x, camera.position.z);
        fly = { at: new THREE.Vector3(Math.sin(turn) * d * 0.62, y + d * 0.72, Math.cos(turn) * d * 0.62), look: new THREE.Vector3(0, y, 0) };
      }
    }
  }
  const floorY = (i) => floors[i].y + (view.explode ? i * SPREAD : 0);
  const reset = () => { if (home) fly = all(); };
  const setSpin = (on) => { controls.autoRotate = !!on; };

  // ---------- pointing ----------

  const ray = new THREE.Raycaster();
  const at = new THREE.Vector2();
  function unitAt(e) {
    const box = renderer.domElement.getBoundingClientRect();
    at.set(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1);
    ray.setFromCamera(at, camera);
    const open = units.filter((u) => view.floor == null || u.floor === view.floor).map((u) => u.mesh);
    const hit = ray.intersectObjects(open, false)[0];
    return hit ? hit.object.userData.unit : null;
  }
  let down = null;
  let over = null;
  const onMove = (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true;
    if (e.pointerType !== 'mouse') return; // a finger has no hover
    const id = e.buttons ? null : unitAt(e);
    if (id !== over || id != null) onHover?.(id, e.clientX, e.clientY);
    over = id;
    renderer.domElement.style.cursor = id != null ? 'pointer' : 'grab';
  };
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY, moved: false }; };
  const onUp = (e) => {
    if (down && !down.moved) onPick?.(unitAt(e));
    down = null;
  };
  const onLeave = () => { over = null; onHover?.(null); };
  const dom = renderer.domElement;
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointerleave', onLeave);

  // ---------- every frame ----------

  function size() {
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const watch = new ResizeObserver(size);
  watch.observe(el);
  size();

  let frame = 0;
  let stopped = false;
  const clock = new THREE.Clock();
  function step() {
    if (stopped) return;
    frame = requestAnimationFrame(step);
    const dt = Math.min(clock.getDelta(), 0.05);
    const k = 1 - Math.exp(-dt * 7); // the same glide whatever the frame rate
    const beat = (Math.sin(clock.elapsedTime * 3.2) + 1) / 2;

    floors.forEach((f, i) => {
      if (f.wait > 0) { f.wait -= dt * 60; return; }
      f.shown = ease(f.shown, 1, k);
      const y = f.roof ? f.y + (view.explode ? (floors.length - 1) * SPREAD : 0) : floorY(i);
      f.group.position.y = ease(f.group.position.y, y, k);
      const away = view.floor != null && view.floor !== i;
      const solid = f.shown * (away ? 0.05 : 1);
      f.slab.material.opacity = ease(f.slab.material.opacity, solid * (f.roof ? 0.55 : 0.5), k);
      f.slab.material.depthWrite = f.slab.material.opacity > 0.3; // a floor faded away hides nothing behind it
      for (const x of f.extras || []) x.material.opacity = ease(x.material.opacity, solid * 0.6, k);
      for (const x of f.parts || []) x.material.opacity = ease(x.material.opacity, away || (x.open && !(view.explode || view.floor === i)) ? (x.open ? 0 : solid * x.o) : solid * x.o, k);
      if (f.tag) f.tag.material.opacity = ease(f.tag.material.opacity, f.shown * (away ? 0.12 : view.explode || view.floor === i ? 0.95 : 0.55), k);
      for (const u of f.units) {
        const m = u.mesh.material;
        const picked = u.id === view.selected;
        m.color.lerp(u.color, k);
        m.emissive.copy(m.color).multiplyScalar((light ? 0.1 : 0.3) + (u.pulse ? beat * 0.55 : 0) + (picked ? 0.35 : 0));
        m.opacity = ease(m.opacity, solid * (picked ? 1 : u.opacity), k);
        m.depthWrite = m.opacity > 0.6;
        u.edges.material.opacity = ease(u.edges.material.opacity, solid * (picked ? 1 : u.edge), k);
        u.edges.material.color.copy(picked || u.dim ? m.color : lineColor).lerp(new THREE.Color(0xffffff), picked ? 1 : light ? 0 : 0.35);
        u.face.material.opacity = ease(u.face.material.opacity, solid * (u.dim && !picked ? 0.55 : 1), k);
        u.lid.material.opacity = ease(u.lid.material.opacity, !away && (view.explode || view.floor === i) ? u.face.material.opacity : 0, k);
        u.mesh.position.z = ease(u.mesh.position.z, u.home + (picked ? u.out * 0.45 : 0), k);
        if (u.beacon.visible) {
          u.beacon.material.opacity = solid;
          u.beacon.scale.setScalar(0.8 + beat * 0.7);
        }
      }
    });

    if (fly) {
      camera.position.lerp(fly.at, k * 0.7);
      controls.target.lerp(fly.look, k * 0.7);
      if (camera.position.distanceTo(fly.at) < 0.05) fly = null;
    }
    controls.update();
    renderer.render(scene, camera);
  }
  // A drag takes the camera back from wherever it was being flown to.
  controls.addEventListener('start', () => { fly = null; });
  step();

  return {
    setData, setPaint, setView, setSpin, reset,
    dispose() {
      stopped = true;
      cancelAnimationFrame(frame);
      watch.disconnect();
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointerleave', onLeave);
      clear();
      controls.dispose();
      renderer.dispose();
      dom.remove();
    },
  };
}
