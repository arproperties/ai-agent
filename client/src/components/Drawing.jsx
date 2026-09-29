import { useMemo, useState } from 'react';
import Icon from './Icon';
import { FORMATS, toSvg, downloadDrawing } from '../lib/drawing';

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
      </div>
      {error && <p className="mt-1.5 text-xs text-bad">{error}</p>}
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
