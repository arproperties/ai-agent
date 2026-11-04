import { lazy, Suspense, useMemo, useState } from 'react';
import { Box } from 'lucide-react';
import Icon from './Icon';
import { FORMATS, toSvg, downloadDrawing } from '../lib/drawing';

// The 3D viewer (three.js) is only fetched when someone opens a plan in 3D.
const Model3D = lazy(() => import('./Model3D'));
const STOREY_M = 3;

/**
 * A floor plan Reem drew, as walls for the 3D view: its thick lines (how walls are drawn), or
 * the outlines of its rooms when it has none. Only a plan drawn in metres, so the 3D is the
 * drawing's own size. Null for anything else (a flowchart, an org chart, a sketch).
 */
export function planWalls(drawing) {
  if (drawing?.unit !== 'm') return null;
  const segs = [];
  const thick = drawing.shapes.filter((s) => s.type === 'line' && s.weight === 'thick');
  for (const l of thick) for (let i = 1; i < l.points.length; i++) segs.push([...l.points[i - 1], ...l.points[i]]);
  if (!segs.length) {
    // Rooms side by side share a wall: each edge is kept once.
    const seen = new Set();
    for (const r of drawing.shapes.filter((s) => s.type === 'rect')) {
      const c = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
      for (let k = 0; k < 4; k++) {
        const e = [...c[k], ...c[(k + 1) % 4]];
        const key = [e.slice(0, 2).join(), e.slice(2).join()].sort().join('|');
        if (!seen.has(key)) { seen.add(key); segs.push(e); }
      }
    }
    if (seen.size < 8) return null; // fewer than two rooms: not a plan
  }
  if (segs.length < 3) return null;
  const xs = segs.flatMap((e) => [e[0], e[2]]), ys = segs.flatMap((e) => [e[1], e[3]]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  if (x1 - x0 < 2 || y1 - y0 < 2 || x1 - x0 > 500 || y1 - y0 > 500) return null; // not a building's size in metres
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // The drawing's y runs down the page; the 3D view's plan y runs north, up it.
  const walls = segs.flatMap(([ax, ay, bx, by]) => [ax - cx, cy - ay, bx - cx, cy - by]);
  return {
    walls, height: STOREY_M, thickness: 0.2,
    note: `Size ${(x1 - x0).toFixed(2)} × ${(y1 - y0).toFixed(2)} m, as in the drawing. Wall height ${STOREY_M} m by default.`,
  };
}

// One download, with its own spinner and its own error.
function useDownload(drawing, messageId) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const run = async (format) => {
    setBusy(format); setError('');
    try {
      await downloadDrawing(format, drawing, messageId);
    } catch (e) {
      setError(e.message);
    }
    setBusy(null);
  };
  return { busy, error, run };
}

/**
 * A drawing in a reply, on white paper, with its three files underneath. PDF and AutoCAD
 * need the saved reply, so they wait until it is saved; the image does not.
 */
export function DrawingCard({ drawing, messageId }) {
  // The SVG is built by toSvg from checked shapes, with every piece of text escaped.
  const svg = useMemo(() => drawing && toSvg(drawing), [drawing]);
  const plan = useMemo(() => planWalls(drawing), [drawing]);
  const [three, setThree] = useState(false);
  const { busy, error, run } = useDownload(drawing, messageId);
  if (!drawing) return <div className="my-3 rounded-2xl border border-stroke px-4 py-3 text-sm text-mute">This drawing could not be shown.</div>;
  return (
    <div className="my-3">
      <div className="overflow-hidden rounded-2xl bg-white p-2 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {Object.entries(FORMATS).map(([format, f]) => (
          <button key={format} onClick={() => run(format)} disabled={!!busy || (format !== 'png' && !messageId)}
            className="glass flex items-center gap-1.5 rounded-full py-1.5 pl-2.5 pr-3 text-xs transition hover:bg-white/10 disabled:opacity-40">
            <Icon name={busy === format ? 'spinner' : 'download'} size={14} className={busy === format ? 'animate-spin' : ''} />
            {f.label}
          </button>
        ))}
        {plan && (
          <button onClick={() => setThree(true)}
            className="flex items-center gap-1.5 rounded-full bg-p1/20 py-1.5 pl-2.5 pr-3 text-xs text-p1 transition hover:bg-p1/30">
            <Box size={14} /> 3D
          </button>
        )}
      </div>
      {error && <p className="mt-1.5 text-xs text-bad">{error}</p>}
      {three && (
        <Suspense fallback={null}>
          <Model3D plan={plan} title={drawing.title} onClose={() => setThree(false)} />
        </Suspense>
      )}
    </div>
  );
}

/** A drawing still arriving. */
export const DrawingPending = () => (
  <div className="my-3 flex items-center gap-2 rounded-2xl border border-stroke px-4 py-3 text-sm text-mute">
    <Icon name="spinner" size={16} className="animate-spin" /> Drawing…
  </div>
);

/** "Convert into pdf": the file for an earlier drawing, ready to download. */
export function DrawingFile({ format, drawing, messageId }) {
  const { busy, error, run } = useDownload(drawing, messageId);
  const f = FORMATS[format];
  return (
    <div className="mt-3 max-w-sm">
      <div className="glass flex items-center gap-3 rounded-2xl py-2 pl-2 pr-2.5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-p1/20 text-p1"><Icon name={format === 'png' ? 'image' : 'file'} size={18} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{drawing.title}</span>
          <span className="text-[11px] text-mute">{f.kind}</span>
        </span>
        <button onClick={() => run(format)} disabled={!!busy}
          className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-p1 to-p2 px-3.5 py-2 text-xs font-medium text-white disabled:opacity-50">
          <Icon name={busy ? 'spinner' : 'download'} size={14} className={busy ? 'animate-spin' : ''} /> Download
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-bad">{error}</p>}
    </div>
  );
}
