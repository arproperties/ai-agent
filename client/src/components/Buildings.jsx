import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Building2, Camera, Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, MessageSquare, Minus, Package, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Picker from './Picker';

// Buildings: who runs each one and the field staff given to them, and the cleaning and
// maintenance jobs those staff do on the saifsys staff app. The master sets the buildings
// up and sees them all; an administrator sees their own. Nothing here changes a job -
// it is a window onto the work. The server is server/buildings.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const KIND = { cleaner: 'Cleaner', technician: 'Technician' };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const shift = (day, by) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + by); return d.toISOString().slice(0, 10); };
const dayName = (day) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
// saifsys stamps a job's start and finish in Dubai time already, as "2026-10-03 09:12:00".
const clock = (stamp) => (stamp ? stamp.slice(11, 16) : '');
const when = (secs) => new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const TONE = { open: 'bg-white/10 text-mute', in_progress: 'bg-p3/20 text-p3', done: 'bg-ok/20 text-ok', cancelled: 'bg-white/10 text-mute' };
const Pill = ({ tone, children }) => <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{children}</span>;

// Each job is in exactly one of these, so the numbers on the tabs add up to the day's jobs.
const GROUPS = [
  ['Late', (j) => j.late],
  ['In progress', (j) => !j.late && j.status === 'in_progress'],
  ['Not started', (j) => !j.late && j.status === 'open'],
  ['Done', (j) => j.status === 'done'],
];
/** "1 late · 3 done · 1 in progress · 2 not started", with what needs someone said first. */
function Summary({ jobs }) {
  if (!jobs.length) return <span className="text-mute">No jobs today</span>;
  const n = Object.fromEntries(GROUPS.map(([label, pick]) => [label, jobs.filter(pick).length]));
  const materials = jobs.filter((j) => j.needs_materials && j.status !== 'done').length;
  const parts = [
    n.Late > 0 && <span key="l" className="text-bad">{n.Late} late</span>,
    materials > 0 && <span key="m" className="text-warn">{materials} need materials</span>,
    n.Done > 0 && <span key="d" className="text-ok">{n.Done} done</span>,
    n['In progress'] > 0 && <span key="p">{n['In progress']} in progress</span>,
    n['Not started'] > 0 && <span key="o">{n['Not started']} not started</span>,
  ].filter(Boolean);
  return <span className="text-mute">{parts.map((p, k) => [k > 0 && ' · ', p])}</span>;
}

// ---------- one job, opened ----------

function Media({ buildingId, m }) {
  const src = `/api/buildings/${buildingId}/media/${m.id}`;
  if (m.kind === 'voice') return <audio controls preload="none" src={src} className="h-9 w-full max-w-[260px]" />;
  if (m.kind === 'video') return <video controls preload="metadata" src={src} className="max-h-56 rounded-lg" />;
  return <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="" loading="lazy" className="size-24 rounded-lg object-cover" /></a>;
}

function Photos({ buildingId, list, label }) {
  if (!list.length) return null;
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium tracking-[0.14em] text-mute">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {list.map((p) => {
          const src = `/api/buildings/${buildingId}/photo/${p.id}`;
          return p.kind === 'video'
            ? <video key={p.id} controls preload="metadata" src={src} className="h-24 rounded-lg" />
            : <a key={p.id} href={src} target="_blank" rel="noreferrer"><img src={src} alt={label} loading="lazy" className="size-24 rounded-lg object-cover" /></a>;
        })}
      </div>
    </div>
  );
}

function JobDetail({ buildingId, id }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/buildings/${buildingId}/jobs/${id}`).then(setJob).catch((e) => setError(e.message)); }, [buildingId, id]);

  if (error) return <p className="py-2 text-sm text-bad">{error}</p>;
  if (!job) return <Loader2 size={16} className="mx-auto my-3 animate-spin text-mute" />;
  const times = [job.started_at && `Started ${clock(job.started_at)}`, job.finished_at && `Finished ${clock(job.finished_at)}`, job.duration && `Took ${job.duration}`].filter(Boolean);
  return (
    <div className="space-y-3 border-t border-stroke/50 pt-3 text-sm">
      {job.places.length > 1 && <p className="text-txt/80">{job.places.join(' · ')}</p>}
      {job.description && <p className="whitespace-pre-wrap text-txt/80">{job.description}</p>}
      <p className="text-xs text-mute">{[job.source_label, ...times].join(' · ')}</p>
      {job.completion_notes && <p className="whitespace-pre-wrap rounded-xl bg-white/[0.04] px-3 py-2">{job.completion_notes}</p>}

      {job.problems && (
        <div className="rounded-xl border border-bad/40 bg-bad/10 px-3 py-2">
          <p className="flex items-center gap-1.5 font-medium text-bad"><AlertTriangle size={14} /> {job.problems.found.join(', ')}</p>
          {job.problems.note && <p className="mt-1 whitespace-pre-wrap text-txt/80">{job.problems.note}</p>}
          {job.problems.maintenance_job_id && <p className="mt-1 text-xs text-mute">A maintenance job was raised for it (#{job.problems.maintenance_job_id}).</p>}
        </div>
      )}

      <Photos buildingId={buildingId} label="BEFORE" list={job.photo_list.filter((p) => p.when === 'before')} />
      <Photos buildingId={buildingId} label="AFTER" list={job.photo_list.filter((p) => p.when === 'after')} />

      {job.checklist && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium tracking-[0.14em] text-mute">CHECKLIST</p>
          {job.checklist.map((s) => (
            <div key={s.title}>
              <p className="mb-0.5 text-xs text-mute">{s.title}</p>
              <ul className="space-y-0.5">
                {s.items.map((i) => (
                  <li key={i.label} className="flex items-start gap-2">
                    <span className={`mt-0.5 grid size-[16px] shrink-0 place-items-center rounded-full ${i.answer === 'done' ? 'bg-ok/20 text-ok' : 'bg-white/10 text-mute'}`}>
                      {i.answer === 'done' ? <Check size={11} strokeWidth={3} /> : <Minus size={11} />}
                    </span>
                    <span className={i.answer === 'done' ? '' : 'text-mute'}>{i.label}{i.answer === 'na' && ' (not needed)'}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {job.message_list.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium tracking-[0.14em] text-mute">MESSAGES</p>
          {job.message_list.map((m) => (
            <div key={m.id} className={`rounded-xl px-3 py-2 ${m.from_staff ? 'bg-white/[0.05]' : 'bg-p1/10'}`}>
              <p className="text-[11px] text-mute">{m.by || 'Someone'}{m.at && ` · ${when(m.at)}`}{m.material_request && <span className="text-warn"> · asking for materials</span>}</p>
              {m.text && <p className="whitespace-pre-wrap">{m.text}</p>}
              {m.media.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">{m.media.map((x) => <Media key={x.id} buildingId={buildingId} m={x} />)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JobRow({ buildingId, job, open, onToggle }) {
  const place = job.places[0] || job.location;
  const more = job.places.length > 1 ? ` +${job.places.length - 1}` : '';
  return (
    <div className={`rounded-2xl px-4 py-3 ${job.late ? 'bg-bad/[0.08] ring-1 ring-bad/25' : 'bg-white/5'}`}>
      <button onClick={onToggle} className="flex w-full items-start gap-2 text-left">
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug">{job.title}</p>
          <p className="mt-0.5 text-xs text-mute">
            {[place && place + more, job.assignee?.name || 'Nobody yet', job.time].filter(Boolean).join(' · ')}
          </p>
          {job.late_note && <p className="mt-1 text-xs text-bad">{job.late_note}</p>}
          {job.paused && <p className="mt-1 text-xs text-warn">Paused{job.pause_reason && `: ${job.pause_reason}`}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mute">
            {job.needs_materials && <span className="flex items-center gap-1 text-warn"><Package size={13} /> Needs materials</span>}
            {job.problems && <span className="flex items-center gap-1 text-bad"><AlertTriangle size={13} /> {job.problems.found.join(', ')}</span>}
            {job.photos.before + job.photos.after > 0 && <span className="flex items-center gap-1"><Camera size={13} /> {job.photos.before + job.photos.after}</span>}
            {job.messages > 0 && <span className="flex items-center gap-1"><MessageSquare size={13} /> {job.messages}</span>}
            {job.duration && <span>{job.duration}</span>}
          </div>
          {!open && job.last_message?.text && <p className="mt-1.5 line-clamp-1 text-xs text-txt/70">"{job.last_message.text}"</p>}
        </div>
        <Pill tone={job.paused ? 'bg-warn/20 text-warn' : TONE[job.status]}>{job.status_label}</Pill>
        <ChevronDown size={16} className={`mt-0.5 shrink-0 text-mute transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-3"><JobDetail buildingId={buildingId} id={job.id} /></div>}
    </div>
  );
}

// ---------- one building ----------

function BuildingView({ b, startJob, master, onEdit }) {
  const [day, setDay] = useState(today());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(startJob || null);
  const [tab, setTab] = useState(null); // null until one is picked: then the open job's tab, or the first with jobs
  const isToday = day === today();

  const load = useCallback(() => api.get(`/buildings/${b.id}/jobs${isToday ? '' : `?from=${day}`}`)
    .then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)), [b.id, day, isToday]);
  useEffect(() => { setData(null); setTab(null); load(); }, [load]);
  // Today moves while it is being watched; a day that has passed does not.
  useEffect(() => {
    if (!isToday) return undefined;
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [isToday, load]);

  const people = (kind) => b.staff.filter((s) => s.kind === kind).map((s) => s.name).join(', ');
  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-white/5 px-4 py-3 text-sm">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-0.5">
            <p><span className="text-mute">Administrator:</span> {b.admin?.name || 'Not set'}</p>
            <p><span className="text-mute">Renewals:</span> {(b.renewals || b.admin)?.name || 'Not set'}</p>
            <p><span className="text-mute">Cleaners:</span> {people('cleaner') || 'None yet'}</p>
            <p><span className="text-mute">Technicians:</span> {people('technician') || 'None yet'}</p>
          </div>
          {master && (
            <button onClick={onEdit} aria-label="Edit" title="Edit"
              className="-mr-1.5 -mt-1 grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button onClick={() => setDay(shift(day, -1))} aria-label="The day before" className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><ChevronLeft size={18} /></button>
        <p className="flex-1 text-center text-sm font-medium">{isToday ? 'Today' : dayName(day)}</p>
        {!isToday && <button onClick={() => setDay(today())} className="rounded-full px-3 py-1 text-xs text-mute hover:bg-white/10 hover:text-txt">Today</button>}
        <button onClick={() => setDay(shift(day, 1))} disabled={isToday} aria-label="The day after" className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt disabled:opacity-30"><ChevronRight size={18} /></button>
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}
      {!data && !error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />}
      {data?.unset && <p className="py-8 text-center text-sm text-mute">No saifsys building or staff has been set for this building yet.</p>}
      {data && !data.unset && (() => {
        const groups = GROUPS.map(([label, pick]) => [label, data.jobs.filter(pick)]);
        // The job a notification asked for decides the tab it opens on.
        const shownTab = tab
          || groups.find(([, jobs]) => jobs.some((j) => j.id === open))?.[0]
          || groups.find(([, jobs]) => jobs.length)?.[0]
          || GROUPS[0][0];
        const jobs = groups.find(([label]) => label === shownTab)[1];
        const materials = data.jobs.filter((j) => j.needs_materials && j.status !== 'done').length;
        return (
        <>
          <div className="grid grid-cols-4 rounded-full bg-white/5 p-1 text-sm">
            {groups.map(([label, list]) => (
              <button key={label} onClick={() => setTab(label)}
                className={`truncate rounded-full px-1 py-1.5 transition ${shownTab === label ? 'bg-white/15 text-txt' : 'text-mute hover:text-txt'}`}>
                {label} <span className={label === 'Late' && list.length > 0 ? 'text-bad' : 'text-mute'}>{list.length}</span>
              </button>
            ))}
          </div>
          {materials > 0 && <p className="px-1 text-sm text-warn">{materials} need materials</p>}
          {data.jobs.length === 0
            ? <p className="py-8 text-center text-sm text-mute">{isToday ? 'Nothing is scheduled for today.' : 'Nothing was scheduled that day.'}</p>
            : jobs.length === 0 && <p className="py-8 text-center text-sm text-mute">Nothing here.</p>}
          <div className="space-y-2">
            {jobs.map((j) => <JobRow key={j.id} buildingId={b.id} job={j} open={open === j.id} onToggle={() => setOpen(open === j.id ? null : j.id)} />)}
          </div>
          {data.more && <p className="text-center text-xs text-mute">There are more jobs than fit here.</p>}
        </>
        );
      })()}
    </div>
  );
}

// ---------- the master's editor ----------

function StaffSearch({ taken, onAdd }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const search = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { setFound(await api.get(`/buildings/staff-search?q=${encodeURIComponent(q.trim())}`)); } catch (x) { setError(x.message); }
    setBusy(false);
  };
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <input value={q} onChange={(e) => { setQ(e.target.value); setFound(null); }} placeholder="Find in HR by name or code"
          onKeyDown={(e) => e.key === 'Enter' && search(e)}
          className="glass min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-p1/70" />
        <button type="button" onClick={search} disabled={busy || q.trim().length < 2} className="flex items-center gap-1 rounded-full border border-stroke px-3 text-sm text-mute hover:text-txt disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Find
        </button>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      {found?.length === 0 && <p className="text-xs text-mute">HR has nobody like that.</p>}
      {found?.map((e) => (
        <div key={e.code} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-1.5 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate">{e.name} <span className="text-mute">· {e.code}</span></p>
            <p className="truncate text-xs text-mute">{[e.position, e.company].filter(Boolean).join(' · ')}</p>
          </div>
          {taken.includes(e.code) ? <span className="text-xs text-mute">Added</span> : Object.entries(KIND).map(([k, l]) => (
            <button key={k} type="button" onClick={() => onAdd({ code: e.code, name: e.name, kind: k })}
              className="shrink-0 rounded-full border border-stroke px-2.5 py-1 text-xs hover:bg-white/10">+ {l}</button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Editor({ start, onSaved, onCancel }) {
  const [opts, setOpts] = useState(null);
  const [name, setName] = useState(start?.name || '');
  const [adminId, setAdminId] = useState(start?.admin?.id || '');
  const [renewalsId, setRenewalsId] = useState(start?.renewals?.id || '');
  const [sites, setSites] = useState(start?.sites.map((s) => s.id) || []);
  const [staff, setStaff] = useState(start?.staff || []);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api.get('/buildings/options').then(setOpts).catch((e) => { setError(e.message); setOpts({ sites: [], people: [] }); }); }, []);

  const act = async (what, fn) => {
    if (busy) return;
    setBusy(what); setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const save = (e) => {
    e.preventDefault();
    act('save', async () => {
      const body = { name, admin_id: adminId || null, renewals_id: renewalsId || null, sites, staff };
      await (start ? api.put(`/buildings/${start.id}`, body) : api.post('/buildings', body));
      await onSaved();
    });
  };
  const remove = () => confirm(`Delete "${start.name}"? The jobs in saifsys are not touched.`)
    && act('delete', async () => { await api.del(`/buildings/${start.id}`); await onSaved(); });
  const toggle = (id) => setSites((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  if (!opts) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  const people = opts.people.map((p) => ({ value: p.id, label: p.name }));
  const label = 'text-[11px] font-medium tracking-[0.14em] text-mute';
  return (
    <form onSubmit={save} className="space-y-3 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Building name, e.g. Park Place" className={FIELD} autoFocus={!start} />
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <span className={label}>ADMINISTRATOR</span>
          <Picker value={adminId} onChange={setAdminId} options={people} none="Not set" searchPlaceholder="Search people" />
        </div>
        <div className="space-y-1">
          <span className={label}>RENEWALS HANDLED BY</span>
          <Picker value={renewalsId} onChange={setRenewalsId} options={people} none="The administrator" searchPlaceholder="Search people" />
        </div>
      </div>

      <div className="space-y-1">
        <span className={label}>BUILDING IN SAIFSYS</span>
        <p className="text-xs text-mute">Tick the one this is in saifsys. Tick several if this name covers more than one.</p>
        <div className="flex flex-wrap gap-1.5">
          {opts.sites.map((s) => (
            <button key={s.id} type="button" onClick={() => toggle(s.id)}
              className={`rounded-full border px-3 py-1 text-sm transition ${sites.includes(s.id) ? 'border-p1/60 bg-p1/15' : 'border-stroke text-mute hover:text-txt'}`}>{s.name}</button>
          ))}
          {opts.sites.length === 0 && <p className="text-xs text-mute">saifsys gave no buildings.</p>}
        </div>
      </div>

      <div className="space-y-1.5">
        <span className={label}>CLEANERS AND TECHNICIANS</span>
        {staff.map((s) => (
          <div key={s.code} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate">{s.name} <span className="text-mute">· {s.code}</span></span>
            <div className="flex shrink-0 rounded-full bg-white/5 p-0.5 text-xs">
              {Object.entries(KIND).map(([k, l]) => (
                <button key={k} type="button" onClick={() => setStaff((list) => list.map((x) => (x.code === s.code ? { ...x, kind: k } : x)))}
                  className={`rounded-full px-2.5 py-1 transition ${s.kind === k ? 'bg-white/15 text-txt' : 'text-mute hover:text-txt'}`}>{l}</button>
              ))}
            </div>
            <button type="button" onClick={() => setStaff((list) => list.filter((x) => x.code !== s.code))} aria-label={`Remove ${s.name}`}
              className="grid size-7 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><X size={14} /></button>
          </div>
        ))}
        <StaffSearch taken={staff.map((s) => s.code)} onAdd={(s) => setStaff((list) => [...list, s])} />
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex items-center gap-2">
        {start && (
          <button type="button" onClick={remove} disabled={!!busy} aria-label="Delete" title="Delete"
            className="grid size-10 shrink-0 place-items-center rounded-full border border-stroke text-mute transition hover:border-bad/50 hover:text-bad disabled:opacity-50"><Trash2 size={16} /></button>
        )}
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={!!busy || !name.trim()} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// ---------- the list ----------

function BuildingCard({ b, onOpen }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get(`/buildings/${b.id}/jobs`).then(setData).catch(() => setData({ failed: true })); }, [b.id]);
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-2xl bg-white/5 px-4 py-3 text-left transition hover:bg-white/[0.08]">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-p1/25 to-p2/10 text-p1"><Building2 size={19} strokeWidth={1.6} /></span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{b.name}</p>
        <p className="text-xs text-mute">{b.admin?.name || 'No administrator yet'} · {b.staff.length} staff</p>
        <p className="mt-0.5 text-xs">
          {!data ? <span className="text-mute">…</span>
            : data.failed ? <span className="text-mute">Could not reach saifsys</span>
              : data.unset ? <span className="text-mute">Not set up yet</span>
                : <Summary jobs={data.jobs} />}
        </p>
      </div>
      <ChevronRight size={18} className="shrink-0 text-mute" />
    </button>
  );
}

export default function BuildingsPage({ me, start, onBack }) {
  const master = me.role === 'master';
  const [rows, setRows] = useState(null);
  const [openId, setOpenId] = useState(start?.building || null);
  const [editing, setEditing] = useState(null); // an id, 'new', or null
  const load = useCallback(() => api.get('/buildings').then(setRows).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  // A notification tapped while this page was already open.
  useEffect(() => { if (start?.building) { setOpenId(start.building); setEditing(null); } }, [start]);

  const saved = async () => { setEditing(null); await load(); };
  // Someone with a single building has nothing to choose between.
  const only = rows?.length === 1 && !master ? rows[0] : null;
  const open = only || rows?.find((b) => b.id === openId) || null;
  const back = open && !only && !editing ? () => setOpenId(null) : onBack;

  return (
    <Page title={open ? open.name : 'Buildings'} onBack={back}>
      {rows === null && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />}
      {rows && editing && (
        <Editor start={editing === 'new' ? null : rows.find((b) => b.id === editing)} onCancel={() => setEditing(null)} onSaved={saved} />
      )}
      {rows && !editing && open && (
        <BuildingView key={open.id} b={open} master={master} startJob={start?.building === open.id ? start.job : null} onEdit={() => setEditing(open.id)} />
      )}
      {rows && !editing && !open && (
        <div className="space-y-2.5">
          {master && (
            <button onClick={() => setEditing('new')}
              className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke/70 py-2.5 text-sm text-mute hover:bg-white/5 hover:text-txt">
              <Plus size={16} /> New building
            </button>
          )}
          {rows.length === 0 && (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <span className="grid size-20 place-items-center rounded-3xl bg-gradient-to-br from-p1/25 to-p2/10 text-p1"><Building2 size={34} strokeWidth={1.4} /></span>
              <div>
                <p className="text-lg font-light">No buildings yet</p>
                <p className="max-w-xs text-sm text-mute">{master
                  ? 'Add a building, pick its administrator and the cleaners and technicians given to it.'
                  : 'You have not been given a building yet.'}</p>
              </div>
            </div>
          )}
          {rows.map((b) => <BuildingCard key={b.id} b={b} onOpen={() => setOpenId(b.id)} />)}
        </div>
      )}
    </Page>
  );
}
