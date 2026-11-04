import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Building2, Check, ChevronLeft, ChevronRight, Download, FileUp, Image, List, Loader2, MessageSquare, RotateCcw, SkipForward, Split, Users } from 'lucide-react';
import { api } from '../lib/api';
import { zipEntries, zipRead, baseName } from '../lib/zip';
import Page from './Page';
import Sheet from './Sheet';
import Picker from './Picker';

// Attendance: who worked which day, checked one person at a time for each pay period
// (26th to 25th). Lists come in as a WhatsApp export, an Excel/CSV/PDF file or a photo;
// Reem reads them (server/attendanceRead.js). Here each person is shown with every day of
// the period. Those on a list every day except single days off come first and need one
// tap; the others say why (days on no list, two companies the same day). Tapping a day
// shows the message or photo it was read from, and it can be changed by hand.
// The server is server/attendance.js.

const CODE = {
  P: ['Present', 'bg-ok/25 text-ok'],
  L: ['Late', 'bg-warn/25 text-warn'],
  A: ['Absent', 'bg-bad/25 text-bad'],
  V: ['Vacation', 'bg-p3/25 text-p3'],
  O: ['Day off', 'bg-white/10 text-mute'],
  S: ['Sick', 'bg-p2/25 text-p2'],
  '?': ['Other', 'bg-white/10 text-mute'],
};
const STATUS = [['present', 'P'], ['late', 'L'], ['absent', 'A'], ['vacation', 'V'], ['off', 'O'], ['sick', 'S']];
const TABS = [['to_verify', 'To verify'], ['verified', 'Verified'], ['skipped', 'Skipped']];
const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const day = (d) => new Date(`${d}T00:00:00Z`);
const short = (d) => day(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekday = (d) => day(d).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const periodName = (p) => `${short(p.start)} – ${short(p.end)}`;

/** Every day of the period as a calendar, Monday first. */
function Days({ person, onDay }) {
  const lead = (day(person.days[0].d).getUTCDay() + 6) % 7;
  // A day on no list that is part of two or more in a row is what makes a person need a look.
  const inGap = new Set();
  person.days.forEach((x, i) => {
    if (x.s !== '') return;
    if (person.days[i - 1]?.s === '' || person.days[i + 1]?.s === '') inGap.add(x.d);
  });
  return (
    <div>
      <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[11px] text-mute">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => <span key={w}>{w}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: lead }, (_, i) => <span key={`l${i}`} />)}
        {person.days.map((x) => {
          const look = x.s ? CODE[x.s][1] : x.s === null ? 'text-mute/40' : inGap.has(x.d) ? 'border border-dashed border-bad/70 text-bad' : 'bg-white/[0.03] text-mute';
          return (
            <button key={x.d} disabled={x.s === null} onClick={() => onDay(x.d)} title={x.h || ''}
              className={`relative flex h-14 flex-col items-center justify-center rounded-xl text-sm transition enabled:hover:brightness-125 ${look}`}>
              <span className="text-[11px] opacity-70">{day(x.d).getUTCDate()}</span>
              <span className="font-medium">{x.s || (x.s === '' ? '–' : '')}</span>
              {x.m && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-p1" title="Changed by hand" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One day as it was read, and changing it by hand. */
function DaySheet({ person, date, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [hours, setHours] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get(`/attendance/people/${person.id}/days/${date}`).then((d) => {
    setData(d); setHours(d.merged?.hours || '');
  }).catch((e) => setError(e.message)), [person.id, date]);
  useEffect(() => { load(); }, [load]);

  const save = async (status) => {
    setBusy(true);
    try { setData(await api.put(`/attendance/people/${person.id}/days/${date}`, { status, hours: status ? hours : '' })); onChanged(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  };
  const manual = data?.entries.some((e) => e.source === 'manual');

  return (
    <Sheet title={`${person.name} · ${weekday(date)} ${short(date)}`} onClose={onClose}>
      <div className="space-y-4 overflow-y-auto px-5 pb-6">
        {error && <p className="text-sm text-bad">{error}</p>}
        {!data ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
          <>
            {!data.entries.length && <p className="text-sm text-mute">No list had {person.name} on this day.</p>}
            {data.entries.map((e) => (
              <div key={e.id} className="rounded-2xl bg-white/[0.04] p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${CODE[STATUS.find(([s]) => s === e.status)?.[1] || '?'][1]}`}>
                    {CODE[STATUS.find(([s]) => s === e.status)?.[1] || '?'][0]}
                  </span>
                  {e.hours && <span>{e.hours}</span>}
                  <span className="text-mute">{e.company}{e.section ? ` · ${e.section}` : ''}</span>
                </div>
                <p className="mt-1 text-xs text-mute">
                  {e.source === 'manual' ? `Changed by hand by ${e.edited_by || e.posted_by}` : `Written "${e.written_name}"${e.posted_by ? ` by ${e.posted_by}` : ''}${e.source_time ? ` at ${e.source_time}` : ''}`}
                  {e.source_day && e.source_day !== date ? `, sent ${short(e.source_day)}` : ''}
                  {e.note ? ` · ${e.note}` : ''}
                </p>
                {e.message && (
                  <details className="mt-2">
                    <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-p1"><MessageSquare size={13} /> The message</summary>
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-black/20 p-3 font-sans text-[13px] leading-snug">{e.message.text}</pre>
                  </details>
                )}
                {e.photo && (
                  <a href={`/api/attendance/photos/${encodeURIComponent(e.photo)}`} target="_blank" rel="noreferrer" className="mt-2 block">
                    <img src={`/api/attendance/photos/${encodeURIComponent(e.photo)}`} alt="The list it was read from" className="max-h-64 rounded-xl" />
                  </a>
                )}
              </div>
            ))}
            {data.photos.length > 0 && (
              <p className="flex items-start gap-2 text-xs text-mute"><Image size={14} className="mt-0.5 shrink-0" />
                Team photos that day: {Object.entries(data.photos.reduce((by, p) => ({ ...by, [p.posted_by]: [...(by[p.posted_by] || []), p] }), {})).map(([who, ps]) => {
                  const most = Math.max(...ps.map((p) => p.headcount));
                  return `${who}: ${ps.length} photo${ps.length > 1 ? 's' : ''} at ${ps[0].sent}${ps.length > 1 ? `–${ps.at(-1).sent}` : ''}${most ? `, up to ${most} ${most > 1 ? 'people' : 'person'} in one` : ''}`;
                }).join(' · ')}
              </p>
            )}
            <div className="rounded-2xl border border-stroke p-3">
              <p className="mb-2 text-sm">Change this day</p>
              <input value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Timing, e.g. 7am-5pm" className={FIELD} />
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                {STATUS.map(([s, c]) => (
                  <button key={s} disabled={busy} onClick={() => save(s)} className={`rounded-xl py-2 text-sm ${CODE[c][1]}`}>{CODE[c][0]}</button>
                ))}
              </div>
              {manual && (
                <button disabled={busy} onClick={() => save('')} className="mt-2 flex items-center gap-1.5 text-sm text-mute hover:text-txt">
                  <RotateCcw size={14} /> Take back the change
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** Sending attendance: a WhatsApp export (zip, or the chat text alone), a sheet, a PDF or photos. */
function AddSheet({ companies, onClose, onStarted }) {
  const [files, setFiles] = useState([]);
  const [company, setCompany] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const first = files[0]?.name.toLowerCase() || '';
  const kind = !files.length ? null : /\.zip$/.test(first) || /\.txt$/.test(first) ? 'whatsapp'
    : /\.(xlsx|csv)$/.test(first) ? 'sheet' : /\.pdf$/.test(first) ? 'pdf' : 'photo';

  const sendBatches = async (id, items) => {
    // About 20 MB a request, under the server's limits.
    let batch = [], size = 0, sent = 0;
    const flush = async () => {
      if (!batch.length) return;
      const form = new FormData();
      for (const [blob, name] of batch) form.append('files', blob, name);
      await api.upload(`/attendance/imports/${id}/files`, form);
      sent += batch.length; batch = []; size = 0;
      setBusy(`Sending ${sent} of ${items.length}…`);
    };
    for (const it of items) {
      const blob = await it.blob();
      if (size + blob.size > 20 * 1024 * 1024 || batch.length >= 40) await flush();
      batch.push([blob, it.name]); size += blob.size;
    }
    await flush();
  };

  const start = async () => {
    setError('');
    try {
      let items;
      if (kind === 'whatsapp' && /\.zip$/.test(first)) {
        setBusy('Opening the export…');
        const zip = files[0];
        const entries = await zipEntries(zip);
        const chat = entries.find((e) => /_chat\.txt$|\.txt$/i.test(baseName(e.name)));
        if (!chat) throw new Error('This zip has no chat in it. In WhatsApp: the group → Export chat → Include media.');
        const photos = entries.filter((e) => /-PHOTO-.*\.(jpe?g|png|webp)$/i.test(baseName(e.name)));
        // Only photos never read before go up: last month's are already done.
        const fresh = new Set();
        for (let i = 0; i < photos.length; i += 1000) {
          const { names } = await api.post('/attendance/imports/new-photos', { names: photos.slice(i, i + 1000).map((e) => baseName(e.name)) });
          names.forEach((n) => fresh.add(n));
        }
        items = [{ name: '_chat.txt', blob: () => zipRead(zip, chat) },
          ...photos.filter((e) => fresh.has(baseName(e.name))).map((e) => ({ name: baseName(e.name), blob: () => zipRead(zip, e) }))];
      } else if (kind === 'whatsapp') {
        items = [{ name: '_chat.txt', blob: async () => files[0] }];
      } else {
        items = files.map((f) => ({ name: f.name, blob: async () => f }));
      }
      const imp = await api.post('/attendance/imports', { kind, file_name: files.map((f) => f.name).join(', '), company, list_date: date });
      setBusy('Sending…');
      await sendBatches(imp.id, items);
      await api.post(`/attendance/imports/${imp.id}/start`);
      onStarted();
    } catch (e) {
      setError(e.message); setBusy('');
    }
  };

  return (
    <Sheet title="Add attendance" onClose={busy ? () => {} : onClose}>
      <div className="space-y-4 overflow-y-auto px-5 pb-6">
        <p className="text-sm text-mute">
          A WhatsApp group: open the group → ⋮ → More → Export chat → Include media, and choose the zip here. Only what is new is read.
          Or an Excel, CSV or PDF sheet, or photos of a list.
        </p>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-stroke py-6 text-sm hover:bg-white/[0.03]">
          <FileUp size={18} /> {files.length ? files.map((f) => f.name).join(', ') : 'Choose a file'}
          <input type="file" className="hidden" multiple accept=".zip,.txt,.xlsx,.csv,.pdf,image/*"
            onChange={(e) => setFiles([...e.target.files])} />
        </label>
        {kind && kind !== 'whatsapp' && (
          <>
            <div>
              <p className="mb-1 text-sm">Company <span className="text-mute">(if the file does not say)</span></p>
              <Picker value={company} onChange={setCompany} none="The file says" onNew={setCompany}
                options={companies.map((c) => ({ value: c, label: c }))} placeholder="The file says" />
            </div>
            <div>
              <p className="mb-1 text-sm">Date of the list <span className="text-mute">(if it has none)</span></p>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={FIELD} />
            </div>
          </>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
        <button disabled={!kind || !!busy} onClick={start}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-p1 py-3 font-medium text-white disabled:opacity-40">
          {busy ? <><Loader2 size={16} className="animate-spin" /> {busy}</> : 'Read it'}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * Which company each list went to. Reem sorts a new list once and remembers it; when it got
 * one wrong (a list with no label, from someone who posts for two teams), it is put right
 * here and every day read from that list moves with it.
 */
function ListsSheet({ onClose, onChanged }) {
  const [teams, setTeams] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/attendance/teams').then(setTeams).catch((e) => setError(e.message)); }, []);
  const companies = useMemo(() => [...new Set((teams || []).map((t) => t.company))].sort(), [teams]);
  const move = async (t, company) => {
    if (!company || company === t.company) return;
    try { setTeams(await api.put('/attendance/teams', { poster: t.poster, team: t.team, company, section: t.section })); onChanged(); }
    catch (e) { setError(e.message); }
  };
  return (
    <Sheet title="Lists and companies" onClose={onClose} wide>
      <div className="overflow-y-auto px-5 pb-6">
        <p className="mb-3 text-sm text-mute">Each list as it is posted (who sends it, and the name it gives), and the company it counts for. Change one and its days move.</p>
        {error && <p className="mb-2 text-sm text-bad">{error}</p>}
        {!teams ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : companies.map((c) => (
          <div key={c} className="mb-4">
            <p className="mb-1 text-sm font-medium">{c}</p>
            <ul className="divide-y divide-stroke rounded-2xl bg-white/[0.03]">
              {teams.filter((t) => t.company === c).map((t) => (
                <li key={`${t.poster}|${t.team}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{t.team || <span className="text-mute">(no name on the list)</span>}{t.section ? <span className="text-mute"> · {t.section}</span> : ''}</span>
                    <span className="block truncate text-xs text-mute">sent by {t.poster || 'a file'} · {t.rows} days</span>
                  </span>
                  <div className="w-48"><Picker value={t.company} onChange={(v) => move(t, v)} onNew={(v) => move(t, v)} searchPlaceholder="Company, or type a new one"
                    options={companies.map((x) => ({ value: x, label: x }))} /></div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

/** What is being read right now, until it is done. */
function Imports({ imports }) {
  const live = imports.filter((i) => ['queued', 'reading'].includes(i.status));
  const failed = imports.filter((i) => i.status === 'failed').slice(0, 1);
  if (!live.length && !failed.length) return null;
  return (
    <div className="mb-3 space-y-2">
      {live.map((i) => (
        <div key={i.id} className="glass rounded-2xl px-4 py-3 text-sm">
          <div className="flex items-center gap-2"><Loader2 size={15} className="animate-spin text-p1" />
            <span className="flex-1 truncate">{i.step || 'Reading'} · {i.file_name}</span>
            {i.total > 0 && <span className="text-mute">{i.done} of {i.total}</span>}
          </div>
          {i.total > 0 && <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-p1" style={{ width: `${(100 * i.done) / i.total}%` }} /></div>}
        </div>
      ))}
      {failed.map((i) => (
        <p key={i.id} className="flex items-start gap-2 rounded-2xl bg-bad/10 px-4 py-3 text-sm text-bad">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {i.file_name}: {i.error}
        </p>
      ))}
    </div>
  );
}

export default function AttendancePage({ onBack }) {
  const [periods, setPeriods] = useState(null);
  const [start, setStart] = useState(null);
  const [period, setPeriod] = useState(null);
  const [tab, setTab] = useState('to_verify');
  const [at, setAt] = useState(0);
  const [list, setList] = useState(false);
  const [openDay, setOpenDay] = useState(null);
  const [adding, setAdding] = useState(false);
  const [imports, setImports] = useState([]);
  const [people, setPeople] = useState([]);
  const [same, setSame] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const wasReading = useRef(false);
  const [watch, setWatch] = useState(0);
  const [lists, setLists] = useState(false); // bumped when something is sent, to look again at once

  const loadPeriods = useCallback(() => api.get('/attendance/periods').then((ps) => {
    setPeriods(ps);
    // The period just finished is the one to check; the one under way only once it is the only one.
    const today = new Date().toISOString().slice(0, 10);
    setStart((s) => s || (ps.find((p) => p.end < today) || ps[0])?.start || null);
  }).catch((e) => setError(e.message)), []);
  const loadPeriod = useCallback(() => (start ? api.get(`/attendance/periods/${start}`).then(setPeriod).catch((e) => setError(e.message)) : null), [start]);
  useEffect(() => { loadPeriods(); }, [loadPeriods]);
  useEffect(() => { setPeriod(null); setAt(0); loadPeriod(); }, [loadPeriod]);

  // While something is being read, look every few seconds; when it finishes, show what it found.
  useEffect(() => {
    let stop = false, timer;
    const tick = async () => {
      try {
        const list = await api.get('/attendance/imports');
        if (stop) return;
        setImports(list);
        const reading = list.some((i) => ['queued', 'reading'].includes(i.status));
        if (wasReading.current && !reading) { loadPeriods(); loadPeriod(); }
        wasReading.current = reading;
        timer = setTimeout(tick, reading ? 3000 : 30000);
      } catch { timer = setTimeout(tick, 30000); }
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [loadPeriods, loadPeriod, watch]);

  const inTab = useMemo(() => (period?.people || []).filter((p) => p.state === tab), [period, tab]);
  const counts = useMemo(() => Object.fromEntries(TABS.map(([k]) => [k, (period?.people || []).filter((p) => p.state === k).length])), [period]);
  const person = inTab[Math.min(at, inTab.length - 1)];
  const companies = useMemo(() => [...new Set((period?.people || []).flatMap((p) => p.companies))].sort(), [period]);
  useEffect(() => { setSame(''); setNote(''); }, [person?.id]);

  const review = async (state) => {
    setBusy(true); setError('');
    try {
      await api.put(`/attendance/periods/${start}/people/${person.id}/review`, { state, note: state === 'skipped' ? note : '' });
      await loadPeriod(); loadPeriods();
      // The next person slides into the same place; at the end, stay on the last one.
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const merge = async (into) => {
    if (!into) return;
    const other = people.find((p) => p.id === Number(into));
    if (!confirm(`${person.name} and ${other?.name} are the same person? Their days join, and next month's lists will know.`)) return;
    setBusy(true);
    try { await api.post(`/attendance/people/${person.id}/merge`, { into: Number(into) }); await loadPeriod(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  };
  const split = async (company) => {
    if (!company || !confirm(`The days at ${company} are someone else with the same name? They become a separate person.`)) return;
    setBusy(true);
    try { await api.post(`/attendance/people/${person.id}/split`, { company }); await loadPeriod(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  };
  const rename = async () => {
    const name = prompt('Name', person.name);
    if (!name || name === person.name) return;
    try { await api.put(`/attendance/people/${person.id}`, { name }); await loadPeriod(); } catch (e) { setError(e.message); }
  };
  useEffect(() => { if (person) api.get('/attendance/people').then(setPeople).catch(() => {}); }, [person?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const action = (
    <div className="flex gap-1">
      {start && (
        <a href={`/api/attendance/periods/${start}/report`} title="Download the report" className="grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
          <Download size={19} />
        </a>
      )}
      <button onClick={() => setLists(true)} title="Lists and companies" className="grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
        <Building2 size={19} />
      </button>
      <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-full bg-p1 px-3.5 py-2 text-sm font-medium text-white">
        <FileUp size={16} /> Add
      </button>
    </div>
  );

  return (
    <Page title="Attendance" onBack={onBack} action={action}>
      <div className="mx-auto max-w-2xl">
        <Imports imports={imports} />
        {error && <p className="mb-3 text-sm text-bad">{error}</p>}
        {periods === null ? <Loader2 size={18} className="mx-auto my-10 animate-spin text-mute" /> : !periods.length ? (
          <div className="glass rounded-3xl p-6 text-center">
            <Users size={28} className="mx-auto mb-3 text-p1" />
            <p className="mb-1">No attendance yet</p>
            <p className="text-sm text-mute">Add the attendance WhatsApp group's export, or a sheet or photo of a list. Reem reads it and you check each person here.</p>
          </div>
        ) : (
          <>
            <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
              {periods.map((p) => (
                <button key={p.start} onClick={() => { setStart(p.start); setTab('to_verify'); }}
                  className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm transition ${p.start === start ? 'bg-white/15 text-txt' : 'bg-white/5 text-mute'}`}>
                  {periodName(p)} <span className="text-mute">· {p.verified}/{p.people}</span>
                </button>
              ))}
            </div>
            <div className="mb-4 grid grid-cols-3 rounded-full bg-white/5 p-1 text-sm">
              {TABS.map(([k, l]) => (
                <button key={k} onClick={() => { setTab(k); setAt(0); }}
                  className={`rounded-full py-1.5 transition ${tab === k ? 'bg-white/15 text-txt' : 'text-mute'}`}>{l} ({counts[k] || 0})</button>
              ))}
            </div>

            {!period ? <Loader2 size={18} className="mx-auto my-10 animate-spin text-mute" /> : !person ? (
              <p className="py-10 text-center text-sm text-mute">
                {tab === 'to_verify' ? 'Everyone in this period has been checked.' : tab === 'verified' ? 'Nobody verified yet.' : 'Nobody skipped.'}
              </p>
            ) : list ? (
              <ul className="glass divide-y divide-stroke rounded-3xl">
                {inTab.map((p, i) => (
                  <li key={p.id}>
                    <button onClick={() => { setAt(i); setList(false); }} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03]">
                      {p.complete ? <Check size={16} className="text-ok" /> : <AlertTriangle size={16} className="text-warn" />}
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="truncate text-xs text-mute">{p.companies.join(', ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="glass rounded-3xl p-4 md:p-5">
                <div className="mb-3 flex items-center gap-2 text-sm text-mute">
                  <button disabled={at === 0} onClick={() => setAt(at - 1)} aria-label="Previous" className="grid size-9 place-items-center rounded-full hover:bg-white/10 disabled:opacity-30"><ChevronLeft size={18} /></button>
                  <span className="flex-1 text-center">{Math.min(at, inTab.length - 1) + 1} of {inTab.length}</span>
                  <button disabled={at >= inTab.length - 1} onClick={() => setAt(at + 1)} aria-label="Next" className="grid size-9 place-items-center rounded-full hover:bg-white/10 disabled:opacity-30"><ChevronRight size={18} /></button>
                  <button onClick={() => setList(true)} aria-label="Everyone" className="grid size-9 place-items-center rounded-full hover:bg-white/10"><List size={17} /></button>
                </div>

                <button onClick={rename} className="text-left text-xl font-light hover:text-p1">{person.name}</button>
                <p className="mb-2 text-sm text-mute">{person.companies.join(' → ')}</p>
                {person.complete
                  ? <p className="mb-3 flex items-center gap-1.5 text-sm text-ok"><Check size={15} /> Complete: on a list every day except single days off</p>
                  : person.reasons.filter((r) => r.startsWith('Not on')).map((r) => <p key={r} className="mb-1 flex items-center gap-1.5 text-sm text-warn"><AlertTriangle size={15} /> {r}</p>)}
                {person.reasons.filter((r) => !r.startsWith('Not on')).map((r) => (
                  <p key={r} className="mb-1 flex items-center gap-1.5 text-sm text-warn"><Users size={15} /> {r} — the same person, or two people with one name?</p>
                ))}
                {person.review && <p className="mb-2 text-xs text-mute">{tab === 'verified' ? 'Verified' : 'Skipped'} by {person.review.by}{person.review.note ? `: ${person.review.note}` : ''}</p>}

                <div className="my-3"><Days person={person} onDay={setOpenDay} /></div>
                <p className="mb-4 text-xs text-mute">
                  Present {person.counts.present + person.counts.late} · Absent {person.counts.absent} · Vacation {person.counts.vacation} · Off {person.counts.off} · Sick {person.counts.sick} · On no list {person.counts.missing}
                  {period.coverEnd < period.end ? ` · lists read up to ${short(period.coverEnd)}` : ''}
                </p>

                <Picker value={same} onChange={(v) => { setSame(v); merge(v); }} placeholder="Same person as…" searchPlaceholder="Find the person"
                  options={people.filter((p) => p.id !== person.id).map((p) => ({ value: String(p.id), label: p.name, hint: `${p.companies || ''}${p.last ? ` · last ${short(p.last)}` : ''}` }))} />
                {person.companies.length > 1 && (
                  <div className="mt-2"><Picker value="" onChange={split} icon={<Split size={15} />} placeholder="Not one person? Split off…"
                    options={person.companies.map((c) => ({ value: c, label: `The days at ${c}` }))} /></div>
                )}

                {tab === 'to_verify' ? (
                  <>
                    <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note, if skipping (e.g. waiting for the site's sheet)" className={`${FIELD} mt-3 text-sm`} />
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button disabled={busy} onClick={() => review('skipped')} className="flex items-center justify-center gap-1.5 rounded-full bg-white/10 py-3 text-sm">
                        <SkipForward size={16} /> Skip
                      </button>
                      <button disabled={busy} onClick={() => review('verified')} className="flex items-center justify-center gap-1.5 rounded-full bg-ok/80 py-3 text-sm font-medium text-black">
                        <Check size={16} /> Verify
                      </button>
                    </div>
                  </>
                ) : (
                  <button disabled={busy} onClick={() => review('to_verify')} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-full bg-white/10 py-3 text-sm">
                    <RotateCcw size={16} /> Back to To verify
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {openDay && person && <DaySheet person={person} date={openDay} onClose={() => setOpenDay(null)} onChanged={loadPeriod} />}
      {lists && <ListsSheet onClose={() => setLists(false)} onChanged={loadPeriod} />}
      {adding && <AddSheet companies={companies} onClose={() => setAdding(false)} onStarted={() => { setAdding(false); wasReading.current = true; setWatch((w) => w + 1); }} />}
    </Page>
  );
}
