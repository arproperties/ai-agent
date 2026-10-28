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
      <button
        onClick={() => { setBusy(true); applyUpdate(); }}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-2 text-sm font-medium text-white shadow-lg shadow-emerald-500/25 transition active:scale-[0.98] disabled:opacity-60"
      >
        <RefreshCw size={15} className={busy ? 'animate-spin' : ''} />
        {busy ? 'Updating…' : 'New version ready — tap to update'}
      </button>
    </div>
  );
}
