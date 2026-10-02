import { useState } from 'react';
import { Loader2, Check, X, ClipboardList } from 'lucide-react';
import { api } from '../lib/api';

// A change to someone's responsibilities that Reem got ready from the master's chat.
// Nothing changes until Save is tapped here (server/responsibilities.js, decide).

const STATE = {
  pending: { label: 'Ready — tap Save', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  saved: { label: 'Saved', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  cancelled: { label: 'Cancelled', tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute' },
};
const VERB = { add: 'New responsibility for', edit: 'Change to', remove: 'Remove from' };

export default function ResponsibilityCard({ proposal: p, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const s = STATE[p.status] || STATE.pending;
  const removing = p.action === 'remove';
  const title = removing ? p.old_title : p.title;
  const body = removing ? p.old_body : p.body;

  const act = async (what) => {
    setBusy(what);
    setError(null);
    try { onChanged(await api.post(`/responsibilities/proposals/${p.id}/${what}`)); } catch (e) { setError(e.message); }
    setBusy(null);
  };

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <ClipboardList size={13} strokeWidth={2} />
        {VERB[p.action]} {p.person}{p.action === 'edit' && "'s responsibility"} · {s.label}
      </p>
      <div className={removing ? 'line-through opacity-70' : ''}>
        {title && <p className="text-[15px] font-medium leading-snug">{title}</p>}
        {body && <p className={`max-h-72 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed ${title ? 'mt-1 text-txt/85' : ''}`}>{body}</p>}
        {removing && !title && !body && <p className="text-mute">(already deleted)</p>}
      </div>
      {p.status === 'pending' && !removing && <p className="mt-2 text-xs text-mute">{p.person}'s phone buzzes when you save.</p>}

      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      {p.status === 'pending' && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => act('save')} disabled={!!busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
            {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {removing ? 'Remove' : 'Save'}
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
