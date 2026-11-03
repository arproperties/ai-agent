import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Loader2, Pencil, Plus, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../lib/api';

// Progress on a project (server/projectProgress.js): each floor with its four stages, and
// inside a floor its steps - status, %, checklist, hold point, who, planned weeks. Progress
// itself is told to Reem in chat and confirmed on a card; here it is looked at. A manager
// shapes the steps here: add, change, reorder, remove, and moves the programme's start day.
// Below a floor's steps are its areas (rooms) with the material each needs - the take-off -
// what has gone out to each, and how far each is (server/projectAreas.js).

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const LABEL = 'text-[11px] font-medium tracking-[0.14em] text-mute';
const STAGES = [['concrete', 'Concrete'], ['blockwork', 'Blockwork'], ['mep', 'MEP'], ['finishes', 'Finishes']];
const STATUS = {
  not_started: { label: 'Not started', bar: 'bg-white/10', chip: 'bg-white/[0.06] text-mute' },
  in_progress: { label: 'In progress', bar: 'bg-p1/70', chip: 'bg-p1/20 text-txt' },
  done: { label: 'Done', bar: 'bg-ok/80', chip: 'bg-ok/20 text-ok' },
  blocked: { label: 'Blocked', bar: 'bg-bad/80', chip: 'bg-bad/20 text-bad' },
};
const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
const day = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const weeks = (s) => (s.week_from ? `wk ${s.week_from}${s.week_to && s.week_to !== s.week_from ? `–${s.week_to}` : ''}` : null);

function StepForm({ start, floor, onSave, onCancel }) {
  const [name, setName] = useState(start?.name || '');
  const [stage, setStage] = useState(start?.stage || 'blockwork');
  const [who, setWho] = useState(start?.who || '');
  const [hold, setHold] = useState(start?.hold_point || '');
  const [from, setFrom] = useState(start?.week_from ?? '');
  const [to, setTo] = useState(start?.week_to ?? '');
  const [points, setPoints] = useState((start?.points || []).map((p) => p.text).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true); setError('');
    try {
      await onSave({ floor, name, stage, who, hold_point: hold, week_from: from, week_to: to, points: points.split('\n').map((p) => p.trim()).filter(Boolean) });
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <div className="glass space-y-3 rounded-2xl p-4">
      <label className="block space-y-1.5"><span className={LABEL}>STEP</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pool tiling" className={FIELD} /></label>
      <div className="space-y-1.5">
        <span className={LABEL}>STAGE</span>
        <div className="flex flex-wrap gap-1">
          {STAGES.map(([k, label]) => (
            <button key={k} onClick={() => setStage(k)}
              className={`rounded-full px-3 py-1.5 text-sm transition ${stage === k ? 'bg-p1/30 text-txt' : 'text-mute hover:bg-white/[0.06]'}`}>{label}</button>
          ))}
        </div>
      </div>
      <label className="block space-y-1.5"><span className={LABEL}>WHO DOES IT</span>
        <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="e.g. Masonry crew" className={FIELD} /></label>
      <label className="block space-y-1.5"><span className={LABEL}>HOLD POINT (A MANAGER SIGNS IT OFF BEFORE DONE)</span>
        <input value={hold} onChange={(e) => setHold(e.target.value)} placeholder="Leave empty if none" className={FIELD} /></label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1.5"><span className={LABEL}>FROM WEEK</span>
          <input type="number" min="1" value={from} onChange={(e) => setFrom(e.target.value)} className={FIELD} /></label>
        <label className="block space-y-1.5"><span className={LABEL}>TO WEEK</span>
          <input type="number" min="1" value={to} onChange={(e) => setTo(e.target.value)} className={FIELD} /></label>
      </div>
      <label className="block space-y-1.5"><span className={LABEL}>CHECKLIST, ONE POINT PER LINE</span>
        <textarea value={points} onChange={(e) => setPoints(e.target.value)} rows={5} className={FIELD} />
        <span className="block text-xs text-mute">A point kept word for word keeps its tick.</span>
      </label>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={busy || !name.trim()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 font-medium text-white shadow-lg shadow-p1/25 disabled:opacity-50">
          {busy && <Loader2 size={15} className="animate-spin" />} Save
        </button>
        <button onClick={onCancel} className="rounded-full border border-stroke px-5 py-2.5 text-mute">Cancel</button>
      </div>
    </div>
  );
}

function Step({ s, n, manager, onChanged }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [hist, setHist] = useState(null);
  const [error, setError] = useState('');
  const st = STATUS[s.status];
  const done = s.points.filter((p) => p.done).length;

  useEffect(() => { if (open && !hist) api.get(`/projects/steps/${s.id}/history`).then(setHist).catch(() => setHist([])); }, [open, hist, s.id]);

  const run = async (fn) => { setError(''); try { onChanged(await fn()); } catch (e) { setError(e.message); } };

  if (editing) {
    return <StepForm start={s} floor={s.floor} onCancel={() => setEditing(false)}
      onSave={async (body) => { onChanged(await api.put(`/projects/steps/${s.id}`, body)); setEditing(false); }} />;
  }
  return (
    <div className="px-4 py-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-3 text-left">
        <span className="w-5 shrink-0 pt-0.5 text-right text-xs tabular-nums text-mute">{n}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{s.name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <span className={`rounded-full px-2 py-0.5 ${st.chip}`}>{st.label}{s.status === 'in_progress' && ` ${s.percent}%`}</span>
            {s.late && <span className="rounded-full bg-warn/20 px-2 py-0.5 text-warn">Late</span>}
            {s.points.length > 0 && <span className="text-mute">{done}/{s.points.length} points</span>}
            {weeks(s) && <span className="text-mute">{weeks(s)}</span>}
            {s.hold_point && (s.signed ? <ShieldCheck size={14} className="text-ok" /> : <ShieldAlert size={14} className="text-warn" />)}
          </span>
          <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <span className={`block h-full ${st.bar}`} style={{ width: `${s.status === 'blocked' ? Math.max(s.percent, 4) : s.percent}%` }} />
          </span>
        </span>
        <ChevronRight size={16} className={`mt-0.5 shrink-0 text-mute transition ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="mt-3 space-y-2.5 pl-8 text-sm">
          {s.note && <p className={s.status === 'blocked' ? 'text-bad' : 'text-txt/85'}>{s.note}</p>}
          {s.who && <p className="text-mute">Who: <span className="text-txt/85">{s.who}</span></p>}
          {s.hold_point && (
            <p className="text-mute">Hold point: <span className="text-txt/85">{s.hold_point}</span>
              <span className={`block text-xs ${s.signed ? 'text-ok' : 'text-warn'}`}>
                {s.signed ? `Signed off by ${s.signed.by || 'a manager'}${s.signed.note ? ` · ${s.signed.note}` : ''}` : 'Not signed off yet'}
              </span>
            </p>
          )}
          {s.points.length > 0 && (
            <ul className="space-y-1">
              {s.points.map((p) => (
                <li key={p.id} className="flex items-start gap-2">
                  <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${p.done ? 'border-ok bg-ok/80 text-white' : 'border-stroke'}`}>
                    {p.done && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className={p.done ? 'text-mute line-through' : ''}>{p.text}</span>
                </li>
              ))}
            </ul>
          )}
          <div>
            <p className={LABEL}>HISTORY</p>
            {!hist ? <Loader2 size={14} className="mt-1 animate-spin text-mute" /> : !hist.length ? <p className="text-xs text-mute">Nothing confirmed yet.</p> : (
              <ul className="mt-1 space-y-0.5 text-xs">
                {hist.map((h) => (
                  <li key={h.id}><span className="text-mute">{new Date(Number(h.at) * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' })}{h.by_name && ` · ${h.by_name}`}:</span> {h.what}</li>
                ))}
              </ul>
            )}
          </div>
          {error && <p className="text-xs text-bad">{error}</p>}
          {manager && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button onClick={() => setEditing(true)} className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-xs text-mute hover:text-txt"><Pencil size={12} /> Edit</button>
              <button onClick={() => run(() => api.post(`/projects/steps/${s.id}/move`, { dir: -1 }))} aria-label="Move up" className="rounded-full border border-stroke px-2.5 py-1 text-mute hover:text-txt"><ArrowUp size={12} /></button>
              <button onClick={() => run(() => api.post(`/projects/steps/${s.id}/move`, { dir: 1 }))} aria-label="Move down" className="rounded-full border border-stroke px-2.5 py-1 text-mute hover:text-txt"><ArrowDown size={12} /></button>
              <button onClick={() => { if (window.confirm(`Remove "${s.name}" and its history?`)) run(() => api.del(`/projects/steps/${s.id}`)); }}
                className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-xs text-mute hover:border-bad/60 hover:text-bad"><Trash2 size={12} /> Remove</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AreaForm({ start, floor, onSave, onCancel }) {
  const [name, setName] = useState(start?.name || '');
  const [item, setItem] = useState(start?.item || 'Hollow block 200mm');
  const [unit, setUnit] = useState(start?.counted_in || 'pcs');
  const [needed, setNeeded] = useState(start?.needed ?? '');
  const [from, setFrom] = useState(start?.week_from ?? '');
  const [to, setTo] = useState(start?.week_to ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { await onSave({ floor, name, item, counted_in: unit, needed, week_from: from, week_to: to }); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <div className="glass space-y-3 rounded-2xl p-4">
      <label className="block space-y-1.5"><span className={LABEL}>ROOM / AREA</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pump room" className={FIELD} /></label>
      <label className="block space-y-1.5"><span className={LABEL}>MATERIAL (THE SAME NAME AS IN STOCK)</span>
        <input value={item} onChange={(e) => setItem(e.target.value)} className={FIELD} /></label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1.5"><span className={LABEL}>NEEDED</span>
          <input type="number" min="0" step="any" value={needed} onChange={(e) => setNeeded(e.target.value)} className={FIELD} /></label>
        <label className="block space-y-1.5"><span className={LABEL}>COUNTED IN</span>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="pcs, bags, m3" className={FIELD} /></label>
        <label className="block space-y-1.5"><span className={LABEL}>FROM WEEK</span>
          <input type="number" min="1" value={from} onChange={(e) => setFrom(e.target.value)} className={FIELD} /></label>
        <label className="block space-y-1.5"><span className={LABEL}>TO WEEK</span>
          <input type="number" min="1" value={to} onChange={(e) => setTo(e.target.value)} className={FIELD} /></label>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={busy || !name.trim() || !item.trim() || needed === ''}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 font-medium text-white shadow-lg shadow-p1/25 disabled:opacity-50">
          {busy && <Loader2 size={15} className="animate-spin" />} Save
        </button>
        <button onClick={onCancel} className="rounded-full border border-stroke px-5 py-2.5 text-mute">Cancel</button>
      </div>
    </div>
  );
}

function Areas({ f, manager, projectId, onChanged }) {
  const [editing, setEditing] = useState(null); // an area, or 'new'
  const [error, setError] = useState('');
  // The screen's state is the whole progress: an area change reloads it.
  const done = async (fn) => { setError(''); try { await fn(); setEditing(null); onChanged(); } catch (e) { setError(e.message); throw e; } };
  return (
    <div className="space-y-2">
      <p className={`${LABEL} pt-2`}>ROOMS AND WHAT THEY NEED</p>
      {!f.areas.length && <p className="text-sm text-mute">No rooms listed for this floor{manager ? ' yet. Add them with their quantities.' : '.'}</p>}
      {f.areas.length > 0 && (
        <div className="glass divide-y divide-stroke/60 rounded-2xl">
          {f.areas.map((a) => (editing?.id === a.id
            ? <div key={a.id} className="p-2"><AreaForm start={a} floor={f.name} onCancel={() => setEditing(null)} onSave={(body) => done(() => api.put(`/projects/areas/${a.id}`, body))} /></div>
            : (
              <div key={a.id} className="px-4 py-3">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 font-medium">{a.name}</span>
                  {a.late && <span className="rounded-full bg-warn/20 px-2 text-xs text-warn">Late</span>}
                  <span className="tabular-nums text-mute">{a.percent}%</span>
                </div>
                <p className="text-xs text-mute">
                  {a.item}: {num(a.given)} of {num(a.needed)} {a.counted_in} given out{weeks(a) && ` · ${weeks(a)}`}
                </p>
                {a.note && <p className="text-xs text-txt/80">{a.note}</p>}
                <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <span className={`block h-full ${a.percent === 100 ? STATUS.done.bar : STATUS.in_progress.bar}`} style={{ width: `${a.percent}%` }} />
                </span>
                {manager && (
                  <div className="mt-2 flex gap-1.5">
                    <button onClick={() => setEditing(a)} className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-xs text-mute hover:text-txt"><Pencil size={12} /> Edit</button>
                    <button onClick={() => { if (window.confirm(`Remove ${a.name} (${a.item})?`)) done(() => api.del(`/projects/areas/${a.id}`)).catch(() => {}); }}
                      className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-xs text-mute hover:border-bad/60 hover:text-bad"><Trash2 size={12} /> Remove</button>
                  </div>
                )}
              </div>
            )))}
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
      {manager && (editing === 'new'
        ? <AreaForm floor={f.name} onCancel={() => setEditing(null)} onSave={(body) => done(() => api.post(`/projects/${projectId}/areas`, body))} />
        : <button onClick={() => setEditing('new')} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt"><Plus size={15} /> Add a room</button>)}
    </div>
  );
}

function StageBars({ f }) {
  return (
    <span className="mt-2 grid grid-cols-4 gap-1.5">
      {STAGES.map(([k, label]) => {
        const st = f.stages[k];
        return (
          <span key={k} className="space-y-1">
            <span className="block h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              {st && <span className={`block h-full ${STATUS[st.status].bar}`} style={{ width: `${st.status === 'done' ? 100 : Math.max(st.percent, st.status === 'not_started' ? 0 : 6)}%` }} />}
            </span>
            <span className="block text-center text-[10px] text-mute">{label}</span>
          </span>
        );
      })}
    </span>
  );
}

function StartDay({ pr, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(pr.start_day || '');
  const [error, setError] = useState('');
  const manager = ['manager', 'master'].includes(pr.role);
  const save = async () => {
    setError('');
    try { onChanged(await api.put(`/projects/${pr.project.id}/progress/start`, { start_day: value })); setEditing(false); } catch (e) { setError(e.message); }
  };
  return (
    <div className="text-sm text-mute">
      {!editing ? (
        <p className="flex items-center gap-2">
          <span>Week <span className="text-txt">{pr.week}</span>{pr.weeks && ` of ${pr.weeks}`} · started {day(pr.start_day)}</span>
          {manager && <button onClick={() => setEditing(true)} aria-label="Change the start day" className="rounded-full p-1 hover:bg-white/10 hover:text-txt"><Pencil size={13} /></button>}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <span>Week 1 starts</span>
          <input type="date" value={value} onChange={(e) => setValue(e.target.value)} className="glass rounded-lg px-2 py-1 text-txt outline-none" />
          <button onClick={save} className="rounded-full bg-p1/30 px-3 py-1 text-txt">Save</button>
          <button onClick={() => setEditing(false)} className="px-2 py-1">Cancel</button>
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}

export default function ProjectProgress({ id }) {
  const [pr, setPr] = useState(null);
  const [error, setError] = useState('');
  const [floor, setFloor] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api.get(`/projects/${id}/progress`).then(setPr).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="py-10 text-center text-bad">{error}</p>;
  if (!pr) return <Loader2 className="mx-auto mt-10 animate-spin text-mute" />;
  const manager = ['manager', 'master'].includes(pr.role);
  const f = floor && pr.floors.find((x) => x.name === floor);

  if (f) {
    return (
      <div className="space-y-3">
        <button onClick={() => { setFloor(null); setAdding(false); }} className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-xs text-mute">
          <ChevronLeft size={13} /> All floors
        </button>
        <div className="flex items-baseline justify-between">
          <h3 className="text-lg font-medium">{f.name}</h3>
          <span className="tabular-nums text-mute">{f.percent}%</span>
        </div>
        {!f.steps.length ? <p className="py-6 text-center text-mute">No steps on this floor.</p> : (
          <div className="glass divide-y divide-stroke/60 rounded-2xl">
            {f.steps.map((s, i) => <Step key={s.id} s={s} n={i + 1} manager={manager} onChanged={setPr} />)}
          </div>
        )}
        {manager && (adding
          ? <StepForm floor={f.name} onCancel={() => setAdding(false)} onSave={async (body) => { setPr(await api.post(`/projects/${id}/steps`, body)); setAdding(false); }} />
          : <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt"><Plus size={15} /> Add a step</button>)}
        <Areas f={f} manager={manager} projectId={id} onChanged={load} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <StartDay pr={pr} onChanged={setPr} />
      <p className="text-xs text-mute">To update, tell Reem in chat, e.g. "basement blockwork 40%, north side done", and confirm the card.</p>
      <div className="glass divide-y divide-stroke/60 rounded-2xl">
        {pr.floors.map((x) => {
          const blocked = x.steps.filter((s) => s.status === 'blocked').length;
          const late = x.steps.filter((s) => s.late).length;
          return (
            <button key={x.name} onClick={() => setFloor(x.name)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.04]">
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="font-medium">{x.name}</span>
                  {blocked > 0 && <span className="rounded-full bg-bad/20 px-2 text-xs text-bad">{blocked} blocked</span>}
                  {late > 0 && <span className="rounded-full bg-warn/20 px-2 text-xs text-warn">{late} late</span>}
                  <span className="ml-auto tabular-nums text-mute">{x.percent}%</span>
                </span>
                <StageBars f={x} />
              </span>
              <ChevronRight size={16} className="text-mute" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
