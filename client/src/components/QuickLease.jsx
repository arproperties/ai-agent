import { useEffect, useState } from 'react';
import { ChevronDown, ClipboardCheck, Paperclip, X } from 'lucide-react';
import { api } from '../lib/api';
import { currency, region, today } from '../lib/region';
import { usPhone } from '../lib/usFormat';
import Select from './Select';
import DateField from './DateField';
import PhoneField from './PhoneField';
import { REQUIRED } from './BookingDocs';

// A new lease made where the unit was tapped, in the 3D View. The company, the building and
// the unit are already known there, so it asks only for the rest: who, from when to when,
// and the rent. It is saved as the lease form saves it (a draft, with the tenant's documents),
// and whatever it does not ask for is as the lease form starts it. The lease form itself,
// with the discount and the other charges, is one tap away.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3 py-2 text-sm outline-none focus:border-p1/70';
const PRIMARY = 'flex w-full items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const FREQ = [['monthly', 'Monthly'], ['quarterly', 'Every 3 months'], ['every_6_months', 'Every 6 months'], ['yearly', 'Yearly'], ['upfront', 'All upfront']];

/** The last day of a year that starts on this one. */
const yearFrom = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y + 1, m - 1, d - 1)).toISOString().slice(0, 10); };

const Label = ({ text, children }) => (
  <label className="block">
    <span className="mb-1 block text-xs text-txt/80">{text}</span>
    {children}
  </label>
);

export default function QuickLease({ unit, where, preset, onSaved, onFull, onCancel }) {
  const [tenantMode, setTenantMode] = useState('new');
  const [tenants, setTenants] = useState([]);
  const [tenantId, setTenantId] = useState('');
  const [tenant, setTenant] = useState({ full_name: '', phone: '' });
  const [v, setV] = useState(() => {
    const start = today();
    return { start_date: start, end_date: yearFrom(start), rent_amount: '', payment_frequency: 'monthly', security_deposit: '', tax_percent: region().tax_percent || '' };
  });
  const [files, setFiles] = useState({}); // the documents a new lease must come with (REQUIRED), by field
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV((now) => ({ ...now, [f]: e.target.value }));

  useEffect(() => { api.get('/leasing/tenants').then(setTenants).catch(() => {}); }, []);

  // A start moved keeps the lease a year long, unless the end was set by hand.
  const setStart = (e) => setV((now) => ({ ...now, start_date: e.target.value,
    end_date: e.target.value && now.end_date === (now.start_date && yearFrom(now.start_date)) ? yearFrom(e.target.value) : now.end_date }));

  const datesOk = v.start_date && v.end_date && v.end_date >= v.start_date;
  const ready = (tenantMode === 'existing' ? !!tenantId : !!tenant.full_name.trim() && !!tenant.phone.trim())
    && datesOk && Number(v.rent_amount) > 0 && REQUIRED.every(([f]) => files[f]);

  const save = (inspect) => async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('booking', JSON.stringify({ ...v, unit_id: unit.unit_id, rent_period: 'month', fees: [], status: 'draft',
        ...(tenantMode === 'existing' ? { tenant_id: tenantId } : { tenant }) }));
      for (const [f] of REQUIRED) form.append(f, files[f]);
      onSaved(await api.upload('/leasing/bookings', form), inspect);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-medium">New lease</p>
          <p className="truncate text-xs text-mute">Unit {unit.unit_no} · {where}</p>
        </div>
        <button type="button" onClick={onCancel} aria-label="Close" className="-mr-1.5 -mt-1.5 grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={16} /></button>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-xs text-txt/80">Tenant</span>
          <span className="flex rounded-full border border-stroke p-0.5">
            {[['new', 'New'], ['existing', 'Existing']].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setTenantMode(k)} aria-pressed={tenantMode === k}
                className={`rounded-full px-2.5 py-0.5 text-xs ${tenantMode === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{l}</button>
            ))}
          </span>
        </div>
        {tenantMode === 'existing' ? (
          <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)} className={FIELD} placeholder="Choose a tenant…" aria-label="Tenant"
            options={tenants.map((t) => [t.id, [t.full_name, usPhone(t.phone)].filter(Boolean).join(' · ')])} />
        ) : (
          <div className="space-y-2">
            <input value={tenant.full_name} onChange={(e) => setTenant({ ...tenant, full_name: e.target.value })} placeholder="Full name, as on the ID" aria-label="Full name" autoFocus className={FIELD} />
            <PhoneField value={tenant.phone} onChange={(e) => setTenant({ ...tenant, phone: e.target.value })} aria-label="Phone" className={FIELD} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Label text="From"><DateField value={v.start_date} onChange={setStart} aria-label="From" className={FIELD} /></Label>
        <Label text="To"><DateField value={v.end_date} min={v.start_date} onChange={set('end_date')} aria-label="To" className={FIELD} /></Label>
      </div>

      <Label text={`Rent a month (${currency()})`}>
        <input type="number" min="0" step="any" value={v.rent_amount} onChange={set('rent_amount')} className={FIELD} />
      </Label>

      {REQUIRED.map(([f, name]) => (
        <Label key={f} text={name}>
          <span className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3 py-2 text-xs text-mute hover:bg-white/5">
            <Paperclip size={14} className="shrink-0" /> <span className={`truncate ${files[f] ? 'text-txt' : ''}`}>{files[f] ? files[f].name : 'Attach the scan (PDF or photo)'}</span>
            <input type="file" accept="application/pdf,image/*,.doc,.docx" className="hidden" onChange={(e) => e.target.files?.[0] && setFiles((now) => ({ ...now, [f]: e.target.files[0] }))} />
          </span>
        </Label>
      ))}

      <button type="button" onClick={() => setMore(!more)} aria-expanded={more} className="flex items-center gap-1 text-xs text-mute hover:text-txt">
        <ChevronDown size={14} className={`transition ${more ? 'rotate-180' : ''}`} /> Paid {FREQ.find(([k]) => k === v.payment_frequency)[1].toLowerCase()}, {Number(v.security_deposit) > 0 ? 'with a deposit' : 'no deposit'}
      </button>
      {more && (
        <div className="space-y-2">
          <Label text="Paid"><Select value={v.payment_frequency} onChange={set('payment_frequency')} className={FIELD} options={FREQ} /></Label>
          <Label text={`Deposit (${currency()})`}><input type="number" min="0" step="any" value={v.security_deposit} onChange={set('security_deposit')} placeholder="None" className={FIELD} /></Label>
        </div>
      )}

      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="space-y-2">
        <button type="button" disabled={busy || !ready} onClick={save(true)} className={PRIMARY}><ClipboardCheck size={15} /> {busy ? 'Saving…' : 'Save and inspect'}</button>
        <button type="button" disabled={busy || !ready} onClick={save(false)} className="w-full rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50">Save as draft</button>
        <p className="text-center text-xs text-mute">The unit shows as leased once its move-in inspection is done.</p>
        <button type="button" onClick={() => onFull({ ...preset, start_date: v.start_date, end_date: v.end_date })} className="w-full text-center text-xs text-mute underline-offset-2 hover:text-txt hover:underline">Discount or other charges? Open the full form</button>
      </div>
    </div>
  );
}
