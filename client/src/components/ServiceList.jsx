import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { currency, money } from '../lib/region';
import Select from './Select';

// A building's extra services (pet fee, parking, laundry…): the list a booking in that
// building picks its other charges from. Each one is a line to read; the pencil opens it
// to rename or reprice, and "Add a service" opens an empty one. A booking keeps its own
// copy of what it charges, so nothing done here changes a booking.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const SELECT = `${FIELD} bg-surface`;
const ICON = 'grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10';
export const REPEAT = [['once', 'Once, on the first day'], ['every', 'With every rent payment']];
const BLANK = { name: '', amount: '', repeats: false };

export default function ServiceList({ services, buildingId, onChange, onError, readOnly }) {
  const [editing, setEditing] = useState(null); // a service's id, 'new', or null
  const [v, setV] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const open = (s) => { onError(''); setV(s ? { name: s.name, amount: s.amount ?? '', repeats: !!s.repeats } : BLANK); setEditing(s ? s.id : 'new'); };
  const save = async () => {
    if (!v.name.trim() || busy) return;
    setBusy(true);
    onError('');
    try {
      const s = editing === 'new' ? await api.post('/leasing/services', { ...v, building_id: buildingId }) : await api.put(`/leasing/services/${editing}`, v);
      onChange([...services.filter((x) => x.id !== s.id), s].sort((a, b) => a.name.localeCompare(b.name)));
      setEditing(null);
    } catch (e) { onError(e.message); }
    setBusy(false);
  };
  const remove = async (s) => {
    if (!confirm(`Remove ${s.name} from the list? Bookings that already charge it keep it.`)) return;
    try { await api.del(`/leasing/services/${s.id}`); onChange(services.filter((x) => x.id !== s.id)); } catch (e) { onError(e.message); }
  };
  // This list can sit inside the booking form, so it is not a form itself: Enter saves the service, not the booking.
  const keys = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') setEditing(null);
  };

  const editor = (
    <div className="space-y-3 rounded-2xl border border-p1/40 bg-white/[0.03] p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs text-txt/80">Service <span className="text-p2">*</span></span>
          <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} onKeyDown={keys} autoFocus placeholder="e.g. Pet fee" className={FIELD} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-txt/80">Usual price ({currency()})</span>
          <input type="number" min="0" step="any" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} onKeyDown={keys} placeholder="Leave empty if it varies" className={FIELD} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-txt/80">Charged</span>
          <Select value={v.repeats ? 'every' : 'once'} onChange={(e) => setV({ ...v, repeats: e.target.value === 'every' })} options={REPEAT} className={SELECT} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setEditing(null)} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button type="button" onClick={save} disabled={busy || !v.name.trim()} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? 'Saving…' : editing === 'new' ? 'Add service' : 'Save'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      {services.length === 0 && editing !== 'new' && <p className="py-1 text-sm text-mute">No services for this building yet.</p>}
      {services.length > 0 && (
        <ul className="divide-y divide-stroke/60">
          {services.map((s) => (editing === s.id
            ? <li key={s.id} className="py-2">{editor}</li>
            : (
              <li key={s.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{s.name}</p>
                  <p className="truncate text-xs text-mute">{s.repeats ? 'With every rent payment' : 'Once, on the first day'}</p>
                </div>
                <span className={`shrink-0 text-sm ${Number(s.amount) ? '' : 'text-mute'}`}>{Number(s.amount) ? money(s.amount) : 'Price set on the booking'}</span>
                {!readOnly && <div className="-mr-1.5 flex shrink-0">
                  <button type="button" onClick={() => open(s)} aria-label={`Edit ${s.name}`} title="Edit" className={`${ICON} hover:text-txt`}><Pencil size={15} /></button>
                  <button type="button" onClick={() => remove(s)} aria-label={`Remove ${s.name}`} title="Remove from the list" className={`${ICON} hover:text-bad`}><Trash2 size={15} /></button>
                </div>}
              </li>
            )))}
        </ul>
      )}
      {!readOnly && buildingId && (editing === 'new'
        ? editor
        : (
          <button type="button" onClick={() => open(null)}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke/70 py-2 text-sm text-mute hover:bg-white/5 hover:text-txt">
            <Plus size={16} /> Add a service
          </button>
        ))}
    </div>
  );
}
