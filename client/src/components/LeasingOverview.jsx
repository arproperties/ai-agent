import { useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Banknote, BellRing, Building2, CalendarClock, CalendarDays, ChevronRight, DoorOpen, Paperclip } from 'lucide-react';
import { api } from '../lib/api';
import { money } from '../lib/region';
import Select from './Select';
import { ALERT_KINDS } from './LeasingAlerts';

// Leasing home: the one screen that says how the buildings are doing — occupancy, rent
// due against collected, who is overdue and which leases end soon.
// The figures come from /leasing/overview. A row about a tenant's rent opens that booking's payments.

const SELECT = 'glass rounded-xl bg-surface px-3.5 py-2 text-sm outline-none focus:border-p1/70';
const CARD = 'rise rounded-2xl border border-stroke p-4 md:p-5';
const PERIODS = [[1, 'This month'], [3, '3 months'], [12, '12 months']];
// Chart colours, stepped down from the theme's violet, pink and blue so they sit in the
// dark-surface lightness band and stay apart for colour-blind readers. Fixed per method.
const VIOLET = 'var(--color-chart)';
// What is due but not collected: the same violet, thinned, so a bar reads as one amount part-filled.
const DUE = 'color-mix(in srgb, var(--color-chart) 22%, transparent)';
const METHOD_COLOR = { transfer: VIOLET, cash: '#e0509a', card: '#0e9bd8' };
const HATCH = { backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 3px, color-mix(in srgb, var(--color-white) 22%, transparent) 3px 4px)' };
const UNIT = {
  occupied: ['Occupied', 'bg-chart/75'], ending: ['Ending soon', 'bg-warn/85'], overdue: ['Overdue', 'bg-bad/90'],
  vacant: ['Vacant', 'border border-dashed border-white/30'], blocked: ['Blocked', 'bg-white/10', HATCH],
};
const monthName = (ym, opts) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-GB', opts);

const aed = (n) => money(Math.round(n));
const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));
const pct = (x) => `${Math.round(x * 100)}%`;
const initials = (name) => name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
const niceMax = (v) => { const p = 10 ** Math.floor(Math.log10(v || 1)); return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((x) => x >= v); };

const Title = ({ children, hint }) => (
  <div className="mb-3 flex items-baseline justify-between gap-3">
    <h2 className="text-[11px] font-medium uppercase tracking-widest text-mute">{children}</h2>
    {hint && <span className="text-xs text-mute">{hint}</span>}
  </div>
);

function Spark({ data }) {
  const min = Math.min(...data);
  const span = Math.max(...data) - min || 1;
  const points = data.map((v, i) => `${(i / (data.length - 1)) * 100},${26 - ((v - min) / span) * 24}`).join(' ');
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-7 w-full text-p1/70" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** One headline number. `change` is against last month; `goodUp` says which direction is good news. */
function Tile({ icon: Ico, label, value, sub, change, goodUp, trend, className = '' }) {
  const Arrow = change > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className={`${CARD} ${className}`}>
      <div className="flex items-center gap-2 text-xs text-mute"><Ico size={14} className="text-p1/80" />{label}</div>
      <p className="mt-2 text-2xl font-light tracking-tight">{value}</p>
      <p className="mt-0.5 flex items-center gap-1 text-xs text-mute">
        {change === 0 ? 'No change' : change ? <span className={`flex items-center ${(change > 0) === goodUp ? 'text-ok' : 'text-bad'}`}><Arrow size={13} />{sub}</span> : sub}
        {change != null && ' vs last month'}
      </p>
      {trend && <div className="mt-3"><Spark data={trend} /></div>}
    </div>
  );
}

function Ring({ value }) {
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <div className="relative size-36 shrink-0">
      <svg viewBox="0 0 120 120" className="size-full -rotate-90">
        <circle cx="60" cy="60" r={R} fill="none" style={{ stroke: 'color-mix(in srgb, var(--color-white) 8%, transparent)' }} strokeWidth="10" />
        <circle cx="60" cy="60" r={R} fill="none" stroke={VIOLET} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - value)} className="transition-[stroke-dashoffset] duration-700" />
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center">
        <p className="text-3xl font-light tracking-tight">{pct(value)}</p>
        <p className="text-[11px] text-mute">occupied</p>
      </div>
    </div>
  );
}

/** Twelve months of rent: each bar is what was due, filled as far as what was collected.
    Point at a month, or tap it, for the figures. */
function CollectionChart({ rows }) {
  const [hot, setHot] = useState(null);
  const max = niceMax(Math.max(...rows.map((r) => r.due)));
  const m = hot != null && rows[hot];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mute">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: VIOLET }} />Collected</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: DUE }} />Still due</span>
        <span className="ml-auto min-h-[1.25rem] text-right text-txt/90">
          {m && <>{m.full} · {aed(m.collected)} of {aed(m.due)}{m.due > 0 && <span className="text-mute"> ({pct(m.collected / m.due)})</span>}</>}
        </span>
      </div>
      <div className="grid flex-1 grid-cols-[2.25rem_1fr] grid-rows-[1fr_auto] gap-x-2">
        <div className="flex flex-col justify-between text-right text-[10px] leading-none text-mute">
          {[1, 0.5, 0].map((t) => <span key={t}>{short(max * t)}</span>)}
        </div>
        <div className="relative min-h-44 xl:min-h-64" onMouseLeave={() => setHot(null)}>
          {[0, 50, 100].map((t) => <div key={t} style={{ top: `${t}%` }} className="absolute inset-x-0 border-t border-stroke/50" />)}
          <div className="absolute inset-0 flex">
            {rows.map((r, i) => (
              <button key={r.full} type="button" onMouseEnter={() => setHot(i)} onFocus={() => setHot(i)} onClick={() => setHot(i)}
                aria-label={`${r.full}: collected ${aed(r.collected)} of ${aed(r.due)} due`}
                className={`flex flex-1 justify-center rounded-t-md px-1 transition ${hot === i ? 'bg-white/[0.06]' : ''}`}>
                <span className="relative w-full max-w-8">
                  <span style={{ height: `${(r.due / max) * 100}%`, background: DUE }} className="absolute inset-x-0 bottom-0 rounded-t transition-[height] duration-500" />
                  <span style={{ height: `${(r.collected / max) * 100}%`, background: VIOLET }} className="absolute inset-x-0 bottom-0 rounded-t transition-[height] duration-500" />
                </span>
              </button>
            ))}
          </div>
        </div>
        <span />
        <div className="mt-1.5 flex text-[10px] text-mute">
          {rows.map((r, i) => <span key={r.full} className={`flex-1 text-center ${hot === i || r.inPeriod ? 'font-medium text-txt' : ''}`}>{r.label}</span>)}
        </div>
      </div>
    </div>
  );
}

/** Rows of label, bar and figure, all on one scale. */
function Bars({ rows, max, color }) {
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.label} title={`${r.label}: ${r.value}`}>
          <div className="mb-1 flex justify-between gap-3 text-sm">
            <span className="truncate">{r.label}</span>
            <span className="shrink-0">{r.value}{r.note && <span className="text-xs text-mute"> · {r.note}</span>}</span>
          </div>
          <div className="h-2 rounded-full bg-white/[0.07]">
            <div style={{ width: `${max ? (r.n / max) * 100 : 0}%`, background: color }} className="h-full rounded-full transition-[width] duration-500" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Methods({ rows }) {
  const total = rows.reduce((t, r) => t + r.amount, 0) || 1;
  return (
    <div>
      <div className="flex h-3 gap-0.5">
        {rows.map((r) => <div key={r.key} title={`${r.label}: ${aed(r.amount)}`} style={{ width: `${(r.amount / total) * 100}%`, background: METHOD_COLOR[r.key] }} className="rounded-sm transition-[width] duration-500" />)}
      </div>
      <dl className="mt-4 divide-y divide-stroke/60 text-sm">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2.5 py-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: METHOD_COLOR[r.key] }} />
            <dt className="flex-1">{r.label}</dt>
            <dd>{aed(r.amount)} <span className="text-xs text-mute">· {pct(r.amount / total)}</span></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A short list under a heading; the rest is counted, not shown. With `onPick`, a row is a button. */
function Attention({ title, hint, rows, empty, onPick, children }) {
  const shown = rows.slice(0, 5);
  return (
    <div className={CARD}>
      <Title hint={hint}>{title}</Title>
      {rows.length === 0 ? <p className="py-2 text-sm text-mute">{empty}</p> : (
        <ul className="divide-y divide-stroke/60">{shown.map((u, i) => (onPick
          ? <li key={i}><button type="button" onClick={() => onPick(u)} className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-white/[0.05]">{children(u)}</button></li>
          : <li key={i} className="flex items-center gap-3 py-2.5">{children(u)}</li>))}</ul>
      )}
      {rows.length > shown.length && <p className="pt-2 text-xs text-mute">and {rows.length - shown.length} more</p>}
    </div>
  );
}
const Who = ({ u }) => (
  <div className="min-w-0 flex-1">
    <p className="truncate text-sm">{u.tenant}</p>
    <p className="truncate text-xs text-mute">Unit {u.unit_no} · {u.building}</p>
  </div>
);

/** What needs somebody today, in one line: how many and of which kinds. It opens the Alerts page. */
function AlertBanner({ alerts, onOpen }) {
  const kinds = ALERT_KINDS.slice(1).map(([k, , , , full]) => [full.toLowerCase(), alerts.filter((a) => a.rule === k).length]).filter(([, n]) => n);
  if (!alerts.length) return null;
  return (
    <button type="button" onClick={() => onOpen('')} className="rise flex w-full items-center gap-3 rounded-2xl border border-bad/30 bg-bad/10 px-4 py-3 text-left transition hover:bg-bad/15">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-orange-400 to-red-500 text-white shadow-lg shadow-red-500/30"><BellRing size={18} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{alerts.length} alert{alerts.length === 1 ? '' : 's'} need{alerts.length === 1 ? 's' : ''} attention</span>
        <span className="block truncate text-xs text-mute">{kinds.map(([l, n]) => `${n} ${l}`).join(' · ')}</span>
      </span>
      <ChevronRight size={18} className="shrink-0 text-mute" />
    </button>
  );
}

/** One building: every unit as a square, a row per floor, coloured by what state it is in. */
function BuildingCard({ b }) {
  const [sel, setSel] = useState(null);
  return (
    <div className={CARD}>
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-p1/15 text-p1"><Building2 size={18} /></div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{b.name}</p>
          <p className="truncate text-xs text-mute">{b.area} · {b.company}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-light leading-tight">{pct(b.occupancy)}</p>
          <p className="text-[11px] text-mute">{b.vacant} vacant of {b.total}</p>
        </div>
      </div>
      <div className="mt-4 space-y-1">
        {b.floors.map((floor) => (
          <div key={floor[0].floor ?? ''} className="flex items-center gap-1">
            <span className="w-5 shrink-0 truncate text-[10px] text-mute">{floor[0].floor ?? '–'}</span>
            {floor.map((u) => {
              const [label, tone, style] = UNIT[u.status];
              return (
                <button key={u.unit_no} type="button" onClick={() => setSel(sel?.unit_no === u.unit_no ? null : u)} style={style}
                  title={`Unit ${u.unit_no} · ${label}${u.tenant ? ` · ${u.tenant}` : ''}`} aria-label={`Unit ${u.unit_no}, ${label}`}
                  className={`h-5 min-w-0 flex-1 rounded-[5px] transition hover:brightness-125 ${tone} ${sel?.unit_no === u.unit_no ? 'ring-2 ring-white/80' : ''}`} />
              );
            })}
          </div>
        ))}
      </div>
      <p className="mt-3 min-h-[2.5rem] border-t border-stroke/60 pt-2 text-xs text-mute">
        {!sel ? 'Tap a unit to see who is in it.' : (
          <>
            <span className="text-txt">Unit {sel.unit_no} · {UNIT[sel.status][0]}</span>
            {sel.tenant && ` · ${sel.tenant} · ${aed(sel.rent)} / month`}
            {sel.status === 'overdue' && ` · owes ${aed(sel.owed)}, ${sel.days_overdue} days late`}
            {sel.days_left <= 60 && ` · ends in ${sel.days_left} days (${sel.renewal})`}
            {sel.status === 'vacant' && (sel.days_vacant == null ? ' · never let' : ` · empty for ${sel.days_vacant} days`)}
          </>
        )}
      </p>
    </div>
  );
}

export default function LeasingOverview({ onPay, onAlerts }) {
  const [company, setCompany] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [months, setMonths] = useState(1);
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [allBuildings, setAllBuildings] = useState(false);
  const [alerts, setAlerts] = useState(null); // left out of the page if they cannot be had
  useEffect(() => {
    api.get(`/leasing/alerts?company_id=${company}&building_id=${buildingId}`).then((r) => setAlerts(r.alerts)).catch(() => setAlerts(null));
    api.get(`/leasing/overview?company_id=${company}&building_id=${buildingId}&months=${months}`)
      .then((r) => { setD(r); setError(''); }).catch((e) => setError(e.message));
  }, [company, buildingId, months]);

  if (!d) return <p className="py-10 text-center text-sm text-mute">{error || 'Loading…'}</p>;

  const pick = onPay && ((u) => onPay(u.booking_id));
  const periodLabel = PERIODS.find(([k]) => k === months)[1].toLowerCase();
  const rate = d.collection.due ? d.collection.collected / d.collection.due : 0;
  const t = d.trends;
  const occChange = (t.occupancy[11] - t.occupancy[10]) * 100;
  const owedChange = t.overdue[10] ? (t.overdue[11] - t.overdue[10]) / t.overdue[10] : 0;
  const vacantChange = t.vacant[11] - t.vacant[10];
  const agingMax = Math.max(...d.overdue.aging.map((a) => a.amount));
  // The emptiest buildings first: they are the ones to act on. The rest sit behind "Show all".
  const ranked = [...d.buildings].sort((a, b) => b.vacant - a.vacant);
  const listed = allBuildings ? ranked : ranked.slice(0, 5);
  const monthly = d.monthly.map((m) => ({ ...m, label: monthName(m.month, { month: 'short' }), full: monthName(m.month, { month: 'long', year: 'numeric' }) }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={company} onChange={(e) => { setCompany(e.target.value); setBuildingId(''); }} aria-label="Company" className={SELECT} wrap="min-w-0 flex-1 basis-[40%] sm:min-w-[12rem] sm:flex-none sm:basis-auto"
          options={[['', 'All companies'], ...d.filters.companies.map((c) => [c.id, c.name])]} />
        <Select value={buildingId} onChange={(e) => setBuildingId(e.target.value)} aria-label="Building" className={SELECT} wrap="min-w-0 flex-1 basis-[40%] sm:min-w-[12rem] sm:flex-none sm:basis-auto"
          options={[['', 'All buildings'], ...d.filters.buildings.filter((b) => !company || b.company_id === Number(company)).map((b) => [b.id, b.name])]} />
        <div className="flex rounded-full border border-stroke p-0.5 text-xs">
          {PERIODS.map(([k, l]) => (
            <button key={k} onClick={() => setMonths(k)} className={`rounded-full px-3 py-1.5 ${months === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{l}</button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {d.filters.buildings.length === 0 && <p className={`${CARD} text-sm text-mute`}>No buildings yet. Add companies, buildings and units under Properties and the figures appear here.</p>}

      {alerts && onAlerts && <AlertBanner alerts={alerts} onOpen={onAlerts} />}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className={`${CARD} flex flex-col xl:col-span-2`}>
          <Title hint={`${d.units.let} tenants paying`}>Rent collected · {periodLabel}</Title>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
            <p className="text-4xl font-light tracking-tight">{aed(d.collection.collected)}</p>
            <p className="pb-1 text-sm text-mute">of {aed(d.collection.due)} due · <span className="text-txt">{pct(rate)}</span></p>
          </div>
          <div className="mb-5 mt-3 h-1.5 rounded-full bg-white/[0.07]">
            <div style={{ width: `${Math.min(1, rate) * 100}%` }} className="h-full rounded-full bg-gradient-to-r from-p1 to-p2 transition-[width] duration-700" />
          </div>
          <CollectionChart rows={monthly} />
        </div>

        <div className={CARD}>
          <Title hint={`${d.units.total} units`}>Occupancy</Title>
          <div className="flex flex-wrap items-center justify-center gap-5">
            <Ring value={d.occupancy} />
            <dl className="min-w-[9rem] flex-1 space-y-1.5 text-sm">
              {Object.keys(UNIT).map((k) => (
                <div key={k} className="flex items-center gap-2.5">
                  <span className={`size-3 shrink-0 rounded-[4px] ${UNIT[k][1]}`} style={UNIT[k][2]} />
                  <dt className="flex-1 text-mute">{UNIT[k][0]}</dt><dd>{d.units[k]}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="mt-5 border-t border-stroke/60 pt-4">
            <div className={allBuildings ? 'max-h-64 overflow-y-auto pr-2' : ''}>
              <Bars max={1} color={VIOLET} rows={listed.map((b) => ({ label: b.name, n: b.occupancy, value: pct(b.occupancy), note: `${b.vacant} vacant` }))} />
            </div>
            {ranked.length > 5 && (
              <button type="button" onClick={() => setAllBuildings(!allBuildings)} className="mt-3 text-xs text-p1 hover:underline">
                {allBuildings ? 'Show fewer' : `Show all ${ranked.length} buildings`}
              </button>
            )}
          </div>
          <p className="mt-4 text-xs text-mute">Ending soon and overdue units count as occupied. Blocked units are left out.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Tile icon={Banknote} label="Overdue rent" value={aed(d.overdue.total)} trend={t.overdue}
          change={owedChange} goodUp={false} sub={pct(Math.abs(owedChange))} />
        <Tile icon={DoorOpen} label="Vacant units" value={d.units.vacant} trend={t.vacant}
          change={vacantChange} goodUp={false} sub={Math.abs(vacantChange)} />
        <Tile icon={Building2} label="Occupancy" value={pct(d.occupancy)} trend={t.occupancy}
          change={Number(occChange.toFixed(1))} goodUp sub={`${Math.abs(occChange).toFixed(1)} pts`} />
        <Tile icon={CalendarClock} label="Leases ending in 60 days" value={d.ending.length} sub="to renew or let again" />
        <Tile icon={Paperclip} label="Missing contracts" value={d.missingContracts} sub="confirmed, no contract on file" className="col-span-2 lg:col-span-1" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Attention title="Overdue" hint={`${d.overdue.rows.length} tenants`} rows={d.overdue.rows} empty="Nobody is overdue." onPick={pick}>
          {(u) => (
            <>
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-bad/15 text-xs font-semibold text-bad">{initials(u.tenant)}</div>
              <Who u={u} />
              <div className="shrink-0 text-right">
                <p className="text-sm">{aed(u.owed)}</p>
                <p className={`text-xs ${u.days_overdue > 30 ? 'text-bad' : 'text-warn'}`}>{u.days_overdue} days late</p>
              </div>
            </>
          )}
        </Attention>
        <Attention title="Due this week" hint={aed(d.dueSoon.reduce((s, u) => s + u.rent, 0))} rows={d.dueSoon} empty="Nothing is due this week." onPick={pick}>
          {(u) => (
            <>
              <div className="grid size-9 shrink-0 place-content-center rounded-lg bg-white/[0.07] text-center leading-none">
                <span className="text-[9px] uppercase text-mute">{new Date(`${u.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' })}</span>
                <span className="text-sm">{Number(u.date.slice(8))}</span>
              </div>
              <Who u={u} />
              <div className="shrink-0 text-right">
                <p className="text-sm">{aed(u.rent)}</p>
                <p className="text-xs text-mute">{u.due_in === 0 ? 'Today' : u.due_in === 1 ? 'Tomorrow' : `In ${u.due_in} days`}</p>
              </div>
            </>
          )}
        </Attention>
        <Attention title="Leases ending" hint="next 60 days" rows={d.ending} empty="No lease ends in the next 60 days.">
          {(u) => (
            <>
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-warn/15 text-warn"><CalendarDays size={16} /></div>
              <Who u={u} />
              <div className="shrink-0 text-right">
                <p className="text-sm">{u.days_left} days</p>
                <p className="text-xs text-mute">{u.renewal}</p>
              </div>
            </>
          )}
        </Attention>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className={CARD}>
          <Title hint={aed(d.overdue.total)}>Overdue by age</Title>
          <Bars max={agingMax} color="#fb7185" rows={d.overdue.aging.map((a) => ({ label: a.label, n: a.amount, value: aed(a.amount), note: `${a.count} tenant${a.count === 1 ? '' : 's'}` }))} />
        </div>
        <div className={CARD}>
          <Title hint={periodLabel}>Collected by method</Title>
          <Methods rows={d.methods} />
        </div>
      </div>

    </div>
  );
}

/** The Buildings section: every building as a card of its units, for one company or all of them. */
export function LeasingBuildings() {
  const [company, setCompany] = useState('');
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/leasing/overview?company_id=${company}&building_id=&months=1`)
      .then((r) => { setD(r); setError(''); }).catch((e) => setError(e.message));
  }, [company]);

  if (!d) return <p className="py-10 text-center text-sm text-mute">{error || 'Loading…'}</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company" className={SELECT} wrap="min-w-0 flex-1 sm:min-w-[12rem] sm:flex-none"
          options={[['', 'All companies'], ...d.filters.companies.map((c) => [c.id, c.name])]} />
        <div className="ml-auto flex flex-wrap gap-x-3 gap-y-1 text-xs text-mute">
          {Object.entries(UNIT).map(([k, [label, tone, style]]) => (
            <span key={k} className="flex items-center gap-1.5"><span className={`size-3 rounded-[4px] ${tone}`} style={style} />{label}</span>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {d.buildings.length === 0 && <p className={`${CARD} text-sm text-mute`}>No buildings yet. Add companies, buildings and units under Properties and they appear here.</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{d.buildings.map((b) => <BuildingCard key={b.id} b={b} />)}</div>
    </div>
  );
}
