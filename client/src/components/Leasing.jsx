import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, Search, CalendarDays, DoorOpen, Check, X, ChevronLeft, ChevronRight, Paperclip, Banknote, RefreshCw, LayoutGrid, List, BedDouble, BedSingle, Lock, History, ClipboardCheck, LogIn, Wrench, Upload } from 'lucide-react';
import { canDo } from '../lib/actions';
import { api } from '../lib/api';
import { can } from '../lib/modules';
import { money as aed, currency, region } from '../lib/region';
import { usDate as fmt, usPhone } from '../lib/usFormat';
import Page from './Page';
import Select from './Select';
import DateRange from './DateRange';
import DateField from './DateField';
import PhoneField from './PhoneField';
import IdField from './IdField';
import Pager, { usePaged } from './Pager';
import BookingDocs, { REQUIRED } from './BookingDocs';
import ServiceList from './ServiceList';
import SourceList from './SourceList';
import BookingPayments from './BookingPayments';
import LeasingOverview from './LeasingOverview';
import LeasingReports from './LeasingReports';
import LeasingAlerts from './LeasingAlerts';
import Documents from './Documents';
import TenantHistory from './TenantHistory';
import TenantImport from './TenantImport';
import LeaseImport from './LeaseImport';
import Inspections from './Inspections';
import WorkOrders from './WorkOrders';
import Prospects from './Prospects';
import Archive, { ArchiveSheet, archiveLine } from './Archive';
import { leasePreset } from '../lib/prospects';

const Building3D = lazy(() => import('./Building3D')); // it brings a 3D library with it, fetched only when the 3D View is opened

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
// Rent Manager's ticks on a lease, as server/leasing.js TICKS has them, with what each does here.
const TICKS = [
  ['no_late_fees', 'Don’t charge late fees', 'No automatic late fee on this lease'],
  ['no_checks', 'Don’t accept checks', 'Kept for the record: the app takes no checks'],
  ['no_partial_payments', 'Don’t accept partial payments', 'A payment must cover all that is due by its date'],
  ['no_payments', 'Don’t accept payments', 'No payment can be recorded on this lease'],
  ['no_twa', 'Don’t allow TWA payments', 'Kept for the record'],
  ['no_emails', 'Don’t email the tenant', 'No automatic reminder or late fee email on this lease'],
];

const nights = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000) + 1;

// The usual lease lengths, and the last night of one that starts on `start` (YYYY-MM-DD):
// a year from 01/01 ends on 12/31. A start on the 31st into a shorter month ends on its last day.
const LENGTHS = [['1 month', 1], ['3 months', 3], ['6 months', 6], ['1 year', 12], ['2 years', 24]];
function lastNight(start, months) {
  const [y, m, d] = start.split('-').map(Number);
  const to = new Date(y, m - 1 + months, 1);
  const end = new Date(to.getFullYear(), to.getMonth(), Math.min(d, new Date(to.getFullYear(), to.getMonth() + 1, 0).getDate()) - 1);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
}

// Where a tenant came from, in a few words: "Referral · by Jane Doe".
const fromWhere = (source, referrer) => [source, referrer && `by ${referrer}`].filter(Boolean).join(' · ');

function Label({ text, need, children, wide }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-xs text-txt/80">{text}{need && <span className="text-p2"> *</span>}</span>
      {children}
    </label>
  );
}
const AUTHORITIES = ['Beaumont', 'Port Arthur', 'Orange', 'Legacy', 'Detcog', 'Louisiana']; // the housing authorities; Louisiana has a line of its own typed under it
/** Whether a tenant's rent is paid in part by a housing authority, and which one. `t` is the tenant, `onChange` gets it back changed. */
function Housing({ t, onChange }) {
  return (
    <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
      <label className="flex items-center gap-2 self-end py-2.5 text-sm">
        <input type="checkbox" checked={!!t.housing} onChange={(e) => onChange({ ...t, housing: e.target.checked, ...(e.target.checked ? {} : { housing_authority: '', housing_detail: '' }) })} className="size-4 accent-p1" />
        Housing tenant
      </label>
      {t.housing && (
        // Louisiana's typed line sits beside the list, in the same row.
        <div className={`grid gap-3 ${t.housing_authority === 'Louisiana' ? 'grid-cols-2' : ''}`}>
          <Label text="Housing authority" need>
            <Select value={t.housing_authority || ''} onChange={(e) => onChange({ ...t, housing_authority: e.target.value, housing_detail: e.target.value === 'Louisiana' ? t.housing_detail : '' })}
              required className={SELECT} placeholder="Choose…" aria-label="Housing authority"
              options={[...new Set([...AUTHORITIES, t.housing_authority].filter(Boolean))]} />
          </Label>
          {t.housing_authority === 'Louisiana' && (
            <Label text="Which one" need>
              <input value={t.housing_detail || ''} onChange={(e) => onChange({ ...t, housing_detail: e.target.value })} required className={FIELD} />
            </Label>
          )}
        </div>
      )}
    </div>
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
const dayNo = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const daysIn = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)).getUTCDate();
const lastOfMonth = (s) => `${s.slice(0, 8)}${String(daysIn(s)).padStart(2, '0')}`;
const firstOfNext = (s) => new Date((dayNo(lastOfMonth(s)) + 1) * 86400000).toISOString().slice(0, 10);
/** A prorated lease's rent rows, as proratedSchedule() makes them on the server: the part first month
    (`head`, in days of its month), then each 1st, with `share` the months each row bills. */
function proratedRows(v) {
  const part = (from, to) => (dayNo(to) - dayNo(from) + 1) / daysIn(from);
  const headEnd = v.end_date < lastOfMonth(v.start_date) ? v.end_date : lastOfMonth(v.start_date);
  const head = v.start_date.endsWith('-01') ? null
    : { due: v.start_date, share: part(v.start_date, headEnd), days: dayNo(headEnd) - dayNo(v.start_date) + 1, of: daysIn(v.start_date) };
  const rows = [];
  for (let d = head ? firstOfNext(v.start_date) : v.start_date; d <= v.end_date; d = firstOfNext(d)) {
    rows.push({ due: d, share: v.end_date < lastOfMonth(d) ? part(d, v.end_date) : 1 });
  }
  if (head && v.prorate === 'second' && rows.length) rows.splice(0, 1, { due: v.start_date, share: rows[0].share }, { due: rows[0].due, share: head.share, part: true });
  else if (head) rows.unshift({ due: head.due, share: head.share, part: true });
  return { rows, head };
}
/** The part month's rent as typed (Rent Manager's own figure), or null to work it out by the day. */
const typedPart = (v) => (Number(v.part_month_amount) > 0 ? Number(v.part_month_amount) : null);
/** The days a monthly charge is billed: those of `dues` (the monthly rent days) from its start to its end, when it has them. */
const chargeDays = (f, dues) => dues.filter((d) => (!f.from || d >= f.from) && (!f.until || d <= f.until));
/** What the dated discounts take off the rent of the month billed on `due`, as offOn() on the server. */
const offOn = (v, due) => (v.discounts || []).reduce((t, d) => t + (Number(d.amount) > 0 && (!d.from || due >= d.from) && (!d.until || due <= d.until) ? Number(d.amount) : 0), 0);
function plan(v) {
  if (v.prorate && v.payment_frequency === 'monthly') return proratedPlan(v);
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
  // A monthly charge is billed each month, whatever the rent's frequency, between its own dates.
  const dues = Array.from({ length: months }, (_, k) => addMonths(v.start_date, k));
  // The dated discounts come off each month they cover.
  const offs = dues.map((d) => Math.min(monthly, offOn(v, d)));
  const dated = offs.reduce((t, o) => t + o, 0);
  // Each month's own rent: the dated rent lines it falls in, or the one rent.
  const rentOf = (d) => rentAt(v, d, monthly);
  const allRent = dues.reduce((t, d) => t + rentOf(d), 0);
  const firstRent = dues.slice(0, step).reduce((t, d) => t + rentOf(d), 0) - offs.slice(0, step).reduce((t, o) => t + o, 0);
  // A one-time charge with a later date of its own is not owed at move-in.
  const billsFirst = (f) => (f.repeats ? chargeDays(f, dues)[0] === v.start_date : !f.on || f.on <= v.start_date);
  const firstFees = fees.reduce((t, f) => t + Number(f.amount) * (billsFirst(f) ? 1 : 0), 0);
  const allFees = fees.reduce((t, f) => t + Number(f.amount) * (f.repeats ? chargeDays(f, dues).length : 1), 0);
  const firstTax = (firstRent + firstFees) * rate;
  const tax = (allRent - dated + allFees) * rate;
  return {
    payments, firstRent, deposit, fees: fees.map((f) => ({ ...f, amount: billsFirst(f) ? f.amount : 0 })), firstTax, tax, discount: (off / per) * months + dated,
    // The deposit is held for the tenant and given back, so it is never part of what the stay costs.
    charges: firstRent + firstFees + firstTax,
    first: firstRent + deposit + firstFees + firstTax,
    total: allRent - dated + allFees + tax,
  };
}
/** plan() for a lease that prorates its first month. `head` is the part month; `second`, when the part
    month is put off to the next 1st, is that bill: the 1st it falls on and the rent it asks for. */
function proratedPlan(v) {
  const { rows, head } = proratedRows(v);
  const rent = Number(v.rent_amount || 0);
  const off = Math.min(rent, v.discount_type === 'percent' ? (rent * Number(v.discount_value || 0)) / 100 : Number(v.discount_value || 0));
  const per = v.rent_period === 'year' ? 12 : 1;
  const monthly = (rent - off) / per;
  const rate = Number(v.tax_percent || 0) / 100;
  const deposit = Number(v.security_deposit || 0);
  const fees = v.fees.filter((f) => Number(f.amount) > 0);
  const shares = rows.reduce((t, r) => t + r.share, 0);
  const atStart = rows[0]?.due === v.start_date ? rows[0].share : 0;
  // A row's rent: the part month at its typed amount when one was typed, the rest by the day; a dated discount comes off by the day too.
  const offOf = (r) => Math.min(monthly, offOn(v, r.due)) * r.share;
  const rentOf = (r) => Math.max(0, (r.part && typedPart(v) ? typedPart(v) : rentAt(v, r.due, monthly) * r.share) - offOf(r));
  const allRent = rows.reduce((t, r) => t + rentOf(r), 0);
  const firstRent = rows[0]?.due === v.start_date ? rentOf(rows[0]) : 0;
  // A monthly charge is its whole price each month, the part month too, as Rent Manager bills it.
  const dues = rows.map((r) => r.due);
  const billsFirst = (f) => (f.repeats ? !!atStart && chargeDays(f, dues)[0] === v.start_date : !f.on || f.on <= v.start_date);
  const firstFees = fees.reduce((t, f) => t + Number(f.amount) * (billsFirst(f) ? 1 : 0), 0);
  const allFees = fees.reduce((t, f) => t + Number(f.amount) * (f.repeats ? chargeDays(f, dues).length : 1), 0);
  const firstTax = (firstRent + firstFees) * rate;
  const tax = (allRent + allFees) * rate;
  return {
    payments: rows.length, firstRent, deposit, fees: fees.map((f) => ({ ...f, amount: billsFirst(f) ? f.amount : 0 })), firstTax, tax,
    discount: (off / per) * shares + rows.reduce((t, r) => t + offOf(r), 0),
    head: head && (({ due }) => ({ ...head, amount: rentOf({ due, share: head.share }), typed: typedPart(v) && rentOf({ due, share: head.share, part: true }) }))(rows.find((r) => r.part) || head),
    second: head && v.prorate === 'second' && rows[1] ? { due: rows[1].due, amount: rentOf(rows[1]) } : null,
    charges: firstRent + firstFees + firstTax,
    first: firstRent + deposit + firstFees + firstTax,
    total: allRent + allFees + tax,
  };
}
/** The rent is typed as monthly charges named "Rent…", each between dates of its own (rent_lines: HUD's part
    changing during the lease), the deposit as a one-time charge named "Security deposit". rent_amount and
    rent_amount_2 stay the rent at the start and its HUD/Agency part, as everything else reads them. */
const isRent = (f) => f.repeats && /^rent\b/i.test(String(f.label || '').trim());
const isDeposit = (f) => !f.repeats && /^security deposit/i.test(String(f.label || '').trim());
const RENT_NAMES = ['Rent', 'Rent – Tenant', 'Rent – HUD/Agency'];
/** Whether a dated line is billed in the month due on `due`. */
const coversDay = (f, due) => (!f.from || due >= f.from) && (!f.until || due <= f.until);
/** A lease's rent and deposit as charge lines, ahead of its other charges, for the form. */
function chargeLines(b) {
  const r = Number(b?.rent_amount), r2 = Number(b?.rent_amount_2) || 0;
  const rent = b?.rent_lines?.length ? b.rent_lines.map(({ label, amount, from, until }) => ({ label, amount: String(amount), repeats: true, from: from || '', until: until || '' }))
    : b?.rent_amount == null || b.rent_amount === '' ? [{ label: 'Rent', amount: '', repeats: true }]
      : r2 > 0 ? [{ label: 'Rent – Tenant', amount: String(Math.round((r - r2) * 100) / 100), repeats: true }, { label: 'Rent – HUD/Agency', amount: String(r2), repeats: true }]
        : [{ label: 'Rent', amount: String(r), repeats: true }];
  const deposit = Number(b?.security_deposit) > 0 ? [{ label: 'Security deposit', amount: String(b.security_deposit), on: b.deposit_due || '' }] : [];
  return [...rent, ...(b?.fees || []), ...deposit];
}
/** The form's lines back into what the lease keeps: the dated rent lines, the rent at the start and its HUD/Agency
    part, the deposit and its day, and the other charges. */
function fromLines(v) {
  const rent = v.fees.filter(isRent);
  const deposit = v.fees.find(isDeposit);
  const typed = rent.filter((f) => f.amount !== '' && f.amount != null);
  const total = (list) => Math.round(list.reduce((t, f) => t + Number(f.amount || 0), 0) * 100) / 100;
  // The HUD/Agency part: the rent lines named for it, or else every rent line after the first (the tenant's).
  const named = rent.filter((f) => /hud|agency/i.test(f.label));
  const hud = (f) => (named.length ? named.includes(f) : rent.indexOf(f) > 0);
  // The rent at the start: the lines on the first day, or else on the first day any line starts.
  const days = [v.start_date, ...rent.map((f) => f.from).filter(Boolean).sort()].filter(Boolean);
  const at = days.find((d) => total(rent.filter((f) => coversDay(f, d))) > 0);
  const now = at ? rent.filter((f) => coversDay(f, at)) : rent;
  const second = total(now.filter(hud));
  return {
    ...v, rent_amount: typed.length ? total(now) : '', rent_amount_2: second > 0 ? second : '',
    rent_lines: typed.map((f) => ({ label: f.label, amount: f.amount, from: f.from || '', until: f.until || '', hud: hud(f) })),
    security_deposit: deposit && Number(deposit.amount) > 0 ? deposit.amount : '', deposit_due: deposit?.on || '',
    fees: v.fees.filter((f) => !isRent(f) && f !== deposit),
  };
}
/** The rent of the month due on `due`: the dated rent lines it falls in, or the one rent less its old-style discount. */
const rentAt = (v, due, flat) => (v.rent_lines?.length ? v.rent_lines.filter((f) => coversDay(f, due)).reduce((t, f) => t + Number(f.amount || 0), 0) : flat);

/** Two or three choices side by side, one of them on. */
const Pick = ({ value, onPick, options }) => (
  <span className="flex shrink-0 rounded-full border border-stroke p-0.5">
    {options.map(([k, l]) => (
      <button key={k} type="button" onClick={() => onPick(k)} aria-pressed={value === k}
        className={`rounded-full px-3 py-1.5 text-xs ${value === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{l}</button>
    ))}
  </span>
);

/** The 1st of next month (this computer's date), as YYYY-MM-DD. */
const firstOfNextMonth = () => { const t = new Date(), n = new Date(t.getFullYear(), t.getMonth() + 1, 1); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`; };

/** New booking, or editing one: a whole page, like registering a company. */
function BookingForm({ start, preset, onDone, onCancel }) {
  const init = start || preset || {}; // preset: a new booking begun from the calendar, or from a prospect (lib/prospects.js leasePreset)
  const [companies, setCompanies] = useState([]);
  const [buildings, setBuildings] = useState([]);
  const [companyId, setCompanyId] = useState(init.company_id || '');
  const [buildingId, setBuildingId] = useState(init.building_id || '');
  const [v, setV] = useState({
    start_date: init.start_date || '', end_date: init.end_date || '', unit_id: init.unit_id || '',
    rent_period: start?.rent_period || 'month', payment_frequency: start?.payment_frequency || 'monthly',
    // The rent, deposit and other charges, all as charge lines (chargeLines, fromLines).
    contract_no: start?.contract_no || '', notes: start?.notes || '', fees: chargeLines(start).map((f) => (start?.status === 'confirmed' ? { ...f, was: true } : f)), discounts: start?.discounts || [], source: start?.source || preset?.source || '',
    // Made from a prospect: the saved lease marks it leased (server/prospects.js).
    ...(!start && preset?.prospect_id ? { prospect_id: preset.prospect_id } : {}), referred_by: start?.referred_by || '', tenant_energy_account: !!start?.tenant_energy_account,
    discount_type: start?.discount_type || 'percent', discount_value: start?.discount_value ?? '', discount_note: start?.discount_note || '',
    // A new booking starts with the region's usual tax; one being edited keeps what it has. Empty is no tax.
    tax_percent: start ? start.tax_percent ?? '' : region().tax_percent || '',
    // A new lease prorates its first month and is then billed on the 1st; one being edited keeps what it has.
    prorate: start?.prorate ?? (start?.id ? null : 'first'),
    part_month_amount: start?.part_month_amount ?? '',
    // Rent Manager's General tab: the lease start is start_date; these sit beside it.
    lease_sign_date: start?.lease_sign_date || '', move_in_date: start?.move_in_date || '', notice_date: start?.notice_date || '', expected_move_out: start?.expected_move_out || '',
    // A lease moved over from Rent Manager: the 1st this app takes over billing (server/leasing.js). The tick is for new leases only.
    billed_from: start?.billed_from || '', ...(!start ? { from_rent_manager: !!preset?.from_rent_manager } : {}),
    leasing_agent: start?.leasing_agent || '', ...Object.fromEntries(TICKS.map(([k]) => [k, !!start?.[k]])),
  });
  // Whether this lease is billed on the 1st: every new one is. A lease made before that (prorate empty)
  // keeps rent on its move-in day, and the form does not offer to change it.
  const onTheFirst = !start?.id || !!start?.prorate;
  const taxName = region().tax_name;
  const [units, setUnits] = useState(null);
  const [unitQ, setUnitQ] = useState(''); // what is typed in the search box over the units
  const [tenantMode,setTenantMode] = useState(start ? 'existing' : 'new');
  const [tenants, setTenants] = useState([]);
  const [tenantId, setTenantId] = useState(start?.tenant_id || '');
  const [tenant, setTenant] = useState({ full_name: '', phone: '', email: '', emirates_id_no: '', ssn: '', housing: false, housing_authority: '', housing_detail: '', ...(!start && preset?.tenant) });
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
  const lease = fromLines(v); // the form as the lease keeps it

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

  // A draft saves itself a moment after each change: one being edited straight away, a new one once it has
  // all a draft needs (unit, tenant and their documents, dates and rent). From then on the new one is that draft.
  const [draftId, setDraftId] = useState(null);
  const [autoNote, setAutoNote] = useState(''); // 'saving', 'saved 5:24 PM', or why it could not be saved
  const lastSaved = useRef(null);
  const autoBusy = useRef(false);
  const draftRef = useRef(null); // draftId, read by a save that was waiting while the draft was made
  const [kick, setKick] = useState(0); // another round, for a change made while a save was on its way
  const autosaves = !start || start.status === 'draft';
  const bodyNow = { ...lease, ...(tenantMode === 'existing' ? { tenant_id: tenantId } : { tenant }) };
  const sent = JSON.stringify(bodyNow);
  const latest = useRef();
  latest.current = { sent, bodyNow };
  useEffect(() => {
    if (!autosaves || busy) return;
    if (lastSaved.current === null) { lastSaved.current = sent; if (start) return; } // what it opened with is already saved
    if (sent === lastSaved.current && (start || draftId)) return;
    const canMake = v.unit_id && datesOk && Number(lease.rent_amount) > 0 && (tenantMode === 'existing' ? tenantId : tenant.full_name.trim() && tenant.phone) && REQUIRED.every(([f]) => files[f]);
    if (!start && !draftId && !canMake) return;
    const timer = setTimeout(async () => {
      if (autoBusy.current) return; // the save on its way kicks off another round when it is done
      autoBusy.current = true;
      setAutoNote('saving');
      const { sent: now, bodyNow: body } = latest.current;
      const id = start?.id || draftRef.current;
      try {
        let saved;
        if (id) saved = await api.put(`/leasing/bookings/${id}`, body);
        else {
          const form = new FormData();
          form.append('booking', JSON.stringify({ ...body, status: 'draft' }));
          for (const [f] of REQUIRED) form.append(f, files[f]);
          saved = await api.upload('/leasing/bookings', form);
          draftRef.current = saved.id;
          setDraftId(saved.id);
          // The new tenant now exists: the draft keeps them, rather than making them again.
          if (tenantMode === 'new') {
            api.get('/leasing/tenants').then(setTenants).catch(() => {});
            setTenantId(saved.tenant_id);
            setTenantMode('existing');
          }
        }
        lastSaved.current = now;
        setAutoNote(`saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
      } catch (err) { lastSaved.current = now; setAutoNote(`Not saved: ${err.message}`); } finally {
        autoBusy.current = false;
        if (latest.current.sent !== now) setKick((k) => k + 1);
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [sent, files, busy, kick]);

  const submit = (status, inspect) => async (e) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const body = bodyNow;
    try {
      if (start) return onDone(await api.put(`/leasing/bookings/${start.id}`, body));
      // Saved as a draft already while it was filled in: this saves the last of it, and goes on as a new one does.
      if (draftRef.current) return onDone(await api.put(`/leasing/bookings/${draftRef.current}`, body), inspect);
      const form = new FormData();
      form.append('booking', JSON.stringify({ ...body, status }));
      for (const [f] of REQUIRED) form.append(f, files[f]);
      onDone(await api.upload('/leasing/bookings', form), inspect);
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
  // The units left once the search box has narrowed them: by number, type, floor, or who is in it.
  const unitWords = unitQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shownUnits = (units || []).filter((u) => {
    const text = [u.unit_no, u.type, u.floor && `fl ${u.floor}`, u.taken_by?.tenant, isFree(u) ? 'free' : u.blocked ? 'blocked' : 'taken'].filter(Boolean).join(' ').toLowerCase();
    return unitWords.every((w) => text.includes(w));
  });

  // The summary beside the form: what has been chosen so far, and what it comes to.
  const unit = units?.find((u) => String(u.id) === String(v.unit_id)) || (start && String(v.unit_id) === String(start.unit_id) ? start : null);
  const buildingName = buildings.find((b) => String(b.id) === String(buildingId))?.name || (start && String(buildingId) === String(start.building_id) ? start.building : '');
  const tenantName = tenantMode === 'existing' ? tenants.find((t) => String(t.id) === String(tenantId))?.full_name : tenant.full_name.trim();
  const sum = datesOk && Number(lease.rent_amount) > 0 ? plan(lease) : null;

  // One step at a time. A step is done once what it must have is filled in, and a later
  // step opens only when those before it are done.
  const filed = !!start || REQUIRED.every(([f]) => files[f]); // a booking being edited already has its documents, or shows them as missing
  const done = [!!v.unit_id, (tenantMode === 'existing' ? !!tenantId : !!tenant.full_name.trim()) && filed, Number(lease.rent_amount) > 0, true];
  const reach = (i) => done.slice(0, i).every(Boolean);
  const go = (i) => { setStep(i); setFar((f) => Math.max(f, i)); };
  const ready = reach(STEPS.length);

  return (
    <form onSubmit={submit('draft', true)} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
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
        {/* Two boxes that can be typed into or picked from a calendar; the usual lengths fill the last night from the first. */}
        <div className="grid gap-x-4 gap-y-2 sm:col-span-2 sm:grid-cols-2">
          <Label text="First night" need>
            <DateField value={v.start_date} required aria-label="First night" className={FIELD}
              onChange={(e) => { const a = e.target.value; setV((now) => ({ ...now, start_date: a, end_date: now.end_date && a && now.end_date < a ? '' : now.end_date })); }} />
          </Label>
          <Label text="Last night" need>
            <DateField value={v.end_date} required min={v.start_date || undefined} aria-label="Last night" className={FIELD}
              onChange={(e) => setV((now) => ({ ...now, end_date: e.target.value }))} />
          </Label>
          <div className="flex flex-wrap items-center gap-1.5 text-xs sm:col-span-2">
            <span className="text-mute">{v.start_date ? 'Lease length:' : 'Type or pick the first night, then a length:'}</span>
            {LENGTHS.map(([name, months]) => {
              const end = v.start_date && lastNight(v.start_date, months);
              return (
                <button key={name} type="button" disabled={!v.start_date} onClick={() => setV((now) => ({ ...now, end_date: end }))} aria-pressed={!!end && v.end_date === end}
                  className={`rounded-full border px-2.5 py-1 disabled:opacity-40 ${end && v.end_date === end ? 'border-p1 bg-p1/15 text-txt' : 'border-stroke/70 text-mute enabled:hover:bg-white/5 enabled:hover:text-txt'}`}>{name}</button>
              );
            })}
          </div>
        </div>
        <div>
          <span className="mb-1 flex items-baseline gap-2 text-xs text-txt/80">
            <span>Source<span className="text-mute"> · where the tenant came from</span></span>
            <button type="button" onClick={() => setSourcesOpen(!sourcesOpen)} className="ml-auto text-mute underline-offset-2 hover:text-txt hover:underline">{sourcesOpen ? 'Hide the list' : 'Edit the list'}</button>
          </span>
          <Select value={v.source} onChange={set('source')} onCreate={makeSource} className={SELECT} placeholder="Choose, or type a new one…" aria-label="Source"
            options={[['', 'Not known'], ...new Set([...sources.map((x) => x.name), v.source].filter(Boolean))]} />
        </div>
        <Label text="Referred by tenant · if one sent them">
          <Select value={v.referred_by} onChange={set('referred_by')} className={SELECT} placeholder="Search tenants…" aria-label="Referred by tenant"
            options={[['', 'No one'], ...tenants.filter((t) => tenantMode !== 'existing' || String(t.id) !== String(tenantId)).map((t) => [t.id, t.full_name])]} />
        </Label>
        {sourcesOpen && (
          <div className="rounded-2xl border border-stroke p-3 sm:col-span-2">
            <p className="mb-2 text-xs text-mute">The same list for every company and building, also kept on the Sources page. Renaming a source renames it on the leases that have it; removing one leaves those leases as they are.</p>
            <SourceList sources={sources} onChange={setSources} onError={setError}
              onRenamed={(was, now) => setV((cur) => (cur.source === was ? { ...cur, source: now } : cur))} />
          </div>
        )}
        {/* The first night above is the lease start, which the rent is billed from; these are as Rent Manager has them. */}
        <Label text="Lease sign date"><DateField value={v.lease_sign_date} onChange={set('lease_sign_date')} className={FIELD} /></Label>
        <Label text="Move-in date · if not the lease start"><DateField value={v.move_in_date} onChange={set('move_in_date')} min={v.start_date || undefined} className={FIELD} /></Label>
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs text-txt/80">Unit<span className="text-p2"> *</span>
            {datesOk && <span className="text-mute"> · {nights(v.start_date, v.end_date)} nights</span>}</span>
          {units?.length > 0 && (
            <div className="relative mb-2">
              <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
              <input value={unitQ} onChange={(e) => setUnitQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                placeholder="Search by unit no., type, floor or tenant" aria-label="Search units" className={`${FIELD} pl-10`} />
            </div>
          )}
          {!buildingId || !datesOk ? <p className="rounded-xl border border-dashed border-stroke px-3.5 py-3 text-sm text-mute">Choose a building and dates to see which units are free.</p>
            : !units ? <Loader2 size={18} className="my-3 animate-spin text-mute" />
              : units.length === 0 ? <p className="text-sm text-mute">This building has no units yet.</p>
                : shownUnits.length === 0 ? <p className="text-sm text-mute">No unit matches “{unitQ.trim()}”.</p>
                : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {shownUnits.map((u) => {
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
            <Label text="ID no."><IdField value={tenant.emirates_id_no} onChange={(e) => setTenant({ ...tenant, emirates_id_no: e.target.value })} className={FIELD} /></Label>
            <Label text="Social security no."><input value={tenant.ssn} onChange={(e) => setTenant({ ...tenant, ssn: e.target.value })} className={FIELD} /></Label>
            <Housing t={tenant} onChange={setTenant} />
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

      {step === 2 && <Section title="Rent and charges">
        {/* Three lists only: the monthly charges (the rent among them), those due once (the deposit among them), and the prorated part month. */}
        {/* Other charges in two lists: monthly ones, each with its own start and end, then those due once. One list
            (v.fees) holds both; `repeats` says which. */}
        {[[true, 'Recurring charges', 'billed every month between its dates · the rent too: a line named Rent (a second, Rent – HUD/Agency, for their part; a new line from the day it changes)', 'Add a monthly charge'],
          [false, 'One-time charges', 'security deposit, pet fee, application fee…, due once, on the first day or a date you choose', 'Add a one-time charge']].map(([monthly, title, hint, add]) => (
          <Group key={title} title={title} hint={hint}>
            {v.fees.map((f, i) => {
              if (!!f.repeats !== monthly) return null;
              const put = (patch) => setV((now) => ({ ...now, fees: now.fees.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
              // Choosing a saved service fills in its usual price, which can still be changed for this booking.
              const pick = (name) => {
                const s = services.find((x) => x.name === name);
                put({ label: name, ...(s?.amount != null ? { amount: s.amount } : {}) });
              };
              // A new name is saved to the list there and then, so nobody has to leave the booking to add it.
              const make = async (name) => {
                // The rent and the deposit are names of the lease's own, not services of the building.
                if (monthly ? isRent({ repeats: true, label: name }) : isDeposit({ label: name })) return put({ label: name });
                try {
                  const s = await api.post('/leasing/services', { name, amount: f.amount, repeats: monthly, building_id: buildingId });
                  setServices((list) => [...list, s].sort((a, b) => a.name.localeCompare(b.name)));
                  put({ label: s.name });
                } catch (err) { setError(err.message); }
              };
              return (
                <div key={i} className="mb-2 flex flex-wrap items-end gap-2">
                  <Select value={f.label} onChange={(e) => pick(e.target.value)} onCreate={make} options={[...new Set([...(monthly ? RENT_NAMES : ['Security deposit']), ...services.map((s) => s.name), f.label].filter(Boolean))]}
                    placeholder="Choose, or type a new one…" aria-label="Charge" className={SELECT} wrap="min-w-[11rem] flex-1" />
                  <input type="number" min="0" step="any" value={f.amount} onChange={(e) => put({ amount: e.target.value })} placeholder={currency()} aria-label="Amount" className={`${FIELD} max-w-[9rem]`} />
                  {!monthly && (
                    <label className="block w-40">
                      <span className="mb-1 block text-xs text-txt/80">Due on · empty: first day</span>
                      <DateField value={f.on || ''} onChange={(e) => put({ on: e.target.value })} aria-label="Due on" className={FIELD} />
                    </label>
                  )}
                  {monthly && (
                    <>
                      <label className="block w-40">
                        <span className="mb-1 block text-xs text-txt/80">Start date</span>
                        <DateField value={f.from || ''} onChange={(e) => put({ from: e.target.value })} max={f.until || v.end_date || undefined} aria-label="Start date" className={FIELD} />
                      </label>
                      <label className="block w-40">
                        <span className="mb-1 block text-xs text-txt/80">End date · empty: no end</span>
                        <DateField value={f.until || ''} onChange={(e) => put({ until: e.target.value })} min={f.from || v.start_date || undefined} aria-label="End date" className={FIELD} />
                      </label>
                    </>
                  )}
                  {/* A line a confirmed lease already has comes off only for those ticked Delete (the server checks it too). */}
                  {(!f.was || canDo('delete')) && <button type="button" onClick={() => setV({ ...v, fees: v.fees.filter((_, j) => j !== i) })} aria-label="Remove this charge"
                    className="mb-0.5 grid size-9 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><X size={15} /></button>}
                </div>
              );
            })}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setV({ ...v, fees: [...v.fees, monthly ? { label: '', amount: '', repeats: true, from: v.start_date || '' } : { label: '', amount: '' }] })} className={GHOST}><Plus size={13} /> {add}</button>
              {!monthly && <button type="button" onClick={() => setListOpen(!listOpen)} className={GHOST}><Pencil size={13} /> {listOpen ? 'Hide this building’s services' : 'Edit this building’s services'}</button>}
            </div>
            {!monthly && listOpen && (
              <div className="mt-3 rounded-2xl border border-stroke p-3">
                <p className="mb-2 text-xs text-mute">{buildingId ? 'This building’s extra services. The usual price fills in when one is chosen, and can still be changed on the lease.' : 'Choose the building first (step 1).'}</p>
                {buildingId && <ServiceList services={services} buildingId={buildingId} onChange={setServices} onError={setError} />}
              </div>
            )}
          </Group>
        ))}
        {/* A lease that starts after the 1st can charge its part month by the day, then rent on the 1st. */}
        {onTheFirst && v.payment_frequency === 'monthly' && v.start_date && !v.start_date.endsWith('-01') && (
          <Group title="Prorated charges" hint="the part month of a lease that starts after the 1st">
            <Pick value={v.prorate} onPick={(k) => setV({ ...v, prorate: k })}
              options={[['first', 'From the first month'], ['second', 'From the second month']]} />
            {sum?.head && v.prorate === 'first' && <p className="mt-2 text-xs text-mute">{sum.head.typed ? 'The prorated rent' : `${sum.head.days} of ${sum.head.of} days`} = <span className="font-medium text-txt">{aed(sum.head.typed || sum.head.amount)}</span>, then the rent is due on the 1st.</p>}
            {sum?.head && v.prorate === 'second' && sum.second && <p className="mt-2 text-xs text-mute">A full month's rent at move-in, then {aed(sum.head.typed || sum.head.amount)} {!sum.head.typed && `(${sum.head.days} of ${sum.head.of} days) `}on <span className="font-medium text-txt">{fmt(sum.second.due)}</span>.</p>}
            {/* Rent Manager may have charged the part month at a figure of its own: typed here, it is used as it is. */}
            <label className="mt-3 block max-w-xs">
              <span className="mb-1 block text-xs text-txt/80">Prorated rent ({currency()}) · only to use a different amount</span>
              <input type="number" min="0" step="any" value={v.part_month_amount} onChange={set('part_month_amount')}
                placeholder={sum?.head ? `Worked out: ${aed(sum.head.amount)}` : 'Worked out by the day'} className={FIELD} />
            </label>
          </Group>
        )}
      </Section>}

      {step === 3 && <Section title="Contract & notes">
        <Label text="Leasing agent"><input value={v.leasing_agent} onChange={set('leasing_agent')} placeholder="Who let the unit" className={FIELD} /></Label>
        <span className="hidden sm:block" />
        <Label text="Notice date · when the tenant gave notice"><DateField value={v.notice_date} onChange={set('notice_date')} className={FIELD} /></Label>
        <Label text="Expected move-out"><DateField value={v.expected_move_out} onChange={set('expected_move_out')} className={FIELD} /></Label>
        <Group title="Payments">
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {TICKS.map(([k, name, hint]) => (
              <label key={k} className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} className="mt-0.5 size-4 shrink-0 accent-p1" />
                <span>{name}<span className="block text-xs text-mute">{hint}</span></span>
              </label>
            ))}
          </div>
        </Group>
        {(!start || start.billed_from) && <Group title="Rent Manager">
          {!start && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={!!v.from_rent_manager} className="mt-0.5 size-4 shrink-0 accent-p1"
                onChange={(e) => setV({ ...v, from_rent_manager: e.target.checked, billed_from: e.target.checked ? v.billed_from || firstOfNextMonth() : '' })} />
              <span>Already living here — moved over from Rent Manager</span>
            </label>
          )}
          {(v.from_rent_manager || start?.billed_from) && (
            <div className="mt-3">
              <Label text="Bill in this app from"><DateField value={v.billed_from} onChange={set('billed_from')} className={FIELD} /></Label>
              <p className="mt-1 text-xs text-mute">The 1st of the month this app takes over. Rent before it was billed in Rent Manager.</p>
            </div>
          )}
        </Group>}
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
          {v.move_in_date && v.move_in_date !== v.start_date && <Row k="Move-in">{fmt(v.move_in_date)}</Row>}
          <Row k="Tenant">{tenantName || '—'}</Row>
          {(v.source || v.referred_by) && <Row k="Source">{fromWhere(v.source, tenants.find((t) => String(t.id) === String(v.referred_by))?.full_name)}</Row>}
        </div>
        {sum ? (
          <>
            <div className="space-y-1.5 border-t border-stroke/60 pt-3">
              <Row k={sum.second ? 'Rent · at move-in' : sum.head && v.prorate ? 'First month · paid at move-in' : sum.payments > 1 ? 'First rent payment' : 'Rent'}>{aed(sum.firstRent)}</Row>
              {sum.fees.filter((f) => Number(f.amount) > 0).map((f, i) => <Row key={i} k={f.label || 'Other charge'}>{aed(Number(f.amount))}</Row>)}
              {sum.firstTax > 0 && <Row k={`${taxName} ${Number(v.tax_percent)}%`}>{aed(sum.firstTax)}</Row>}
              <Row k="Rent and charges" strong>{aed(sum.charges)}</Row>
              {v.discounts.filter((d) => Number(d.amount) > 0).map((d, i) => (
                <Row key={i} k={`Discount${d.from && d.from > v.start_date ? ` from ${fmt(d.from)}` : ''}${d.until ? ` to ${fmt(d.until)}` : ''}`}>−{aed(Number(d.amount))} a month</Row>
              ))}
              {sum.discount > 0 && <Row k="Discounts, whole stay · already taken off">−{aed(sum.discount)}</Row>}
              {sum.second && <Row k={`Prorated rent · on ${fmt(sum.second.due)}`}>{aed(sum.second.amount)}</Row>}
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
        {autosaves && (
          <p className={`text-center text-xs ${autoNote.startsWith('Not saved') ? 'text-bad' : 'text-mute'}`}>
            {autoNote === 'saving' ? 'Saving the draft…' : autoNote.startsWith('saved') ? `Draft ${autoNote}` : autoNote || (start || draftId ? 'Changes save themselves as a draft.' : 'Saves itself as a draft once the rent is entered.')}
          </p>
        )}
        <div className="space-y-2 pt-1">
          {start ? <button disabled={busy || !ready || autoNote === 'saving'} className={`${PRIMARY} w-full justify-center`}>{busy ? 'Saving…' : 'Save'}</button> : <>
            <button disabled={busy || !ready || autoNote === 'saving'} className={`${PRIMARY} w-full justify-center`}>{busy ? 'Saving…' : 'Save and inspect'}</button>
            <p className="text-center text-xs text-mute">Next is the move-in inspection. The lease is confirmed after it.</p>
            <button type="button" disabled={busy || !ready || autoNote === 'saving'} onClick={submit('draft')} className="w-full rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50">Save as draft</button>
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

/** The tenant's archived Rent Manager leases in this unit: fetched only when the person opens the list. */
function PreviousLeases({ booking }) {
  const [rows, setRows] = useState(null);
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');
  const toggle = () => {
    setShown(!shown);
    if (!shown && !rows) api.get(`/leasing/bookings/${booking.id}/previous`).then(setRows).catch((e) => setError(e.message));
  };
  return (
    <div className="border-t border-stroke px-4 py-2 text-sm">
      <button onClick={toggle} aria-expanded={shown} className="flex w-full items-center gap-1.5 text-xs text-mute hover:text-txt"><History size={13} /> Previous leases (Rent Manager)</button>
      {shown && (error ? <p className="mt-1 text-xs text-bad">{error}</p> : !rows ? <Loader2 size={14} className="my-1 animate-spin text-mute" />
        : rows.length === 0 ? <p className="mt-1 text-xs text-mute">None archived for this tenant in this unit.</p>
          : <ul className="mt-1 divide-y divide-stroke/60">{rows.map((r) => <li key={r.id}><button onClick={() => setOpen(r.id)} className="w-full py-1.5 text-left text-xs hover:text-p1">{archiveLine(r)}</button></li>)}</ul>)}
      {open && <ArchiveSheet id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function BookingCard({ b, list, fresh, onEdit, onDocs, onPay, onEnd, onInspect, onWork, onRenewed, onChanged }) {
  // Added in the last day (created_at is unix seconds): marked New, so it is easy to find again.
  const isNew = b.created_at && Date.now() / 1000 - Number(b.created_at) < 86400;
  const chip = fresh ? <span className="ml-1.5 rounded-full bg-p1/20 px-1.5 py-px text-[10px] font-medium text-p1">Just added</span>
    : isNew ? <span className="ml-1.5 rounded-full bg-p1/15 px-1.5 py-px text-[10px] font-medium text-p1">New</span> : null;
  const [error, setError] = useState('');
  const act = async (fn) => { setError(''); try { await fn(); onChanged(); } catch (e) { setError(e.message); } };
  const [label, tone] = STAGE[b.stage];
  const stay = `${nights(b.start_date, b.end_date)} nights · ${b.type === 'lease' ? 'Lease' : 'Short stay'}`;
  const terms = [FREQ.find(([k]) => k === b.payment_frequency)?.[1], b.discount_type && `${b.discount_type === 'percent' ? `${b.discount_value}%` : aed(b.discount_value)} off`,
    ...(b.discounts || []).map((d) => `${aed(d.amount)} off${d.from && d.from > b.start_date ? ` from ${fmt(d.from)}` : ''}${d.until ? ` to ${fmt(d.until)}` : ''}`),
    b.tax_percent && `+ ${region().tax_name} ${b.tax_percent}%`, b.prorate && 'prorated',
    // The rent shown is the rent at the start; dated rent lines change it later (the Schedule has each month's).
    ...[...new Set((b.rent_lines || []).map((l) => l.from).filter((d) => d && d > b.start_date))].sort().map((d) => `rent changes ${fmt(d)}`)].filter(Boolean).join(' · ');
  const rent = <>{aed(b.rent_amount)} / {b.rent_period} <span className="text-xs text-mute">· {terms}</span></>;
  // A lease confirmed with no move-in (by Riley, or imported), whose tenant now has the unit: how they found it is not written down.
  const moveInDue = b.status === 'confirmed' && b.stage !== 'upcoming' && !b.renewed_from && !b.moved_in && !b.moved_out;
  const due = moveInDue && <p className="text-xs text-warn">Move-in inspection not done</p>;
  // What can be done to it: [icon, name, what happens, a longer hint, whether it is the dangerous one].
  const actions = [
    [Paperclip, 'Documents', onDocs, b.docs > 0 ? `${b.docs} document${b.docs === 1 ? '' : 's'}` : ''],
    b.status !== 'draft' && [Banknote, 'Payments', onPay],
    b.status === 'confirmed' && [RefreshCw, 'Renew', async () => {
      setError('');
      try {
        // The tenant's record first, so nobody is renewed without it being seen. The record is the Tenants
        // module's: without it there is nothing to show, and the renewal goes on.
        if (can('tenants')) {
          const { summary: r } = await api.get(`/leasing/tenants/${b.tenant_id}/history`);
          const record = [r.late && `${r.late} late rent payment${r.late === 1 ? '' : 's'}`, r.complaints && `${r.complaints} complaint${r.complaints === 1 ? '' : 's'} (${r.complaints_open} open)`].filter(Boolean);
          if (record.length && !confirm(`${b.tenant}'s record: ${record.join(', ')}. Renew anyway?`)) return;
        }
        onRenewed(await api.post(`/leasing/bookings/${b.id}/renew`));
      } catch (e) { setError(e.message); }
    },
      'Draft the next lease: same unit, tenant and rent, starting the day after this one ends'],
    b.status === 'confirmed' && [CalendarDays, 'Change end date', onEnd, 'The tenant stays longer, or the stay is shorter than was leased'],
    b.status === 'confirmed' && can('workorders') && [Wrench, 'Work orders', onWork, 'Repairs raised for this tenant during the lease'],
    // A draft is confirmed after its move-in inspection; a renewal has none to do.
    moveInDue || (b.status === 'draft' && !b.moved_in && !b.renewed_from) ? [LogIn, 'Move-in inspection', () => onInspect('move_in'), 'How the tenant finds the unit. The lease is confirmed after it']
      : [ClipboardCheck, 'Inspections', () => onInspect(), 'The unit’s condition: make-ready, move-in and move-out'],
    canDo('edit') && b.status === 'draft' && (b.moved_in || b.renewed_from) && [Check, 'Confirm', () => act(() => api.post(`/leasing/bookings/${b.id}/confirm`))],
    canDo('edit') && b.status !== 'cancelled' && [Pencil, 'Edit', onEdit],
    canDo('delete') && b.status === 'draft' && [Trash2, 'Delete', () => confirm('Delete this draft?') && act(() => api.del(`/leasing/bookings/${b.id}`)), '', true],
    canDo('edit') && b.status === 'confirmed' && [X, 'Cancel lease', () => { const reason = prompt('Why is this lease cancelled? (What is already due stays owed; later payments are taken off.)'); if (reason) act(() => api.post(`/leasing/bookings/${b.id}/cancel`, { reason })); }, '', true],
  ].filter(Boolean);

  if (list) return (
    <tr className={`align-top ${fresh ? 'bg-p1/10' : ''}`}>
      <td className="px-3 py-2.5">
        <p className="font-medium">{b.tenant}{chip}</p>
        <p className="text-xs text-mute">{b.ref}{b.tenant_phone && ` · ${usPhone(b.tenant_phone)}`}{(b.source || b.referred_by_name) && ` · ${fromWhere(b.source, b.referred_by_name)}`}</p>
        {b.cancel_reason && <p className="max-w-[16rem] whitespace-normal text-xs text-bad">Cancelled: {b.cancel_reason}</p>}
        {due}
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
        {(b.source || b.referred_by_name) && (
          <div className="flex justify-between gap-4 py-2">
            <span className="text-mute">Source</span>
            <span className="truncate text-right">{fromWhere(b.source, b.referred_by_name)}</span>
          </div>
        )}
        {/* As on Rent Manager's General tab, when they were filled in. */}
        {[['Moved in', b.move_in_date && b.move_in_date !== b.start_date && fmt(b.move_in_date)], ['Leasing agent', b.leasing_agent],
          ['Notice given', b.notice_date && `${fmt(b.notice_date)}${b.expected_move_out ? ` · out ${fmt(b.expected_move_out)}` : ''}`],
          ['Expected move-out', !b.notice_date && b.expected_move_out && fmt(b.expected_move_out)],
          ['Billed here from', b.billed_from && fmt(b.billed_from)],
          ['Deposit charged', b.deposit_due && b.deposit_due !== b.start_date && fmt(b.deposit_due)],
          ['Payments', TICKS.filter(([k]) => b[k]).map(([, name]) => name).join(' · ')]].filter(([, x]) => x).map(([k, x]) => (
          <div key={k} className="flex justify-between gap-4 py-2">
            <span className="shrink-0 text-mute">{k}</span>
            <span className={`text-right ${k === 'Payments' ? 'text-xs text-warn' : 'truncate'}`}>{x}</span>
          </div>
        ))}
        {b.cancel_reason && <p className="py-2 text-xs text-bad">Cancelled: {b.cancel_reason}</p>}
        {due && <div className="py-2">{due}</div>}
      </dl>
      {error && <p className="px-4 pb-1 text-xs text-bad">{error}</p>}
      {b.status === 'confirmed' && <PreviousLeases booking={b} />}
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

function Bookings({ fresh, onEdit, onDocs, onPay, onEnd, onInspect, onWork }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('active');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false); // the leases from Rent Manager's Rent Roll
  const [view, see] = useView('bookings');
  // The order: by unit number (101, 102 … building by building, the default), as added, newest first
  // (so the booking just made is at the top), or by start date as the server sends them.
  const [sort, setSort] = useState(() => { try { const k = localStorage.getItem('bookings-order'); return k === 'start' || k === 'added' ? k : 'unit'; } catch { return 'unit'; } });
  const order = (k) => { setSort(k); try { localStorage.setItem('bookings-order', k); } catch { /* private mode: it just is not remembered */ } };
  const load = () => api.get(`/leasing/bookings?q=${encodeURIComponent(q)}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q]);

  // The dates keep every booking that shares a day with the range: one that began before it and
  // is still running counts. Either end can be left open.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const dated = rows && rows.filter((b) => (!to || b.start_date <= to) && (!from || b.end_date >= from));
  const staged = dated && (stage ? dated.filter((b) => b.stage === stage) : dated);
  // Unit numbers compare as numbers ("101" before "1001"); one unit's leases show the latest first.
  const byUnit = (a, b) => (a.building || '').localeCompare(b.building || '') || String(a.unit_no).localeCompare(String(b.unit_no), undefined, { numeric: true }) || (b.start_date || '').localeCompare(a.start_date || '');
  const shown = staged && (sort === 'added' ? [...staged].sort((a, b) => b.id - a.id) : sort === 'unit' ? [...staged].sort(byUnit) : staged);
  const count = (k) => dated?.filter((b) => b.stage === k).length || 0;
  const paged = usePaged(shown, [q, stage, from, to, sort].join('|')); // cards or table, a page at a time
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <label className="relative block min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by tenant, phone, unit, building, company or contract no." className={`${FIELD} pl-10`} />
        </label>
        {!importing && <button onClick={() => setImporting(true)} className="flex shrink-0 items-center gap-1.5 rounded-full border border-stroke/70 px-4 py-2 text-sm text-mute hover:bg-white/5 hover:text-txt"><Upload size={16} /> Import</button>}
      </div>
      {importing && <LeaseImport onClose={() => setImporting(false)} onDone={load} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap gap-1.5 text-xs">
          {[...['active', 'upcoming', 'draft', 'ended', 'cancelled'].map((k) => [k, STAGE[k][0], count(k)]), ['', 'All', dated?.length || 0]].map(([k, l, n]) => (
            <button key={k} onClick={() => setStage(k)} className={`rounded-full px-3 py-1 ${stage === k ? 'bg-p1/20 text-p1' : 'text-mute hover:bg-white/5 hover:text-txt'}`}>{l} <span className="opacity-60">{n}</span></button>
          ))}
        </div>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={sort} onChange={(e) => order(e.target.value)} options={[['unit', 'By unit number'], ['added', 'Newest added first'], ['start', 'By start date']]} aria-label="Order" className="glass rounded-xl bg-surface px-3.5 py-2 text-sm outline-none" wrap="w-48" />
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
                    {paged.rows.map((b) => <BookingCard key={b.id} list b={b} fresh={b.id === fresh} onEdit={() => onEdit(b)} onDocs={() => onDocs(b)} onPay={() => onPay(b)} onEnd={() => onEnd(b)} onInspect={(start) => onInspect(b, start)} onWork={() => onWork(b)} onRenewed={onEdit} onChanged={load} />)}
                  </tbody>
                </table>
              </div>
              <Pager {...paged.pager} />
            </>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{paged.rows.map((b) => <BookingCard key={b.id} b={b} fresh={b.id === fresh} onEdit={() => onEdit(b)} onDocs={() => onDocs(b)} onPay={() => onPay(b)} onEnd={() => onEnd(b)} onInspect={(start) => onInspect(b, start)} onWork={() => onWork(b)} onRenewed={onEdit} onChanged={load} />)}</div>
              <Pager {...paged.pager} />
            </>
          )}
    </div>
  );
}

function TenantForm({ start, onDone, onCancel }) {
  const [v, setV] = useState({ full_name: '', phone: '', email: '', emirates_id_no: '', emirates_id_expiry: '', passport_no: '', ssn: '', housing: false, housing_authority: '', housing_detail: '', notes: '', ...start });
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    // No tenant to start from: a new one, on file with no lease yet.
    try { await (start ? api.put(`/leasing/tenants/${start.id}`, v) : api.post('/leasing/tenants', v)); onDone(); } catch (err) { setError(err.message); }
  };
  return (
    <form onSubmit={save} className="space-y-3 rounded-2xl border border-p1/40 p-4 md:col-span-2 xl:col-span-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Full name" need wide><input value={v.full_name || ''} onChange={set('full_name')} required className={FIELD} /></Label>
        <Label text="Phone" need><PhoneField value={v.phone || ''} onChange={set('phone')} required className={FIELD} /></Label>
        <Label text="Email"><input type="email" value={v.email || ''} onChange={set('email')} className={FIELD} /></Label>
        <Label text="ID no."><IdField value={v.emirates_id_no || ''} onChange={set('emirates_id_no')} className={FIELD} /></Label>
        <Label text="ID expiry"><DateField value={v.emirates_id_expiry || ''} onChange={set('emirates_id_expiry')} className={FIELD} /></Label>
        <Label text="Passport no."><input value={v.passport_no || ''} onChange={set('passport_no')} className={FIELD} /></Label>
        <Label text="Social security no."><input value={v.ssn || ''} onChange={set('ssn')} className={FIELD} /></Label>
        <Housing t={v} onChange={setV} />
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
  const [adding, setAdding] = useState(false); // a tenant with no lease yet
  const [importing, setImporting] = useState(false); // the tenant list from Rent Manager
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
      {canDo('edit') && <button onClick={() => { setAdding(false); setEditing(t.id); }} aria-label="Edit" title="Edit" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>}
      {canDo('delete') && <button onClick={() => remove(t)} aria-label="Delete" title="Delete" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>}
    </>
  );
  const open = shown?.find((t) => t.id === editing);
  const paged = usePaged(shown, [q, from, to].join('|')); // cards or table, a page at a time

  return (
    <div className="space-y-4">
      <label className="relative block">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tenants by name, phone, email, ID, notes or Rent Manager #" className={`${FIELD} pl-10`} />
      </label>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-xs text-mute">{shown ? `${shown.length} tenant${shown.length === 1 ? '' : 's'}` : ''}</p>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} placeholder="Added any date" className="glass rounded-xl bg-surface px-3.5 py-2 text-sm outline-none" />
          <ViewToggle view={view} onView={see} />
          <button onClick={() => { setEditing(null); setAdding(false); setImporting(true); }} className="flex shrink-0 items-center gap-1.5 rounded-full border border-stroke/70 px-4 py-2 text-sm text-mute hover:bg-white/5 hover:text-txt"><Upload size={16} /> Import</button>
          {canDo('add') && <button onClick={() => { setEditing(null); setImporting(false); setAdding(true); }} className={PRIMARY}><Plus size={16} /> Add tenant</button>}
        </span>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {importing && <TenantImport onClose={() => setImporting(false)} onDone={load} />}
      {adding && <div className="grid"><TenantForm onDone={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} /></div>}
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
                        <td className="px-3 py-2.5"><p className="font-medium">{t.full_name}</p>{t.housing && <p className="text-xs text-mute">Housing · {[t.housing_authority, t.housing_detail].filter(Boolean).join(' – ')}</p>}{t.old_account && <p className="text-xs text-mute">Rent Manager #{t.old_account}</p>}{t.notes && <p className="max-w-xs truncate text-xs text-mute" title={t.notes}>{t.notes}</p>}</td>
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
                        <p className="truncate text-xs text-mute">{t.bookings} lease{t.bookings === 1 ? '' : 's'}{t.housing && ` · Housing · ${[t.housing_authority, t.housing_detail].filter(Boolean).join(' – ')}`}</p>
                      </div>
                      <div className="-mr-1.5 flex shrink-0">{tools(t)}</div>
                    </div>
                    <dl className="mx-4 my-3 divide-y divide-stroke/60 border-t border-stroke text-sm">
                      {[['Phone', usPhone(t.phone)], ['Email', t.email], ['ID', t.emirates_id_no], ...(t.old_account ? [['Rent Manager #', t.old_account]] : []), ['Added', fmt(added(t))]].map(([l, x]) => (
                        <div key={l} className="flex gap-4 py-2"><dt className="shrink-0 text-mute">{l}</dt><dd className={`min-w-0 flex-1 truncate text-right ${x ? '' : 'text-mute/50'}`}>{x || '—'}</dd></div>
                      ))}
                      {/* Notes only when there are some: two lines at most, the whole of it on hover. */}
                      {t.notes && <div className="py-2"><dt className="text-mute">Notes</dt><dd className="mt-0.5 line-clamp-2 text-xs text-txt/80" title={t.notes}>{t.notes}</dd></div>}
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

/**
 * The empty units, the longest empty first, each with a way to let it. A unit that already has a
 * draft lease opens that draft instead, so it is not leased twice; one let from a later date says so.
 */
function Vacant({ onNew, onOpen }) {
  const [d, setD] = useState(null);
  const [leases, setLeases] = useState([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/leasing/overview?company_id=&building_id=&months=1').then(setD).catch((e) => setError(e.message));
    api.get('/leasing/bookings?q=').then(setLeases).catch(() => {});
  }, []);

  const companyOf = new Map((d?.filters.buildings || []).map((b) => [b.id, b.company_id]));
  const draftOf = new Map(leases.filter((b) => b.stage === 'draft').map((b) => [b.unit_id, b]));
  const nextOf = new Map();
  for (const b of leases.filter((x) => x.stage === 'upcoming').sort((a, b) => a.start_date.localeCompare(b.start_date))) if (!nextOf.has(b.unit_id)) nextOf.set(b.unit_id, b);
  const all = d && d.buildings.flatMap((b) => b.floors.flat()).filter((u) => u.status === 'vacant')
    .sort((a, b) => (b.days_vacant ?? Infinity) - (a.days_vacant ?? Infinity) || a.building.localeCompare(b.building) || String(a.unit_no).localeCompare(String(b.unit_no), undefined, { numeric: true }));
  const words = q.trim().toLowerCase();
  const shown = all && (words ? all.filter((u) => [u.unit_no, u.building, u.company, u.type, u.floor].join(' ').toLowerCase().includes(words)) : all);
  const paged = usePaged(shown, q);
  const empty = (u) => (u.days_vacant == null ? 'Never let' : `${u.days_vacant} day${u.days_vacant === 1 ? '' : 's'}`);
  const action = (u) => {
    const draft = draftOf.get(u.unit_id);
    if (draft) return <button onClick={() => onOpen(draft)} className="flex items-center gap-1.5 rounded-full border border-dashed border-p1/70 px-3 py-1.5 text-xs text-p1 hover:bg-p1/10"><Pencil size={13} /> Open draft</button>;
    return canDo('add') && <button onClick={() => onNew({ company_id: companyOf.get(u.building_id), building_id: u.building_id, unit_id: u.unit_id })} className="flex items-center gap-1.5 rounded-full bg-p1 px-3 py-1.5 text-xs text-white hover:opacity-90"><Plus size={13} /> New lease</button>;
  };

  return (
    <div className="space-y-4">
      <label className="relative block">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by unit, building, company or type" className={`${FIELD} pl-10`} />
      </label>
      {shown && <p className="text-xs text-mute">{shown.length} vacant unit{shown.length === 1 ? '' : 's'}</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      {!shown ? (!error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />)
        : shown.length === 0 ? <p className="py-3 text-sm text-mute">{all.length ? 'No vacant units match.' : 'No vacant units: every unit is let.'}</p>
          : (
            <>
              <div className="overflow-x-auto rounded-2xl border border-stroke">
                <table className="w-full whitespace-nowrap text-sm">
                  <thead><tr className={HEAD}>{['Unit', 'Building', 'Type', 'Floor', 'Empty since', 'Empty for', 'Next lease', ''].map((h) => <th key={h} className={TH}>{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-stroke/60">
                    {paged.rows.map((u) => {
                      const next = nextOf.get(u.unit_id);
                      return (
                        <tr key={u.unit_id}>
                          <td className="px-3 py-2.5 font-medium">{u.unit_no}</td>
                          <td className="px-3 py-2.5"><p>{u.building}</p><p className="text-xs text-mute">{u.company}</p></td>
                          <td className={`px-3 py-2.5 ${u.type ? '' : 'text-mute/50'}`}>{u.type || '—'}</td>
                          <td className={`px-3 py-2.5 ${u.floor ? '' : 'text-mute/50'}`}>{u.floor || '—'}</td>
                          <td className={`px-3 py-2.5 ${u.vacant_since ? '' : 'text-mute/50'}`}>{u.vacant_since ? fmt(u.vacant_since) : '—'}</td>
                          <td className="px-3 py-2.5">{empty(u)}</td>
                          <td className="px-3 py-2.5">{next ? <><p>{fmt(next.start_date)}</p><p className="text-xs text-mute">{next.tenant}</p></> : <span className="text-mute/50">—</span>}</td>
                          <td className="px-2 py-1.5"><div className="flex justify-end">{action(u)}</div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
// has the 3D View and the calendar beside it as tabs), Tenants, Reports, Alerts and Documents. Which one
// is open is the app's to hold, as `tab`, so the sidebar can open any of them.
const BOOKING_TABS = [['bookings', 'Leasing'], ['vacant', 'Vacant'], ['3d', 'Building (3D view)'], ['calendar', 'Calendar'], ['archive', 'Archive']];

// The module an alert's link leads into: the screen that deals with it.
const alertModule = (a) => ({ documents: 'documents', tenants: 'tenants', workorder: 'workorders', prospects: 'prospects' }[a.open] || 'leasing');

export default function LeasingPage({ tab, onTab: setTab, report, onReport, alert, onAlert, onBack }) {
  const [form, setForm] = useState(null); // { preset } for a new booking, a booking being edited, { docsOf } for its documents, { payOf } for its payments, or null
  const [key, setKey] = useState(0); // bumped after a save, so the list reloads
  const [fresh, setFresh] = useState(null); // the id of the booking just made, picked out in the list
  const [docOpen, setDocOpen] = useState(null); // the document an alert was about, opened on the Documents page
  const [renewalOpen, setRenewalOpen] = useState(null); // or its renewal, when one is under way
  const close = () => { setForm(null); setKey((k) => k + 1); };
  const openBooking = (id, as) => api.get(`/leasing/bookings/${id}`).then((b) => setForm(as ? { [as]: b } : b)).catch(() => {});
  // A lease is opened only by someone who has Leasing; from the other screens the way in is simply not offered.
  const pay = can('leasing') ? (id) => openBooking(id, 'payOf') : undefined;
  // An alert opens the screen that deals with it, when the person has that screen.
  const openAlert = (a) => {
    if (!can(alertModule(a))) return;
    if (a.open === 'documents') { setDocOpen(a.document_id); setRenewalOpen(a.renewal_id || null); setTab('documents'); return; }
    if (a.open === 'tenants') { setTab('tenants'); return; }
    if (a.open === 'prospects') { setTab('prospects'); return; }
    if (a.open === 'workorder') { setForm({ workOf: { openId: a.work_order_id } }); return; }
    openBooking(a.booking_id, { pay: 'payOf', docs: 'docsOf' }[a.open]);
  };

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

  if (form?.inspectOf) {
    const b = form.inspectOf;
    return <Inspections unit={{ id: b.unit_id, unit_no: b.unit_no, building: b.building }} booking={b} start={form.start} onBack={close} />;
  }
  if (form?.historyOf) return <TenantHistory key={key} tenant={form.historyOf} onBack={close} onPay={pay} onWorkOrder={(w) => setForm({ workOf: w, back: { historyOf: form.historyOf } })} />;
  // Work orders opened from somewhere else: an alert, a lease, a tenant's history. Back returns there.
  if (form?.workOf) {
    const from = form.back;
    return <WorkOrders {...form.workOf} onBack={() => (from ? (setForm(from), setKey((k) => k + 1)) : close())} />;
  }

  // A new lease is a draft, and goes on to its move-in inspection; saved as a draft only, it goes on to its documents.
  if (form) return (
    <Page title={form.id ? `Edit ${form.ref}` : 'New lease'} onBack={close}
      action={form.id && <button onClick={() => setForm({ docsOf: form })} className={PRIMARY}><Paperclip size={16} /> Documents</button>}>
      <BookingForm start={form.id ? form : null} preset={form.preset}
        onDone={(saved, inspect) => { setTab('bookings'); if (form.id) close(); else { setFresh(saved.id); setForm(inspect ? { inspectOf: saved, start: 'move_in' } : { docsOf: saved }); } }} onCancel={close} />
    </Page>
  );

  // These stand alone: their own page and title, with none of Leasing's tabs.
  const add = can('leasing') && canDo('add') && <button onClick={() => setForm({ preset: null })} className={PRIMARY}><Plus size={16} /> New lease</button>;
  if (BOOKING_TABS.some(([k]) => k === tab)) return (
    <Page title="Leasing" onBack={onBack} action={add}>
      <div className="mb-4 flex gap-5 overflow-x-auto border-b border-stroke text-sm">
        {BOOKING_TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`-mb-px shrink-0 border-b-2 pb-2 pt-1 transition ${tab === k ? 'border-p1 text-txt' : 'border-transparent text-mute hover:text-txt'}`}>{l}</button>
        ))}
      </div>
      {tab === '3d' ? (
          <Suspense fallback={<p className="flex items-center justify-center gap-2 py-10 text-sm text-mute"><Loader2 size={16} className="animate-spin" /> Loading…</p>}>
            <Building3D key={key} onPay={pay} onLease={(id) => openBooking(id)} onNew={(preset) => setForm({ preset })} onInspect={(b) => setForm({ inspectOf: b, start: 'move_in' })}
              onWork={(u) => setForm({ workOf: { scope: { unit_id: u.unit_id }, title: `Work orders · Unit ${u.unit_no}`, preset: { unit_id: u.unit_id } } })} />
          </Suspense>
        )
        : tab === 'calendar' ? <Calendar key={key} onEdit={(b) => setForm(b)} onNew={(preset) => setForm({ preset })} />
        : tab === 'archive' ? <Archive key={key} />
        : tab === 'vacant' ? <Vacant key={key} onNew={(preset) => setForm({ preset })} onOpen={(b) => setForm(b)} />
        : <Bookings key={key} fresh={fresh} onEdit={(b) => setForm(b)} onDocs={(b) => setForm({ docsOf: b })} onPay={(b) => setForm({ payOf: b })} onEnd={(b) => setForm({ endOf: b })} onInspect={(b, start) => setForm({ inspectOf: b, start })} onWork={(b) => setForm({ workOf: { scope: { booking_id: b.id }, title: `Work orders · ${b.ref}`, preset: { unit_id: b.unit_id } } })} />}
    </Page>
  );
  if (tab === 'workorders') return <WorkOrders key={key} onBack={onBack} />;
  if (tab === 'tenants') return <Page title="Tenants" onBack={onBack}><Tenants onHistory={(t) => setForm({ historyOf: t })} /></Page>;
  if (tab === 'prospects') return <Page title="Prospects" onBack={onBack}><Prospects key={key} canLease={can('leasing')} onLease={(p) => setForm({ preset: leasePreset(p) })} /></Page>;
  if (tab === 'reports') return <Page title="Reports" onBack={onBack}><LeasingReports key={key} name={report} onName={onReport} onPay={pay} /></Page>;
  if (tab === 'alerts') return <Page title="Alerts" onBack={onBack}><LeasingAlerts key={key} rule={alert} onRule={onAlert} onOpen={openAlert} canOpen={(a) => can(alertModule(a))} /></Page>;
  if (tab === 'documents') return <Page title="Documents" onBack={onBack}><Documents key={key} openId={docOpen} openRenewal={renewalOpen} onOpened={() => { setDocOpen(null); setRenewalOpen(null); }} /></Page>;

  return <Page title="Overview" onBack={onBack} action={add}><LeasingOverview key={key} onPay={pay} onAlerts={can('alerts') ? (k) => { onAlert(k); setTab('alerts'); } : undefined} /></Page>;
}
