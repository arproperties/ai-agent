import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { PenLine, Highlighter, Eraser, Undo2, Redo2, Trash2, Plus } from 'lucide-react';

// The Diary's pen. A sheet of paper (always paper-coloured, in either theme, so ink looks
// like ink) that a finger, a mouse or a stylus draws on.
//
// What is kept is the strokes, in the sheet's own units (W wide), never pixels: a page
// drawn on a phone opens the same, and as sharp, on a laptop. Each point is [x, y, pressure]
// as whole numbers, which keeps a page small enough to save in one go.
//
// With a stylus (Apple Pencil, S Pen) the pressure thickens the line, and once a stylus has
// touched the sheet a finger no longer draws - so a resting palm leaves no marks and the
// finger scrolls instead.

export const W = 1000; // sheet width in sheet units
const START_H = 1300;
const MORE_H = 650;
const MAX_H = 6500;
export const PAPER = '#fbf8f1';

export const INKS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed'];
const MARKS = ['#fde047', '#86efac', '#f9a8d4', '#7dd3fc'];
const SIZES = [{ px: 2.2, label: 'Fine' }, { px: 4.5, label: 'Medium' }, { px: 9, label: 'Bold' }];

/** Draws one stroke. Shared with the thumbnail, so the list shows exactly what was drawn. */
export function drawStroke(ctx, s, scale = 1) {
  const p = s.p;
  const n = p.length / 3;
  if (!n) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  const at = (i) => [p[i * 3] * scale, p[i * 3 + 1] * scale, (p[i * 3 + 2] || 50) / 100];
  if (s.t === 'mark') {
    // A highlighter is one even, see-through band, so it does not darken where it overlaps itself.
    ctx.globalAlpha = 0.38;
    ctx.lineWidth = s.s * scale;
    ctx.beginPath();
    const [x0, y0] = at(0);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < n; i++) { const [x, y] = at(i); ctx.lineTo(x, y); }
    if (n === 1) ctx.lineTo(x0 + 0.1, y0);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const width = (pr) => Math.max(0.6, s.s * scale * (0.45 + pr * 1.1));
  if (n === 1) {
    const [x, y, pr] = at(0);
    ctx.beginPath();
    ctx.arc(x, y, width(pr) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  // Smooth curves through the midpoints, each piece as wide as the pressure there.
  let [px, py, pp] = at(0);
  let [mx, my] = [px, py];
  for (let i = 1; i < n; i++) {
    const [x, y, pr] = at(i);
    const nx = (px + x) / 2;
    const ny = (py + y) / 2;
    ctx.beginPath();
    ctx.lineWidth = width((pp + pr) / 2);
    ctx.moveTo(mx, my);
    ctx.quadraticCurveTo(px, py, nx, ny);
    ctx.stroke();
    [mx, my] = [nx, ny];
    [px, py, pp] = [x, y, pr];
  }
  ctx.beginPath();
  ctx.lineWidth = width(pp);
  ctx.moveTo(mx, my);
  ctx.lineTo(px, py);
  ctx.stroke();
  ctx.restore();
}

/** A small picture of the drawing for the list: cropped to what was drawn, on paper. */
export function makeThumb(drawing) {
  const strokes = drawing?.strokes || [];
  if (!strokes.length) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of strokes) {
    for (let i = 0; i < s.p.length; i += 3) {
      x0 = Math.min(x0, s.p[i]); x1 = Math.max(x1, s.p[i]);
      y0 = Math.min(y0, s.p[i + 1]); y1 = Math.max(y1, s.p[i + 1]);
    }
  }
  const pad = 30;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W, x1 + pad); y1 += pad;
  // Never thinner than a card, so a single line does not become a sliver.
  const bw = Math.max(x1 - x0, 300);
  const bh = Math.max(y1 - y0, 200);
  const out = 360;
  const scale = out / Math.max(bw, bh * 1.2);
  const c = document.createElement('canvas');
  c.width = Math.round(bw * scale);
  c.height = Math.round(bh * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(-x0 * scale, -y0 * scale);
  for (const s of strokes) drawStroke(ctx, s, scale);
  return c.toDataURL('image/jpeg', 0.82);
}

const near = (s, x, y, r) => {
  const rr = (r + (s.t === 'mark' ? s.s / 2 : s.s)) ** 2;
  for (let i = 0; i < s.p.length; i += 3) if ((s.p[i] - x) ** 2 + (s.p[i + 1] - y) ** 2 <= rr) return true;
  return false;
};

function ToolButton({ on, label, onClick, children, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} aria-pressed={on}
      className={`grid size-10 shrink-0 place-items-center rounded-full transition disabled:opacity-30
        ${on ? 'bg-p1 text-white shadow-lg shadow-p1/30' : 'text-mute hover:bg-white/10 hover:text-txt'}`}>
      {children}
    </button>
  );
}

const DiaryPad = forwardRef(function DiaryPad({ initial, onChange }, ref) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const strokes = useRef(initial?.strokes ? [...initial.strokes] : []);
  const [height, setHeight] = useState(Math.max(START_H, initial?.h || 0));
  const undoStack = useRef([]); // each entry: the strokes as they were before a change
  const redoStack = useRef([]);
  const [, bump] = useState(0);
  const refresh = () => bump((n) => n + 1);

  const [tool, setTool] = useState('pen'); // pen | mark | erase
  const [ink, setInk] = useState(INKS[0]);
  const [mark, setMark] = useState(MARKS[0]);
  const [size, setSize] = useState(1);
  const [width, setWidth] = useState(0); // the sheet's width on screen, in CSS pixels
  const live = useRef(null); // the stroke being drawn
  const penSeen = useRef(false);
  const erasing = useRef(false);

  useImperativeHandle(ref, () => ({ value: () => ({ w: W, h: height, strokes: strokes.current }) }), [height]);

  // Fit the sheet to the space it is given.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scale = width / W;

  const paint = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssH = height * scale;
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(cssH * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, cssH);
    for (const s of strokes.current) drawStroke(ctx, s, scale);
    if (live.current) drawStroke(ctx, live.current, scale);
  }, [width, height, scale]);

  useEffect(() => { paint(); }, [paint]);

  const changed = () => {
    redoStack.current = [];
    refresh();
    onChange?.({ w: W, h: height, strokes: strokes.current });
  };

  const point = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) / scale);
    const y = Math.round((e.clientY - r.top) / scale);
    // A mouse or finger reports no real pressure: draw it at an even middle weight.
    const pr = e.pointerType === 'pen' && e.pressure > 0 ? Math.round(e.pressure * 100) : 50;
    return [x, y, pr];
  };

  const eraseAt = (x, y) => {
    const r = 14;
    const keep = strokes.current.filter((s) => !near(s, x, y, r));
    if (keep.length !== strokes.current.length) {
      strokes.current = keep;
      paint();
      return true;
    }
    return false;
  };

  const down = (e) => {
    if (e.pointerType === 'pen') penSeen.current = true;
    if (e.pointerType === 'touch' && penSeen.current) return; // a palm, while writing with a pen
    if (e.button > 0) return;
    e.preventDefault();
    try { canvasRef.current.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone; draw anyway */ }
    const [x, y, pr] = point(e);
    if (tool === 'erase') {
      undoStack.current.push(strokes.current);
      erasing.current = { removed: eraseAt(x, y) };
      return;
    }
    live.current = tool === 'mark'
      ? { t: 'mark', c: mark, s: SIZES[size].px * 5, p: [x, y, pr] }
      : { c: ink, s: SIZES[size].px, p: [x, y, pr] };
    paint();
  };

  const move = (e) => {
    if (erasing.current) {
      const evs = e.getCoalescedEvents?.() || [e];
      for (const ev of evs) { const [x, y] = point(ev); if (eraseAt(x, y)) erasing.current.removed = true; }
      return;
    }
    const s = live.current;
    if (!s) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents?.() || [e];
    for (const ev of evs) {
      const [x, y, pr] = point(ev);
      const lx = s.p[s.p.length - 3];
      const ly = s.p[s.p.length - 2];
      if ((x - lx) ** 2 + (y - ly) ** 2 < 2) continue; // too close to the last point to matter
      s.p.push(x, y, pr);
    }
    // Writing near the bottom of the sheet: more paper appears below, like turning a page.
    const lastY = s.p[s.p.length - 2];
    if (lastY > height - 120 && height < MAX_H) setHeight((h) => Math.min(MAX_H, h + MORE_H));
    paint();
  };

  const up = () => {
    if (erasing.current) {
      if (!erasing.current.removed) undoStack.current.pop(); // nothing was rubbed out
      erasing.current = false;
      changed();
      return;
    }
    const s = live.current;
    if (!s) return;
    live.current = null;
    undoStack.current.push(strokes.current);
    strokes.current = [...strokes.current, s];
    paint();
    changed();
  };

  const undo = () => {
    if (!undoStack.current.length) return;
    redoStack.current.push(strokes.current);
    strokes.current = undoStack.current.pop();
    paint();
    refresh();
    onChange?.({ w: W, h: height, strokes: strokes.current });
  };
  const redo = () => {
    if (!redoStack.current.length) return;
    undoStack.current.push(strokes.current);
    strokes.current = redoStack.current.pop();
    paint();
    refresh();
    onChange?.({ w: W, h: height, strokes: strokes.current });
  };
  const clear = () => {
    if (!strokes.current.length || !confirm('Clear the whole drawing? You can still undo it.')) return;
    undoStack.current.push(strokes.current);
    strokes.current = [];
    paint();
    changed();
  };

  // Ctrl/Cmd+Z on a keyboard.
  useEffect(() => {
    const key = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const colours = tool === 'mark' ? MARKS : INKS;
  const current = tool === 'mark' ? mark : ink;
  const pick = tool === 'mark' ? setMark : setInk;

  return (
    <div className="space-y-3">
      {/* The tools stay in reach at the top while the sheet scrolls underneath. */}
      <div className="glass sticky top-0 z-10 flex flex-wrap items-center gap-1 rounded-2xl border border-stroke p-1.5 backdrop-blur-xl">
        <ToolButton on={tool === 'pen'} label="Pen" onClick={() => setTool('pen')}><PenLine size={18} /></ToolButton>
        <ToolButton on={tool === 'mark'} label="Highlighter" onClick={() => setTool('mark')}><Highlighter size={18} /></ToolButton>
        <ToolButton on={tool === 'erase'} label="Eraser: rub over a line to remove it" onClick={() => setTool('erase')}><Eraser size={18} /></ToolButton>
        <span className="mx-1 h-6 w-px bg-stroke" />
        {tool !== 'erase' && (
          <>
            <div className="flex items-center gap-1">
              {colours.map((c) => (
                <button key={c} type="button" onClick={() => pick(c)} aria-label={`Colour ${c}`} aria-pressed={current === c}
                  className={`size-7 rounded-full transition ${current === c ? 'scale-110 ring-2 ring-p1 ring-offset-2 ring-offset-bg' : 'hover:scale-110'}`}
                  style={{ background: c }} />
              ))}
            </div>
            <span className="mx-1 h-6 w-px bg-stroke" />
            <div className="flex items-center">
              {SIZES.map((s, i) => (
                <button key={s.label} type="button" onClick={() => setSize(i)} aria-label={s.label} title={s.label} aria-pressed={size === i}
                  className={`grid size-9 place-items-center rounded-full transition ${size === i ? 'bg-white/10' : 'hover:bg-white/[0.06]'}`}>
                  <span className="rounded-full bg-txt" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
                </button>
              ))}
            </div>
          </>
        )}
        <span className="flex-1" />
        <ToolButton label="Undo" onClick={undo} disabled={!undoStack.current.length}><Undo2 size={18} /></ToolButton>
        <ToolButton label="Redo" onClick={redo} disabled={!redoStack.current.length}><Redo2 size={18} /></ToolButton>
        <ToolButton label="Clear drawing" onClick={clear} disabled={!strokes.current.length}><Trash2 size={17} /></ToolButton>
      </div>

      <div ref={wrapRef} className="overflow-hidden rounded-2xl shadow-xl shadow-black/20 ring-1 ring-black/10"
        style={{
          background: PAPER,
          backgroundImage: 'radial-gradient(circle, rgb(120 113 108 / 0.28) 1.1px, transparent 1.2px)',
          backgroundSize: `${Math.max(14, 32 * scale)}px ${Math.max(14, 32 * scale)}px`,
        }}>
        <canvas ref={canvasRef}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={(e) => e.buttons === 0 && up()}
          className={`block w-full ${tool === 'erase' ? 'cursor-cell' : 'cursor-crosshair'}`}
          // Pen and mouse never scroll the page; a finger scrolls only once a stylus has been used.
          style={{ height: height * scale || 400, touchAction: penSeen.current ? 'pan-y' : 'none' }} />
      </div>
      {height < MAX_H && (
        <button type="button" onClick={() => setHeight((h) => Math.min(MAX_H, h + MORE_H))}
          className="mx-auto flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-mute hover:bg-white/[0.06] hover:text-txt">
          <Plus size={15} /> More paper
        </button>
      )}
    </div>
  );
});

export default DiaryPad;
