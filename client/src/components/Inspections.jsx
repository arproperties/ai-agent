import { useEffect, useState } from 'react';
import { Camera, Check, ChevronLeft, ChevronRight, ClipboardCheck, GitCompareArrows, Loader2, LogIn, LogOut, Pencil, Plus, Sparkles, Trash2, Wrench, X } from 'lucide-react';
import { api } from '../lib/api';
import { usDate as fmt } from '../lib/usFormat';
import Page from './Page';
import Select from './Select';
import DateField from './DateField';
import WorkOrders from './WorkOrders';

// One unit's condition over time: the make-ready done before it is let, and the move-in and
// move-out inspection of every lease it has had. Nothing here is replaced, so the list is the
// unit's history, and any two of them can be set side by side (a year ago beside today).
// They go in one order, lease after lease: the make-ready of the empty unit, the move-in, then
// the move-out; the page offers the step that is next. A lease made on the form is a draft
// until its move-in is done, and is confirmed here. Opened from the unit (Properties), where the
// lease is the unit's lease of today, or from a lease. The server is server/inspections.js.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3.5 py-2.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const OUTLINE = 'flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5';
const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3 py-1.5 text-xs text-mute hover:bg-white/5 hover:text-txt';
const ROUND = 'grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10';

const KIND = {
  make_ready: ['Make ready', Sparkles, 'from-sky-400 to-blue-500'],
  move_in: ['Move-in inspection', LogIn, 'from-emerald-400 to-teal-600'],
  move_out: ['Move-out inspection', LogOut, 'from-amber-400 to-orange-500'],
};
// What each can be marked, in order: [value, label, its colours].
const RATES = {
  good: ['Good', 'bg-ok/15 text-ok'], fair: ['Fair', 'bg-warn/15 text-warn'], damaged: ['Damaged', 'bg-bad/15 text-bad'],
  done: ['Done', 'bg-ok/15 text-ok'], pending: ['Pending', 'bg-warn/15 text-warn'],
};
// A rated area's card takes the colour of its rating, and each choice has its dot.
const EDGE = { good: 'border-ok/40', fair: 'border-warn/40', damaged: 'border-bad/40', done: 'border-ok/40' };
// The choices are buttons in their own colour: [waiting to be pressed, pressed].
const TINT = { ok: ['border-ok/50 bg-ok/10 text-ok hover:bg-ok/20', 'border-ok bg-ok text-white shadow-sm'], warn: ['border-warn/50 bg-warn/10 text-warn hover:bg-warn/20', 'border-warn bg-warn text-white shadow-sm'],
  bad: ['border-bad/50 bg-bad/10 text-bad hover:bg-bad/20', 'border-bad bg-bad text-white shadow-sm'] };
const CHOICE = { good: TINT.ok, fair: TINT.warn, damaged: TINT.bad, done: TINT.ok, pending: TINT.warn };
const CHOICES = { make_ready: ['done', 'pending'], move_in: ['good', 'fair', 'damaged'], move_out: ['good', 'fair', 'damaged'] };
// The usual list, to start from; areas can be added and taken off.
const AREAS = {
  make_ready: ['Cleaning', 'Painting', 'Repairs', 'AC service', 'Pest control', 'Locks & keys'],
  inspect: ['Entrance & doors', 'Living room', 'Kitchen', 'Bedrooms', 'Bathrooms', 'Walls & paint', 'Floors', 'Windows & blinds', 'AC & heating', 'Appliances', 'Lights & electrical', 'Plumbing', 'Keys & remotes'],
};
const PER = 6; // areas on the form at a time: three rows of two, so the page does not scroll
const BATCH = 10; // photos the server takes in one go
const photoUrl = (p) => `/api/leasing/inspection-photos/${p.id}`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const WORSE = { good: 0, fair: 1, damaged: 2 };
const ORDER = ['make_ready', 'move_in', 'move_out']; // a lease's steps, in turn

/** "11 good · 1 fair · 1 damaged", or "4 of 6 done" for a make-ready. */
function tally(i) {
  const n = (c) => i.items.filter((it) => it.condition === c).length;
  if (i.kind === 'make_ready') return `${n('done')} of ${i.items.length} done`;
  return [...['good', 'fair', 'damaged'].filter(n).map((c) => `${n(c)} ${c}`), n(null) && `${n(null)} not rated`].filter(Boolean).join(' · ');
}
const who = (i) => [i.tenant, i.ref].filter(Boolean).join(' · ');
const Pill = ({ rate }) => (rate ? <span className={`rounded-full px-2 py-0.5 text-[11px] ${RATES[rate][1]}`}>{RATES[rate][0]}</span> : <span className="text-xs text-mute/60">—</span>);
const Thumbs = ({ photos, onRemove }) => photos.length > 0 && (
  <div className="mt-2 flex flex-wrap gap-2">
    {photos.map((p) => (
      <span key={p.id} className="relative">
        <a href={photoUrl(p)} target="_blank" rel="noreferrer"><img src={photoUrl(p)} alt={p.area} loading="lazy" className="size-16 rounded-lg border border-stroke object-cover" /></a>
        {onRemove && <button type="button" onClick={() => onRemove(p)} aria-label="Remove photo" className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-bad text-white"><X size={12} /></button>}
      </span>
    ))}
  </div>
);

/** A new inspection (`kind`), or one being changed (`start`). `before` is the move-in a move-out is checked against. */
function InspectionForm({ unit, booking, kind, start, before, onDone, onCancel }) {
  const first = () => (start ? start.items : (before ? before.items.map((it) => it.area) : AREAS[kind === 'make_ready' ? 'make_ready' : 'inspect']).map((area) => ({ area, condition: '', note: '' })));
  const [items, setItems] = useState(() => first().map((it) => ({ ...it, note: it.note || '' })));
  const [date, setDate] = useState(start?.date || today());
  const [notes, setNotes] = useState(start?.notes || '');
  const [kept, setKept] = useState(start?.photos || []); // already saved
  const [picked, setPicked] = useState({}); // area → files chosen here, sent on Save
  const [extra, setExtra] = useState('');
  const [page, setPage] = useState(0); // the areas are shown a screenful at a time
  const [id, setId] = useState(start?.id || null); // set once saved, so a failed upload is tried again on the same inspection
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choices = CHOICES[kind];
  const set = (n, patch) => setItems(items.map((it, i) => (i === n ? { ...it, ...patch } : it)));
  const addArea = () => {
    const area = extra.trim();
    if (!area) return;
    if (items.some((it) => it.area.toLowerCase() === area.toLowerCase())) return setError(`${area} is already on the list.`);
    setItems([...items, { area, condition: '', note: '' }]); setExtra(''); setError(''); setPage(Math.floor(items.length / PER));
  };
  const unrated = kind === 'make_ready' ? 0 : items.filter((it) => !it.condition).length;
  const drop = async (p) => {
    if (!confirm('Remove this photo?')) return;
    try { await api.del(`/leasing/inspection-photos/${p.id}`); setKept(kept.filter((k) => k.id !== p.id)); } catch (e) { setError(e.message); }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    const body = { kind, booking_id: booking?.id, date, notes, items: items.map((it) => ({ ...it, condition: it.condition || (kind === 'make_ready' ? 'pending' : '') })) };
    try {
      let saved = await (id ? api.put(`/leasing/inspections/${id}`, body) : api.post(`/leasing/units/${unit.id}/inspections`, body));
      setId(saved.id);
      const left = { ...picked };
      for (const area of Object.keys(left)) {
        while (left[area].length) {
          const form = new FormData();
          form.append('area', area);
          left[area].slice(0, BATCH).forEach((f) => form.append('photos', f));
          saved = await api.upload(`/leasing/inspections/${saved.id}/photos`, form);
          left[area] = left[area].slice(BATCH);
          setKept(saved.photos); setPicked({ ...left });
        }
      }
      onDone(saved);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  const pages = Math.ceil(items.length / PER);
  const at = Math.max(0, Math.min(page, pages - 1)); // an area can be taken off while the last page is open
  const from = at * PER;
  // How far along it is: areas rated (jobs done, in a make-ready), and how many of each.
  const settled = items.filter((it) => (kind === 'make_ready' ? it.condition === 'done' : it.condition)).length;
  const counts = choices.map((c) => [c, items.filter((it) => (it.condition || (kind === 'make_ready' ? 'pending' : '')) === c).length]).filter(([, n]) => n);

  return (
    <form onSubmit={save} className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0 space-y-3">
        {before && <p className="text-xs text-mute">Under each area is how it was at move-in on {fmt(before.date)}.</p>}
        <ul className="grid gap-3 xl:grid-cols-2">
          {items.slice(from, from + PER).map((it, k) => {
            const n = from + k;
            const was = before?.items.find((b) => b.area === it.area);
            const chosen = picked[it.area] || [];
            const saved = kept.filter((p) => p.area === it.area);
            const shots = saved.length + chosen.length;
            const ok = kind === 'make_ready' ? it.condition === 'done' : !!it.condition;
            return (
              <li key={it.area} className={`rounded-2xl border bg-surface p-3.5 ${EDGE[it.condition] || 'border-stroke'}`}>
                <div className="flex items-center gap-2.5">
                  <span className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-medium ${ok ? RATES[it.condition][1] : 'border border-stroke/70 text-mute'}`}>{ok ? <Check size={13} /> : n + 1}</span>
                  <p className="min-w-0 flex-1 truncate font-medium">{it.area}</p>
                  <button type="button" onClick={() => setItems(items.filter((_, i) => i !== n))} aria-label={`Take ${it.area} off the list`} title="Take off the list" className={`${ROUND} size-7 hover:text-bad`}><X size={14} /></button>
                </div>
                <div className="mt-2.5 flex gap-2">
                  {choices.map((c) => (
                    <button key={c} type="button" onClick={() => set(n, { condition: it.condition === c && kind !== 'make_ready' ? '' : c })} aria-pressed={it.condition === c}
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-full border px-2 py-2 text-sm font-medium transition active:scale-95 ${CHOICE[c][it.condition === c ? 1 : 0]} ${it.condition && it.condition !== c ? 'opacity-50' : ''}`}>
                      {it.condition === c && <Check size={14} />}{RATES[c][0]}
                    </button>
                  ))}
                </div>
                {was && <p className="mt-2 flex items-center gap-1.5 text-xs text-mute">At move-in: <Pill rate={was.condition} />{was.note && <span className="truncate">{was.note}</span>}</p>}
                <div className="mt-2 flex gap-2">
                  <input value={it.note} onChange={(e) => set(n, { note: e.target.value })} maxLength={500} placeholder={kind === 'make_ready' ? 'What was done (optional)' : 'What you see (optional)'} className={`${FIELD} min-w-0 flex-1 py-2 text-sm`} />
                  <label className={`${GHOST} shrink-0 cursor-pointer self-center ${shots ? 'border-p1/50 text-p1' : ''}`} title="Add photos of this area">
                    <Camera size={14} /> {shots || <span className="hidden sm:inline">Photos</span>}
                    <input type="file" multiple accept="image/*" className="hidden" onChange={(e) => { setPicked({ ...picked, [it.area]: [...chosen, ...e.target.files] }); e.target.value = ''; }} />
                  </label>
                </div>
                <Thumbs photos={saved} onRemove={drop} />
                {chosen.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {chosen.map((f, i) => (
                      <span key={`${f.name}-${i}`} className="relative">
                        <img src={URL.createObjectURL(f)} alt={f.name} className="size-16 rounded-lg border border-dashed border-p1/60 object-cover opacity-80" />
                        <button type="button" onClick={() => setPicked({ ...picked, [it.area]: chosen.filter((_, j) => j !== i) })} aria-label={`Take off ${f.name}`} className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-white/25 text-txt"><X size={12} /></button>
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
          {/* A last page with fewer areas keeps the height of a full one, so Back and Next do not jump. */}
          {pages > 1 && Array.from({ length: PER - items.slice(from, from + PER).length }, (_, i) => (
            <li key={`empty-${i}`} aria-hidden className="invisible hidden rounded-2xl border p-3.5 xl:block">
              <div className="size-7" />
              <div className="mt-2.5 rounded-full border px-2 py-2 text-sm font-medium">&nbsp;</div>
              <input disabled tabIndex={-1} className={`${FIELD} mt-2 py-2 text-sm`} />
            </li>
          ))}
        </ul>
        {pages > 1 && (
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={() => setPage(at - 1)} disabled={at === 0} className={`${OUTLINE} disabled:opacity-40`}><ChevronLeft size={15} /> Back</button>
            <div className="flex items-center gap-1.5" aria-label={`Areas ${from + 1} to ${Math.min(from + PER, items.length)} of ${items.length}`}>
              {Array.from({ length: pages }, (_, i) => {
                const left = items.slice(i * PER, i * PER + PER).filter((it) => !(kind === 'make_ready' ? it.condition === 'done' : it.condition)).length;
                return <button key={i} type="button" onClick={() => setPage(i)} aria-current={i === at} title={left ? `${left} still to do` : 'All done'}
                  className={`h-2 rounded-full transition-all ${i === at ? 'w-8 bg-p1' : left ? 'w-2 bg-stroke hover:bg-mute' : 'w-2 bg-ok'}`} />;
              })}
              <span className="ml-2 text-xs text-mute">{from + 1 < Math.min(from + PER, items.length) && `${from + 1}–`}{Math.min(from + PER, items.length)} of {items.length}</span>
            </div>
            <button type="button" onClick={() => setPage(at + 1)} disabled={at >= pages - 1} className={`${at >= pages - 1 ? OUTLINE : PRIMARY} disabled:opacity-40`}>Next <ChevronRight size={15} /></button>
          </div>
        )}
        <div className="flex gap-2 rounded-2xl border border-dashed border-stroke p-2">
          <input value={extra} onChange={(e) => setExtra(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addArea(); } }} maxLength={60} placeholder="Another area, e.g. Balcony" className={`${FIELD} min-w-0 flex-1 py-2 text-sm`} />
          <button type="button" onClick={addArea} className={OUTLINE}><Plus size={15} /> Add area</button>
        </div>
      </div>

      {/* Stays in view while the areas scroll: how far along it is, and Save. */}
      <aside className="space-y-4 rounded-2xl border border-stroke bg-surface p-4 text-sm lg:sticky lg:top-2">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-medium">{settled} of {items.length} {kind === 'make_ready' ? 'done' : 'rated'}</p>
            <p className="text-xs text-mute">{items.length ? Math.round((settled / items.length) * 100) : 0}%</p>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stroke/60"><div className="h-full rounded-full bg-gradient-to-r from-p1 to-p2 transition-[width]" style={{ width: `${items.length ? (settled / items.length) * 100 : 0}%` }} /></div>
          {counts.length > 0 && <div className="mt-2.5 flex flex-wrap gap-1.5">{counts.map(([c, n]) => <span key={c} className={`rounded-full px-2 py-0.5 text-[11px] ${RATES[c][1]}`}>{n} {RATES[c][0].toLowerCase()}</span>)}</div>}
          {unrated > 0 && <button type="button" onClick={() => setItems(items.map((it) => ({ ...it, condition: it.condition || 'good' })))} className={`${GHOST} mt-3 w-full justify-center`}><Check size={13} /> Mark the other {unrated} good</button>}
        </div>
        <label className="block border-t border-stroke/60 pt-4"><span className="mb-1 block text-xs text-txt/80">Date <span className="text-p2">*</span></span>
          <DateField value={date} onChange={(e) => setDate(e.target.value)} max={today()} required className={FIELD} /></label>
        <label className="block"><span className="mb-1 block text-xs text-txt/80">Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} maxLength={2000} placeholder="Meter readings, keys handed over, anything else" className={`${FIELD} resize-none`} /></label>

        {error && <p className="text-bad">{error}</p>}
        <div className="space-y-2 border-t border-stroke/60 pt-4">
          <button disabled={busy || !items.length} className={`${PRIMARY} w-full justify-center`}>{busy ? 'Saving…' : unrated ? 'Save progress' : 'Save'}</button>
          {unrated > 0 && <p className="text-center text-xs text-mute">{unrated} area{unrated === 1 ? '' : 's'} not rated yet. Save now and finish later.</p>}
          <button type="button" onClick={onCancel} className="w-full rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        </div>
      </aside>
    </form>
  );
}

/** One inspection, read. With `versus`, the other one beside it, area by area. */
function Sheet({ i, list, onEdit, onRemoved }) {
  const others = list.filter((o) => o.id !== i.id);
  // A move-out opens beside its own move-in: that is the question it answers.
  const [versusId, setVersusId] = useState(() => (i.kind === 'move_out' && i.booking_id ? others.find((o) => o.kind === 'move_in' && o.booking_id === i.booking_id)?.id || '' : ''));
  const [error, setError] = useState('');
  const versus = others.find((o) => String(o.id) === String(versusId));
  const areas = [...new Set([...i.items, ...(versus?.items || [])].map((it) => it.area))];
  const cell = (of, area) => {
    const it = of.items.find((x) => x.area === area);
    return (
      <div className="min-w-0">
        {it ? <><Pill rate={it.condition} />{it.note && <p className="mt-1 whitespace-pre-wrap text-sm text-txt/80">{it.note}</p>}</> : <span className="text-xs text-mute/60">Not looked at</span>}
        <Thumbs photos={of.photos.filter((p) => p.area === area)} />
      </div>
    );
  };
  const remove = async () => {
    if (!confirm(`Delete this ${KIND[i.kind][0].toLowerCase()} and its photos? It cannot be brought back.`)) return;
    try { await api.del(`/leasing/inspections/${i.id}`); onRemoved(); } catch (e) { setError(e.message); }
  };
  const head = (of) => <p className="text-xs text-mute">{KIND[of.kind][0]} · {fmt(of.date)}{who(of) && ` · ${who(of)}`}</p>;

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-mute">{[fmt(i.date), who(i), i.done_by && `By ${i.done_by}`, tally(i)].filter(Boolean).join(' · ')}</p>
        <button onClick={onEdit} className={GHOST}><Pencil size={13} /> Edit</button>
        <button onClick={remove} className={`${GHOST} hover:text-bad`}><Trash2 size={13} /> Delete</button>
      </div>
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <GitCompareArrows size={15} className="shrink-0 text-mute" />
          <Select value={versusId} onChange={(e) => setVersusId(e.target.value)} placeholder="Compare with another inspection" aria-label="Compare with" className={`${FIELD} py-2 text-sm`} wrap="w-full sm:w-96"
            options={[['', 'Not compared'], ...others.map((o) => [o.id, `${KIND[o.kind][0]} · ${fmt(o.date)}${who(o) ? ` · ${who(o)}` : ''}`])]} />
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      {i.kind !== 'make_ready' && !i.complete && <p className="rounded-2xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">This inspection is not finished: some areas are not rated yet. Edit it to carry on.</p>}

      <div className="overflow-hidden rounded-2xl border border-stroke">
        {versus && (
          <div className="grid grid-cols-2 gap-4 border-b border-stroke bg-white/[0.03] px-4 py-2.5">{head(i)}{head(versus)}</div>
        )}
        <ul className="divide-y divide-stroke/60">
          {areas.map((area) => {
            const a = i.items.find((x) => x.area === area)?.condition;
            const b = versus?.items.find((x) => x.area === area)?.condition;
            // Which way it went, read oldest to newest, whichever side the older one is on.
            const [old, now] = versus && versus.date > i.date ? [a, b] : [b, a];
            const turn = versus && old in WORSE && now in WORSE && WORSE[now] !== WORSE[old] ? (WORSE[now] > WORSE[old] ? ['Worse', 'text-bad'] : ['Better', 'text-ok']) : null;
            return (
              <li key={area} className="px-4 py-3">
                <p className="mb-1.5 text-sm font-medium">{area}{turn && <span className={`ml-2 text-xs font-normal ${turn[1]}`}>{turn[0]}</span>}</p>
                {versus ? <div className="grid grid-cols-2 gap-4">{cell(i, area)}{cell(versus, area)}</div> : cell(i, area)}
              </li>
            );
          })}
        </ul>
      </div>
      {i.notes && <p className="whitespace-pre-wrap rounded-2xl border border-stroke px-4 py-3 text-sm text-txt/80">{i.notes}</p>}
      {i.kind === 'move_out' && i.items.some((it) => it.condition === 'damaged') && <p className="text-xs text-mute">Damage was found: what is kept from the deposit is set in the lease’s Payments.</p>}
    </div>
  );
}

/**
 * `unit` is { id, unit_no, building }. With `booking`, it is about that lease (else the unit's
 * lease of today), and `start` ('move_in') opens that step straight away, if it is the next one.
 */
export default function Inspections({ unit, booking, start, onBack }) {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState(null); // { form: kind, editing? } | { view: id } | null
  const [asked, setAsked] = useState(start);
  const [orders, setOrders] = useState(false); // the unit's work orders are open
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try { setData(await api.get(`/leasing/units/${unit.id}/inspections${booking ? `?booking=${booking.id}` : ''}`)); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [unit.id]);

  const place = `Unit ${unit.unit_no}${unit.building ? `, ${unit.building}` : ''}`;
  const list = data?.list || [];
  const lease = data?.lease;
  const next = data?.next;
  const last = list.find((i) => i.kind !== 'move_in'); // the make-ready or move-out the unit last had
  // A step is one inspection: begun and not finished, it is carried on, not started twice.
  const begun = (kind) => (kind === 'make_ready' ? (last?.kind === kind && !last.complete ? last : null) : lease && list.find((i) => i.kind === kind && i.booking_id === lease.id));
  const go = (kind) => { const have = begun(kind); setMode(have ? { form: kind, editing: have } : { form: kind }); };
  useEffect(() => {
    if (!data || !asked) return;
    setAsked(null);
    if (next?.kind === asked || next?.also === asked) go(asked);
  }, [data]);

  if (mode?.form) {
    const editing = mode.editing;
    const kind = editing?.kind || mode.form;
    const back = () => { setMode(null); load(); }; // reloaded even on Cancel: a photo may have been removed, or it was saved before an upload failed
    return (
      <Page title={`${editing ? 'Edit' : 'New'} ${KIND[kind][0].toLowerCase()} · ${place}`} onBack={back}>
        {lease && kind !== 'make_ready' && <p className="mb-4 text-sm text-mute">{lease.tenant} · {lease.ref} · {fmt(lease.start_date)} → {fmt(lease.end_date)}</p>}
        {!data ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
          : <InspectionForm unit={unit} booking={editing ? null : lease} kind={kind} start={editing}
              before={kind === 'move_out' ? list.find((i) => i.kind === 'move_in' && i.booking_id === (editing?.booking_id ?? lease?.id)) : null}
              onDone={(saved) => { setMode({ view: saved.id }); load(); }} onCancel={back} />}
      </Page>
    );
  }

  const open = mode?.view && list.find((i) => i.id === mode.view);
  if (open) return (
    <Page title={`${KIND[open.kind][0]} · ${place}`} onBack={() => setMode(null)}>
      <Sheet key={open.id} i={open} list={list} onEdit={() => setMode({ form: open.kind, editing: open })} onRemoved={() => { setMode(null); load(); }} />
    </Page>
  );

  // Only the step that is next is offered, but for: a lease for a unit not made ready
  // (the move-in as well), a lease that began with no move-in, an imported one say (its move-out
  // as well), and a unit that is ready (it can be made ready again).
  const step = next && next.kind !== 'confirm' ? next.kind : null;
  const confirm = async () => {
    setBusy(true); setError('');
    try { await api.post(`/leasing/bookings/${lease.id}/confirm`); onBack(); } catch (e) { setError(e.message); setBusy(false); }
  };
  const button = (kind, look) => {
    const [name, Ico] = KIND[kind];
    const [head, ...rest] = name.split(' ');
    return <button key={kind} onClick={() => go(kind)} className={look}><Ico size={16} /> {begun(kind) ? `Continue ${head.toLowerCase()}` : head}{rest.length > 0 && <span className={kind === 'make_ready' ? '' : 'hidden sm:inline'}> {rest.join(' ')}</span>}</button>;
  };
  const action = data && (
    <div className="flex gap-2">
      <button onClick={() => setOrders(true)} className={OUTLINE} title="Every repair done in this unit, whoever lived in it"><Wrench size={16} /> <span className="hidden sm:inline">Work orders</span></button>
      {next?.also ? button(next.also, OUTLINE) : next?.late && step === 'move_in' ? button('move_out', OUTLINE) : !next && button('make_ready', OUTLINE)}
      {step && button(step, PRIMARY)}
    </div>
  );
  const tenant = lease?.tenant;
  const [say, warn] = !data ? []
    : next?.kind === 'make_ready' ? [last?.kind === 'move_out' ? 'The tenant has left. Make the unit ready before it is leased again.'
      : `First the unit is made ready: cleaning, painting, repairs.${next.also ? ` ${tenant}’s lease is waiting, so the move-in inspection can be done as well.` : ' The move-in inspection comes after it.'}`, true]
    : next?.kind === 'move_in' ? [`${next.late ? `The lease started on ${fmt(lease.start_date)} and the move-in inspection is not done.` : `Next is ${tenant}’s move-in inspection.`}${lease.status === 'draft' ? ' The lease is confirmed after it.' : ''}`, next.late]
    : next?.kind === 'confirm' ? []
    : next?.kind === 'move_out' ? (next.late ? [`The lease ended on ${fmt(lease.end_date)} and the move-out inspection is not done. The unit is not vacant until it is.`, true] : [`${tenant}’s move-in is done. The move-out inspection comes when they leave.`])
    : ['The unit is ready. Next is a new lease, and its move-in inspection.'];
  if (orders) return <WorkOrders scope={{ unit_id: unit.id }} title={`Work orders · ${place}`} preset={{ unit_id: unit.id }} onBack={() => setOrders(false)} />;
  return (
    <Page title={`Inspections · ${place}`} onBack={onBack} action={action}>
      {error && <p className="mb-3 text-sm text-bad">{error}</p>}
      {!data ? !error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
        <div className="max-w-3xl space-y-4">
          {lease && <p className="text-sm text-mute">{lease.tenant} · {lease.ref} · {fmt(lease.start_date)} → {fmt(lease.end_date)}</p>}
          <ol className="flex flex-wrap items-center gap-1.5 text-xs">
            {ORDER.map((k, n) => {
              const at = !next ? 1 : next.kind === 'confirm' ? 1.5 : ORDER.indexOf(next.kind); // nothing next: it is ready, and waits for a move-in; to confirm: between the move-in and the move-out
              return (
                <li key={k} className="flex items-center gap-1.5">
                  {n > 0 && <ChevronRight size={13} className="text-mute/60" />}
                  <span className={`flex items-center gap-1 rounded-full px-2.5 py-1 ${n === at ? 'bg-p1/20 font-medium text-p1' : n < at ? 'bg-ok/10 text-ok' : 'border border-stroke/70 text-mute'}`}>
                    {n < at && <Check size={12} />}{KIND[k][0]}
                  </span>
                </li>
              );
            })}
          </ol>
          {next?.kind === 'confirm' ? (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-ok/40 bg-ok/10 px-4 py-3">
              <p className="min-w-0 flex-1 text-sm">{lease.renewed_from ? 'A renewal has no move-in inspection: the tenant is already in.' : 'The move-in inspection is done.'} The lease can be confirmed.</p>
              <button onClick={confirm} disabled={busy} className={PRIMARY}><Check size={16} /> {busy ? 'Confirming…' : 'Confirm lease'}</button>
            </div>
          ) : <p className={`rounded-2xl border px-4 py-3 text-sm ${warn ? 'border-warn/40 bg-warn/10' : 'border-stroke text-txt/80'}`}>{say}</p>}

          {list.length === 0 ? <p className="py-3 text-sm text-mute">Nothing on record for this unit yet.</p> : (
            <ul className="space-y-3">
              {list.map((i) => {
                const [name, Ico, tint] = KIND[i.kind];
                return (
                  <li key={i.id}>
                    <button onClick={() => setMode({ view: i.id })} className="flex w-full items-center gap-3 rounded-2xl border border-stroke bg-surface p-4 text-left hover:border-p1/50">
                      <span className={`grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br text-white ${tint}`}><Ico size={18} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2">
                          <span className="text-sm font-medium">{name}</span>
                          {!i.complete && (i.kind === 'make_ready' ? <Pill rate="pending" /> : <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">Not finished</span>)}
                          {lease && i.booking_id === lease.id && <span className="rounded-full bg-p1/15 px-2 py-0.5 text-[11px] text-p1">This lease</span>}
                        </span>
                        <span className="block truncate text-xs text-mute">{[fmt(i.date), who(i), tally(i), i.photos.length && `${i.photos.length} photo${i.photos.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span>
                      </span>
                      <ClipboardCheck size={16} className="shrink-0 text-mute" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}
