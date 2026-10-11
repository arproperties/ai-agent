import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// The app drawn as a place, as a network: Riley a living cloud of points in the middle, every
// screen a node wired to it, with signals running along the wires. Like the building in the 3D View (buildingScene.js) it is drawn over the page,
// in the theme's own colours, which the component hands it, so it sits in the light theme and
// the dark alike. It knows nothing of what the screens are: the component (Tour3D.jsx) names
// the stops, and is told which one is pointed at, tapped and arrived at.
//
//   stops:  in the order they are walked, each { id, icon, color: [from, to] }
//     icon is the stop's icon as SVG markup, drawn white; color is the stop's own two, the
//     ones its disc wears in the sidebar, run one into the other across its plate
//   colors: the theme's { p1, p2, p3, chart, warn, bad, mute, txt }
//   badges: stop id → a count asking for attention: the stop's light beats
//   labels: stop id → the element that is the stop's name tag: it is kept under its stop
//     as the camera moves ('riley' is the core's). What is written on it is the component's.

const TAU = Math.PI * 2;
const ease = (from, to, k) => from + (to - from) * k;
/** The short way round from one angle to another. */
const turn = (from, to) => { const d = (to - from) % TAU; return d > Math.PI ? d - TAU : d < -Math.PI ? d + TAU : d; };

function paint(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
/** A soft point of light. */
const dotTex = () => paint(64, 64, (g) => {
  const f = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  f.addColorStop(0, 'rgba(255,255,255,1)'); f.addColorStop(0.4, 'rgba(255,255,255,0.35)'); f.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = f; g.fillRect(0, 0, 64, 64);
});
/** A round plate in a stop's two colours, to carry its icon. */
const discTex = ([from, to]) => paint(128, 128, (g) => {
  const f = g.createLinearGradient(20, 20, 108, 108); // from the top left to the bottom right, as the sidebar's discs run
  f.addColorStop(0, from); f.addColorStop(1, to);
  g.fillStyle = f; g.beginPath(); g.arc(64, 64, 60, 0, TAU); g.fill();
});
const sprite = (map, color, size, opacity = 1) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, transparent: true, opacity, depthWrite: false }));
  s.scale.set(size, size * (map.image.height / map.image.width), 1);
  s.userData.size = size;
  return s;
};
const line = (points, color, opacity) => new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
/** SVG markup as an image, once the browser has drawn it. */
const drawn = (svg) => new Promise((done) => { const img = new Image(); img.onload = () => done(img); img.onerror = () => done(null); img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`; });

/** Riley as a cloud of points on a ball, its surface always moving. */
function orb(radius, count, colors, dot, blending) {
  const base = new Float32Array(count * 3); const pos = new Float32Array(count * 3); const col = new Float32Array(count * 3);
  const [a, b, c] = colors.map((x) => new THREE.Color(x));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2; const r = Math.sqrt(1 - y * y); const th = i * 2.399963;
    base.set([Math.cos(th) * r, y, Math.sin(th) * r], i * 3);
    const k = new THREE.Color().copy(a).lerp(b, (y + 1) / 2).lerp(c, Math.max(0, Math.sin(th * 0.5)) * 0.6);
    col.set([k.r, k.g, k.b], i * 3);
  }
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)).setAttribute('color', new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ map: dot, size: radius * 0.075, vertexColors: true, transparent: true, depthWrite: false, blending }));
  points.userData.tick = (t, stir = 0) => {
    for (let i = 0; i < count; i++) {
      const [x, y, z] = [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]];
      const r = radius * (1 + (0.13 + stir * 0.1) * Math.sin(x * 3.1 + t * 1.3) + 0.1 * Math.sin(y * 4.3 - t * 1.7) + 0.08 * Math.sin(z * 5.2 + t * 0.9));
      pos.set([x * r, y * r, z * r], i * 3);
    }
    geo.attributes.position.needsUpdate = true;
    points.rotation.y = t * 0.15;
  };
  points.userData.tick(0);
  return points;
}

export function createTourScene(el, { onHover, onPick, onArrive, onTurn, light = false, colors = {}, still = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  el.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 400);
  // Light added to a pale page is not seen: there, what glows on the dark is simply drawn in its colour.
  const glowing = light ? THREE.NormalBlending : THREE.AdditiveBlending;
  const C = { p1: '#a78bfa', p2: '#f472b6', p3: '#38bdf8', chart: '#8b5cf6', warn: '#fbbf24', bad: '#fb7185', mute: '#9a95bd', txt: '#f2f0ff', ...colors };

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.maxPolarAngle = Math.PI / 2 - 0.08; // never from under the table
  controls.autoRotateSpeed = 0.5;

  const R = 7.5; // how far out the ring of stops is
  let world = null; // everything on screen, replaced whole when the stops change
  let fresh = true; // the first drawing, whose stops grow into place in turn
  let made = 0; // which drawing is the latest asked for: one still waiting on its icons when another is asked for is dropped
  let stops = []; // { id, group, hit, anchor, angle, pos, hot, count, born, glow(hot, calling, t) }
  let riley = null; // the core, pointed at and tagged like a stop: { id, group, hit, anchor, hot }
  let frameTick = null; // what the network does every frame
  let focus = null; // the stop being looked at
  let over = null; // the stop under the pointer
  let fly = null; // where the camera is being taken: { at, look, then }
  let labels = new Map(); // the name tags, kept under their stops
  let counts = new Map();
  let wanted = null; // the stop asked to be stood before, kept across a redrawing

  function clear() {
    if (!world) return;
    scene.remove(world);
    world.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) { m.map?.dispose(); m.dispose(); }
    });
    world = null; stops = []; riley = null; frameTick = null; focus = null;
  }

  const unseen = new THREE.MeshBasicMaterial({ visible: false });
  /** A stop's place on the ring, and what hangs on it: where it is touched, and where its tag goes. */
  function post(list, s, i, y, tagY) {
    const angle = (i / list.length) * TAU;
    const pos = new THREE.Vector3(Math.sin(angle) * R, y, Math.cos(angle) * R);
    const group = new THREE.Group();
    group.position.copy(pos);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(1.15, 10, 8), unseen); // generous, so a finger finds it
    hit.userData.stop = s.id;
    const anchor = new THREE.Object3D();
    anchor.position.y = tagY;
    group.add(hit, anchor);
    group.scale.setScalar(fresh ? 0.01 : 1);
    world.add(group);
    const stop = { id: s.id, group, hit, anchor, angle, pos, hot: 0, count: 0, born: fresh ? i * 0.06 : 0, glow: null };
    stops.push(stop);
    return stop;
  }
  function heart(group, y, tagY, reach) {
    const hit = new THREE.Mesh(new THREE.SphereGeometry(reach, 12, 10), unseen);
    hit.userData.stop = 'riley';
    const anchor = new THREE.Object3D();
    anchor.position.y = tagY;
    group.add(hit, anchor);
    group.position.y = y;
    world.add(group);
    riley = { id: 'riley', group, hit, anchor, hot: 0 };
  }

  // ---------- the three looks ----------

  /** Riley as a living cloud of points, every stop a node wired to it, with signals running along the wires. */
  function draw(list, pal, dot) {
    const core = orb(1.7, 2600, pal.orb, dot, glowing);
    const cloud = new THREE.Group();
    cloud.add(core);
    heart(cloud, 0, -2.3, 2);
    const far = new Float32Array(300 * 3);
    for (let i = 0; i < 300; i++) far.set([(Math.random() - 0.5) * 34, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 34], i * 3);
    world.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(far, 3)), new THREE.PointsMaterial({ map: dot, size: 0.09, color: pal.a, transparent: true, opacity: 0.6, depthWrite: false })));
    const ring = paint(128, 128, (g) => { g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.arc(64, 64, 60, 0, TAU); g.stroke(); });
    const nodes = list.map((s, i) => post(list, s, i, Math.sin(i * 1.9) * 1.1, -0.85));
    const signals = [];
    list.forEach((s, i) => {
      const stop = nodes[i];
      const p = stop.pos;
      const wire = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), p.clone().multiplyScalar(0.5).setY(p.y + 1.6), p);
      const cable = line(wire.getPoints(40), s.ink, 0.5);
      world.add(cable, line([p, nodes[(i + 1) % nodes.length].pos], pal.a, light ? 0.35 : 0.22), line([p, nodes[(i + 3) % nodes.length].pos], pal.a, light ? 0.16 : 0.08));
      const head = new THREE.Group();
      const halo = sprite(dot, s.ink, 2.4, 0.18);
      head.add(halo, sprite(s.plate, 0xffffff, 1.2), sprite(ring, s.ink, 1.45), sprite(s.mark, 0xffffff, 0.62));
      stop.group.add(head);
      stop.glow = (hot, calling) => {
        head.scale.setScalar(1 + hot * 0.3);
        halo.material.opacity = 0.18 + hot * 0.3 + calling * 0.3;
        cable.material.opacity = 0.5 + hot * 0.5;
      };
      for (let n = 0; n < 2; n++) { const sig = sprite(dot, s.ink, 0.4); world.add(sig); signals.push({ sig, wire, phase: n / 2 + i * 0.13, back: n === 1 }); }
    });
    return (t) => {
      core.userData.tick(t, riley.hot);
      cloud.scale.setScalar(1 + riley.hot * 0.12);
      for (const { sig, wire, phase, back } of signals) { const f = (t * 0.28 + phase) % 1; sig.position.copy(wire.getPoint(back ? 1 - f : f)); sig.material.opacity = Math.sin(f * Math.PI); }
    };
  }

  /** Draw the stops. The camera stays where it is unless this is the first drawing. */
  async function setStops(list) {
    const mine = ++made;
    const imgs = await Promise.all(list.map((s) => drawn(s.icon)));
    if (mine !== made || stopped) return;
    fresh = !world;
    clear();
    world = new THREE.Group();
    scene.add(world);
    // The ground it is all over: the same grid the building stands on in the 3D View.
    const grid = new THREE.GridHelper(34, 28, C.p1, C.p1); // no wider than this: lines running off to the horizon crowd into stripes
    grid.material.transparent = true; grid.material.opacity = light ? 0.22 : 0.13;
    grid.position.y = -3.4;
    world.add(grid);
    const pal = { orb: [C.p1, C.p2, C.p3], a: C.p1 };
    const drawnList = list.map((s, i) => ({ ...s, ink: s.color[1], plate: discTex(s.color), img: imgs[i], mark: paint(128, 128, (g) => { if (imgs[i]) g.drawImage(imgs[i], 0, 0, 128, 128); }) }));
    frameTick = draw(drawnList, pal, dotTex());
    setBadges(counts);
    over = null;
    const start = whole();
    controls.minDistance = 3;
    controls.maxDistance = start.at.length() * 2.2;
    if (fresh) {
      // It opens from higher and further off, and comes down to the ring.
      camera.position.copy(start.at).multiplyScalar(still ? 1 : 1.7);
      controls.target.copy(start.look);
      fly = start;
    }
    if (wanted) setFocus(wanted);
  }

  /** How many are waiting at each stop: the light of one that has any beats. */
  function setBadges(next) { counts = next; for (const s of stops) s.count = counts.get(s.id) || 0; }
  /** The name tags: stop id → element. They are moved here, every frame. */
  function setLabels(map) { labels = map; }
  /** A stop pointed at from outside the drawing (its name tag, say). */
  function setOver(id) { over = id; }

  const tall = () => camera.aspect < 1; // a phone held upright
  /** Where the camera stands to take in the whole ring. */
  function whole() {
    const back = 25 * Math.max(1, 1.75 / camera.aspect);
    return { at: new THREE.Vector3(0, back * 0.45, back), look: new THREE.Vector3(0, tall() ? 0.4 : -1.4, 0) };
  }
  /** And to stand in front of one stop: outside the ring, looking in at it, Riley behind. */
  function before(s, near = 1) {
    const out = s.pos.clone().setY(0).normalize();
    const side = new THREE.Vector3(out.z, 0, -out.x);
    const d = (tall() ? 16 : 12.5) * near;
    return {
      at: s.pos.clone().addScaledVector(out, d).addScaledVector(side, d * 0.2).setY(s.pos.y + d * 0.22),
      // The card is over the right of a wide screen and the foot of a phone's: look past the
      // stop that way, and it stands in what is left.
      look: tall() ? s.pos.clone().setY(s.pos.y - 2 * near) : s.pos.clone().addScaledVector(side, 2.4 * near),
    };
  }

  /** Go and stand before a stop, or step back to see them all. */
  function setFocus(id) {
    wanted = id;
    focus = stops.find((s) => s.id === id) || null;
    if (!world) return;
    fly = focus ? before(focus) : whole();
    fly.then = () => onArrive?.(focus?.id ?? null);
  }
  /** Walk into a stop, or into Riley; `done` is called when the camera is upon it. */
  function enter(id, done) {
    const s = stops.find((x) => x.id === id);
    if (still || (!s && id !== 'riley')) return done?.();
    if (s) { focus = s; fly = { ...before(s, 0.17), look: s.pos.clone(), fast: true }; }
    else { const from = camera.position.clone().setY(0).normalize(); fly = { at: from.multiplyScalar(3.4).setY(riley.group.position.y + 0.8), look: riley.group.position.clone(), fast: true }; }
    setTimeout(() => done?.(), 520);
    return undefined;
  }
  const setSpin = (on) => { controls.autoRotate = !!on && !still; };

  // ---------- pointing ----------

  const ray = new THREE.Raycaster();
  const at = new THREE.Vector2();
  function stopAt(e) {
    const box = renderer.domElement.getBoundingClientRect();
    at.set(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1);
    ray.setFromCamera(at, camera);
    const hit = ray.intersectObjects([...stops.map((s) => s.hit), ...(riley ? [riley.hit] : [])], false)[0];
    return hit ? hit.object.userData.stop : null;
  }
  let down = null;
  const dom = renderer.domElement;
  const onMove = (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true;
    if (e.pointerType !== 'mouse') return; // a finger has no hover
    const id = e.buttons ? null : stopAt(e);
    if (id !== over || id != null) onHover?.(id, e.clientX, e.clientY);
    over = id;
    dom.style.cursor = id != null ? 'pointer' : 'grab';
  };
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY, moved: false }; };
  const onUp = (e) => {
    if (down && !down.moved) onPick?.(stopAt(e));
    down = null;
  };
  const onLeave = () => { over = null; onHover?.(null); };
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointerleave', onLeave);
  // A drag takes the camera back from wherever it was being flown to.
  controls.addEventListener('start', () => { fly = null; onTurn?.(); });

  // ---------- every frame ----------

  const view = { w: 1, h: 1 };
  function size() {
    view.w = el.clientWidth || 1;
    view.h = el.clientHeight || 1;
    renderer.setSize(view.w, view.h, false);
    camera.aspect = view.w / view.h;
    camera.updateProjectionMatrix();
  }
  const watch = new ResizeObserver(size);
  watch.observe(el);
  size();

  /** Hang a name tag under its stop: nearer ones bigger, and over those behind. */
  const spot = new THREE.Vector3();
  function tag(s, shown) {
    const node = labels.get(s.id);
    if (!node) return;
    s.anchor.getWorldPosition(spot);
    const far = spot.distanceTo(camera.position);
    spot.project(camera);
    const o = spot.z < 1 ? shown : 0;
    node.style.opacity = o.toFixed(2);
    node.style.visibility = o < 0.05 ? 'hidden' : 'visible';
    node.style.zIndex = String(Math.max(1, Math.round(900 - far * 8)));
    const big = Math.min(1.2, Math.max(0.74, 1.5 - far / 40)) * (tall() ? 0.84 : 1);
    node.style.transform = `translate(${(((spot.x + 1) / 2) * view.w).toFixed(1)}px, ${(((1 - spot.y) / 2) * view.h).toFixed(1)}px) translate(-50%, 0) scale(${big.toFixed(3)})`;
  }

  let frame = 0;
  let stopped = false;
  const clock = new THREE.Clock();
  const polar = (v) => ({ a: Math.atan2(v.x, v.z), r: Math.hypot(v.x, v.z) });
  function step() {
    if (stopped) return;
    frame = requestAnimationFrame(step);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = still ? 2 : clock.elapsedTime;
    const k = still ? 1 : 1 - Math.exp(-dt * 7); // the same glide whatever the frame rate

    if (riley) riley.hot = ease(riley.hot, over === 'riley' ? 1 : 0, k);
    for (const s of stops) {
      // Each grows into place in turn when the ring is drawn.
      s.born -= dt;
      s.group.scale.setScalar(ease(s.group.scale.x, still || s.born <= 0 ? 1 : 0.01, k * 0.8));
      s.hot = ease(s.hot, s === focus ? 1 : s.id === over ? 0.8 : 0, k);
      s.glow?.(s.hot, s.count > 0 && !still ? 0.5 + 0.5 * Math.sin(t * 3) : 0, t);
    }
    frameTick?.(t);

    if (fly) {
      // Round the ring rather than straight through the middle of it.
      const j = fly.fast || still ? k : k * 0.42;
      const [now, to] = [polar(camera.position), polar(fly.at)];
      const a = now.a + turn(now.a, to.a) * j;
      const r = ease(now.r, to.r, j);
      camera.position.set(Math.sin(a) * r, ease(camera.position.y, fly.at.y, j), Math.cos(a) * r);
      controls.target.lerp(fly.look, j);
      if (camera.position.distanceTo(fly.at) < 0.12) { const then = fly.then; fly = null; then?.(); }
    }
    controls.update();
    renderer.render(scene, camera);

    // The tags go where the picture just drawn has their stops. While one stop is stood before, its
    // card speaks for it and the rest keep quiet.
    for (const s of stops) tag(s, focus ? 0 : Math.min(1, s.group.scale.x * 1.2));
    if (riley) tag(riley, focus ? 0 : 1);
  }
  step();

  return {
    setStops, setBadges, setLabels, setOver, setFocus, enter, setSpin,
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
