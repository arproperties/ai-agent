import { useEffect, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, Search, CalendarDays, DoorOpen, Check, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// Leasing: bookings of units and the tenants who make them. Anyone signed in can use it.
// The server is server/leasing.js; the units come from Properties.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const SELECT = `${FIELD} bg-[#141128]`;
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3 py-1.5 text-xs text-mute hover:bg-white/5 hover:text-txt';
const STAGE = {
  active: ['Active', 'bg-ok/15 text-ok'], upcoming: ['Upcoming', 'bg-p3/15 text-p3'], draft: ['Draft', 'bg-white/10 text-txt/80'],
  ended: ['Ended', 'bg-white/5 text-mute'], cancelled: ['Cancelled', 'bg-bad/15 text-bad'],
};
const FREQ = [['monthly', 'Monthly'], ['quarterly', 'Every 3 months'], ['every_6_months', 'Every 6 months'], ['yearly', 'Yearly'], ['upfront', 'All upfront']];

const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const aed = (n) => `AED ${Number(n).toLocaleString()}`;
const nights = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000) + 1;

function Label({ text, need, children, wide }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-xs text-txt/80">{text}{need && <span className="text-p2"> *</span>}</span>
      {children}
    </label>
  );
}
const Section = ({ title, children }) => (
  <fieldset>
    <legend className="mb-2 text-[11px] font-medium uppercase tracking-widest text-mute">{title}</legend>
    <div className="grid gap-3 sm:grid-cols-2">{children}</div>
  </fieldset>
);

/** New booking, or editing one: a whole page, like registering a company. */
function BookingForm({ start, preset, onDone, onCancel }) {
  const init = start || preset || {}; // preset: a new booking begun from the calendar
  const [companies, setCompanies] = useState([]);
  const [buildings, setBuildings] = useState([]);
  const [companyId, setCompanyId] = useState(init.company_id || '');
  const [buildingId, setBuildingId] = useState(init.building_id || '');
  const [v, setV] = useState({
    start_date: init.start_date || '', end_date: init.end_date || '', unit_id: init.unit_id || '',
    rent_amount: start?.rent_amount ?? '', rent_period: start?.rent_period || 'month', payment_frequency: start?.payment_frequency || 'monthly',
    security_deposit: start?.security_deposit ?? '', contract_no: start?.contract_no || '', notes: start?.notes || '',
  });
  const [units, setUnits] = useState(null);
  const [tenantMode, setTenantMode] = useState(start ? 'existing' : 'new');
  const [tenants, setTenants] = useState([]);
  const [tenantId, setTenantId] = useState(start?.tenant_id || '');
  const [tenant, setTenant] = useState({ full_name: '', phone: '', email: '', emirates_id_no: '', nationality: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });

  useEffect(() => { api.get('/properties/companies').then(setCompanies).catch(() => {}); api.get('/leasing/tenants').then(setTenants).catch(() => {}); }, []);
  useEffect(() => {
    if (!companyId) return setBuildings([]);
    api.get(`/properties/companies/${companyId}`).then((c) => setBuildings(c.list)).catch(() => setBuildings([]));
  }, [companyId]);
  const datesOk = v.start_date && v.end_date && v.end_date >= v.start_date;
  useEffect(() => {
    setUnits(null);
    if (!buildingId || !datesOk) return;
    api.get(`/leasing/available?building_id=${buildingId}&start=${v.start_date}&end=${v.end_date}`).then(setUnits).catch((e) => setError(e.message));
  }, [buildingId, v.start_date, v.end_date]);

  const submit = (status) => async (e) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const body = { ...v, ...(tenantMode === 'existing' ? { tenant_id: tenantId } : { tenant }) };
    try {
      if (start) await api.put(`/leasing/bookings/${start.id}`, body);
      else await api.post('/leasing/bookings', { ...body, status });
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  // The unit already booked by this very booking counts as free while editing it.
  const isFree = (u) => u.free || (start && u.id === start.unit_id && u.taken_by?.ref === start.ref);

  return (
    <form onSubmit={submit('confirmed')} className="space-y-5 rounded-3xl border border-stroke p-5 md:p-7">
      <Section title="Where and when">
        <Label text="Company" need>
          <select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setBuildingId(''); setV({ ...v, unit_id: '' }); }} required className={SELECT}>
            <option value="">Choose…</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Label>
        <Label text="Building" need>
          <select value={buildingId} onChange={(e) => { setBuildingId(e.target.value); setV({ ...v, unit_id: '' }); }} required disabled={!companyId} className={SELECT}>
            <option value="">{companyId ? 'Choose…' : 'Choose a company first'}</option>{buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Label>
        <Label text="Start date (first night)" need><input type="date" value={v.start_date} onChange={set('start_date')} required className={FIELD} /></Label>
        <Label text="End date (last night)" need><input type="date" value={v.end_date} onChange={set('end_date')} min={v.start_date || undefined} required className={FIELD} /></Label>
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs text-txt/80">Unit<span className="text-p2"> *</span>
            {datesOk && <span className="text-mute"> · {nights(v.start_date, v.end_date)} nights</span>}</span>
          {!buildingId || !datesOk ? <p className="rounded-xl border border-dashed border-stroke px-3.5 py-3 text-sm text-mute">Choose a building and dates to see which units are free.</p>
            : !units ? <Loader2 size={18} className="my-3 animate-spin text-mute" />
              : units.length === 0 ? <p className="text-sm text-mute">This building has no units yet.</p>
                : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                    {units.map((u) => {
                      const free = isFree(u);
                      const on = String(v.unit_id) === String(u.id);
                      return (
                        <button key={u.id} type="button" disabled={!free} onClick={() => setV({ ...v, unit_id: u.id })}
                          title={u.taken_by ? `Booked by ${u.taken_by.tenant}, ${u.taken_by.start_date} to ${u.taken_by.end_date}` : u.blocked ? 'Blocked' : ''}
                          className={`rounded-xl border px-3 py-2 text-left text-sm transition ${on ? 'border-p1 bg-p1/15' : free ? 'border-stroke hover:border-p1/60' : 'cursor-not-allowed border-stroke/40 opacity-45'}`}>
                          <p className="font-medium">{u.unit_no}</p>
                          <p className="truncate text-[11px] text-mute">{free ? [u.type, u.floor && `Fl ${u.floor}`].filter(Boolean).join(' · ') || 'Free' : u.blocked ? 'Blocked' : `Taken · ${u.taken_by.tenant}`}</p>
                        </button>
                      );
                    })}
                  </div>
                )}
        </div>
      </Section>

      <fieldset>
        <legend className="mb-2 flex items-center gap-3 text-[11px] font-medium uppercase tracking-widest text-mute">
          Tenant
          <span className="flex gap-1 normal-case tracking-normal">
            {[['new', 'New tenant'], ['existing', 'Existing tenant']].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setTenantMode(k)}
                className={`rounded-full px-2.5 py-0.5 text-xs ${tenantMode === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{l}</button>
            ))}
          </span>
        </legend>
        {tenantMode === 'existing' ? (
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} required className={SELECT}>
            <option value="">Choose a tenant…</option>
            {tenants.map((t) => <option key={t.id} value={t.id}>{[t.full_name, t.phone, t.emirates_id_no].filter(Boolean).join(' · ')}</option>)}
          </select>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Label text="Full name" need wide><input value={tenant.full_name} onChange={(e) => setTenant({ ...tenant, full_name: e.target.value })} required placeholder="As on the Emirates ID or passport" className={FIELD} /></Label>
            <Label text="Phone"><input type="tel" value={tenant.phone} onChange={(e) => setTenant({ ...tenant, phone: e.target.value })} placeholder="+971 5…" className={FIELD} /></Label>
            <Label text="Email"><input type="email" value={tenant.email} onChange={(e) => setTenant({ ...tenant, email: e.target.value })} className={FIELD} /></Label>
            <Label text="Emirates ID no."><input value={tenant.emirates_id_no} onChange={(e) => setTenant({ ...tenant, emirates_id_no: e.target.value })} placeholder="784-…" className={FIELD} /></Label>
            <Label text="Nationality"><input value={tenant.nationality} onChange={(e) => setTenant({ ...tenant, nationality: e.target.value })} className={FIELD} /></Label>
          </div>
        )}
      </fieldset>

      <Section title="Rent">
        <Label text="Rent (AED)" need><input type="number" min="0" step="any" value={v.rent_amount} onChange={set('rent_amount')} required className={FIELD} /></Label>
        <Label text="Per">
          <select value={v.rent_period} onChange={set('rent_period')} className={SELECT}><option value="month">Month</option><option value="year">Year</option></select>
        </Label>
        <Label text="Paid">
          <select value={v.payment_frequency} onChange={set('payment_frequency')} className={SELECT}>{FREQ.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </Label>
        <Label text="Security deposit (AED)"><input type="number" min="0" step="any" value={v.security_deposit} onChange={set('security_deposit')} className={FIELD} /></Label>
      </Section>

      <Section title="Contract & notes">
        <Label text="Contract / Ejari no." wide><input value={v.contract_no} onChange={set('contract_no')} className={FIELD} /></Label>
        <Label text="Notes" wide><textarea value={v.notes} onChange={set('notes')} rows={3} className={`${FIELD} resize-none`} /></Label>
      </Section>

      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-stroke/60 pt-3">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        {start ? <button disabled={busy || !v.unit_id} className={PRIMARY}>{busy ? 'Saving…' : 'Save'}</button> : <>
          <button type="button" disabled={busy || !v.unit_id} onClick={submit('draft')} className="rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50">Save as draft</button>
          <button disabled={busy || !v.unit_id} className={PRIMARY}>{busy ? 'Saving…' : 'Confirm booking'}</button>
        </>}
      </div>
    </form>
  );
}

function BookingCard({ b, onEdit, onChanged }) {
  const [error, setError] = useState('');
  const act = async (fn) => { setError(''); try { await fn(); onChanged(); } catch (e) { setError(e.message); } };
  const [label, tone] = STAGE[b.stage];
  return (
    <div className="flex flex-col rounded-2xl border border-stroke">
      <div className="flex items-start gap-3 px-4 pt-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{b.tenant}</p>
          <p className="truncate text-xs text-mute">{b.ref}{b.tenant_phone && ` · ${b.tenant_phone}`}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${tone}`}>{label}</span>
      </div>
      <dl className="mx-4 mt-3 flex-1 divide-y divide-stroke/60 border-t border-stroke text-sm">
        {[[DoorOpen, `Unit ${b.unit_no} · ${b.building}`, b.company], [CalendarDays, `${fmt(b.start_date)} → ${fmt(b.end_date)}`, `${nights(b.start_date, b.end_date)} nights · ${b.type === 'lease' ? 'Lease' : 'Short stay'}`]].map(([Ico, main, sub]) => (
          <div key={main} className="flex gap-2.5 py-2">
            <Ico size={15} className="mt-0.5 shrink-0 text-p1/80" />
            <div className="min-w-0"><p className="truncate">{main}</p><p className="truncate text-xs text-mute">{sub}</p></div>
          </div>
        ))}
        <div className="flex justify-between gap-4 py-2">
          <span className="text-mute">Rent</span>
          <span className="text-right">{aed(b.rent_amount)} / {b.rent_period} <span className="text-xs text-mute">· {FREQ.find(([k]) => k === b.payment_frequency)?.[1]}</span></span>
        </div>
        {b.cancel_reason && <p className="py-2 text-xs text-bad">Cancelled: {b.cancel_reason}</p>}
      </dl>
      {error && <p className="px-4 pb-1 text-xs text-bad">{error}</p>}
      {b.status !== 'cancelled' && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stroke px-4 py-2.5">
          {b.status === 'draft' && <button onClick={() => act(() => api.post(`/leasing/bookings/${b.id}/confirm`))} className={GHOST}><Check size={13} /> Confirm</button>}
          <button onClick={onEdit} className={GHOST}><Pencil size={13} /> Edit</button>
          {b.status === 'draft'
            ? <button onClick={() => confirm('Delete this draft?') && act(() => api.del(`/leasing/bookings/${b.id}`))} className={`${GHOST} hover:text-bad`}><Trash2 size={13} /> Delete</button>
            : <button onClick={() => { const reason = prompt('Why is this booking cancelled?'); if (reason) act(() => api.post(`/leasing/bookings/${b.id}/cancel`, { reason })); }}
              className={`${GHOST} hover:text-bad`}><X size={13} /> Cancel booking</button>}
        </div>
      )}
    </div>
  );
}

function Bookings({ onEdit }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const load = () => api.get(`/leasing/bookings?q=${encodeURIComponent(q)}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q]);

  const shown = rows && (stage ? rows.filter((b) => b.stage === stage) : rows);
  const count = (k) => rows?.filter((b) => b.stage === k).length || 0;
  return (
    <div className="space-y-4">
      <label className="relative block">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by tenant, phone, unit, building, company or contract no." className={`${FIELD} pl-10`} />
      </label>
      <div className="flex flex-wrap gap-1.5 text-xs">
        {[['', 'All', rows?.length || 0], ...['active', 'upcoming', 'draft', 'ended', 'cancelled'].map((k) => [k, STAGE[k][0], count(k)])].map(([k, l, n]) => (
          <button key={k} onClick={() => setStage(k)} className={`rounded-full px-3 py-1 ${stage === k ? 'bg-p1/20 text-p1' : 'text-mute hover:bg-white/5 hover:text-txt'}`}>{l} <span className="opacity-60">{n}</span></button>
        ))}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!shown ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
        : shown.length === 0 ? <p className="py-3 text-sm text-mute">{rows.length ? 'No bookings match.' : 'No bookings yet. Use New booking to make the first one.'}</p>
          : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{shown.map((b) => <BookingCard key={b.id} b={b} onEdit={() => onEdit(b)} onChanged={load} />)}</div>}
    </div>
  );
}

function TenantForm({ start, onDone, onCancel }) {
  const [v, setV] = useState({ full_name: '', phone: '', email: '', emirates_id_no: '', emirates_id_expiry: '', passport_no: '', nationality: '', notes: '', ...start });
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    try { await api.put(`/leasing/tenants/${start.id}`, v); onDone(); } catch (err) { setError(err.message); }
  };
  return (
    <form onSubmit={save} className="space-y-3 rounded-2xl border border-p1/40 p-4 md:col-span-2 xl:col-span-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Full name" need wide><input value={v.full_name || ''} onChange={set('full_name')} required className={FIELD} /></Label>
        <Label text="Phone"><input value={v.phone || ''} onChange={set('phone')} className={FIELD} /></Label>
        <Label text="Email"><input type="email" value={v.email || ''} onChange={set('email')} className={FIELD} /></Label>
        <Label text="Emirates ID no."><input value={v.emirates_id_no || ''} onChange={set('emirates_id_no')} className={FIELD} /></Label>
        <Label text="Emirates ID expiry"><input type="date" value={v.emirates_id_expiry || ''} onChange={set('emirates_id_expiry')} className={FIELD} /></Label>
        <Label text="Passport no."><input value={v.passport_no || ''} onChange={set('passport_no')} className={FIELD} /></Label>
        <Label text="Nationality"><input value={v.nationality || ''} onChange={set('nationality')} className={FIELD} /></Label>
        <Label text="Notes" wide><textarea value={v.notes || ''} onChange={set('notes')} rows={2} className={`${FIELD} resize-none`} /></Label>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button className={PRIMARY}>Save</button>
      </div>
    </form>
  );
}

function Tenants() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const load = () => api.get(`/leasing/tenants?q=${encodeURIComponent(q)}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q]);
  const remove = async (t) => {
    if (!confirm(`Delete ${t.full_name}?`)) return;
    try { await api.del(`/leasing/tenants/${t.id}`); load(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-4">
      <label className="relative block">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tenants by name, phone, email, Emirates ID or passport" className={`${FIELD} pl-10`} />
      </label>
      <p className="text-xs text-mute">Tenants are added from New booking.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!rows ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
        : rows.length === 0 ? <p className="py-3 text-sm text-mute">No tenants yet.</p> : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((t) => (editing === t.id
              ? <TenantForm key={t.id} start={t} onDone={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
              : (
                <div key={t.id} className="rounded-2xl border border-stroke">
                  <div className="flex items-start gap-3 px-4 pt-4">
                    <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-p1/15 text-sm font-semibold text-p1">
                      {t.full_name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{t.full_name}</p>
                      <p className="truncate text-xs text-mute">{t.bookings} booking{t.bookings === 1 ? '' : 's'}{t.nationality && ` · ${t.nationality}`}</p>
                    </div>
                    <div className="-mr-1.5 flex shrink-0">
                      <button onClick={() => setEditing(t.id)} aria-label="Edit" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
                      <button onClick={() => remove(t)} aria-label="Delete" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
                    </div>
                  </div>
                  <dl className="mx-4 my-3 divide-y divide-stroke/60 border-t border-stroke text-sm">
                    {[['Phone', t.phone], ['Email', t.email], ['Emirates ID', t.emirates_id_no]].map(([l, x]) => (
                      <div key={l} className="flex gap-4 py-2"><dt className="shrink-0 text-mute">{l}</dt><dd className={`min-w-0 flex-1 truncate text-right ${x ? '' : 'text-mute/50'}`}>{x || '—'}</dd></div>
                    ))}
                  </dl>
                </div>
              )))}
          </div>
        )}
    </div>
  );
}

const BAR = {
  active: 'bg-p1/70 text-white', upcoming: 'bg-p3/60 text-white', ended: 'bg-white/15 text-txt/70',
  draft: 'border border-dashed border-p1/70 bg-p1/10 text-p1',
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const COL = 34; // px per day
const isWeekend = (d) => d.getDay() === 5 || d.getDay() === 6; // Fri, Sat

/**
 * One building, one month: a row per unit and a bar per booking. A bar opens its booking;
 * an empty day starts a new booking of that unit from that day.
 */
function Calendar({ onEdit, onNew }) {
  const [companies, setCompanies] = useState([]);
  const [buildings, setBuildings] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [units, setUnits] = useState(null);
  const [bookings, setBookings] = useState([]);

  useEffect(() => {
    api.get('/properties/companies').then((cs) => { setCompanies(cs); if (cs[0]) setCompanyId(String(cs[0].id)); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!companyId) return;
    api.get(`/properties/companies/${companyId}`).then((c) => { setBuildings(c.list); setBuildingId(c.list[0] ? String(c.list[0].id) : ''); }).catch(() => {});
  }, [companyId]);
  useEffect(() => {
    setUnits(null);
    if (!buildingId) return;
    api.get(`/properties/buildings/${buildingId}`).then((b) => setUnits(b.list)).catch(() => setUnits([]));
    api.get(`/leasing/bookings?building_id=${buildingId}`).then((r) => setBookings(r.filter((b) => b.status !== 'cancelled'))).catch(() => setBookings([]));
  }, [buildingId]);

  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const first = iso(month);
  const last = iso(new Date(month.getFullYear(), month.getMonth(), days));
  const today = iso(new Date());
  const dayList = Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1));
  const shift = (n) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const index = (d) => Math.round((new Date(`${d}T00:00:00`) - month) / 86400000); // 0 = the 1st
  const inMonth = bookings.filter((b) => b.start_date <= last && b.end_date >= first);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={`${SELECT} w-auto min-w-[12rem] flex-1 sm:flex-none`}>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)} className={`${SELECT} w-auto min-w-[12rem] flex-1 sm:flex-none`}>
          {buildings.length === 0 && <option value="">No buildings</option>}
          {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => shift(-1)} aria-label="Previous month" className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><ChevronLeft size={18} /></button>
          <span className="min-w-[8.5rem] text-center text-sm">{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
          <button onClick={() => shift(1)} aria-label="Next month" className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><ChevronRight size={18} /></button>
          <button onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }} className={GHOST}>Today</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
        {[['active', 'Active'], ['upcoming', 'Upcoming'], ['draft', 'Draft'], ['ended', 'Ended']].map(([k, l]) => (
          <span key={k} className="flex items-center gap-1.5"><span className={`h-2.5 w-5 rounded ${BAR[k]}`} />{l}</span>
        ))}
        <span className="ml-auto">Tap an empty day to book that unit from that day</span>
      </div>

      {!buildingId ? <p className="py-3 text-sm text-mute">Choose a building.</p>
        : !units ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
          : units.length === 0 ? <p className="py-3 text-sm text-mute">This building has no units yet.</p> : (
            <div className="overflow-x-auto rounded-2xl border border-stroke">
              <div style={{ minWidth: 112 + days * COL }}>
                <div className="flex border-b border-stroke text-[11px] text-mute">
                  <div className="w-28 shrink-0 px-3 py-2">Unit</div>
                  {dayList.map((d) => (
                    <div key={d.getDate()} style={{ width: COL }}
                      className={`shrink-0 py-1 text-center ${iso(d) === today ? 'font-semibold text-p1' : ''} ${isWeekend(d) ? 'bg-white/[0.03]' : ''}`}>
                      <div>{d.toLocaleDateString('en-GB', { weekday: 'narrow' })}</div><div>{d.getDate()}</div>
                    </div>
                  ))}
                </div>
                {units.map((u) => (
                  <div key={u.id} className="flex border-b border-stroke/50 last:border-b-0">
                    <div className="w-28 shrink-0 truncate px-3 py-2.5 text-sm">
                      {u.unit_no}<span className="ml-1.5 text-[11px] text-mute">{u.blocked ? 'Blocked' : u.type}</span>
                    </div>
                    <div className="relative flex">
                      {dayList.map((d) => (
                        <button key={d.getDate()} style={{ width: COL }} disabled={u.blocked}
                          onClick={() => onNew({ company_id: companyId, building_id: buildingId, unit_id: u.id, start_date: iso(d) })}
                          title={u.blocked ? 'Blocked' : `Book unit ${u.unit_no} from ${iso(d)}`}
                          className={`h-full shrink-0 border-l border-stroke/30 ${u.blocked ? 'cursor-not-allowed bg-white/[0.04]' : 'hover:bg-p1/10'} ${isWeekend(d) ? 'bg-white/[0.03]' : ''} ${iso(d) === today ? 'bg-p1/[0.07]' : ''}`} />
                      ))}
                      {inMonth.filter((b) => b.unit_id === u.id).map((b) => {
                        const from = Math.max(0, index(b.start_date));
                        const to = Math.min(days - 1, index(b.end_date));
                        return (
                          <button key={b.id} onClick={() => onEdit(b)} title={`${b.tenant} · ${b.start_date} → ${b.end_date} · ${b.ref}`}
                            style={{ left: from * COL + 2, width: (to - from + 1) * COL - 4 }}
                            className={`absolute inset-y-1.5 truncate rounded-md px-2 text-left text-[11px] font-medium ${BAR[b.stage]} ${b.start_date < first ? 'rounded-l-none' : ''} ${b.end_date > last ? 'rounded-r-none' : ''}`}>
                            {b.tenant}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
    </div>
  );
}

export default function LeasingPage({ onBack }) {
  const [tab, setTab] = useState('bookings');
  const [form, setForm] = useState(null); // { preset } for a new booking, a booking being edited, or null
  const [key, setKey] = useState(0); // bumped after a save, so the list reloads

  if (form) return (
    <Page title={form.id ? `Edit ${form.ref}` : 'New booking'} onBack={() => setForm(null)}>
      <BookingForm start={form.id ? form : null} preset={form.preset} onDone={() => { setForm(null); setTab('bookings'); setKey((k) => k + 1); }} onCancel={() => setForm(null)} />
    </Page>
  );

  return (
    <Page title="Leasing" onBack={onBack} action={<button onClick={() => setForm({ preset: null })} className={PRIMARY}><Plus size={16} /> New booking</button>}>
      <div className="mb-4 flex gap-5 border-b border-stroke text-sm">
        {[['bookings', 'Bookings'], ['calendar', 'Calendar'], ['tenants', 'Tenants']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`-mb-px border-b-2 pb-2 pt-1 transition ${tab === k ? 'border-p1 text-txt' : 'border-transparent text-mute hover:text-txt'}`}>{l}</button>
        ))}
      </div>
      {tab === 'bookings' ? <Bookings key={key} onEdit={(b) => setForm(b)} />
        : tab === 'calendar' ? <Calendar key={key} onEdit={(b) => setForm(b)} onNew={(preset) => setForm({ preset })} />
          : <Tenants />}
    </Page>
  );
}
