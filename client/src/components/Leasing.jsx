import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, Search, CalendarDays, DoorOpen, Check, X, ChevronLeft, ChevronRight, Paperclip, Banknote, RefreshCw, Upload, LayoutGrid, List, BedDouble, BedSingle, Lock, History } from 'lucide-react';
import { api } from '../lib/api';
import { money as aed, currency, region } from '../lib/region';
import { usDate as fmt, usPhone } from '../lib/usFormat';
import Page from './Page';
import Select from './Select';
import DateRange from './DateRange';
import DateField from './DateField';
import PhoneField from './PhoneField';
import Pager, { usePaged } from './Pager';
import BookingDocs, { REQUIRED } from './BookingDocs';
import ServiceList, { REPEAT } from './ServiceList';
import SourceList from './SourceList';
import BookingPayments from './BookingPayments';
import ImportBookings from './ImportBookings';
import LeasingOverview, { LeasingBuildings } from './LeasingOverview';
import LeasingReports from './LeasingReports';
import LeasingAlerts from './LeasingAlerts';
import TenantHistory from './TenantHistory';

// Leasing: bookings of units and the tenants who make them. Anyone signed in can use it.
// The server is server/leasing.js; the units come from Properties.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3.5 py-2.5 outline-none focus:border-p1/70'; // a fainter fill than `glass`, so a form full of them stays quiet
const SELECT = FIELD; // the same see-through field as a typed one; the list it opens has its own background
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3 py-1.5 text-xs text-mute hover:bg-white/5 hover:text-txt';
const STAGE = {
  active: ['Active', 'bg-ok/15 text-ok'], upcoming: ['Upcoming', 'bg-p3/15 text-p3'], draft: ['Draft', 'bg-white/10 text-txt/80'],
  ended: ['Ended', 'bg-white/5 text-mute'], cancelled: ['Cancelled', 'bg-bad/15 text-bad'],
};
const STEPS = ['Where and when', 'Tenant', 'Rent and charges', 'Contract & notes']; // the booking form, a step at a time
const FREQ = [['monthly', 'Monthly'], ['quarterly', 'Every 3 months'], ['every_6_months', 'Every 6 months'], ['yearly', 'Yearly'], ['upfront', 'All upfront']];

const nights = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000) + 1;

function Label({ text, need, children, wide }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-xs text-txt/80">{text}{need && <span className="text-p2"> *</span>}</span>
      {children}
    </label>
  );
}
/** One step of the booking form; `extra` sits beside its title. */
const Section = ({ title, extra, children }) => (
  <section>
    <div className="mb-3 flex min-h-8 flex-wrap items-center gap-2.5">
      <h2 className="text-base font-medium">{title}</h2>
      {extra}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">{children}</div>
  </section>
);
/** A named part of a step, with a line above it to set it apart from the part before; `extra` sits beside its title. */
const Group = ({ title, hint, extra, children }) => (
  <div className="border-t border-stroke/60 pt-4 first:border-0 first:pt-0 sm:col-span-2">
    <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
      <p className="text-sm font-medium">{title}{hint && <span className="font-normal text-mute"> · {hint}</span>}</p>
      {extra}
    </div>
    {children}
  </div>
);
const Row = ({ k, children, strong }) => (
  <div className={`flex items-baseline justify-between gap-3 ${strong ? 'font-medium' : ''}`}>
    <span className={strong ? '' : 'text-mute'}>{k}</span><span className="text-right tabular-nums">{children}</span>
  </div>
);

// What a booking will come to, worked out as the server's schedule does (server/leasing.js),
// so the summary can show it before anything is saved. A part month counts as a month.
const STEP = { monthly: 1, quarterly: 3, every_6_months: 6, yearly: 12 };
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + n, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}
function plan(v) {
  let months = 1;
  while (addMonths(v.start_date, months) < v.end_date) months++;
  const step = STEP[v.payment_frequency] || months;
  const payments = Math.ceil(months / step);
  // The discount comes off the rent as it was entered; the tax is on the rent after it and on the other charges, never the deposit.
  const rent = Number(v.rent_amount || 0);
  const off = Math.min(rent, v.discount_type === 'percent' ? (rent * Number(v.discount_value || 0)) / 100 : Number(v.discount_value || 0));
  const per = v.rent_period === 'year' ? 12 : 1;
  const monthly = (rent - off) / per;
  const rate = Number(v.tax_percent || 0) / 100;
  const deposit = Number(v.security_deposit || 0);
  const fees = v.fees.filter((f) => Number(f.amount) > 0);
  const firstRent = monthly * Math.min(step, months);
  const firstFees = fees.reduce((t, f) => t + Number(f.amount), 0);
  const allFees = fees.reduce((t, f) => t + Number(f.amount) * (f.repeats ? payments : 1), 0);
  const firstTax = (firstRent + firstFees) * rate;
  const tax = (monthly * months + allFees) * rate;
  return {
    payments, firstRent, deposit, fees, firstTax, tax, discount: (off / per) * months,
    // The deposit is held for the tenant and given back, so it is never part of what the stay costs.
    charges: firstRent + firstFees + firstTax,
    first: firstRent + deposit + firstFees + firstTax,
    total: monthly * months + allFees + tax,
  };
}
/** Two or three choices side by side, one of them on. */
const Pick = ({ value, onPick, options }) => (
  <span className="flex shrink-0 rounded-full border border-stroke p-0.5">
    {options.map(([k, l]) => (
      <button key={k} type="button" onClick={() => onPick(k)} aria-pressed={value === k}
        className={`rounded-full px-3 py-1.5 text-xs ${value === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{l}</button>
    ))}
  </span>
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
    security_deposit: start?.security_deposit ?? '', contract_no: start?.contract_no || '', notes: start?.notes || '', fees: start?.fees || [], source: start?.source || '', tenant_energy_account: !!start?.tenant_energy_account,
    discount_type: start?.discount_type || 'percent', discount_value: start?.discount_value ?? '', discount_note: start?.discount_note || '',
    // A new booking starts with the region's usual tax; one being edited keeps what it has. Empty is no tax.
    tax_percent: start ? start.tax_percent ?? '' : region().tax_percent || '',
  });
  const taxName = region().tax_name;
  const [units, setUnits] = useState(null);
  const [tenantMode, setTenantMode] = useState(start ? 'existing' : 'new');
  const [tenants, setTenants] = useState([]);
  const [tenantId, setTenantId] = useState(start?.tenant_id || '');
  const [tenant, setTenant] = useState({ full_name: '', phone: '', email: '', emirates_id_no: '', nationality: '' });
  const [files, setFiles] = useState({}); // the documents a new booking must come with (REQUIRED), by field
  const [services, setServices] = useState([]); // the saved extra services the other charges are picked from
  const [listOpen, setListOpen] = useState(false);
  const [sources, setSources] = useState([]); // where tenants come from: one list for the whole app
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [step, setStep] = useState(0); // which of STEPS is on screen
  const [far, setFar] = useState(start ? STEPS.length - 1 : 0); // the furthest step reached
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });

  useEffect(() => { api.get('/properties/companies').then(setCompanies).catch(() => {}); api.get('/leasing/tenants').then(setTenants).catch(() => {}); api.get('/leasing/sources').then(setSources).catch(() => {}); }, []);
  // The other charges are picked from the services of the building the booking is in.
  useEffect(() => {
    if (!buildingId) return setServices([]);
    api.get(`/leasing/services?building_id=${buildingId}`).then(setServices).catch(() => {});
  }, [buildingId]);
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
      if (start) return onDone(await api.put(`/leasing/bookings/${start.id}`, body));
      const form = new FormData();
      form.append('booking', JSON.stringify({ ...body, status }));
      for (const [f] of REQUIRED) form.append(f, files[f]);
      onDone(await api.upload('/leasing/bookings', form));
    } catch (err) { setError(err.message); setBusy(false); }
  };

  // A source typed in that is not on the list is saved to it there and then, for every booking after this one.
  const makeSource = async (name) => {
    try {
      const made = await api.post('/leasing/sources', { name });
      setSources((list) => [...list, made].sort((a, b) => a.name.localeCompare(b.name)));
      setV((now) => ({ ...now, source: made.name }));
    } catch (err) { setError(err.message); }
  };

  // The unit already booked by this very booking counts as free while editing it.
  const isFree = (u) => u.free || (start && u.id === start.unit_id && u.taken_by?.ref === start.ref);

  // The summary beside the form: what has been chosen so far, and what it comes to.
  const unit = units?.find((u) => String(u.id) === String(v.unit_id)) || (start && String(v.unit_id) === String(start.unit_id) ? start : null);
  const buildingName = buildings.find((b) => String(b.id) === String(buildingId))?.name || (start && String(buildingId) === String(start.building_id) ? start.building : '');
  const tenantName = tenantMode === 'existing' ? tenants.find((t) => String(t.id) === String(tenantId))?.full_name : tenant.full_name.trim();
  const sum = datesOk && Number(v.rent_amount) > 0 ? plan(v) : null;
  // What the discount takes off the rent as entered, shown under the discount as it is typed.
  const rent = Number(v.rent_amount || 0);
  const off = Math.min(rent, v.discount_type === 'percent' ? (rent * Number(v.discount_value || 0)) / 100 : Number(v.discount_value || 0));

  // One step at a time. A step is done once what it must have is filled in, and a later
  // step opens only when those before it are done.
  const filed = !!start || REQUIRED.every(([f]) => files[f]); // a booking being edited already has its documents, or shows them as missing
  const done = [!!v.unit_id, (tenantMode === 'existing' ? !!tenantId : !!tenant.full_name.trim()) && filed, v.rent_amount !== '', true];
  const reach = (i) => done.slice(0, i).every(Boolean);
  const go = (i) => { setStep(i); setFar((f) => Math.max(f, i)); };
  const ready = reach(STEPS.length);

  return (
    <form onSubmit={submit('confirmed')} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
     <div className="flex flex-col gap-5 rounded-2xl border border-stroke p-4 md:p-5">
      <ol className="flex items-center gap-2 border-b border-stroke/60 pb-4">
        {STEPS.map((name, i) => (
          <li key={name} className={`flex min-w-0 items-center gap-2 ${i < STEPS.length - 1 ? 'flex-1' : ''}`}>
            <button type="button" disabled={!reach(i)} onClick={() => go(i)} aria-current={step === i ? 'step' : undefined} title={name}
              className="flex min-w-0 items-center gap-2 rounded-full disabled:cursor-not-allowed disabled:opacity-60">
              <span className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-medium ${step === i ? 'bg-gradient-to-br from-p1 to-p2 text-white' : i <= far && done[i] ? 'bg-p1/15 text-p1' : 'border border-stroke text-mute'}`}>
                {step !== i && i <= far && done[i] ? <Check size={14} /> : i + 1}
              </span>
              <span className={`truncate text-sm ${step === i ? 'font-medium' : 'hidden text-mute md:block'}`}>{name}</span>
            </button>
            {i < STEPS.length - 1 && <span className="h-px min-w-3 flex-1 bg-stroke" />}
          </li>
        ))}
      </ol>

      {step === 0 && <Section title="Where and when">
        <Label text="Company" need>
          <Select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setBuildingId(''); setV({ ...v, unit_id: '' }); }} required className={SELECT}
            options={companies.map((c) => [c.id, c.name])} />
        </Label>
        <Label text="Building" need>
          <Select value={buildingId} onChange={(e) => { setBuildingId(e.target.value); setV({ ...v, unit_id: '' }); }} required disabled={!companyId} className={SELECT}
            placeholder={companyId ? 'Choose…' : 'Choose a company first'} options={buildings.map((b) => [b.id, b.name])} />
        </Label>
        <div>
          <span className="mb-1 block text-xs text-txt/80">Dates<span className="text-p2"> *</span><span className="text-mute"> · first night to last night</span></span>
          <DateRange from={v.start_date} to={v.end_date} onChange={(a, b) => setV((now) => ({ ...now, start_date: a, end_date: b }))}
            placeholder="Choose the first and last night" className={SELECT} wrap="w-full" />
        </div>
        <div>
          <span className="mb-1 flex items-baseline gap-2 text-xs text-txt/80">
            <span>Source<span className="text-mute"> · where the tenant came from</span></span>
            <button type="button" onClick={() => setSourcesOpen(!sourcesOpen)} className="ml-auto text-mute underline-offset-2 hover:text-txt hover:underline">{sourcesOpen ? 'Hide the list' : 'Edit the list'}</button>
          </span>
          <Select value={v.source} onChange={set('source')} onCreate={makeSource} className={SELECT} placeholder="Choose, or type a new one…" aria-label="Source"
            options={[['', 'Not known'], ...new Set([...sources.map((x) => x.name), v.source].filter(Boolean))]} />
        </div>
        {sourcesOpen && (
          <div className="rounded-2xl border border-stroke p-3 sm:col-span-2">
            <p className="mb-2 text-xs text-mute">The same list for every company and building, also kept on the Sources page. Renaming a source renames it on the leases that have it; removing one leaves those leases as they are.</p>
            <SourceList sources={sources} onChange={setSources} onError={setError}
              onRenamed={(was, now) => setV((cur) => (cur.source === was ? { ...cur, source: now } : cur))} />
          </div>
        )}
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs text-txt/80">Unit<span className="text-p2"> *</span>
            {datesOk && <span className="text-mute"> · {nights(v.start_date, v.end_date)} nights</span>}</span>
          {!buildingId || !datesOk ? <p className="rounded-xl border border-dashed border-stroke px-3.5 py-3 text-sm text-mute">Choose a building and dates to see which units are free.</p>
            : !units ? <Loader2 size={18} className="my-3 animate-spin text-mute" />
              : units.length === 0 ? <p className="text-sm text-mute">This building has no units yet.</p>
                : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {units.map((u) => {
                      const free = isFree(u);
                      const on = String(v.unit_id) === String(u.id);
                      const Bed = u.blocked ? Lock : /studio|single/i.test(u.type || '') ? BedSingle : BedDouble;
                      return (
                        <button key={u.id} type="button" disabled={!free} onClick={() => setV({ ...v, unit_id: u.id })} aria-pressed={on}
                          title={u.taken_by ? `Leased by ${u.taken_by.tenant}, ${u.taken_by.start_date} to ${u.taken_by.end_date}` : u.blocked ? 'Blocked' : ''}
                          className={`flex items-center gap-2.5 rounded-xl border bg-surface p-2.5 text-left text-sm transition ${on ? 'border-p1' : free ? 'border-stroke hover:border-p1/60' : 'cursor-not-allowed border-stroke/40 opacity-45'}`}>
                          <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${on ? 'bg-gradient-to-br from-p1 to-p2 text-white' : free ? 'bg-ok/10 text-ok' : 'bg-white/5 text-mute'}`}><Bed size={18} /></span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium">{u.unit_no}</span>
                            <span className="block truncate text-[11px] text-mute">{free ? [u.type, u.floor && `Fl ${u.floor}`].filter(Boolean).join(' · ') || 'Free' : u.blocked ? 'Blocked' : `Taken · ${u.taken_by.tenant}`}</span>
                          </span>
                          {on && <Check size={15} className="shrink-0 text-p1" />}
                        </button>
                      );
                    })}
                  </div>
                )}
        </div>
      </Section>}

      {step === 1 && <Section title="Tenant" extra={(
        <span className="ml-auto flex rounded-full border border-stroke p-0.5">
          {[['new', 'New tenant'], ['existing', 'Existing tenant']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTenantMode(k)} aria-pressed={tenantMode === k}
              className={`rounded-full px-3 py-1 text-xs ${tenantMode === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{l}</button>
          ))}
        </span>
      )}>
        {tenantMode === 'existing' ? (
          <div className="sm:col-span-2">
            <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)} required className={SELECT} placeholder="Choose a tenant…"
              options={tenants.map((t) => [t.id, [t.full_name, usPhone(t.phone), t.emirates_id_no].filter(Boolean).join(' · ')])} />
          </div>
        ) : (
          <>
            <Label text="Full name" need wide><input value={tenant.full_name} onChange={(e) => setTenant({ ...tenant, full_name: e.target.value })} required placeholder="As on the ID or passport" className={FIELD} /></Label>
            <Label text="Phone" need><PhoneField value={tenant.phone} onChange={(e) => setTenant({ ...tenant, phone: e.target.value })} required className={FIELD} /></Label>
            <Label text="Email"><input type="email" value={tenant.email} onChange={(e) => setTenant({ ...tenant, email: e.target.value })} className={FIELD} /></Label>
            <Label text="ID no."><input value={tenant.emirates_id_no} onChange={(e) => setTenant({ ...tenant, emirates_id_no: e.target.value })} className={FIELD} /></Label>
            <Label text="Nationality"><input value={tenant.nationality} onChange={(e) => setTenant({ ...tenant, nationality: e.target.value })} className={FIELD} /></Label>
          </>
        )}
        {!start && REQUIRED.map(([f, name]) => (
          <Label key={f} text={name} need>
            <span className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
              <Paperclip size={15} className="shrink-0" /> <span className={`truncate ${files[f] ? 'text-txt' : ''}`}>{files[f] ? files[f].name : 'Attach the scan (PDF or photo)'}</span>
              <input type="file" accept="application/pdf,image/*,.doc,.docx" className="hidden" onChange={(e) => e.target.files?.[0] && setFiles((now) => ({ ...now, [f]: e.target.files[0] }))} />
            </span>
          </Label>
        ))}
      </Section>}

      {step === 2 && <Section title="Rent and charges" extra={(
        <span className="ml-auto flex items-center gap-2 text-xs text-mute">Rent is
          <Pick value={v.rent_period} onPick={(k) => setV({ ...v, rent_period: k })} options={[['month', 'A month'], ['year', 'A year']]} />
        </span>
      )}>
        <Group title="Rent">
          <div className="grid gap-3 sm:grid-cols-3">
            <Label text={`Amount (${currency()})`} need><input type="number" min="0" step="any" value={v.rent_amount} onChange={set('rent_amount')} required className={FIELD} /></Label>
            <Label text="Paid">
              <Select value={v.payment_frequency} onChange={set('payment_frequency')} className={SELECT} options={FREQ} />
            </Label>
            <Label text={`Security deposit (${currency()})`}><input type="number" min="0" step="any" value={v.security_deposit} onChange={set('security_deposit')} placeholder="None" className={FIELD} /></Label>
          </div>
        </Group>
        <Group title="Discount" hint={`off the rent per ${v.rent_period}`}
          extra={<span className="ml-auto"><Pick value={v.discount_type} onPick={(k) => setV({ ...v, discount_type: k })} options={[['percent', 'Percent'], ['amount', currency()]]} /></span>}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Label text={`Discount (${v.discount_type === 'percent' ? '%' : currency()})`}>
              <input type="number" min="0" max={v.discount_type === 'percent' ? 99.99 : undefined} step="any" value={v.discount_value} onChange={set('discount_value')} placeholder="None" className={FIELD} />
            </Label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-txt/80">Reason</span>
              <input value={v.discount_note} onChange={set('discount_note')} disabled={!Number(v.discount_value)} placeholder="e.g. early payment, long stay" className={`${FIELD} disabled:opacity-50`} />
            </label>
          </div>
          {off > 0 && <p className="mt-2 text-xs text-mute">Takes {aed(off)} off, so the rent is <span className="font-medium text-txt">{aed(rent - off)}</span> a {v.rent_period}.</p>}
        </Group>
        <Group title="Other charges" hint="pet fee, parking, laundry…, once on the first day or with every rent payment">
          {v.fees.map((f, i) => {
            const put = (patch) => setV((now) => ({ ...now, fees: now.fees.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
            // Choosing a saved service fills in its usual price, which can still be changed for this booking.
            const pick = (name) => {
              const s = services.find((x) => x.name === name);
              put({ label: name, ...(s?.amount != null ? { amount: s.amount, repeats: s.repeats } : {}) });
            };
            // A new name is saved to the list there and then, so nobody has to leave the booking to add it.
            const make = async (name) => {
              try {
                const s = await api.post('/leasing/services', { name, amount: f.amount, repeats: !!f.repeats, building_id: buildingId });
                setServices((list) => [...list, s].sort((a, b) => a.name.localeCompare(b.name)));
                put({ label: s.name });
              } catch (err) { setError(err.message); }
            };
            return (
              <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                <Select value={f.label} onChange={(e) => pick(e.target.value)} onCreate={make} options={[...new Set([...services.map((s) => s.name), f.label].filter(Boolean))]}
                  placeholder="Choose, or type a new one…" aria-label="Charge" className={SELECT} wrap="min-w-[11rem] flex-1" />
                <input type="number" min="0" step="any" value={f.amount} onChange={(e) => put({ amount: e.target.value })} placeholder={currency()} aria-label="Amount" className={`${FIELD} max-w-[9rem]`} />
                <Select value={f.repeats ? 'every' : 'once'} onChange={(e) => put({ repeats: e.target.value === 'every' })} options={REPEAT} aria-label="How often" className={SELECT} wrap="w-56" />
                <button type="button" onClick={() => setV({ ...v, fees: v.fees.filter((_, j) => j !== i) })} aria-label="Remove this charge"
                  className="grid size-9 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><X size={15} /></button>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setV({ ...v, fees: [...v.fees, { label: '', amount: '' }] })} className={GHOST}><Plus size={13} /> Add a charge</button>
            <button type="button" onClick={() => setListOpen(!listOpen)} className={GHOST}><Pencil size={13} /> {listOpen ? 'Hide this building’s services' : 'Edit this building’s services'}</button>
          </div>
          {listOpen && (
            <div className="mt-3 rounded-2xl border border-stroke p-3">
              <p className="mb-2 text-xs text-mute">{buildingId ? 'This building’s extra services. The usual price fills in when one is chosen, and can still be changed on the lease.' : 'Choose the building first (step 1).'}</p>
              {buildingId && <ServiceList services={services} buildingId={buildingId} onChange={setServices} onError={setError} />}
            </div>
          )}
        </Group>
        <Group title={taxName} hint="on the rent and the other charges, never on the deposit">
          <div className="flex flex-wrap items-center gap-2">
            <Pick value={v.tax_percent === '' ? 'none' : 'taxed'} onPick={(k) => setV({ ...v, tax_percent: k === 'none' ? '' : v.tax_percent || region().tax_percent || 5 })}
              options={[['none', `No ${taxName}`], ['taxed', `Charge ${taxName}`]]} />
            {v.tax_percent !== '' && (
              <span className="flex items-center gap-2">
                <input type="number" min="0" max="100" step="any" value={v.tax_percent} onChange={set('tax_percent')} required aria-label={`${taxName} percent`} className={`${FIELD} max-w-[6rem]`} />
                <span className="text-sm text-mute">%</span>
              </span>
            )}
          </div>
        </Group>
      </Section>}

      {step === 3 && <Section title="Contract & notes">
        <Label text="Contract / Ejari no." wide><input value={v.contract_no} onChange={set('contract_no')} className={FIELD} /></Label>
        <Group title="Energy account" hint="electricity and water for this stay">
          <Pick value={v.tenant_energy_account ? 'tenant' : 'company'} onPick={(k) => setV({ ...v, tenant_energy_account: k === 'tenant' })}
            options={[['company', 'On the company’s account'], ['tenant', 'Tenant’s own account']]} />
          {v.tenant_energy_account && <p className="mt-2 text-xs text-mute">The unit’s energy account number is hidden while this tenant is in it, and shown again once the unit is vacant.</p>}
        </Group>
        <Label text="Notes" wide><textarea value={v.notes} onChange={set('notes')} rows={3} className={`${FIELD} resize-none`} /></Label>
      </Section>}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-stroke/60 pt-4">
        {step > 0 ? <button type="button" onClick={() => go(step - 1)} className="flex items-center gap-1 rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5"><ChevronLeft size={16} /> Back</button> : <span />}
        {step < STEPS.length - 1
          ? <button type="button" disabled={!done[step]} onClick={(e) => e.currentTarget.form.reportValidity() && go(step + 1)} className={PRIMARY}>Next <ChevronRight size={16} /></button>
          : <span className="text-xs text-mute">Last step · {start ? 'save' : 'confirm'} it from the summary.</span>}
      </div>
     </div>

      <aside className="space-y-4 rounded-2xl border border-stroke p-4 text-sm md:p-5">
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-mute">Summary</h2>
        <div>
          <p className={`text-lg font-medium ${unit ? '' : 'text-mute'}`}>{unit ? `Unit ${unit.unit_no}` : 'No unit chosen'}</p>
          {buildingName && <p className="text-mute">{buildingName}</p>}
        </div>
        <div className="space-y-1.5">
          <Row k="Dates">{datesOk ? `${fmt(v.start_date)} → ${fmt(v.end_date)}` : '—'}</Row>
          {datesOk && <Row k="Stay">{nights(v.start_date, v.end_date)} nights</Row>}
          <Row k="Tenant">{tenantName || '—'}</Row>
          {v.source && <Row k="Source">{v.source}</Row>}
        </div>
        {sum ? (
          <>
            <div className="space-y-1.5 border-t border-stroke/60 pt-3">
              <Row k={sum.payments > 1 ? 'First rent payment' : 'Rent'}>{aed(sum.firstRent)}</Row>
              {sum.fees.map((f, i) => <Row key={i} k={f.label || 'Other charge'}>{aed(Number(f.amount))}</Row>)}
              {sum.firstTax > 0 && <Row k={`${taxName} ${Number(v.tax_percent)}%`}>{aed(sum.firstTax)}</Row>}
              <Row k="Rent and charges" strong>{aed(sum.charges)}</Row>
              {sum.discount > 0 && <Row k="Discount, already taken off">−{aed(sum.discount)}</Row>}
              {sum.payments > 1 && <Row k={`Whole stay · ${sum.payments} payments`}>{aed(sum.total)}</Row>}
              {sum.payments > 1 && sum.tax > 0 && <Row k={`Of which ${taxName}`}>{aed(sum.tax)}</Row>}
            </div>
            {/* The deposit stands apart: it is the tenant's money, held and given back at check-out. */}
            {sum.deposit > 0 && (
              <div className="space-y-1 border-t border-stroke/60 pt-3">
                <Row k="Security deposit">{aed(sum.deposit)}</Row>
                <p className="text-xs text-mute">Held for the tenant, not income. Given back at check-out.</p>
              </div>
            )}
            <div className="border-t border-stroke/60 pt-3"><Row k="To collect on the first day" strong>{aed(sum.first)}</Row></div>
          </>
        ) : <p className="border-t border-stroke/60 pt-3 text-mute">Choose the dates and enter the rent to see what is due.</p>}

        {error && <p className="text-bad">{error}</p>}
        <div className="space-y-2 pt-1">
          {start ? <button disabled={busy || !ready} className={`${PRIMARY} w-full justify-center`}>{busy ? 'Saving…' : 'Save'}</button> : <>
            <button disabled={busy || !ready} className={`${PRIMARY} w-full justify-center`}>{busy ? 'Saving…' : 'Confirm lease'}</button>
            <button type="button" disabled={busy || !ready} onClick={submit('draft')} className="w-full rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50">Save as draft</button>
          </>}
          <button type="button" onClick={onCancel} className="w-full rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        </div>
      </aside>
    </form>
  );
}

/** Cards or a table, as this person last had that list (`name` says which list). */
function useView(name) {
  const [view, setView] = useState(() => { try { return localStorage.getItem(`${name}-view`) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } });
  return [view, (v) => { setView(v); try { localStorage.setItem(`${name}-view`, v); } catch { /* private mode: it just is not remembered */ } }];
}
/** The two buttons that choose between them. */
const ViewToggle = ({ view, onView }) => (
  <span className="flex shrink-0 rounded-full border border-stroke p-0.5">
    {[['grid', LayoutGrid, 'Grid view'], ['list', List, 'List view']].map(([k, Ico, name]) => (
      <button key={k} onClick={() => onView(k)} aria-label={name} title={name} aria-pressed={view === k}
        className={`grid size-8 place-items-center rounded-full ${view === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}><Ico size={15} /></button>
    ))}
  </span>
);
const TH = 'px-3 py-2.5 font-medium';
const HEAD = 'border-b border-stroke text-left text-[11px] uppercase tracking-wider text-mute';

/** One booking, as a card in the grid or (with `list`) as a row of the table. The same actions either way. */
/** Move a confirmed booking's end date: a longer stay, or one shorter than was booked. Payments already recorded stay. */
function ChangeEnd({ booking: b, onPay, onDone }) {
  const [end, setEnd] = useState(b.end_date);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null);
  const longer = end > b.end_date;
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { setSaved(await api.post(`/leasing/bookings/${b.id}/end`, { end_date: end })); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  if (saved) return (
    <div className="max-w-xl space-y-4 rounded-3xl border border-stroke p-5 md:p-7">
      <p className="text-sm">The stay now ends on <span className="font-medium">{fmt(saved.end_date)}</span>. The payment schedule has been changed to match.</p>
      {saved.overpaid > 0 && <p className="rounded-xl bg-warn/15 px-3.5 py-2.5 text-sm text-warn">{aed(saved.overpaid)} of rent was already paid for the time taken off. Give it back to the tenant, or keep it against what they owe. It is written in the lease’s history.</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onPay} className={GHOST}><Banknote size={13} /> See the payments</button>
        <button onClick={onDone} className={PRIMARY}><Check size={16} /> Done</button>
      </div>
    </div>
  );
  return (
    <form onSubmit={save} className="max-w-xl space-y-4 rounded-3xl border border-stroke p-5 md:p-7">
      <label className="block"><span className="mb-1 block text-xs text-txt/80">New end date (the last day of the stay)</span>
        <DateField value={end} min={b.start_date} onChange={(e) => setEnd(e.target.value)} required className={FIELD} /></label>
      <p className="text-sm text-mute">
        {end === b.end_date ? 'Pick a later date to extend the stay, or an earlier one if the stay is shorter than was leased.'
          : longer ? 'Longer: the unit must be free for the extra days, and the extra rent is added to the payments.'
            : 'Shorter: payments not yet made for the time taken off are removed. What is due for the time actually stayed is still owed, and payments already recorded are kept.'}
      </p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy || end === b.end_date} className={PRIMARY}>{busy ? 'Saving…' : longer ? 'Extend the stay' : 'Shorten the stay'}</button>
      </div>
    </form>
  );
}

function BookingCard({ b, list, fresh, onEdit, onDocs, onPay, onEnd, onRenewed, onChanged }) {
  // Added in the last day (created_at is unix seconds): marked New, so it is easy to find again.
  const isNew = b.created_at && Date.now() / 1000 - Number(b.created_at) < 86400;
  const chip = fresh ? <span className="ml-1.5 rounded-full bg-p1/20 px-1.5 py-px text-[10px] font-medium text-p1">Just added</span>
    : isNew ? <span className="ml-1.5 rounded-full bg-p1/15 px-1.5 py-px text-[10px] font-medium text-p1">New</span> : null;
  const [error, setError] = useState('');
  const act = async (fn) => { setError(''); try { await fn(); onChanged(); } catch (e) { setError(e.message); } };
  const [label, tone] = STAGE[b.stage];
  const stay = `${nights(b.start_date, b.end_date)} nights · ${b.type === 'lease' ? 'Lease' : 'Short stay'}`;
  const terms = [FREQ.find(([k]) => k === b.payment_frequency)?.[1], b.discount_type && `${b.discount_type === 'percent' ? `${b.discount_value}%` : aed(b.discount_value)} off`,
    b.tax_percent && `+ ${region().tax_name} ${b.tax_percent}%`].filter(Boolean).join(' · ');
  const rent = <>{aed(b.rent_amount)} / {b.rent_period} <span className="text-xs text-mute">· {terms}</span></>;
  // What can be done to it: [icon, name, what happens, a longer hint, whether it is the dangerous one].
  const actions = [
    [Paperclip, 'Documents', onDocs, b.docs > 0 ? `${b.docs} document${b.docs === 1 ? '' : 's'}` : ''],
    b.status !== 'draft' && [Banknote, 'Payments', onPay],
    b.status === 'confirmed' && [RefreshCw, 'Renew', async () => {
      setError('');
      try {
        // The tenant's record first, so nobody is renewed without it being seen.
        const { summary: r } = await api.get(`/leasing/tenants/${b.tenant_id}/history`);
        const record = [r.late && `${r.late} late rent payment${r.late === 1 ? '' : 's'}`, r.complaints && `${r.complaints} complaint${r.complaints === 1 ? '' : 's'} (${r.complaints_open} open)`].filter(Boolean);
        if (record.length && !confirm(`${b.tenant}'s record: ${record.join(', ')}. Renew anyway?`)) return;
        onRenewed(await api.post(`/leasing/bookings/${b.id}/renew`));
      } catch (e) { setError(e.message); }
    },
      'Draft the next lease: same unit, tenant and rent, starting the day after this one ends'],
    b.status === 'confirmed' && [CalendarDays, 'Change end date', onEnd, 'The tenant stays longer, or the stay is shorter than was leased'],
    b.status === 'draft' && [Check, 'Confirm', () => act(() => api.post(`/leasing/bookings/${b.id}/confirm`))],
    b.status !== 'cancelled' && [Pencil, 'Edit', onEdit],
    b.status === 'draft' && [Trash2, 'Delete', () => confirm('Delete this draft?') && act(() => api.del(`/leasing/bookings/${b.id}`)), '', true],
    b.status === 'confirmed' && [X, 'Cancel lease', () => { const reason = prompt('Why is this lease cancelled? (What is already due stays owed; later payments are taken off.)'); if (reason) act(() => api.post(`/leasing/bookings/${b.id}/cancel`, { reason })); }, '', true],
  ].filter(Boolean);

  if (list) return (
    <tr className={`align-top ${fresh ? 'bg-p1/10' : ''}`}>
      <td className="px-3 py-2.5">
        <p className="font-medium">{b.tenant}{chip}</p>
        <p className="text-xs text-mute">{b.ref}{b.tenant_phone && ` · ${usPhone(b.tenant_phone)}`}{b.source && ` · ${b.source}`}</p>
        {b.cancel_reason && <p className="max-w-[16rem] whitespace-normal text-xs text-bad">Cancelled: {b.cancel_reason}</p>}
        {error && <p className="max-w-[16rem] whitespace-normal text-xs text-bad">{error}</p>}
      </td>
      <td className="px-3 py-2.5"><p>Unit {b.unit_no} · {b.building}</p><p className="text-xs text-mute">{b.company}</p></td>
      <td className="px-3 py-2.5"><p>{fmt(b.start_date)} → {fmt(b.end_date)}</p><p className="text-xs text-mute">{stay}</p></td>
      <td className="px-3 py-2.5">{rent}</td>
      <td className="px-3 py-2.5"><span className={`rounded-full px-2.5 py-0.5 text-xs ${tone}`}>{label}</span></td>
      <td className="px-2 py-1.5">
        <div className="flex justify-end">
          {actions.map(([Ico, name, run, hint, danger]) => (
            <button key={name} onClick={run} aria-label={name} title={hint ? `${name}: ${hint}` : name}
              className={`relative grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 ${danger ? 'hover:text-bad' : 'hover:text-txt'}`}>
              <Ico size={15} />
              {name === 'Documents' && b.docs > 0 && <span className="absolute right-0 top-0 rounded-full bg-white/20 px-1 text-[9px] leading-[13px] text-txt">{b.docs}</span>}
            </button>
          ))}
        </div>
      </td>
    </tr>
  );

  return (
    <div className={`flex flex-col rounded-2xl border ${fresh ? 'border-p1 ring-2 ring-p1/25' : 'border-stroke'}`}>
      <div className="flex items-start gap-3 px-4 pt-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{b.tenant}{chip}</p>
          <p className="truncate text-xs text-mute">{b.ref}{b.tenant_phone && ` · ${usPhone(b.tenant_phone)}`}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${tone}`}>{label}</span>
      </div>
      <dl className="mx-4 mt-3 flex-1 divide-y divide-stroke/60 border-t border-stroke text-sm">
        {[[DoorOpen, `Unit ${b.unit_no} · ${b.building}`, b.company], [CalendarDays, `${fmt(b.start_date)} → ${fmt(b.end_date)}`, stay]].map(([Ico, main, sub]) => (
          <div key={main} className="flex gap-2.5 py-2">
            <Ico size={15} className="mt-0.5 shrink-0 text-p1/80" />
            <div className="min-w-0"><p className="truncate">{main}</p><p className="truncate text-xs text-mute">{sub}</p></div>
          </div>
        ))}
        <div className="flex justify-between gap-4 py-2">
          <span className="text-mute">Rent</span>
          <span className="text-right">{rent}</span>
        </div>
        {b.source && (
          <div className="flex justify-between gap-4 py-2">
            <span className="text-mute">Source</span>
            <span className="truncate text-right">{b.source}</span>
          </div>
        )}
        {b.cancel_reason && <p className="py-2 text-xs text-bad">Cancelled: {b.cancel_reason}</p>}
      </dl>
      {error && <p className="px-4 pb-1 text-xs text-bad">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stroke px-4 py-2.5">
        {actions.map(([Ico, name, run, hint, danger]) => (
          <button key={name} onClick={run} title={name === 'Documents' ? undefined : hint || undefined} className={`${GHOST} ${name === 'Documents' ? 'mr-auto' : ''} ${danger ? 'hover:text-bad' : ''}`}>
            <Ico size={13} /> {name}{name === 'Documents' && b.docs > 0 && <span className="rounded-full bg-white/15 px-1.5 text-[10px] text-txt">{b.docs}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function Bookings({ fresh, onEdit, onDocs, onPay, onEnd, onImport }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [view, see] = useView('bookings');
  // The order: as added, newest first (so the booking just made is at the top), or by start date as the server sends them.
  const [sort, setSort] = useState(() => { try { return localStorage.getItem('bookings-sort') === 'start' ? 'start' : 'added'; } catch { return 'added'; } });
  const order = (k) => { setSort(k); try { localStorage.setItem('bookings-sort', k); } catch { /* private mode: it just is not remembered */ } };
  const load = () => api.get(`/leasing/bookings?q=${encodeURIComponent(q)}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q]);

  // The dates keep every booking that shares a day with the range: one that began before it and
  // is still running counts. Either end can be left open.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const dated = rows && rows.filter((b) => (!to || b.start_date <= to) && (!from || b.end_date >= from));
  const staged = dated && (stage ? dated.filter((b) => b.stage === stage) : dated);
  const shown = staged && (sort === 'added' ? [...staged].sort((a, b) => b.id - a.id) : staged);
  const count = (k) => dated?.filter((b) => b.stage === k).length || 0;
  const paged = usePaged(shown, [q, stage, from, to, sort].join('|')); // cards or table, a page at a time
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label className="relative block flex-1">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by tenant, phone, unit, building, company or contract no." className={`${FIELD} pl-10`} />
        </label>
        <button onClick={onImport} title="Bring in leases from an Excel sheet (master only)" className={`${GHOST} shrink-0 py-2.5`}><Upload size={13} /> Import</button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap gap-1.5 text-xs">
          {[['', 'All', dated?.length || 0], ...['active', 'upcoming', 'draft', 'ended', 'cancelled'].map((k) => [k, STAGE[k][0], count(k)])].map(([k, l, n]) => (
            <button key={k} onClick={() => setStage(k)} className={`rounded-full px-3 py-1 ${stage === k ? 'bg-p1/20 text-p1' : 'text-mute hover:bg-white/5 hover:text-txt'}`}>{l} <span className="opacity-60">{n}</span></button>
          ))}
        </div>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={sort} onChange={(e) => order(e.target.value)} options={[['added', 'Newest added first'], ['start', 'By start date']]} aria-label="Order" className="glass rounded-xl bg-surface px-3.5 py-2 text-sm outline-none" wrap="w-48" />
          <DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} className="glass rounded-xl bg-surface px-3.5 py-2 text-sm outline-none" />
          <ViewToggle view={view} onView={see} />
        </span>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!shown ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
        : shown.length === 0 ? <p className="py-3 text-sm text-mute">{rows.length ? 'No leases match.' : 'No leases yet. Use New lease to make the first one.'}</p>
          : view === 'list' ? (
            <>
              <div className="overflow-x-auto rounded-2xl border border-stroke">
                <table className="w-full whitespace-nowrap text-sm">
                  <thead>
                    <tr className={HEAD}>{['Tenant', 'Unit', 'Dates', 'Rent', 'Status', ''].map((h) => <th key={h} className={TH}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-stroke/60">
                    {paged.rows.map((b) => <BookingCard key={b.id} list b={b} fresh={b.id === fresh} onEdit={() => onEdit(b)} onDocs={() => onDocs(b)} onPay={() => onPay(b)} onEnd={() => onEnd(b)} onRenewed={onEdit} onChanged={load} />)}
                  </tbody>
                </table>
              </div>
              <Pager {...paged.pager} />
            </>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{paged.rows.map((b) => <BookingCard key={b.id} b={b} fresh={b.id === fresh} onEdit={() => onEdit(b)} onDocs={() => onDocs(b)} onPay={() => onPay(b)} onEnd={() => onEnd(b)} onRenewed={onEdit} onChanged={load} />)}</div>
              <Pager {...paged.pager} />
            </>
          )}
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
        <Label text="Phone" need><PhoneField value={v.phone || ''} onChange={set('phone')} required className={FIELD} /></Label>
        <Label text="Email"><input type="email" value={v.email || ''} onChange={set('email')} className={FIELD} /></Label>
        <Label text="ID no."><input value={v.emirates_id_no || ''} onChange={set('emirates_id_no')} className={FIELD} /></Label>
        <Label text="ID expiry"><DateField value={v.emirates_id_expiry || ''} onChange={set('emirates_id_expiry')} className={FIELD} /></Label>
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

function Tenants({ onHistory }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [view, see] = useView('tenants');
  // The dates are when the tenant was added. Either end can be left open.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const load = () => api.get(`/leasing/tenants?q=${encodeURIComponent(q)}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q]);
  const remove = async (t) => {
    if (!confirm(`Delete ${t.full_name}?`)) return;
    try { await api.del(`/leasing/tenants/${t.id}`); load(); } catch (e) { setError(e.message); }
  };

  const added = (t) => iso(new Date(Number(t.created_at) * 1000));
  const shown = rows && rows.filter((t) => (!from || added(t) >= from) && (!to || added(t) <= to));
  const initials = (t) => t.full_name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  const tools = (t) => (
    <>
      <button onClick={() => onHistory(t)} aria-label="History" title="History: late rent, complaints, maintenance" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><History size={15} /></button>
      <button onClick={() => setEditing(t.id)} aria-label="Edit" title="Edit" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
      <button onClick={() => remove(t)} aria-label="Delete" title="Delete" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
    </>
  );
  const open = shown?.find((t) => t.id === editing);
  const paged = usePaged(shown, [q, from, to].join('|')); // cards or table, a page at a time

  return (
    <div className="space-y-4">
      <label className="relative block">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tenants by name, phone, email, ID or passport" className={`${FIELD} pl-10`} />
      </label>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-xs text-mute">{shown ? `${shown.length} tenant${shown.length === 1 ? '' : 's'} · ` : ''}Tenants are added from New lease.</p>
        <span className="ml-auto flex items-center gap-2">
          <DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} placeholder="Added any date" className="glass rounded-xl bg-surface px-3.5 py-2 text-sm outline-none" />
          <ViewToggle view={view} onView={see} />
        </span>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!shown ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
        : shown.length === 0 ? <p className="py-3 text-sm text-mute">{rows.length ? 'No tenants match.' : 'No tenants yet.'}</p>
          : view === 'list' ? (
            <>
              {open && <div className="grid"><TenantForm key={open.id} start={open} onDone={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} /></div>}
              <div className="overflow-x-auto rounded-2xl border border-stroke">
                <table className="w-full whitespace-nowrap text-sm">
                  <thead><tr className={HEAD}>{['Tenant', 'Phone', 'Email', 'ID', 'Leases', 'Added', ''].map((h) => <th key={h} className={TH}>{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-stroke/60">
                    {paged.rows.map((t) => (
                      <tr key={t.id} className={t.id === editing ? 'bg-p1/10' : ''}>
                        <td className="px-3 py-2.5"><p className="font-medium">{t.full_name}</p>{t.nationality && <p className="text-xs text-mute">{t.nationality}</p>}</td>
                        {[usPhone(t.phone), t.email, t.emirates_id_no].map((x, i) => <td key={i} className={`px-3 py-2.5 ${x ? '' : 'text-mute/50'}`}>{x || '—'}</td>)}
                        <td className="px-3 py-2.5">{t.bookings}</td>
                        <td className="px-3 py-2.5 text-mute">{fmt(added(t))}</td>
                        <td className="px-2 py-1.5"><div className="flex justify-end">{tools(t)}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager {...paged.pager} />
            </>
          ) : (
            <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {paged.rows.map((t) => (editing === t.id
                ? <TenantForm key={t.id} start={t} onDone={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
                : (
                  <div key={t.id} className="rounded-2xl border border-stroke">
                    <div className="flex items-start gap-3 px-4 pt-4">
                      <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-p1/15 text-sm font-semibold text-p1">{initials(t)}</div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{t.full_name}</p>
                        <p className="truncate text-xs text-mute">{t.bookings} lease{t.bookings === 1 ? '' : 's'}{t.nationality && ` · ${t.nationality}`}</p>
                      </div>
                      <div className="-mr-1.5 flex shrink-0">{tools(t)}</div>
                    </div>
                    <dl className="mx-4 my-3 divide-y divide-stroke/60 border-t border-stroke text-sm">
                      {[['Phone', usPhone(t.phone)], ['Email', t.email], ['ID', t.emirates_id_no], ['Added', fmt(added(t))]].map(([l, x]) => (
                        <div key={l} className="flex gap-4 py-2"><dt className="shrink-0 text-mute">{l}</dt><dd className={`min-w-0 flex-1 truncate text-right ${x ? '' : 'text-mute/50'}`}>{x || '—'}</dd></div>
                      ))}
                    </dl>
                  </div>
                )))}
            </div>
            <Pager {...paged.pager} />
            </>
          )}
    </div>
  );
}

const BAR = {
  active: 'bg-p1/70 text-white', upcoming: 'bg-p3/60 text-white', ended: 'bg-white/15 text-txt/70',
  draft: 'border border-dashed border-p1/70 bg-p1/10 text-p1',
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const VIEWS = [[1, 'Month'], [3, '3 months'], [12, 'Year']];
const DAY_MIN = { 1: 34, 3: 11, 12: 3 }; // the narrowest a day gets, in px, before the grid scrolls sideways
const UNIT_W = 112; // the unit column, which stays put while the days scroll
const UNIT_CELL = 'sticky left-0 z-10 w-28 shrink-0 border-r border-stroke/50 bg-surface px-3';
const isWeekend = (d) => d.getDay() === 5 || d.getDay() === 6; // Fri, Sat

/**
 * One building over a month, a quarter or a year: a row per unit and a bar per booking.
 * A bar opens its booking; an empty day starts a new booking of that unit from that day.
 */
function Calendar({ onEdit, onNew }) {
  const [companies, setCompanies] = useState([]);
  const [buildings, setBuildings] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [view, setView] = useState(1); // months on screen
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [units, setUnits] = useState(null);
  const [bookings, setBookings] = useState([]);
  const scroller = useRef(null);

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

  const y = month.getFullYear(), m = month.getMonth();
  const end = new Date(y, m + view, 0); // the last day on screen
  const total = Math.round((end - month) / 86400000) + 1;
  const first = iso(month);
  const last = iso(end);
  const today = iso(new Date());
  const shift = (n) => setMonth(new Date(y, m + n * view, 1));
  const index = (d) => Math.round((new Date(`${d}T00:00:00`) - month) / 86400000); // 0 = the first day on screen
  const share = (n) => `${(n / total) * 100}%`;
  const todayAt = today >= first && today <= last ? index(today) : null;
  // What the grid is cut into: days in the month view, months in the longer ones.
  const segments = view === 1
    ? Array.from({ length: total }, (_, i) => ({ start: new Date(y, m, i + 1), days: 1 }))
    : Array.from({ length: view }, (_, i) => ({ start: new Date(y, m + i, 1), days: new Date(y, m + i + 1, 0).getDate() }));
  const shown = bookings.filter((b) => b.start_date <= last && b.end_date >= first);
  const letNow = new Set(bookings.filter((b) => b.stage === 'active').map((b) => b.unit_id));
  const freeNow = (units || []).filter((u) => !u.blocked && !letNow.has(u.id)).length;
  const monthYear = (d, month) => d.toLocaleDateString('en-GB', { month, year: 'numeric' });

  // On a narrow screen the grid scrolls sideways; start it with today in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || todayAt == null) return;
    el.scrollLeft = Math.max(0, (todayAt / total) * (el.scrollWidth - UNIT_W) - (el.clientWidth - UNIT_W) / 3);
  }, [units, view, first]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-label="Company" className={SELECT} wrap="min-w-[12rem] flex-1 sm:flex-none"
          options={companies.map((c) => [c.id, c.name])} />
        <Select value={buildingId} onChange={(e) => setBuildingId(e.target.value)} aria-label="Building" className={SELECT} wrap="min-w-[12rem] flex-1 sm:flex-none"
          placeholder={buildings.length === 0 ? 'No buildings' : undefined} options={buildings.map((b) => [b.id, b.name])} />
        <div className="flex rounded-full border border-stroke p-0.5 text-xs">
          {VIEWS.map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} className={`rounded-full px-3 py-1.5 ${view === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{l}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => shift(-1)} aria-label="Earlier" className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><ChevronLeft size={18} /></button>
          <span className="min-w-[8.5rem] text-center text-sm">{view === 1 ? monthYear(month, 'long') : `${monthYear(month, 'short')} – ${monthYear(end, 'short')}`}</span>
          <button onClick={() => shift(1)} aria-label="Later" className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><ChevronRight size={18} /></button>
          <button onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }} className={GHOST}>Today</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mute">
        {units?.length > 0 && <span className="text-txt">{units.length} units · {letNow.size} let · {freeNow} free today</span>}
        {[['active', 'Active'], ['upcoming', 'Upcoming'], ['draft', 'Draft'], ['ended', 'Ended']].map(([k, l]) => (
          <span key={k} className="flex items-center gap-1.5"><span className={`h-2.5 w-5 rounded ${BAR[k]}`} />{l}</span>
        ))}
        <span className="ml-auto">Tap an empty day to lease that unit from that day</span>
      </div>

      {!buildingId ? <p className="py-3 text-sm text-mute">Choose a building.</p>
        : !units ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
          : units.length === 0 ? <p className="py-3 text-sm text-mute">This building has no units yet.</p> : (
            <div ref={scroller} className="overflow-x-auto rounded-2xl border border-stroke bg-surface">
              <div style={{ minWidth: UNIT_W + total * DAY_MIN[view] }}>
                <div className="flex border-b border-stroke text-[11px] text-mute">
                  <div className={`${UNIT_CELL} py-2`}>Unit</div>
                  <div className="flex min-w-0 flex-1">
                    {segments.map((s, i) => (view === 1 ? (
                      <div key={i} style={{ width: share(1) }}
                        className={`shrink-0 py-1 text-center ${iso(s.start) === today ? 'font-semibold text-p1' : ''} ${isWeekend(s.start) ? 'bg-white/[0.03]' : ''}`}>
                        <div>{s.start.toLocaleDateString('en-GB', { weekday: 'narrow' })}</div><div>{s.start.getDate()}</div>
                      </div>
                    ) : (
                      <div key={i} style={{ width: share(s.days) }}
                        className={`shrink-0 truncate border-l border-stroke/30 px-1.5 py-2 ${today.startsWith(iso(s.start).slice(0, 7)) ? 'font-semibold text-p1' : ''}`}>
                        {s.start.toLocaleDateString('en-GB', i === 0 || s.start.getMonth() === 0 ? { month: 'short', year: 'numeric' } : { month: 'short' })}
                      </div>
                    )))}
                  </div>
                </div>
                {units.map((u) => (
                  <div key={u.id} className="flex border-b border-stroke/50 last:border-b-0">
                    <div className={`${UNIT_CELL} truncate py-2.5 text-sm`}>
                      {u.unit_no}<span className="ml-1.5 text-[11px] text-mute">{u.blocked ? 'Blocked' : u.type}</span>
                    </div>
                    <div className="relative flex min-w-0 flex-1">
                      {segments.map((s, i) => (
                        <button key={i} style={{ width: share(s.days) }} disabled={u.blocked}
                          onClick={(e) => {
                            // In a month-wide cell, the day is where along it the tap landed.
                            const box = e.currentTarget.getBoundingClientRect();
                            const n = Math.min(s.days - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * s.days)));
                            onNew({ company_id: companyId, building_id: buildingId, unit_id: u.id, start_date: iso(new Date(s.start.getFullYear(), s.start.getMonth(), s.start.getDate() + n)) });
                          }}
                          title={u.blocked ? 'Blocked' : view === 1 ? `Lease unit ${u.unit_no} from ${iso(s.start)}` : `Lease unit ${u.unit_no}`}
                          className={`h-full shrink-0 border-l border-stroke/30 ${u.blocked ? 'cursor-not-allowed bg-white/[0.04]' : 'hover:bg-p1/10'} ${view === 1 && isWeekend(s.start) ? 'bg-white/[0.03]' : ''} ${view === 1 && iso(s.start) === today ? 'bg-p1/[0.07]' : ''}`} />
                      ))}
                      {shown.filter((b) => b.unit_id === u.id).map((b) => {
                        const from = Math.max(0, index(b.start_date));
                        const to = Math.min(total - 1, index(b.end_date));
                        return (
                          <button key={b.id} onClick={() => onEdit(b)} title={`${b.tenant} · ${fmt(b.start_date)} → ${fmt(b.end_date)} · ${b.ref}`}
                            style={{ left: `calc(${share(from)} + 2px)`, width: `max(4px, calc(${share(to - from + 1)} - 4px))` }}
                            className={`absolute inset-y-1.5 truncate rounded-md px-2 text-left text-[11px] font-medium ${BAR[b.stage]} ${b.start_date < first ? 'rounded-l-none' : ''} ${b.end_date > last ? 'rounded-r-none' : ''}`}>
                            {b.tenant}<span className="ml-1.5 font-normal opacity-75">until {fmt(b.end_date)}</span>
                          </button>
                        );
                      })}
                      {todayAt != null && <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-p1" style={{ left: share(todayAt + 0.5) }} />}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
    </div>
  );
}

// Leasing is several pages, each with its own row in the sidebar: the overview, Bookings (which
// has the buildings beside it as a second tab), Calendar, Tenants, Reports and Alerts. Which one
// is open is the app's to hold, as `tab`, so the sidebar can open any of them.
const BOOKING_TABS = [['bookings', 'Leasing'], ['buildings', 'Buildings']];

export default function LeasingPage({ tab, onTab: setTab, report, onReport, alert, onAlert, onBack }) {
  const [form, setForm] = useState(null); // { preset } for a new booking, a booking being edited, { docsOf } for its documents, { payOf } for its payments, or null
  const [key, setKey] = useState(0); // bumped after a save, so the list reloads
  const [fresh, setFresh] = useState(null); // the id of the booking just made, picked out in the list
  const close = () => { setForm(null); setKey((k) => k + 1); };
  const openBooking = (id, as) => api.get(`/leasing/bookings/${id}`).then((b) => setForm(as ? { [as]: b } : b)).catch(() => {});
  const pay = (id) => openBooking(id, 'payOf');
  // An alert opens the screen that deals with it.
  const openAlert = (a) => (a.open === 'tenants' ? setTab('tenants') : openBooking(a.booking_id, { pay: 'payOf', docs: 'docsOf' }[a.open]));

  if (form?.docsOf) {
    const b = form.docsOf;
    return (
      <Page title={`Documents · ${b.ref}`} onBack={close} action={<button onClick={close} className={PRIMARY}><Check size={16} /> Done</button>}>
        <p className="mb-4 text-sm text-mute">{b.tenant} · Unit {b.unit_no}, {b.building} · {fmt(b.start_date)} → {fmt(b.end_date)}</p>
        <BookingDocs booking={b} />
      </Page>
    );
  }

  if (form?.payOf) {
    const b = form.payOf;
    return (
      <Page title={`Payments · ${b.ref}`} onBack={close} action={<button onClick={close} className={PRIMARY}><Check size={16} /> Done</button>}>
        <p className="mb-4 text-sm text-mute">{b.tenant} · Unit {b.unit_no}, {b.building} · {fmt(b.start_date)} → {fmt(b.end_date)}</p>
        <BookingPayments booking={b} />
      </Page>
    );
  }

  if (form?.endOf) {
    const b = form.endOf;
    return (
      <Page title={`Change end date · ${b.ref}`} onBack={close}>
        <p className="mb-4 text-sm text-mute">{b.tenant} · Unit {b.unit_no}, {b.building} · {fmt(b.start_date)} → {fmt(b.end_date)}</p>
        <ChangeEnd booking={b} onPay={() => setForm({ payOf: b })} onDone={close} />
      </Page>
    );
  }

  if (form?.historyOf) return <TenantHistory tenant={form.historyOf} onBack={close} onPay={pay} />;
  if (form?.importing) return (
    <Page title="Import leases" onBack={close}>
      <ImportBookings onDone={() => { setTab('bookings'); close(); }} />
    </Page>
  );

  // A new booking goes on to its documents, so the contract and ID are attached while they are at hand.
  if (form) return (
    <Page title={form.id ? `Edit ${form.ref}` : 'New lease'} onBack={() => setForm(null)}
      action={form.id && <button onClick={() => setForm({ docsOf: form })} className={PRIMARY}><Paperclip size={16} /> Documents</button>}>
      <BookingForm start={form.id ? form : null} preset={form.preset}
        onDone={(saved) => { setTab('bookings'); if (form.id) close(); else { setFresh(saved.id); setForm({ docsOf: saved }); } }} onCancel={() => setForm(null)} />
    </Page>
  );

  // These stand alone: their own page and title, with none of Leasing's tabs.
  const add = <button onClick={() => setForm({ preset: null })} className={PRIMARY}><Plus size={16} /> New lease</button>;
  if (tab === 'bookings' || tab === 'buildings') return (
    <Page title="Leasing" onBack={onBack} action={add}>
      <div className="mb-4 flex gap-5 overflow-x-auto border-b border-stroke text-sm">
        {BOOKING_TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`-mb-px shrink-0 border-b-2 pb-2 pt-1 transition ${tab === k ? 'border-p1 text-txt' : 'border-transparent text-mute hover:text-txt'}`}>{l}</button>
        ))}
      </div>
      {tab === 'buildings' ? <LeasingBuildings key={key} />
        : <Bookings key={key} fresh={fresh} onEdit={(b) => setForm(b)} onDocs={(b) => setForm({ docsOf: b })} onPay={(b) => setForm({ payOf: b })} onEnd={(b) => setForm({ endOf: b })} onImport={() => setForm({ importing: true })} />}
    </Page>
  );
  if (tab === 'calendar') return <Page title="Calendar" onBack={onBack} action={add}><Calendar key={key} onEdit={(b) => setForm(b)} onNew={(preset) => setForm({ preset })} /></Page>;
  if (tab === 'tenants') return <Page title="Tenants" onBack={onBack}><Tenants onHistory={(t) => setForm({ historyOf: t })} /></Page>;
  if (tab === 'reports') return <Page title="Reports" onBack={onBack}><LeasingReports key={key} name={report} onName={onReport} onPay={pay} /></Page>;
  if (tab === 'alerts') return <Page title="Alerts" onBack={onBack}><LeasingAlerts key={key} rule={alert} onRule={onAlert} onOpen={openAlert} /></Page>;

  return <Page title="Overview" onBack={onBack} action={add}><LeasingOverview key={key} onPay={pay} onAlerts={(k) => { onAlert(k); setTab('alerts'); }} /></Page>;
}
