import { useState } from 'react';
import { Loader2, Check, X, Package } from 'lucide-react';
import { api } from '../lib/api';

// Inventory items Reem got ready from what was typed or said in chat. Nothing is added
// until Add is tapped here (server/inventory.js, decide).

const STATE = {
  pending: { label: 'Ready — tap Add', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  added: { label: 'Added', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  cancelled: { label: 'Cancelled', tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute' },
};
const amount = (i) => [i.quantity, i.counted_in].filter((x) => x !== null && x !== '').join(' ');
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function InventoryCard({ proposal: p, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const s = STATE[p.status] || STATE.pending;

  const act = async (what) => {
    setBusy(what);
    setError(null);
    try { onChanged(await api.post(`/inventory/proposals/${p.id}/${what}`)); } catch (e) { setError(e.message); }
    setBusy(null);
  };

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <Package size={13} strokeWidth={2} />
        {p.building} inventory · {p.status === 'added' ? `${count(p.added, 'item')} added` : s.label}
      </p>
      <div className="max-h-80 space-y-3 overflow-y-auto">
        {p.groups.map((g) => (
          <div key={g.places[0]}>
            <p className="text-[15px] font-medium leading-snug">
              {g.places.length > 1 && <span className="text-mute">{g.places.length} places: </span>}
              {g.places.join(', ')}
            </p>
            <ul className="mt-1 space-y-0.5">
              {g.items.map((i, n) => (
                <li key={n} className={`flex items-baseline gap-2 ${i.exists ? 'text-mute' : 'text-txt/85'}`}>
                  <span className="w-12 shrink-0 text-right tabular-nums">{amount(i)}</span>
                  {i.photo_doc && (
                    <a href={`/api/inventory/proposals/${p.id}/photo/${i.photo_doc}`} target="_blank" rel="noreferrer" className="shrink-0 self-center">
                      <img src={`/api/inventory/proposals/${p.id}/photo/${i.photo_doc}`} alt="" loading="lazy" className="size-9 rounded-md object-cover" />
                    </a>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className={i.exists ? 'line-through' : ''}>{i.name}</span>
                    {i.condition !== 'good' && <span className={i.condition === 'damaged' ? ' text-warn' : ' text-bad'}> · {i.condition}</span>}
                    {i.notes && <span className="text-mute"> · {i.notes}</span>}
                    {i.exists && <span> · already listed</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {p.status === 'pending' && (
        <p className="mt-2.5 text-xs text-mute">
          {count(p.total, 'item')} in all{p.skipped > 0 && `; ${p.skipped} already listed ${p.skipped === 1 ? 'is' : 'are'} left as ${p.skipped === 1 ? 'it is' : 'they are'}`}.
        </p>
      )}

      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      {p.status === 'pending' && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => act('add')} disabled={!!busy || p.total === 0}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
            {busy === 'add' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {p.total > 1 ? `Add all ${p.total}` : 'Add'}
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
