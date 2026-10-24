import { useState } from 'react';
import { Loader2, Check, X, BookUser } from 'lucide-react';
import { api } from '../lib/api';

// A company address Reem did not know, got ready from the master's chat. Nothing is added
// until Add is tapped here (server/addressBook.js, decide); then the chat carries on with
// whatever was waiting on it, so they do not have to ask twice.

const STATE = {
  pending: { label: 'Ready — tap Add', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  added: { label: 'Added', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  cancelled: { label: 'Cancelled', tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute' },
};

export default function AddressCard({ proposal: p, onChanged, onAdded }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const s = STATE[p.status] || STATE.pending;

  const act = async (what) => {
    setBusy(what);
    setError(null);
    try {
      const u = await api.post(`/address-book/proposals/${p.id}/${what}`);
      onChanged(u);
      if (u.status === 'added') onAdded?.(u.email);
    } catch (e) { setError(e.message); }
    setBusy(null);
  };

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <BookUser size={13} strokeWidth={2} /> Add to the address book · {s.label}
      </p>
      <p className={`break-all text-[15px] font-medium ${p.status === 'cancelled' ? 'line-through opacity-70' : ''}`}>{p.email}</p>
      {p.status === 'pending' && <p className="mt-2 text-xs text-mute">Everyone's Reem will treat it as a real company mailbox.</p>}

      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      {p.status === 'pending' && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => act('add')} disabled={!!busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
            {busy === 'add' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Add
          </button>
          <button onClick={() => act('cancel')} disabled={!!busy}
            className="flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:border-bad/60 hover:text-bad disabled:opacity-60">
            {busy === 'cancel' ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />} Cancel
          </button>
        </div>
      )}
    </div>
  );
}
