import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2, AlertTriangle, Plus, Search, X, Check, Clock, Gavel, Scale, FileText, Paperclip, Upload, Download, Pencil,
  CircleDot, MessageSquare, UserRound, Building2, ChevronDown, Trash2, Settings2, ArrowRightLeft, Lock,
} from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Sheet from './Sheet';
import Picker from './Picker';

// Legal cases (server/legalCases.js): Alreem's legal case flow, from the case type to the
// end. The list has the dashboard's counts on top and is searched and filtered here; a
// case opens to the stage it is in, what it asks for, its documents and its timeline.
// The stages, their fields and the decisions all come from the server (flow), so the
// screen draws whatever the flow is.

const aed = (n) => (n === null || n === undefined || n === '' ? '' : `AED ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const day = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const when = (secs) => new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const ymdOf = (secs) => new Date(secs * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const daysTo = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const size = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

const CHIP = { warn: 'bg-warn/15 text-warn', p1: 'bg-p1/20 text-txt', bad: 'bg-bad/15 text-bad', ok: 'bg-ok/15 text-ok', mute: 'bg-white/10 text-mute' };
const STATUS_TONE = { open: 'p1', settled: 'ok', proceeding: 'warn', dismissed: 'bad', appealed: 'warn', paid: 'ok', closed: 'mute' };
const PRIORITY = { low: ['Low', 'mute'], normal: ['Normal', 'mute'], high: ['High', 'warn'], urgent: ['Urgent', 'bad'] };
const PERIOD = { pending: ['Pending', 'mute'], active: ['Active', 'p1'], completed: ['Completed', 'ok'], overdue: ['Overdue', 'bad'] };
const PROCEEDING_STAGES = ['proceeding_1', 'gov_registration', 'fee_voucher', 'case_status'];

const Chip = ({ c: [label, tone] }) => <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${CHIP[tone]}`}>{label}</span>;

const Btn = ({ primary, busy, children, className = '', ...p }) => (
  <button {...p} disabled={busy || p.disabled}
    className={`${primary
      ? 'bg-gradient-to-br from-p1 to-p2 font-medium text-white shadow-lg shadow-p1/25'
      : 'border border-stroke text-mute hover:text-txt'} flex items-center gap-1.5 rounded-full px-4 py-2 text-sm transition active:scale-[0.98] disabled:opacity-40 ${className}`}>
    {busy && <Loader2 size={14} className="animate-spin" />} {children}
  </button>
);

const Problem = ({ text }) => (text ? <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {text}</p> : null);

const BOX = 'w-full rounded-2xl border border-stroke bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-p1/60';

/** One field of a stage or of the case, drawn by its type. */
function Field({ f, value, onChange, disabled }) {
  const v = value ?? '';
  return (
    <label className={`block space-y-1.5 text-sm ${f.type === 'long' ? 'sm:col-span-2' : ''}`}>
      <span>{f.label}{f.required && <span className="text-bad"> *</span>}</span>
      {f.type === 'long' ? (
        <textarea value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} rows={3} className={`${BOX} resize-y`} />
      ) : f.type === 'date' ? (
        <input type="date" value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={`${BOX}`} />
      ) : (
        <input value={v} disabled={disabled} inputMode={f.type === 'money' ? 'decimal' : undefined}
          onChange={(e) => onChange(f.type === 'money' ? e.target.value.replace(/[^\d.,]/g, '') : e.target.value)} className={BOX} />
      )}
    </label>
  );
}

// ---------- the list ----------

export default function LegalCasesPage({ onBack, open: openFirst }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(openFirst || null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tile, setTile] = useState('active');
  const [q, setQ] = useState('');
  const [f, setF] = useState({ type: '', stage: '', status: '', assigned: '', priority: '', from: '', to: '' });
  const [moreFilters, setMoreFilters] = useState(false);

  const load = useCallback(() => api.get('/legal-cases').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (open) return <CaseView id={open} meta={data} onBack={() => { setOpen(null); load(); }} />;

  const all = data?.cases || [];
  const want = q.trim().toLowerCase();
  const narrowed = all.filter((c) => (!want || [c.number, c.title, c.type, c.party, c.building, c.unit, c.contractRef, c.refs].join(' ').toLowerCase().includes(want))
    && (!f.type || c.type === f.type) && (!f.stage || c.stage === f.stage) && (!f.status || c.status === f.status)
    && (!f.assigned || String(c.assigned?.id || 'none') === f.assigned) && (!f.priority || c.priority === f.priority)
    && (!f.from || ymdOf(c.createdAt) >= f.from) && (!f.to || ymdOf(c.createdAt) <= f.to));
  // The SRS's dashboard: each count is a tile, and a tile is also a filter.
  const tiles = [
    ['all', 'Total', narrowed],
    ['active', 'Active', narrowed.filter((c) => c.stage !== 'closed')],
    ['cooling', 'In cooling period', narrowed.filter((c) => c.stage === 'initial_cooling' || c.stage === 'legal_cooling')],
    ['settlement', 'Pending settlement', narrowed.filter((c) => c.stage === 'settlement')],
    ['proceeding', 'Proceeding', narrowed.filter((c) => PROCEEDING_STAGES.includes(c.stage) || c.stage === 'proceeding_2')],
    ['appealed', 'Appealed', narrowed.filter((c) => ['appeal', 'proceeding_2', 'payment_voucher'].includes(c.stage) || c.status === 'appealed')],
    ['closed', 'Paid / closed', narrowed.filter((c) => c.stage === 'closed' || c.status === 'paid')],
    ['overdue', 'Overdue', narrowed.filter((c) => c.overdue)],
  ];
  const shown = (tiles.find((t) => t[0] === tile) || tiles[0])[2];
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const filtering = Object.values(f).some(Boolean);

  const actions = data && (
    <div className="flex items-center gap-2">
      <Reports reports={data.reports} />
      {data.master && <button onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings" className="grid size-9 place-items-center rounded-full border border-stroke text-mute hover:text-txt"><Settings2 size={16} /></button>}
      <Btn primary onClick={() => setCreating(true)}><Plus size={15} /> New case</Btn>
    </div>
  );

  return (
    <Page title="Legal cases" onBack={onBack} action={actions}>
      {error ? <div className="pt-6"><Problem text={error} /></div> : !data ? (
        <div className="grid place-items-center pt-16 text-mute"><Loader2 className="animate-spin" /></div>
      ) : (
        <div className="space-y-4 pb-8">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
            {tiles.map(([k, label, list]) => (
              <button key={k} onClick={() => setTile(k)}
                className={`rounded-2xl border px-3.5 py-3 text-left transition ${tile === k ? 'border-p1/60 bg-p1/[0.1]' : 'border-stroke bg-white/[0.04] hover:bg-white/[0.07]'}`}>
                <p className={`text-2xl font-semibold tabular-nums ${k === 'overdue' && list.length ? 'text-bad' : ''}`}>{list.length}</p>
                <p className="text-xs text-mute">{label}</p>
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="glass flex flex-1 items-center gap-2 rounded-xl px-3.5 py-2">
              <Search size={15} className="shrink-0 text-mute" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search case number, party, building, unit, reference…" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-mute/70" />
              {q && <button onClick={() => setQ('')} aria-label="Clear" className="text-mute hover:text-txt"><X size={14} /></button>}
            </div>
            <Picker value={f.type} onChange={set('type')} none="All case types" placeholder="All case types" searchPlaceholder="Search types" className="sm:w-56"
              options={data.types.map((t) => ({ value: t.name, label: t.name }))} />
            <button onClick={() => setMoreFilters(!moreFilters)}
              className={`flex shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3.5 py-2 text-sm transition ${filtering ? 'border-p1/60 text-txt' : 'border-stroke text-mute hover:text-txt'}`}>
              Filters <ChevronDown size={14} className={`transition ${moreFilters ? 'rotate-180' : ''}`} />
            </button>
          </div>
          {moreFilters && (
            <div className="grid gap-2 rounded-2xl border border-stroke bg-white/[0.03] p-3 sm:grid-cols-2 lg:grid-cols-3">
              <Picker value={f.stage} onChange={set('stage')} none="Any stage" placeholder="Any stage" searchPlaceholder="Search stages"
                options={[...data.flow.map((s) => ({ value: s.key, label: s.label })), { value: 'closed', label: 'Closed' }]} />
              <Picker value={f.status} onChange={set('status')} none="Any status" placeholder="Any status" searchPlaceholder="Search"
                options={Object.entries(data.statuses).map(([k, l]) => ({ value: k, label: l }))} />
              <Picker value={f.assigned} onChange={set('assigned')} none="Anyone" placeholder="Anyone" searchPlaceholder="Search people"
                options={[{ value: 'none', label: 'Not assigned' }, ...data.people.map((p) => ({ value: String(p.id), label: p.name }))]} />
              <Picker value={f.priority} onChange={set('priority')} none="Any priority" placeholder="Any priority" searchPlaceholder="Search"
                options={Object.entries(PRIORITY).map(([k, [l]]) => ({ value: k, label: l }))} />
              <label className="flex items-center gap-2 text-sm text-mute">Opened from
                <input type="date" value={f.from} onChange={(e) => set('from')(e.target.value)} className={`${BOX}`} /></label>
              <label className="flex items-center gap-2 text-sm text-mute">to
                <input type="date" value={f.to} onChange={(e) => set('to')(e.target.value)} className={`${BOX}`} /></label>
              {filtering && <button onClick={() => setF({ type: '', stage: '', status: '', assigned: '', priority: '', from: '', to: '' })} className="text-left text-sm text-p1">Clear the filters</button>}
            </div>
          )}

          {shown.length === 0 ? (
            <p className="pt-12 text-center text-sm text-mute">{all.length ? 'Nothing here.' : 'No legal cases yet. Tap New case to open the first one.'}</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((c) => <CaseCard key={c.id} c={c} today={data.today} onOpen={() => setOpen(c.id)} />)}
            </ul>
          )}
        </div>
      )}
      {creating && <NewCase meta={data} onClose={() => setCreating(false)} onDone={(c) => { setCreating(false); load(); setOpen(c.id); }} />}
      {settingsOpen && <SettingsSheet meta={data} onClose={() => setSettingsOpen(false)} onSaved={load} />}
    </Page>
  );
}

/** What a card says is waiting: a decision, a period running out, or just the stage. */
function stateOf(c, today) {
  if (c.stage === 'closed') return [c.statusLabel, STATUS_TONE[c.status] || 'mute'];
  if (c.overdue) return ['Overdue', 'bad'];
  if (c.waitingDecision) return ['Decision needed', 'warn'];
  if (c.due) { const n = daysTo(today, c.due); return [n === 0 ? 'Ends today' : `${n} day${n > 1 ? 's' : ''} left`, n <= 3 ? 'warn' : 'p1']; }
  return [c.statusLabel, STATUS_TONE[c.status] || 'mute'];
}

function CaseCard({ c, today, onOpen }) {
  return (
    <li>
      <button onClick={onOpen}
        className={`flex h-full w-full flex-col gap-2 rounded-2xl border bg-white/[0.04] p-4 text-left transition hover:bg-white/[0.07] ${c.overdue ? 'border-bad/50' : c.waitingDecision ? 'border-warn/50' : 'border-stroke'}`}>
        <div className="flex w-full items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-mute">{c.number} · {c.type}</p>
            <p className="truncate font-medium">{c.title}</p>
          </div>
          <Chip c={stateOf(c, today)} />
        </div>
        {(c.party || c.building) && (
          <p className="truncate text-sm text-mute">{[c.party, [c.building, c.unit && `Unit ${c.unit}`].filter(Boolean).join(' · ')].filter(Boolean).join(' — ')}</p>
        )}
        <div className="mt-auto flex w-full items-center justify-between gap-2 border-t border-stroke pt-2 text-xs">
          <span className="flex items-center gap-1.5"><CircleDot size={12} className="text-p1" /> {c.stageLabel}</span>
          <span className="flex items-center gap-2 text-mute">
            {(c.priority === 'high' || c.priority === 'urgent') && <Chip c={PRIORITY[c.priority]} />}
            {c.assigned?.name || 'Not assigned'}
          </span>
        </div>
      </button>
    </li>
  );
}

/** The SRS's reports, each a CSV for Excel. */
function Reports({ reports }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    <div ref={wrap} className="relative">
      <Btn onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}><Download size={14} /> <span className="max-sm:hidden">Reports</span></Btn>
      {open && (
        <div role="menu" style={{ background: 'var(--color-surface-2)' }} className="menu-glass absolute right-0 top-full z-50 mt-1.5 min-w-60 overflow-hidden rounded-xl p-1.5 shadow-2xl shadow-black/50">
          {Object.entries(reports).map(([k, label]) => (
            <a key={k} role="menuitem" href={`/api/legal-cases/reports/${k}`} download onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-white/10">
              <FileText size={14} className="shrink-0 text-mute" /> {label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- a new case, and changing one ----------

const DETAIL_FIELDS = [
  { key: 'title', label: 'Title / subject', type: 'text' },
  { key: 'party_name', label: 'Tenant / customer / party name', type: 'text' },
  { key: 'party_phone', label: 'Contact number', type: 'text' },
  { key: 'party_email', label: 'Contact email', type: 'text' },
  { key: 'contract_ref', label: 'Related contract / reference', type: 'text' },
  { key: 'incident_date', label: 'Incident / issue date', type: 'date' },
  { key: 'description', label: 'Description', type: 'long' },
  { key: 'remarks', label: 'Remarks', type: 'long' },
];

/** The building from saifsys's list (or typed, when it is not there) and the unit. */
function Property({ v, set }) {
  const [places, setPlaces] = useState(null);
  useEffect(() => { api.get('/legal-cases/places').then(setPlaces).catch(() => setPlaces([])); }, []);
  const b = (places || []).find((x) => x.name === v.building);
  const typed = places && places.length === 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5 text-sm">
        <span>Property / building</span>
        {typed ? <input value={v.building || ''} onChange={(e) => set('building')(e.target.value)} className={BOX} />
          : <Picker value={v.building || ''} onChange={(x) => { set('building')(x); set('unit')(''); }} none="No building" placeholder={places ? 'No building' : 'Loading…'} searchPlaceholder="Search buildings"
            options={[...(places || []).map((p) => ({ value: p.name, label: p.name })), ...(v.building && !b && places ? [{ value: v.building, label: v.building }] : [])]} />}
      </div>
      <div className="space-y-1.5 text-sm">
        <span>Unit</span>
        {b && b.units.length ? <Picker value={v.unit || ''} onChange={set('unit')} none="No unit" placeholder="No unit" searchPlaceholder="Search units"
          options={[...b.units.map((u) => ({ value: u, label: u })), ...(v.unit && !b.units.includes(v.unit) ? [{ value: v.unit, label: v.unit }] : [])]} />
          : <input value={v.unit || ''} onChange={(e) => set('unit')(e.target.value)} className={BOX} />}
      </div>
    </div>
  );
}

function CaseForm({ meta, v, set, isNew }) {
  const types = meta.types.filter((t) => t.active || t.id === v.type_id);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5 text-sm">
        <span>Case type <span className="text-bad">*</span></span>
        <Picker value={v.type_id || ''} onChange={(x) => set('type_id')(x)} placeholder="Choose the case type" searchPlaceholder="Search types"
          options={types.map((t) => ({ value: t.id, label: t.name }))} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {DETAIL_FIELDS.slice(0, 1).map((d) => <Field key={d.key} f={{ ...d, label: isNew ? `${d.label} (or leave it to Reem)` : d.label }} value={v[d.key]} onChange={set(d.key)} />)}
        <div className="space-y-1.5 text-sm">
          <span>Assigned to</span>
          <Picker value={v.assigned_to ? String(v.assigned_to) : ''} onChange={(x) => set('assigned_to')(x ? Number(x) : null)} none="Not assigned" placeholder="Not assigned" searchPlaceholder="Search people"
            options={meta.people.map((p) => ({ value: String(p.id), label: p.name }))} />
        </div>
      </div>
      <Property v={v} set={set} />
      <div className="grid gap-3 sm:grid-cols-2">
        {DETAIL_FIELDS.slice(1).map((d) => <Field key={d.key} f={d} value={v[d.key]} onChange={set(d.key)} />)}
      </div>
      <div className="space-y-1.5 text-sm">
        <span>Priority</span>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(PRIORITY).map(([k, [l]]) => (
            <button key={k} type="button" onClick={() => set('priority')(k)}
              className={`rounded-full px-3.5 py-1.5 text-sm ${(v.priority || 'normal') === k ? 'bg-p1/30 text-txt' : 'bg-white/5 text-mute'}`}>{l}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function NewCase({ meta, onClose, onDone }) {
  const [v, setV] = useState({ priority: 'normal' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const save = async () => {
    setBusy(true); setError('');
    try { onDone(await api.post('/legal-cases', v)); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Sheet title="New legal case" onClose={onClose} wide="text">
      <div className="space-y-4">
        <CaseForm meta={meta} v={v} set={set} isNew />
        <p className="text-xs text-mute">The case gets its number and starts its initial cooling period of {meta.settings.initial_days} days today.</p>
        <Problem text={error} />
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary busy={busy} disabled={!v.type_id} onClick={save}><Plus size={14} /> Open the case</Btn>
        </div>
      </div>
    </Sheet>
  );
}

function EditCase({ c, meta, onClose, onDone }) {
  const [v, setV] = useState({
    type_id: c.typeId, title: c.title, party_name: c.party, party_phone: c.partyPhone, party_email: c.partyEmail, contract_ref: c.contractRef,
    incident_date: c.incidentDate, description: c.description, remarks: c.remarks, building: c.building, unit: c.unit, priority: c.priority, assigned_to: c.assigned?.id || null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const save = async () => {
    setBusy(true); setError('');
    try { onDone(await api.patch(`/legal-cases/${c.id}`, v)); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Sheet title={`${c.number} · details`} onClose={onClose} wide="text">
      <div className="space-y-4">
        <CaseForm meta={meta} v={v} set={set} />
        <p className="text-xs text-mute">Every change goes on the case's timeline, with what it was before.</p>
        <Problem text={error} />
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary busy={busy} onClick={save}><Check size={14} /> Save</Btn>
        </div>
      </div>
    </Sheet>
  );
}

// ---------- one case ----------

/** The stages this case has gone or will go through, as far as its decisions so far say. */
function pathOf(c, flow) {
  const by = Object.fromEntries(flow.map((s) => [s.key, s]));
  const path = ['initial_cooling', 'legal_notice', 'legal_cooling', 'settlement'];
  const settled = c.steps.settlement?.decision;
  if (settled === 'settled') path.push('not_proceeding');
  if (settled === 'no_settlement') {
    path.push(...PROCEEDING_STAGES);
    const st = c.steps.case_status?.decision;
    if (st === 'settled') path.push('paid');
    if (st === 'dismissed') path.push('appeal', 'proceeding_2', 'payment_voucher');
  }
  return path.map((k) => by[k]).filter(Boolean);
}

function CaseView({ id, meta: given, onBack }) {
  const [meta, setMeta] = useState(given);
  const [c, setC] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => api.get(`/legal-cases/${id}`).then(setC).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!given) api.get('/legal-cases').then(setMeta).catch((e) => setError(e.message)); }, [given]);

  if (!c || !meta) {
    return (
      <Page title="Legal case" onBack={onBack}>
        {error ? <div className="pt-6"><Problem text={error} /></div> : <div className="grid place-items-center pt-16 text-mute"><Loader2 className="animate-spin" /></div>}
      </Page>
    );
  }
  const flow = meta.flow;
  const path = pathOf(c, flow);
  const current = flow.find((s) => s.key === c.stage);
  const del = async () => {
    if (!confirm(`Delete ${c.number} with its documents and timeline? This cannot be undone.`)) return;
    try { await api.del(`/legal-cases/${c.id}`); onBack(); } catch (e) { setError(e.message); }
  };

  return (
    <Page title={c.number} onBack={onBack} action={(
      <div className="flex items-center gap-2">
        <Btn onClick={() => setEditing(true)}><Pencil size={14} /> <span className="max-sm:hidden">Details</span></Btn>
        {meta.master && <button onClick={del} aria-label="Delete the case" title="Delete the case" className="grid size-9 place-items-center rounded-full border border-stroke text-mute hover:text-bad"><Trash2 size={15} /></button>}
      </div>
    )}>
      <div className="space-y-5 pb-10">
        {/* Who and what: one band across the top */}
        <div className="rounded-3xl border border-stroke bg-white/[0.04] px-5 py-4">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1 basis-64">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-lg font-medium">{c.title}</p>
                <Chip c={[c.statusLabel, STATUS_TONE[c.status] || 'mute']} />
                {c.priority !== 'normal' && <Chip c={PRIORITY[c.priority]} />}
              </div>
              <p className="text-sm text-mute">{c.type} · opened {when(c.createdAt)}{c.createdBy ? ` by ${c.createdBy}` : ''}</p>
              {c.description && <p className="mt-2 whitespace-pre-wrap text-sm">{c.description}</p>}
            </div>
            <div className="grid shrink-0 gap-1.5 text-sm">
              {c.party && <p className="flex items-center gap-2"><UserRound size={14} className="text-mute" /> {c.party}{c.partyPhone ? ` · ${c.partyPhone}` : ''}{c.partyEmail ? ` · ${c.partyEmail}` : ''}</p>}
              {(c.building || c.unit) && <p className="flex items-center gap-2"><Building2 size={14} className="text-mute" /> {[c.building, c.unit && `Unit ${c.unit}`].filter(Boolean).join(' · ')}</p>}
              {c.contractRef && <p className="flex items-center gap-2"><FileText size={14} className="text-mute" /> {c.contractRef}</p>}
              <p className="flex items-center gap-2"><ArrowRightLeft size={14} className="text-mute" /> {c.assigned?.name || 'Not assigned'}</p>
              {c.incidentDate && <p className="text-xs text-mute">Incident {day(c.incidentDate)}</p>}
            </div>
          </div>
        </div>

        <Stepper path={path} c={c} />

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
          <div className="min-w-0 space-y-5">
            {c.stage === 'closed' ? (
              <div className="rounded-3xl border border-ok/30 bg-ok/[0.06] p-5">
                <p className="flex items-center gap-2 font-medium"><Lock size={16} /> Closed: {c.outcome}</p>
                <p className="mt-1 text-sm text-mute">{c.closedAt ? `On ${when(c.closedAt)}` : ''}{c.closedBy ? ` by ${c.closedBy}` : ''}.</p>
              </div>
            ) : current && <StageCard key={c.stage} c={c} stage={current} meta={meta} onChanged={setC} />}

            {path.filter((s) => c.steps[s.key]?.done_at).reverse().map((s) => <DoneStage key={s.key} s={s} c={c} />)}

            <div>
              <p className="mb-3 px-1 text-xs font-medium tracking-[0.14em] text-mute">TIMELINE</p>
              <Note id={c.id} onChanged={setC} />
              <Timeline events={c.events} flow={flow} />
            </div>
          </div>

          <aside className="rounded-3xl border border-stroke bg-white/[0.04] lg:sticky lg:top-4">
            <Documents c={c} flow={flow} master={meta.master} maxMb={meta.settings.max_file_mb} onChanged={setC} />
          </aside>
        </div>
      </div>
      {editing && <EditCase c={c} meta={meta} onClose={() => setEditing(false)} onDone={(x) => { setEditing(false); setC(x); }} />}
    </Page>
  );
}

/** The path as a row of steps: done, where it is now, and what is still to come. */
function Stepper({ path, c }) {
  const at = path.findIndex((s) => s.key === c.stage);
  return (
    <ol className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
      {path.map((s, i) => {
        const done = !!c.steps[s.key]?.done_at;
        const now = s.key === c.stage;
        const overdue = now && c.overdue;
        return (
          <li key={s.key} className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ${now ? (overdue ? 'bg-bad/20 text-bad' : 'bg-p1/25 text-txt') : done ? 'bg-ok/10 text-ok' : 'bg-white/5 text-mute'}`}>
            {done ? <Check size={12} /> : now ? <CircleDot size={12} /> : <span className="tabular-nums">{i + 1}</span>}
            {s.decision ? <Scale size={12} /> : null} {s.label}
          </li>
        );
      })}
      {c.stage !== 'closed' && at === path.length - 1 && path[at]?.decision && <li className="flex shrink-0 items-center px-2 text-xs text-mute">… depends on the decision</li>}
      {c.stage === 'closed' && <li className="flex shrink-0 items-center gap-1.5 rounded-full bg-ok/10 px-3 py-1.5 text-xs text-ok"><Lock size={12} /> Closed</li>}
    </ol>
  );
}

/** The stage the case is in: its fields, its documents, and Complete (or the decision). */
function StageCard({ c, stage, meta, onChanged }) {
  const saved = c.steps[stage.key] || {};
  const [v, setV] = useState(() => Object.fromEntries(stage.fields.map((f) => [f.key, saved[f.key] ?? (f.type === 'date' && !stage.period && f.required ? meta.today : '')])));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const hasFile = c.files.some((f) => f.stage === stage.key);
  const missing = stage.fields.filter((f) => f.required && !String(v[f.key] ?? '').trim()).map((f) => f.label);
  const changed = stage.fields.some((f) => String(v[f.key] ?? '') !== String(saved[f.key] ?? ''));

  const run = async (what, body) => {
    setBusy(what); setError('');
    try { onChanged(await body()); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const save = () => run('save', () => api.put(`/legal-cases/${c.id}/stage`, { values: v }));
  const complete = (decision = null) => run(decision || 'complete', () => api.post(`/legal-cases/${c.id}/complete`, { stage: stage.key, values: v, decision }));
  const period = stage.period ? c.periods[stage.key] : null;
  const left = stage.period && v.end ? daysTo(meta.today, v.end) : null;

  return (
    <div className={`rounded-3xl border p-5 ${c.overdue ? 'border-bad/40 bg-bad/[0.06]' : stage.decision ? 'border-warn/40 bg-warn/[0.06]' : 'border-p1/40 bg-p1/[0.07]'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex flex-1 items-center gap-2 font-medium">{stage.decision ? <Scale size={17} /> : stage.period ? <Clock size={17} /> : <Gavel size={17} />} {stage.label}</p>
        {period && <Chip c={PERIOD[period]} />}
      </div>
      {stage.period && left !== null && (
        <p className="mt-1 text-sm text-mute">{left < 0 ? `Ended ${-left} day${left < -1 ? 's' : ''} ago - complete it to move on.` : left === 0 ? 'Ends today.' : `${left} day${left > 1 ? 's' : ''} left, until ${day(v.end)}.`}</p>
      )}
      {stage.decision && !meta.canDecide && <p className="mt-1 text-sm text-mute">This decision is the master's, or someone the master picks. Fill in what you know; they decide.</p>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {stage.fields.map((f) => <Field key={f.key} f={f} value={v[f.key]} onChange={set(f.key)} />)}
      </div>

      {stage.docType && (
        <div className="mt-4">
          <StageUpload c={c} stage={stage} onChanged={onChanged} />
          {stage.file && !hasFile && <p className="mt-1.5 text-xs text-warn">The {stage.docType.toLowerCase()} must be uploaded before this stage is complete.</p>}
        </div>
      )}

      {error && <div className="mt-3"><Problem text={error} /></div>}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {missing.length > 0 && <span className="mr-auto text-xs text-mute">Still needed: {missing.join(', ')}</span>}
        {changed && <Btn busy={busy === 'save'} onClick={save}>Save</Btn>}
        {stage.decision
          ? stage.decision.map((d, i) => (
            <Btn key={d.key} primary={i === 0} busy={busy === d.key} disabled={!meta.canDecide || missing.length > 0 || !!busy} onClick={() => {
              if (confirm(`Record "${d.label}" for ${c.number}? The case moves on, and this cannot be undone here.`)) complete(d.key);
            }}>{d.label}</Btn>
          ))
          : <Btn primary busy={busy === 'complete'} disabled={missing.length > 0 || (stage.file && !hasFile) || !!busy} onClick={() => complete()}><Check size={14} /> Complete {stage.label.toLowerCase()}</Btn>}
      </div>
    </div>
  );
}

/** Upload at a stage, with its document type set to what the stage expects. */
function StageUpload({ c, stage, onChanged }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const files = c.files.filter((f) => f.stage === stage.key);
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    const form = new FormData();
    form.append('file', file);
    form.append('stage', stage.key);
    form.append('doc_type', stage.docType);
    try { onChanged(await api.upload(`/legal-cases/${c.id}/files`, form)); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {files.map((f) => <FileChip key={f.id} c={c} f={f} />)}
        <button onClick={() => input.current?.click()} disabled={busy}
          className="flex items-center gap-1.5 rounded-full border border-dashed border-stroke px-3 py-1.5 text-xs text-mute transition hover:text-txt disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} Upload {stage.docType.toLowerCase()}
        </button>
        <input ref={input} type="file" accept=".pdf,image/*,.doc,.docx,.xls,.xlsx" className="hidden" onChange={pick} />
      </div>
      <Problem text={error} />
    </div>
  );
}

const FileChip = ({ c, f }) => (
  <a href={`/api/legal-cases/${c.id}/files/${f.id}`} target="_blank" rel="noreferrer" title={`${f.doc_type} · ${f.by || ''} · ${when(f.created_at)}`}
    className="flex max-w-full items-center gap-1 rounded-full bg-white/5 px-2.5 py-1 text-xs text-mute hover:text-txt">
    {f.mime === 'application/pdf' ? <FileText size={12} className="shrink-0" /> : <Paperclip size={12} className="shrink-0" />} <span className="truncate">{f.name}</span>
  </a>
);

/** A stage already done: what was recorded, kept in view under the current one. */
function DoneStage({ s, c }) {
  const [open, setOpen] = useState(false);
  const st = c.steps[s.key];
  const dec = s.decision?.find((d) => d.key === st.decision);
  const files = c.files.filter((f) => f.stage === s.key);
  const shown = s.fields.filter((f) => st[f.key] !== undefined && st[f.key] !== '');
  return (
    <div className="rounded-2xl border border-stroke bg-white/[0.03]">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <Check size={15} className="shrink-0 text-ok" />
        <span className="min-w-0 flex-1 truncate text-sm"><span className="font-medium">{s.label}</span>{dec ? <span className="text-mute"> · {dec.label}</span> : null}</span>
        <span className="text-xs text-mute">{st.done_at ? ymdOf(st.done_at) : ''}</span>
        <ChevronDown size={14} className={`shrink-0 text-mute transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-stroke px-4 py-3 text-sm">
          <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[12rem_1fr]">
            {shown.map((f) => (
              <div key={f.key} className="contents">
                <dt className="text-mute">{f.label}</dt>
                <dd className="whitespace-pre-wrap">{f.type === 'date' ? day(st[f.key]) : f.type === 'money' ? aed(st[f.key]) : st[f.key]}</dd>
              </div>
            ))}
          </dl>
          {files.length > 0 && <div className="flex flex-wrap gap-1.5">{files.map((f) => <FileChip key={f.id} c={c} f={f} />)}</div>}
        </div>
      )}
    </div>
  );
}

/** Every document on the case, by the stage it came with; more can be added any time. */
function Documents({ c, flow, master, maxMb, onChanged }) {
  const input = useRef(null);
  const [type, setType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const label = (k) => (k === 'case' ? 'Case' : flow.find((s) => s.key === k)?.label || k);
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    const form = new FormData();
    form.append('file', file);
    form.append('stage', 'case');
    if (type.trim()) form.append('doc_type', type.trim());
    try { onChanged(await api.upload(`/legal-cases/${c.id}/files`, form)); setType(''); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const remove = async (f) => {
    if (!confirm(`Take ${f.name} off the case? It stays on the timeline that it was removed.`)) return;
    try { onChanged(await api.del(`/legal-cases/${c.id}/files/${f.id}`)); } catch (err) { setError(err.message); }
  };
  return (
    <section className="p-5">
      <p className="font-medium">Documents</p>
      {c.files.length === 0 ? <p className="mt-1 text-xs text-mute">None yet.</p> : (
        <ul className="mt-3 space-y-2">
          {[...c.files].reverse().map((f) => (
            <li key={f.id} className="flex items-start gap-2 text-sm">
              {f.mime === 'application/pdf' ? <FileText size={15} className="mt-0.5 shrink-0 text-mute" /> : <Paperclip size={15} className="mt-0.5 shrink-0 text-mute" />}
              <div className="min-w-0 flex-1">
                <a href={`/api/legal-cases/${c.id}/files/${f.id}`} target="_blank" rel="noreferrer" className="block truncate hover:text-p1">{f.name}</a>
                <p className="text-xs text-mute">{f.doc_type} · {label(f.stage)} · {f.by || 'someone'} · {ymdOf(f.created_at)} · {size(f.size)}</p>
              </div>
              {master && <button onClick={() => remove(f)} aria-label={`Remove ${f.name}`} className="text-mute hover:text-bad"><Trash2 size={14} /></button>}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 space-y-2">
        <input value={type} onChange={(e) => setType(e.target.value)} placeholder="Document type (e.g. Photo, Cheque copy)" className={BOX} />
        <Btn busy={busy} onClick={() => input.current?.click()} className="w-full justify-center"><Upload size={14} /> Add a document</Btn>
        <input ref={input} type="file" accept=".pdf,image/*,.doc,.docx,.xls,.xlsx" className="hidden" onChange={pick} />
        <p className="text-xs text-mute">PDF, pictures, Word or Excel, up to {maxMb} MB.</p>
        <Problem text={error} />
      </div>
    </section>
  );
}

function Note({ id, onChanged }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async () => {
    setBusy(true); setError('');
    try { onChanged(await api.post(`/legal-cases/${id}/notes`, { text })); setText(''); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  return (
    <div className="mb-4 space-y-2">
      <div className="flex items-end gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Add a note to the timeline…" className={`${BOX} resize-y`} />
        <Btn busy={busy} disabled={!text.trim()} onClick={add}><MessageSquare size={14} /> Add</Btn>
      </div>
      <Problem text={error} />
    </div>
  );
}

const DOT = {
  created: ['bg-p1/20 text-p1', Plus], stage: ['bg-white/10 text-txt', Check], decision: ['bg-warn/15 text-warn', Scale],
  update: ['bg-white/5 text-mute', Pencil], assign: ['bg-white/5 text-mute', ArrowRightLeft], file: ['bg-white/5 text-mute', Paperclip],
  note: ['bg-white/10 text-txt', MessageSquare], closed: ['bg-ok/15 text-ok', Lock],
};

/** The case's history, newest first: who did what and when, and what a change was before. */
function Timeline({ events, flow }) {
  const labels = useMemo(() => Object.fromEntries(flow.flatMap((s) => s.fields.map((f) => [f.key, f.label]))), [flow]);
  return (
    <ol className="relative space-y-3 pl-11">
      <span className="absolute bottom-3 left-[17px] top-3 w-px bg-gradient-to-b from-p1/50 via-stroke to-transparent" aria-hidden />
      {events.map((e) => {
        const [tint, Ico] = DOT[e.kind] || DOT.update;
        const changes = e.data?.changes ? Object.entries(e.data.changes) : [];
        return (
          <li key={e.id} className="relative">
            <span className={`absolute -left-11 top-0 grid size-9 place-items-center rounded-full ring-4 ring-[var(--color-surface)] ${tint}`}><Ico size={15} /></span>
            <div className="min-h-9 pt-1.5">
              <p className={`text-sm ${e.kind === 'note' ? 'whitespace-pre-wrap rounded-2xl border border-stroke bg-white/[0.04] px-3 py-2' : ''}`}>{e.title}</p>
              {changes.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-mute">
                  {changes.map(([k, x]) => <li key={k}>{labels[k] || k.replace(/_/g, ' ')}: <span className="line-through">{String(x.before ?? '—')}</span> → <span className="text-txt">{String(x.after ?? '—')}</span></li>)}
                </ul>
              )}
              <p className="mt-0.5 text-xs text-mute">{e.by || 'Reem'} · {when(e.at)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- the master's settings ----------

function SettingsSheet({ meta, onClose, onSaved }) {
  const s = meta.settings;
  const [v, setV] = useState({ initial_days: String(s.initial_days), legal_days: String(s.legal_days), warn_days: String(s.warn_days), max_file_mb: String(s.max_file_mb) });
  const [deciders, setDeciders] = useState(s.deciders.map(String));
  const [types, setTypes] = useState(meta.types);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const num = (k) => (e) => setV((o) => ({ ...o, [k]: e.target.value.replace(/[^\d]/g, '') }));
  const save = async () => {
    setBusy('save'); setError('');
    try { await api.put('/legal-cases/settings', { ...v, deciders: deciders.map(Number) }); onSaved(); onClose(); } catch (e) { setError(e.message); setBusy(''); }
  };
  const typeCall = async (key, fn) => {
    setBusy(key); setError('');
    try { setTypes(await fn()); onSaved(); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const rename = (t) => {
    const n = prompt('The new name of this case type', t.name);
    if (n && n.trim() !== t.name) typeCall(`t${t.id}`, () => api.patch(`/legal-cases/types/${t.id}`, { name: n }));
  };
  const NUMS = [['initial_days', 'Initial cooling period (days)'], ['legal_days', 'Legal cooling period (days)'], ['warn_days', 'Alert this many days before a period ends'], ['max_file_mb', 'Largest document (MB)']];
  return (
    <Sheet title="Legal cases settings" onClose={onClose} wide="text">
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          {NUMS.map(([k, l]) => (
            <label key={k} className="block space-y-1.5 text-sm"><span>{l}</span><input inputMode="numeric" value={v[k]} onChange={num(k)} className={BOX} /></label>
          ))}
        </div>
        <p className="-mt-2 text-xs text-mute">A new period starts with these; each case's dates can still be moved on the case.</p>
        <div className="space-y-1.5 text-sm">
          <span>Who may take the settlement and case-status decisions, besides you</span>
          <Picker multi value={deciders} onChange={setDeciders} placeholder="Only the master" searchPlaceholder="Search people"
            options={meta.people.map((p) => ({ value: String(p.id), label: p.name }))} />
        </div>
        <div className="flex justify-end"><Btn primary busy={busy === 'save'} onClick={save}>Save</Btn></div>

        <div className="space-y-2 border-t border-stroke pt-4">
          <p className="font-medium">Case types</p>
          <ul className="space-y-1.5">
            {types.map((t) => (
              <li key={t.id} className="flex items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2 text-sm">
                <span className={`min-w-0 flex-1 truncate ${t.active ? '' : 'text-mute line-through'}`}>{t.name}</span>
                <button onClick={() => rename(t)} className="text-xs text-mute hover:text-txt">Rename</button>
                <button onClick={() => typeCall(`t${t.id}`, () => api.patch(`/legal-cases/types/${t.id}`, { active: !t.active }))} disabled={busy === `t${t.id}`}
                  className="text-xs text-mute hover:text-txt">{t.active ? 'Retire' : 'Bring back'}</button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="A new case type" className={BOX} />
            <Btn busy={busy === 'add'} disabled={!name.trim()} onClick={() => typeCall('add', async () => { const r = await api.post('/legal-cases/types', { name }); setName(''); return r; })}><Plus size={14} /> Add</Btn>
          </div>
          <p className="text-xs text-mute">A retired type is not offered for new cases; the cases already of that type keep it.</p>
        </div>
        <Problem text={error} />
      </div>
    </Sheet>
  );
}
