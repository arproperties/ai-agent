import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { applyUpdate, onUpdateReady, updateReady } from '../lib/update';

// A line of its own at the very top of the menu, above "REEM", once a new version of Reem
// is ready. It waits for the person to tap it, so a reload never lands in the middle of a
// message or a form. There is deliberately no way to dismiss it: given a close button,
// people close it and stay on the old version. It stays until they update.
export default function UpdateButton() {
  const [ready, setReady] = useState(updateReady);
  const [busy, setBusy] = useState(false);
  useEffect(() => onUpdateReady(setReady), []);

  if (!ready) return null;
  return (
    <div className="px-4 pt-2">
      {/* In the app's own colours, so it reads as part of the menu rather than a warning. */}
      <button
        onClick={() => { setBusy(true); applyUpdate(); }}
        disabled={busy}
        className="flex w-full items-center gap-3 rounded-2xl border border-p1/25 bg-p1/10 px-3 py-2 text-left transition hover:bg-p1/15 active:scale-[0.99] disabled:opacity-70"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-p1 to-p2 text-white">
          <RefreshCw size={15} className={busy ? 'animate-spin' : ''} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-medium text-txt">New version of Reem</span>
          <span className="block truncate text-[11px] text-mute">{busy ? 'Updating…' : 'Ready to install'}</span>
        </span>
        <span className="shrink-0 rounded-full bg-gradient-to-br from-p1 to-p2 px-3 py-1 text-xs font-medium text-white">Update</span>
      </button>
    </div>
  );
}
