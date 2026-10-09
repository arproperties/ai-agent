import { useState } from 'react';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import { api } from '../lib/api';

// Where tenants come from (a walk-in, a referral, a listing site…): the one list, for every
// company and building, that a booking's source is picked from. Each one is a line to read;
// the pencil renames it, on the bookings that have it too. Removing one only takes it off
// the list: a booking keeps the source it was given.

const FIELD = 'glass min-w-0 flex-1 rounded-xl px-3.5 py-2 text-sm outline-none focus:border-p1/70';
const ICON = 'grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10';
const byName = (a, b) => a.name.localeCompare(b.name);

export default function SourceList({ sources, onChange, onRenamed, onError }) {
  const [editing, setEditing] = useState(null); // a source's id, 'new', or null
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const open = (s) => { onError(''); setName(s ? s.name : ''); setEditing(s ? s.id : 'new'); };
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    onError('');
    try {
      const old = sources.find((x) => x.id === editing);
      const s = old ? await api.put(`/leasing/sources/${old.id}`, { name }) : await api.post('/leasing/sources', { name });
      onChange([...sources.filter((x) => x.id !== s.id), s].sort(byName));
      if (old && old.name !== s.name) onRenamed?.(old.name, s.name);
      setEditing(null);
    } catch (e) { onError(e.message); }
    setBusy(false);
  };
  const remove = async (s) => {
    if (!confirm(`Remove ${s.name} from the list? Leases that already have it keep it.`)) return;
    try { await api.del(`/leasing/sources/${s.id}`); onChange(sources.filter((x) => x.id !== s.id)); } catch (e) { onError(e.message); }
  };
  // This list sits inside the booking form, so it is not a form itself: Enter saves the source, not the booking.
  const keys = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') setEditing(null);
  };

  const editor = (
    <div className="flex items-center gap-1">
      <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={keys} autoFocus maxLength={60} placeholder="e.g. Airbnb" aria-label="Source" className={FIELD} />
      <button type="button" onClick={save} disabled={busy || !name.trim()} aria-label="Save" title="Save" className={`${ICON} hover:text-p1 disabled:opacity-50`}><Check size={15} /></button>
      <button type="button" onClick={() => setEditing(null)} aria-label="Cancel" title="Cancel" className={`${ICON} hover:text-txt`}><X size={15} /></button>
    </div>
  );

  return (
    <div className="space-y-2">
      {sources.length === 0 && editing !== 'new' && <p className="py-1 text-sm text-mute">No sources yet.</p>}
      {sources.length > 0 && (
        <ul className="grid gap-x-6 sm:grid-cols-2">
          {sources.map((s) => (
            <li key={s.id} className="border-b border-stroke/60 py-1">
              {editing === s.id ? editor : (
                <div className="flex items-center gap-1">
                  <p className="min-w-0 flex-1 truncate text-sm">{s.name}</p>
                  <button type="button" onClick={() => open(s)} aria-label={`Rename ${s.name}`} title="Rename" className={`${ICON} hover:text-txt`}><Pencil size={15} /></button>
                  <button type="button" onClick={() => remove(s)} aria-label={`Remove ${s.name}`} title="Remove from the list" className={`${ICON} hover:text-bad`}><Trash2 size={15} /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing === 'new' ? editor : (
        <button type="button" onClick={() => open(null)}
          className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke/70 py-2 text-sm text-mute hover:bg-white/5 hover:text-txt">
          <Plus size={16} /> Add a source
        </button>
      )}
    </div>
  );
}
