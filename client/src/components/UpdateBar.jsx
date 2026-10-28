import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { applyUpdate, onUpdateReady, updateReady } from '../lib/update';

// The small bar that says a new version of Reem is ready. It waits for the person to tap
// Update, so a reload never lands in the middle of a message or a form. "Later" hides it;
// the new version is then picked up the next time the app is fully closed and opened.
export default function UpdateBar() {
  const [ready, setReady] = useState(updateReady);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => onUpdateReady(setReady), []);

  if (!ready || hidden) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] flex justify-center px-4 pb-safe">
      <div className="rise pointer-events-auto mb-4 flex w-full max-w-sm items-center gap-3 rounded-2xl border border-stroke bg-surface/95 p-3 shadow-2xl backdrop-blur-xl">
        <span className="min-w-0 flex-1 text-sm">A new version of Reem is ready.</span>
        <button
          onClick={() => { setBusy(true); applyUpdate(); }}
          disabled={busy}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
        >
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Update
        </button>
        <button onClick={() => setHidden(true)} aria-label="Later" className="shrink-0 rounded-full p-1 text-mute hover:bg-white/10 hover:text-txt">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
