import { useEffect, useRef, useState } from 'react';

// A little paper plane that makes waiting and sending feel alive. Two uses: it loops
// around the "thinking" spot while a long answer is on its way, and it flies a
// loop-de-loop onto the Send button when an email goes. People who ask their phone for
// less motion get neither: the dots and the button work exactly as before.

const NS = 'http://www.w3.org/2000/svg';
const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function planeShape() {
  const g = document.createElementNS(NS, 'g');
  g.innerHTML = '<path d="M16 0 L-12 -11 L-5 0 L-12 11 Z" fill="var(--color-p1)" stroke="var(--color-txt)" stroke-width="1.2" stroke-linejoin="round"/>'
    + '<path d="M16 0 L-5 0" stroke="var(--color-txt)" stroke-width="1" opacity=".6"/>';
  return g;
}

// While a reply is being worked on. Quick answers never see the plane: it takes off only
// after a second and a bit, which is when waiting starts to feel long.
export function ThinkingPlane({ status }) {
  const box = useRef(null);
  const plane = useRef(null);
  const trail = useRef(null);
  const [flying, setFlying] = useState(false);

  useEffect(() => {
    if (stillPlease()) return undefined;
    const t = setTimeout(() => setFlying(true), 1200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!flying) return undefined;
    // Round the middle in a wide oval with small loops on top of it, worked out from the
    // box's size each frame so it still fits after the phone is turned.
    const at = (s, w, h) => {
      const r = Math.min(26, h / 4);
      const rx = w / 2 - 16 - r, ry = Math.max(8, h / 2 - 14 - r);
      return [w / 2 + rx * Math.cos(s) + r * Math.cos(5 * s), h / 2 + ry * Math.sin(s) + r * Math.sin(5 * s)];
    };
    const LAP = 5200;
    const t0 = performance.now();
    let raf;
    const frame = (now) => {
      const el = box.current;
      if (!el || !plane.current) return;
      const w = el.clientWidth, h = el.clientHeight;
      const s = (((now - t0) % LAP) / LAP) * Math.PI * 2;
      const [x, y] = at(s, w, h);
      const [nx, ny] = at(s + 0.004, w, h);
      plane.current.setAttribute('transform', `translate(${x} ${y}) rotate(${(Math.atan2(ny - y, nx - x) * 180) / Math.PI})`);
      let d = '';
      for (let k = 40; k >= 0; k--) { const [px, py] = at(s - k * 0.02, w, h); d += `${k === 40 ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`; }
      trail.current.setAttribute('d', d);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [flying]);

  return (
    <div ref={box} className="relative flex h-28 w-full max-w-[300px] items-center justify-center">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex shrink-0 gap-1.5">{[0, 1, 2].map((i) => (
          <span key={i} className="size-2 animate-bounce rounded-full bg-p1" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}</span>
        {status && <span key={status} className="rise max-w-[11rem] truncate text-xs text-mute">{status}</span>}
      </div>
      {flying && (
        <svg className="pointer-events-none absolute inset-0 size-full overflow-visible transition-opacity duration-500" aria-hidden="true">
          <path ref={trail} fill="none" stroke="var(--color-p1)" strokeWidth="2" strokeLinecap="round" opacity=".5" />
          <g ref={(el) => { if (el && !el.firstChild) el.append(planeShape()); plane.current = el; }} />
        </svg>
      )}
    </div>
  );
}

// The plane takes off from the left edge of the screen, does a loop-de-loop and lands on
// the button that was tapped. Drawn over the whole page so no card or scroll box clips it.
// The send itself never waits for it.
export function flyLoopTo(target) {
  if (!target || stillPlease()) return;
  const r = target.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
  const top = Math.max(10, sy - 220), h = Math.min(H - 10, sy + 160) - top;
  const k = Math.max(sx / 0.9, 220);
  const X = (f) => f * k, Y = (f) => top + f * h;
  const d = `M -30 ${Y(0.85)} C ${X(0.12)} ${Y(0.85)}, ${X(0.3)} ${Y(0.72)}, ${X(0.26)} ${Y(0.5)}
    C ${X(0.23)} ${Y(0.3)}, ${X(0.1)} ${Y(0.34)}, ${X(0.14)} ${Y(0.52)} C ${X(0.18)} ${Y(0.68)}, ${X(0.32)} ${Y(0.58)}, ${X(0.34)} ${Y(0.32)}
    C ${X(0.36)} ${Y(0.08)}, ${X(0.52)} ${Y(0.04)}, ${X(0.62)} ${Y(0.14)} C ${X(0.72)} ${Y(0.26)}, ${sx - 90} ${sy - 110}, ${sx} ${sy}`;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:70;overflow:visible';
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--color-p1)');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('opacity', '.55');
  const plane = planeShape();
  svg.append(path, plane);
  document.body.append(svg);

  const L = path.getTotalLength();
  path.style.strokeDasharray = `0 ${L}`;
  const MS = 2400;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const t0 = performance.now();
  const frame = (now) => {
    const t = Math.min(1, (now - t0) / MS), l = ease(t) * L;
    const p = path.getPointAtLength(l), q = path.getPointAtLength(Math.min(L, l + 1.5)), b = path.getPointAtLength(Math.max(0, l - 1.5));
    plane.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${(Math.atan2(q.y - b.y, q.x - b.x) * 180) / Math.PI})`);
    path.style.strokeDasharray = `${l} ${L}`;
    if (t < 1) { requestAnimationFrame(frame); return; }
    // Landed: a small ring where the button was, then the trail fades away.
    plane.remove();
    const ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('cx', sx); ring.setAttribute('cy', sy);
    ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', 'var(--color-p2)'); ring.setAttribute('stroke-width', '3');
    svg.append(ring);
    const r0 = performance.now();
    const fade = (n) => {
      const u = Math.min(1, (n - r0) / 600);
      ring.setAttribute('r', 4 + u * 36);
      ring.setAttribute('opacity', 1 - u);
      path.setAttribute('opacity', 0.55 * (1 - u));
      if (u < 1) requestAnimationFrame(fade); else svg.remove();
    };
    requestAnimationFrame(fade);
  };
  requestAnimationFrame(frame);
}
