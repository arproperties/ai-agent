import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { currency } from '../lib/region';
import Select from './Select';

// A building's extra services (pet fee, parking, laundry…): the list a booking in that
// building picks its other charges from. Add, rename, reprice or remove them here. A booking
// keeps its own copy of what it charges, so nothing done here changes a booking.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const SELECT = `${FIELD} bg-surface`;
const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3 py-1.5 text-xs text-mute hover:bg-white/5 hover:text-txt disabled:opacity-50';
export const REPEAT = [['once', 'Once, on the first day'], ['every', 'With every rent payment']];

export default function ServiceList({ services, buildingId, onChange, onError }) {
  const [add, setAdd] = useState({ name: '', amount: '', repeats: false });
  const save = async (s, patch) => {
    try { const now = await api.put(`/leasing/services/${s.id}`, patch); onChange(services.map((x) => (x.id === s.id ? now : x))); } catch (e) { onError(e.message); }
  };
  // Enter saves the field (by leaving it) rather than submitting a form around it.
  const done = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
  const remove = async (s) => {
    if (!confirm(`Remove ${s.name} from the list? Bookings that already charge it keep it.`)) return;
    try { await api.del(`/leasing/services/${s.id}`); onChange(services.filter((x) => x.id !== s.id)); } catch (e) { onError(e.message); }
  };
  const create = async () => {
    if (!add.name.trim()) return;
    onError('');
    try {
      const s = await api.post('/leasing/services', { ...add, building_id: buildingId });
      onChange([...services, s].sort((a, b) => a.name.localeCompare(b.name)));
      setAdd({ name: '', amount: '', repeats: false });
    } catch (e) { onError(e.message); }
  };
  return (
    <div className="space-y-2">
      {services.length === 0 && <p className="text-sm text-mute">No services for this building yet.</p>}
      {services.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-2">
          <input defaultValue={s.name} onKeyDown={done} onBlur={(e) => e.target.value.trim() !== s.name && save(s, { name: e.target.value })} aria-label="Service" className={`${FIELD} min-w-[11rem] flex-1`} />
          <input type="number" min="0" step="any" defaultValue={s.amount ?? ''} onKeyDown={done} onBlur={(e) => Number(e.target.value || 0) !== Number(s.amount || 0) && save(s, { amount: e.target.value })}
            placeholder={currency()} aria-label="Usual price" className={`${FIELD} max-w-[9rem]`} />
          <Select value={s.repeats ? 'every' : 'once'} onChange={(e) => save(s, { repeats: e.target.value === 'every' })} options={REPEAT} aria-label="How often" className={SELECT} wrap="w-56" />
          <button type="button" onClick={() => remove(s)} aria-label={`Remove ${s.name}`} title="Remove from the list"
            className="grid size-9 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
        </div>
      ))}
      {buildingId && (
        <div className="flex flex-wrap items-center gap-2 border-t border-stroke/60 pt-3">
          <input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }}
            placeholder="New service, e.g. Pet fee" aria-label="New service" className={`${FIELD} min-w-[11rem] flex-1`} />
          <input type="number" min="0" step="any" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} placeholder={currency()} aria-label="Price" className={`${FIELD} max-w-[9rem]`} />
          <Select value={add.repeats ? 'every' : 'once'} onChange={(e) => setAdd({ ...add, repeats: e.target.value === 'every' })} options={REPEAT} aria-label="How often" className={SELECT} wrap="w-56" />
          <button type="button" onClick={create} disabled={!add.name.trim()} className={GHOST}><Plus size={13} /> Add</button>
        </div>
      )}
    </div>
  );
}
