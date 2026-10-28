import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { applyUpdate, onUpdateReady, updateReady } from '../lib/update';

// Shown at the top of the menu, beside "REEM", once a new version of Reem is ready. It
// waits for the person to tap it, so a reload never lands in the middle of a message or
// a form. There is deliberately no way to dismiss it: given a close button, people close it
// and stay on the old version. It stays until they update.
export default function UpdateButton() {
  const [ready, setReady] = useState(updateReady);
  const [busy, setBusy] = useState(false);
  useEffect(() => onUpdateReady(setReady), []);

  if (!ready) return null;
  return (
    <button
      onClick={() => { setBusy(true); applyUpdate(); }}
      disabled={busy}
      title="A new version of Reem is ready"
      className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-2.5 py-1 text-xs font-medium tracking-normal text-white shadow-lg shadow-emerald-500/25 transition active:scale-[0.97] disabled:opacity-60"
    >
      <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Update
    </button>
  );
}
