import { useEffect, useRef } from 'react';

/**
 * Drifting dots that link with faint lines when they pass near each other, on a canvas
 * behind whatever it is mounted in. Ported from Business Lens
 * (admin/src/components/ParticleField.tsx) in Reem's violet rather than its mint.
 *
 * It is mounted in two places. Once beside <App/> in main.jsx, where `.fx-canvas` makes
 * it a fixed full-screen layer at z-index 1 (above the glow and grid the body wears at
 * z-0, below the app at z-10) -- this is the one you see on the chat and login screens.
 * And once inside each full-screen panel (Files, People, Team chat, Live voice, To-do,
 * Meetings), where `.fx-canvas-panel` makes it absolute at z-index -1. Those panels have
 * to paint solid, because the chat is still mounted underneath them, so they cannot let
 * the first canvas show through and carry their own instead.
 *
 * It measures the box CSS gives it rather than the window, which is what lets the same
 * component fill the viewport in one case and a panel in the other.
 *
 * Two things keep it from costing anything it does not have to: it never starts for
 * someone who has asked their phone to stop animations, and it stops entirely while
 * the tab is hidden rather than drawing frames nobody is looking at.
 */
export function ParticleField({ className = 'fx-canvas' }) {
  const ref = useRef(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!ctx) return;

    let w = 0, h = 0, dpr = 1;
    let pts = [];
    let raf = 0;

    // Capped at 2: a phone reporting 3x would triple the pixels drawn every frame
    // for a difference nobody can see on dots this small. The count follows the area
    // of this canvas so a laptop is not sparse and a phone is not crowded.
    function size() {
      const r = cv.getBoundingClientRect();
      // Before the panel has been laid out there is nothing to measure; the observer
      // below calls back the moment there is.
      if (!r.width || !r.height) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Only the backing store is set. The box itself is sized by CSS, so the same
      // component can be a fixed full-screen layer or fill a panel.
      w = cv.width = Math.round(r.width * dpr);
      h = cv.height = Math.round(r.height * dpr);
      const target = Math.min(120, Math.floor((r.width * r.height) / 13000));
      pts = Array.from({ length: target }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.75 * dpr,
        vy: (Math.random() - 0.5) * 0.75 * dpr,
        r: (Math.random() * 1.7 + 0.8) * dpr,
      }));
    }

    function step() {
      ctx.clearRect(0, 0, w, h);
      const LINK = 165 * dpr;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1; // bounce, so the field never empties out
        if (p.y < 0 || p.y > h) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(167,139,250,0.85)';
        ctx.fill();
        // Only forward pairs, so each line is drawn once rather than twice.
        for (let j = i + 1; j < pts.length; j++) {
          const q = pts[j];
          const dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy);
          if (d < LINK) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = `rgba(167,139,250,${0.3 * (1 - d / LINK)})`; // fades out with distance
            ctx.lineWidth = 1.1 * dpr;
            ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(step);
    }

    // Resizing rebuilds every point, so it waits for the drag to settle. Watching the
    // canvas rather than the window catches a panel changing shape when the sidebar
    // opens, which a window resize event never fires for.
    let t;
    const onResize = () => { clearTimeout(t); t = setTimeout(size, 200); };
    const ro = new ResizeObserver(onResize);
    ro.observe(cv);
    const onVis = () => {
      cancelAnimationFrame(raf); // always cancel first: showing twice must not leave two loops running
      if (!document.hidden) step();
    };
    document.addEventListener('visibilitychange', onVis);
    size();
    step();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(t);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
