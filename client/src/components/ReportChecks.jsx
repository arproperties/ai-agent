import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Pencil, Copy, Check, X, RotateCw, FileText, History, Sparkles, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// Settings → Report checks (server/reportChecks.js). Reem reads each work report as it comes
// in and lists what is missing against the report's own list. Here the master sees every
// day's report, copies the note for the writer into WhatsApp (nothing is sent from Reem),
// and changes the lists. Anyone else with the module only reads.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const niceDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const hour = (h) => `${String(h).padStart(2, '0')}:00`;
const workDays = (s) => (String(s) === '0123456' ? 'every day' : [...String(s)].map((d) => DAYS[d]).join(', '));

function Pill({ tone, children }) {
  const tones = { ok: 'bg-ok/20 text-ok', warn: 'bg-warn/20 text-warn', bad: 'bg-bad/20 text-bad', mute: 'bg-white/[0.06] text-mute' };
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${tones[tone]}`}>{children}</span>;
}

function dayStatus(d) {
  if (d.missing) return d.late ? <Pill tone="bad">No report</Pill> : <Pill tone="mute">Not due yet</Pill>;
  const n = d.check.gaps.length;
  if (!n) return <Pill tone="ok">Complete</Pill>;
  const note = { waiting: ' · note to send', sent: ' · note sent', dismissed: '', replaced: '', past: '', none: '' }[d.check.note_state] || '';
  return <Pill tone="warn">{n} missing{note}</Pill>;
}

function CheckDetail({ check, master, onChanged }) {
  const [note, setNote] = useState(check.note);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => setNote(check.note), [check.id, check.note]);

  const act = async (what, fn) => {
    setBusy(what); setError('');
    try { await fn(); await onChanged(); } catch (e) { setError(e.message); }
    setBusy('');
  };
  // Copying is the sending: the master pastes it into WhatsApp, so it is marked sent then.
  const copy = () => act('copy', async () => {
    try { await navigator.clipboard.writeText(note); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the text is on screen to copy by hand */ }
    await api.post(`/report-checks/checks/${check.id}/note`, { state: 'sent', note });
  });
  const dismiss = () => act('dismiss', () => api.post(`/report-checks/checks/${check.id}/note`, { state: 'dismissed', note }));
  const recheck = () => act('recheck', () => api.post(`/report-checks/checks/${check.id}/recheck`));
  const open = check.note_state === 'waiting';

  return (
    <div className="space-y-3 px-4 pb-4 text-sm">
      {check.summary && <p className="text-mute">{check.summary}</p>}
      {check.gaps.length > 0 ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-wide text-mute">Missing</p>
          <ul className="space-y-1.5">
            {check.gaps.map((g, i) => (
              <li key={i} className="flex gap-2"><X size={15} className="mt-0.5 shrink-0 text-warn" />
                <span><span className="font-medium">{g.item}</span>{g.missing && <span className="text-mute"> - {g.missing}</span>}</span></li>
            ))}
          </ul>
        </div>
      ) : <p className="flex items-center gap-2 text-ok"><Check size={15} /> Everything on the list is there.</p>}

      {check.note && (
        <div>
          <p className="mb-1 text-xs uppercase tracking-wide text-mute">Message for the writer {check.note_state === 'sent' && '· sent'}{check.note_state === 'dismissed' && '· dismissed'}{check.note_state === 'replaced' && '· a newer copy came in'}{check.note_state === 'past' && '· from before Reem was watching'}</p>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} readOnly={!master || !open} rows={Math.min(10, note.split('\n').length + 1)}
            className={`${FIELD} resize-y text-sm`} />
        </div>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {master && check.note && (
          <button onClick={copy} disabled={!!busy}
            className="flex items-center gap-1.5 rounded-full border border-p1/50 bg-p1/15 px-3.5 py-1.5 text-sm font-medium hover:bg-p1/25 disabled:opacity-50">
            {busy === 'copy' ? <Loader2 size={14} className="animate-spin" /> : copied ? <Check size={14} /> : <Copy size={14} />} Copy for WhatsApp
          </button>
        )}
        {master && open && (
          <button onClick={dismiss} disabled={!!busy} className="rounded-full border border-stroke px-3.5 py-1.5 text-sm text-mute hover:text-txt disabled:opacity-50">
            {busy === 'dismiss' ? <Loader2 size={14} className="animate-spin" /> : 'Dismiss'}
          </button>
        )}
        {check.document_id && (
          <a href={`/api/documents/${check.document_id}/file`} target="_blank" rel="noreferrer"
            className="flex items-center gap-1.5 rounded-full border border-stroke px-3.5 py-1.5 text-sm text-mute hover:text-txt"><FileText size={14} /> Open the report</a>
        )}
        {master && check.document_id && (
          <button onClick={recheck} disabled={!!busy} title="Read it again against the list as it is now"
            className="flex items-center gap-1.5 rounded-full border border-stroke px-3.5 py-1.5 text-sm text-mute hover:text-txt disabled:opacity-50">
            {busy === 'recheck' ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />} Check again
          </button>
        )}
      </div>
    </div>
  );
}

function DayRow({ day, master, openId, onOpen, onChanged }) {
  const id = day.check?.id;
  const open = !!id && openId === id;
  return (
    <li className="glass overflow-hidden rounded-2xl">
      <button disabled={!id} onClick={() => onOpen(open ? null : id)} className="flex w-full items-center gap-3 px-4 py-3 text-left disabled:cursor-default">
        {id ? (open ? <ChevronDown size={16} className="shrink-0 text-mute" /> : <ChevronRight size={16} className="shrink-0 text-mute" />) : <span className="w-4 shrink-0" />}
        <span className="flex-1">
          <span className="block">{niceDay(day.date)}</span>
          {day.check && <span className="block truncate text-xs text-mute">{day.check.title}</span>}
        </span>
        {dayStatus(day)}
      </button>
      {open && <CheckDetail check={day.check} master={master} onChanged={onChanged} />}
      {open && day.earlier.length > 0 && (
        <div className="border-t border-stroke px-4 py-2 text-xs text-mute">
          <span className="flex items-center gap-1.5"><History size={13} /> Earlier copies of this day:</span>
          {day.earlier.map((e) => (
            <a key={e.id} href={e.document_id ? `/api/documents/${e.document_id}/file` : undefined} target="_blank" rel="noreferrer" className="ml-5 block truncate hover:text-txt">
              {e.title} · {e.gaps.length ? `${e.gaps.length} missing` : 'complete'}
            </a>
          ))}
        </div>
      )}
    </li>
  );
}

function TypeForm({ type, onSaved, onCancel, onDeleted }) {
  const [t, setT] = useState(() => ({
    name: type?.name || '', writer: type?.writer || '', about: type?.about || '',
    items: type?.items?.length ? type.items : [''], due_hour: type?.due_hour ?? 12, work_days: type?.work_days ?? '123456', active: type?.active ?? true,
  }));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const set = (k, v) => setT((o) => ({ ...o, [k]: v }));
  const setItem = (i, v) => set('items', t.items.map((x, k) => (k === i ? v : x)));
  const flipDay = (d) => set('work_days', t.work_days.includes(d) ? t.work_days.replace(d, '') : [...t.work_days, d].sort().join(''));

  const draft = async () => {
    setBusy('draft'); setError('');
    try { set('items', (await api.post('/report-checks/draft-items', { name: t.name, about: t.about })).items); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy('save'); setError('');
    try {
      const body = { ...t, items: t.items.filter((i) => i.trim()), due_hour: Number(t.due_hour) };
      onSaved(type ? await api.patch(`/report-checks/types/${type.id}`, body) : await api.post('/report-checks/types', body));
    } catch (err) { setError(err.message); }
    setBusy('');
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${type.name}" and every check of it?`)) return;
    try { await api.del(`/report-checks/types/${type.id}`); onDeleted(); } catch (e) { setError(e.message); }
  };

  return (
    <form onSubmit={save} className="glass space-y-3 rounded-2xl p-4 text-sm">
      <label className="block"><span className="mb-1 block text-xs text-mute">Report name</span>
        <input value={t.name} onChange={(e) => set('name', e.target.value)} placeholder="Cleaning daily report" className={FIELD} /></label>
      <label className="block"><span className="mb-1 block text-xs text-mute">Who writes it</span>
        <input value={t.writer} onChange={(e) => set('writer', e.target.value)} placeholder="Faisal" className={FIELD} /></label>
      <label className="block"><span className="mb-1 block text-xs text-mute">What it is (so Reem can find it among the files)</span>
        <textarea value={t.about} onChange={(e) => set('about', e.target.value)} rows={3} className={`${FIELD} resize-y`}
          placeholder="Photos of the day's cleaning report from the cleaning team, shared from WhatsApp" /></label>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="flex-1 text-xs text-mute">A complete report has</span>
          <button type="button" onClick={draft} disabled={!!busy || !t.name.trim()} className="flex items-center gap-1 text-xs text-p1 disabled:opacity-50">
            {busy === 'draft' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Let Reem write it
          </button>
        </div>
        <div className="space-y-1.5">
          {t.items.map((item, i) => (
            <div key={i} className="flex gap-1.5">
              <input value={item} onChange={(e) => setItem(i, e.target.value)} className={FIELD} />
              <button type="button" aria-label="Remove" onClick={() => set('items', t.items.filter((_, k) => k !== i))}
                className="grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><X size={15} /></button>
            </div>
          ))}
          <button type="button" onClick={() => set('items', [...t.items, ''])} className="flex items-center gap-1 text-xs text-mute hover:text-txt"><Plus size={13} /> Add a point</button>
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs text-mute">A report is expected on</span>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d, i) => (
            <button type="button" key={d} onClick={() => flipDay(String(i))}
              className={`rounded-full border px-3 py-1 text-xs ${t.work_days.includes(String(i)) ? 'border-p1/60 bg-p1/15' : 'border-stroke text-mute'}`}>{d}</button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2"><span className="text-xs text-mute">Each day&apos;s report is due the next day by</span>
        <input type="number" min={0} max={23} value={t.due_hour} onChange={(e) => set('due_hour', e.target.value)} className="glass w-16 rounded-xl px-2 py-1.5 text-center outline-none" />
        <span className="text-xs text-mute">:00</span></label>
      <label className="flex items-center gap-2 text-xs text-mute">
        <input type="checkbox" checked={t.active} onChange={(e) => set('active', e.target.checked)} /> Reem checks this report and buzzes about it
      </label>

      {error && <p className="text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={!!busy} className="flex items-center gap-1.5 rounded-full border border-p1/50 bg-p1/15 px-4 py-1.5 font-medium hover:bg-p1/25 disabled:opacity-50">
          {busy === 'save' && <Loader2 size={14} className="animate-spin" />} Save
        </button>
        <button type="button" onClick={onCancel} className="rounded-full px-3 py-1.5 text-mute hover:text-txt">Cancel</button>
        {type && <button type="button" onClick={remove} className="ml-auto flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-mute hover:text-bad"><Trash2 size={13} /> Delete</button>}
      </div>
    </form>
  );
}

function Backfill({ type, onStarted }) {
  const [error, setError] = useState('');
  const b = type.backfill;
  const running = b?.state === 'running';
  const start = async () => {
    setError('');
    try { await api.post(`/report-checks/types/${type.id}/backfill`, { days: 30 }); onStarted(); } catch (e) { setError(e.message); }
  };
  return (
    <div className="text-xs text-mute">
      {running ? (
        <span className="flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" />
          Going through the last {b.days} days: {b.found ? `${b.checked} of ${b.found} reports checked` : `looking at ${b.files} files`}…</span>
      ) : (
        <button onClick={start} className="flex items-center gap-1.5 hover:text-txt"><History size={13} /> Check the reports of the last 30 days</button>
      )}
      {b?.state === 'done' && !running && <span className="mt-1 block">Last time: {b.checked} report{b.checked === 1 ? '' : 's'} found in {b.days} days.</span>}
      {b?.state === 'failed' && <span className="mt-1 block text-bad">That stopped: {b.error}</span>}
      {error && <span className="mt-1 block text-bad">{error}</span>}
    </div>
  );
}

export default function ReportChecks({ onBack, focus = null }) {
  const [data, setData] = useState(null);
  const [typeId, setTypeId] = useState(null);
  const [days, setDays] = useState(null);
  const [openId, setOpenId] = useState(typeof focus === 'number' ? focus : null);
  const [editing, setEditing] = useState(null); // 'new' | type id
  const [error, setError] = useState('');

  const loadTypes = useCallback(async () => {
    const d = await api.get('/report-checks');
    setData(d);
    return d;
  }, []);
  const loadDays = useCallback(async (id) => { if (id) setDays(await api.get(`/report-checks/types/${id}/days?days=30`)); }, []);

  useEffect(() => {
    (async () => {
      try {
        const d = await loadTypes();
        let pick = d.types[0]?.id ?? null;
        // A buzz about one report opens straight on it.
        if (typeof focus === 'number') pick = (await api.get(`/report-checks/checks/${focus}`).catch(() => null))?.type_id ?? pick;
        setTypeId(pick);
      } catch (e) { setError(e.message); }
    })();
  }, [focus, loadTypes]);
  useEffect(() => { setDays(null); loadDays(typeId).catch((e) => setError(e.message)); }, [typeId, loadDays]);

  const type = data?.types.find((t) => t.id === typeId);
  // While the past is being gone through, the counts on screen follow it.
  useEffect(() => {
    if (type?.backfill?.state !== 'running') return undefined;
    const t = setInterval(() => { loadTypes().catch(() => {}); loadDays(typeId).catch(() => {}); }, 4000);
    return () => clearInterval(t);
  }, [type?.backfill?.state, typeId, loadTypes, loadDays]);

  const refresh = async () => { await Promise.all([loadTypes(), loadDays(typeId)]); };
  const master = !!data?.master;

  return (
    <Page title="Report checks" onBack={onBack}
      action={master && <button onClick={() => setEditing('new')} className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1.5 text-sm text-mute hover:text-txt"><Plus size={15} /> New report</button>}>
      {error && <p className="mb-3 text-sm text-bad">{error}</p>}
      {!data ? <Loader2 className="mx-auto mt-10 animate-spin text-mute" /> : (
        <div className="mx-auto max-w-2xl space-y-4">
          {editing === 'new' && (
            <TypeForm onCancel={() => setEditing(null)} onDeleted={() => {}}
              onSaved={async (t) => { setEditing(null); await loadTypes(); setTypeId(t.id); }} />
          )}
          {data.types.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {data.types.map((t) => (
                <button key={t.id} onClick={() => { setTypeId(t.id); setOpenId(null); setEditing(null); }}
                  className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm ${t.id === typeId ? 'border-p1/60 bg-p1/15' : 'border-stroke text-mute hover:text-txt'}`}>
                  {t.name}{t.waiting > 0 && <span className="rounded-full bg-warn px-1.5 text-[11px] font-semibold text-ink">{t.waiting}</span>}
                </button>
              ))}
            </div>
          )}
          {!data.types.length && editing !== 'new' && <p className="text-sm text-mute">No reports yet. {master ? 'Tap New report to add one.' : ''}</p>}

          {type && (editing === type.id ? (
            <TypeForm type={type} onCancel={() => setEditing(null)}
              onDeleted={async () => { setEditing(null); const d = await loadTypes(); setTypeId(d.types[0]?.id ?? null); }}
              onSaved={async () => { setEditing(null); await refresh(); }} />
          ) : (
            <div className="glass space-y-2 rounded-2xl p-4 text-sm">
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <p className="text-base">{type.name}{!type.active && <span className="ml-2 text-xs text-mute">(paused)</span>}</p>
                  <p className="text-xs text-mute">{type.writer ? `By ${type.writer} · ` : ''}expected {workDays(type.work_days)}, due the next day by {hour(type.due_hour)}</p>
                </div>
                {master && <button onClick={() => setEditing(type.id)} aria-label="Edit" className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>}
              </div>
              <details className="text-xs text-mute">
                <summary className="cursor-pointer hover:text-txt">What a complete report has ({type.items.length})</summary>
                <ol className="mt-1 list-decimal space-y-0.5 pl-5">{type.items.map((i) => <li key={i}>{i}</li>)}</ol>
              </details>
              {master && <Backfill type={type} onStarted={refresh} />}
            </div>
          ))}

          {type && !days && <Loader2 className="mx-auto animate-spin text-mute" />}
          {type && days && (days.days.length ? (
            <ul className="space-y-2">
              {days.days.map((d) => <DayRow key={d.date} day={d} master={master} openId={openId} onOpen={setOpenId} onChanged={refresh} />)}
            </ul>
          ) : <p className="text-sm text-mute">Nothing in the last 30 days yet. Reports are checked as they arrive{master ? ', or check the past ones above' : ''}.</p>)}
        </div>
      )}
    </Page>
  );
}
