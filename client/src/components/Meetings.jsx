import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Mic, Square, Loader2, Trash2, Plus, Play, RotateCcw, Pencil, UserRound, AlertTriangle, Check } from 'lucide-react';
import { api } from '../lib/api';
import { recordMeeting, recordSample } from '../lib/meeting';
import Sheet from './Sheet';

// Meetings: record one, and get back who said what plus a summary. The work happens on
// the server (server/meetings.js); this page records, uploads and shows the result.

const MAX_PEOPLE = 4;
const SAMPLE_SECONDS = 8;
const LAST_PICK = 'jarvis:meeting-people';
const UNKNOWN = 'Someone else';
const TONES = ['text-p1', 'text-sky-300', 'text-p2', 'text-emerald-300'];

const clock = (secs) => {
  const s = Math.max(0, Math.round(secs || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const length = (secs) => {
  const m = Math.round((secs || 0) / 60);
  if (!m) return 'under a minute';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const dated = (secs) => new Date(secs * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const titleOf = (m) => m.title || `Meeting, ${dated(m.created_at)}`;

const readPick = () => { try { return JSON.parse(localStorage.getItem(LAST_PICK)) || []; } catch { return []; } };
const savePick = (ids) => { try { localStorage.setItem(LAST_PICK, JSON.stringify(ids)); } catch { /* private mode */ } };

function Status({ m }) {
  if (m.status === 'ready' && !m.error) return null;
  const [label, tone] = {
    recording: ['Recording', 'bg-bad/20 text-bad'],
    processing: [m.parts ? `Writing it up… ${m.parts_done ?? 0}/${m.parts}` : 'Writing it up…', 'bg-warn/15 text-warn'],
    failed: ['Failed', 'bg-bad/20 text-bad'],
    ready: ['Partly missing', 'bg-warn/15 text-warn'],
  }[m.status] || [m.status, 'bg-white/10 text-mute'];
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${tone}`}>{label}</span>;
}

// ---------- teaching Jarvis a voice ----------
function VoiceSheet({ onClose, onSaved }) {
  const [name, setName] = useState('');
  const [left, setLeft] = useState(0);
  const [sample, setSample] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const record = async () => {
    setError(''); setSample(null);
    try {
      setSample(await recordSample(SAMPLE_SECONDS, setLeft));
    } catch (e) { setError(e.message); }
    setLeft(0);
  };
  const save = async () => {
    setBusy(true); setError('');
    try { await api.post('/meetings/voices', { name, sample }); onSaved(); onClose(); } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <Sheet title="Add a voice" icon={<UserRound size={20} className="text-p1" />} onClose={onClose}>
      <div className="space-y-4">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name, e.g. Francis" maxLength={40}
          className="w-full rounded-2xl border border-stroke bg-white/[0.04] px-4 py-3 outline-none focus:border-p1/60" />
        <div className="rounded-2xl bg-white/[0.04] p-4 text-sm">
          <p className="mb-2 text-mute">When you tap record, the person reads this out in their normal voice:</p>
          <p className="italic">“Hello, this is {name.trim() || 'me'}. I’m recording a short sample so Jarvis can recognise my voice in our meetings.”</p>
        </div>
        {left > 0 ? (
          <div className="flex items-center justify-center gap-3 rounded-full bg-bad/15 py-3 text-bad">
            <span className="size-2.5 animate-pulse rounded-full bg-bad" /> Listening… {left}
          </div>
        ) : sample ? (
          <div className="flex gap-2">
            <button onClick={() => new Audio(sample).play()} className="flex flex-1 items-center justify-center gap-2 rounded-full border border-stroke py-3 hover:bg-white/5">
              <Play size={16} /> Play back
            </button>
            <button onClick={record} className="flex flex-1 items-center justify-center gap-2 rounded-full border border-stroke py-3 hover:bg-white/5">
              <RotateCcw size={16} /> Again
            </button>
          </div>
        ) : (
          <button onClick={record} disabled={!name.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke py-3 transition hover:bg-white/5 disabled:opacity-40">
            <Mic size={17} /> Record {SAMPLE_SECONDS} seconds
          </button>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
        <button onClick={save} disabled={!sample || !name.trim() || busy}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 py-3 font-medium text-white disabled:opacity-40">
          {busy ? <Loader2 size={17} className="animate-spin" /> : <Check size={17} />} Save voice
        </button>
      </div>
    </Sheet>
  );
}

// ---------- before the meeting ----------
function StartSheet({ voices, onClose, onStart, onAddVoice }) {
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState(() => readPick().filter((id) => voices.some((v) => v.id === id)).slice(0, MAX_PEOPLE));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_PEOPLE ? [...p, id] : p));
  const start = async () => {
    setBusy(true); setError('');
    try { savePick(picked); await onStart({ title, speakers: picked }); } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Sheet title="New meeting" icon={<Mic size={20} className="text-p1" />} onClose={onClose}>
      <div className="space-y-4">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional — Jarvis names it otherwise)" maxLength={120}
          className="w-full rounded-2xl border border-stroke bg-white/[0.04] px-4 py-3 outline-none focus:border-p1/60" />
        <div>
          <p className="mb-2 text-sm text-mute">Who is in the meeting? Up to {MAX_PEOPLE} people can be named. Anyone else shows as “{UNKNOWN}”.</p>
          <div className="flex flex-wrap gap-2">
            {voices.map((v) => {
              const on = picked.includes(v.id);
              return (
                <button key={v.id} onClick={() => toggle(v.id)} disabled={!on && picked.length >= MAX_PEOPLE}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-40 ${on ? 'border-p1/60 bg-p1/20 text-txt' : 'border-stroke text-mute hover:text-txt'}`}>
                  {on && <Check size={14} />} {v.name}
                </button>
              );
            })}
            <button onClick={onAddVoice} className="flex items-center gap-1 rounded-full border border-dashed border-white/25 px-3 py-1.5 text-sm text-mute hover:text-txt">
              <Plus size={14} /> Add a voice
            </button>
          </div>
        </div>
        <ul className="space-y-1.5 rounded-2xl bg-white/[0.04] p-4 text-sm text-mute">
          <li>• Put the phone in the middle of the table.</li>
          <li>• Keep Jarvis open with the screen on until you tap Stop.</li>
          <li>• Let everyone know the meeting is being recorded.</li>
        </ul>
        {error && <p className="text-sm text-bad">{error}</p>}
        <button onClick={start} disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 py-3 font-medium text-white disabled:opacity-40">
          {busy ? <Loader2 size={17} className="animate-spin" /> : <Mic size={17} />} Start recording
        </button>
      </div>
    </Sheet>
  );
}

// ---------- during the meeting ----------
function Recording({ meeting, recorder, state, onStopped }) {
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    if (!confirm('Stop recording and write up the meeting?')) return;
    setStopping(true);
    const duration = await recorder.stop();
    await api.post(`/meetings/${meeting.id}/finish`, { duration }).catch(() => {});
    onStopped(meeting.id);
  };
  const pulse = Math.min(1, (state.level || 0) * 12);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="relative grid size-44 place-items-center">
        <span className="absolute inset-0 rounded-full bg-bad/20 transition-transform duration-200" style={{ transform: `scale(${0.75 + pulse * 0.35})` }} />
        <span className="relative grid size-28 place-items-center rounded-full bg-bad/30 text-bad"><Mic size={42} /></span>
      </div>
      <div>
        <p className="font-mono text-5xl font-light tabular-nums">{clock(state.elapsed)}</p>
        <p className="mt-2 text-sm text-mute">{titleOf(meeting)}</p>
        {meeting.speaker_names?.length > 0 && <p className="text-sm text-mute">Listening for {meeting.speaker_names.join(', ')}</p>}
      </div>
      <p className="max-w-xs text-xs text-mute">
        {stopping ? (state.waiting ? `Sending the last ${state.waiting > 1 ? `${state.waiting} pieces` : 'piece'}… keep Jarvis open.` : 'Finishing…')
          : state.waiting ? `${state.waiting} piece(s) waiting for the internet — they will send on their own.`
          : 'Keep Jarvis open and the screen on. It is saved every 10 minutes as you go.'}
        {state.failed > 0 && <span className="block text-bad">{state.failed} piece(s) could not be sent.</span>}
      </p>
      <button onClick={stop} disabled={stopping}
        className="flex items-center gap-2 rounded-full bg-bad px-8 py-3.5 font-medium text-white shadow-lg shadow-bad/25 transition active:scale-[0.98] disabled:opacity-60">
        {stopping ? <Loader2 size={18} className="animate-spin" /> : <Square size={16} fill="currentColor" />} Stop
      </button>
    </div>
  );
}

// ---------- after the meeting ----------
function Detail({ id, onDeleted }) {
  const [m, setM] = useState(null);
  const [error, setError] = useState('');
  const [openTranscript, setOpenTranscript] = useState(false);

  const load = useCallback(() => api.get(`/meetings/${id}`).then(setM).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  // Still being written up: check back every few seconds until it is done.
  useEffect(() => {
    if (!m || m.status === 'ready' || m.status === 'failed') return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [m, load]);

  if (error) return <p className="p-6 text-bad">{error}</p>;
  if (!m) return <div className="grid flex-1 place-items-center"><Loader2 className="animate-spin text-mute" /></div>;

  const tone = (who) => (who ? TONES[Math.max(0, m.speaker_names.indexOf(who)) % TONES.length] : 'text-mute');
  const turns = [];
  for (const l of m.lines) {
    const last = turns.at(-1);
    if (last && last.who === l.speaker && l.start_s - last.end <= 5) { last.text += ` ${l.text}`; last.end = l.end_s; } else turns.push({ who: l.speaker, at: l.start_s, end: l.end_s, text: l.text });
  }
  const s = m.summary;
  const rename = async () => {
    const title = prompt('Meeting title', m.title);
    if (title === null) return;
    setM(await api.patch(`/meetings/${m.id}`, { title }));
  };
  const again = async () => setM(await api.post(`/meetings/${m.id}/summarize`));
  const finish = async () => setM(await api.post(`/meetings/${m.id}/finish`, {}));
  const remove = async () => {
    if (!confirm('Delete this meeting, its recording and transcript?')) return;
    await api.del(`/meetings/${m.id}`);
    onDeleted();
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
      <div className="mx-auto max-w-3xl space-y-4 pb-8">
        <div>
          <button onClick={rename} className="group flex items-start gap-2 text-left">
            <h2 className="text-xl font-light">{titleOf(m)}</h2>
            <Pencil size={14} className="mt-1.5 shrink-0 text-mute opacity-60 group-hover:opacity-100" />
          </button>
          <p className="text-sm text-mute">{dated(m.created_at)}{m.duration_s ? ` · ${length(m.duration_s)}` : ''}{m.speaker_names.length ? ` · ${m.speaker_names.join(', ')}` : ''}</p>
        </div>

        {m.status === 'recording' && (
          <div className="rounded-2xl bg-warn/10 p-4 text-sm">
            <p>This recording never finished — maybe the phone went off. Whatever reached Jarvis can still be written up.</p>
            <button onClick={finish} className="mt-3 rounded-full bg-warn/20 px-4 py-1.5 text-warn">Write up what was saved</button>
          </div>
        )}
        {m.status === 'processing' && (
          <div className="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-4 text-sm text-mute">
            <Loader2 size={18} className="shrink-0 animate-spin" />
            Turning the recording into text and writing the summary. This takes a few minutes — you can leave this page.
          </div>
        )}
        {m.error && (
          <div className="flex gap-3 rounded-2xl bg-bad/10 p-4 text-sm">
            <AlertTriangle size={18} className="shrink-0 text-bad" /> <span>{m.error}</span>
          </div>
        )}

        {s && (
          <section className="space-y-4 rounded-3xl border border-stroke bg-white/[0.04] p-5">
            <p className="leading-relaxed">{s.summary}</p>
            {s.decisions.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-[11px] font-medium tracking-[0.14em] text-mute">DECISIONS</h3>
                <ul className="space-y-1">{s.decisions.map((d, i) => <li key={i} className="flex gap-2"><Check size={16} className="mt-1 shrink-0 text-ok" />{d}</li>)}</ul>
              </div>
            )}
            {s.actions.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-[11px] font-medium tracking-[0.14em] text-mute">ACTION ITEMS</h3>
                <ul className="space-y-1.5">
                  {s.actions.map((a, i) => (
                    <li key={i}><span className={`font-medium ${tone(a.who === UNKNOWN ? null : a.who)}`}>{a.who || UNKNOWN}:</span> {a.what}{a.when && <span className="text-mute"> · {a.when}</span>}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {turns.length > 0 && (
          <section>
            <button onClick={() => setOpenTranscript((v) => !v)} className="px-1 py-1 text-[11px] font-medium tracking-[0.14em] text-mute hover:text-txt">
              {openTranscript ? 'HIDE' : 'SHOW'} TRANSCRIPT · {turns.length}
            </button>
            {openTranscript && (
              <ol className="mt-2 space-y-3">
                {turns.map((t, i) => (
                  <li key={i} className="text-sm leading-relaxed">
                    <span className={`font-medium ${tone(t.who)}`}>{t.who || UNKNOWN}</span>
                    <span className="ml-2 font-mono text-[11px] text-mute">{clock(t.at)}</span>
                    <p>{t.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          {m.status === 'ready' && m.lines.length > 0 && (
            <button onClick={again} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt">
              <RotateCcw size={14} /> Summarise again
            </button>
          )}
          <button onClick={remove} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-bad">
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- the page ----------
export default function MeetingsPage({ onBack }) {
  const [meetings, setMeetings] = useState(null);
  const [voices, setVoices] = useState([]);
  const [open, setOpen] = useState(null); // a meeting id
  const [sheet, setSheet] = useState(null); // 'start' | 'voice'
  const [live, setLive] = useState(null); // { meeting, recorder }
  const [state, setState] = useState({ elapsed: 0, waiting: 0, failed: 0, level: 0 });
  const liveRef = useRef(null);
  liveRef.current = live;

  const load = useCallback(() => Promise.all([
    api.get('/meetings').then(setMeetings),
    api.get('/meetings/voices').then(setVoices),
  ]).catch(() => setMeetings((m) => m || [])), []);
  useEffect(() => { load(); }, [load]);

  // Closing the tab mid-meeting would lose the piece being recorded: ask first.
  useEffect(() => {
    if (!live) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live]);
  useEffect(() => () => { liveRef.current?.recorder.stop(); }, []);

  // While something is being written up, keep the list's progress moving.
  useEffect(() => {
    if (open || live || !meetings?.some((m) => m.status === 'processing')) return undefined;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [open, live, meetings, load]);

  const start = async ({ title, speakers }) => {
    const meeting = await api.post('/meetings', { title, speakers });
    try {
      const recorder = await recordMeeting(meeting.id, setState);
      setLive({ meeting, recorder });
      setSheet(null);
    } catch (e) {
      await api.del(`/meetings/${meeting.id}`).catch(() => {});
      throw e;
    }
  };
  const removeVoice = async (v) => {
    if (!confirm(`Remove ${v.name}'s voice?`)) return;
    await api.del(`/meetings/voices/${v.id}`);
    load();
  };
  const back = () => {
    if (live) return;
    if (open) { setOpen(null); load(); } else onBack();
  };

  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 pt-1">
          <button onClick={back} disabled={!!live} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt disabled:opacity-30">
            <ChevronLeft size={22} />
          </button>
          <h1 className="flex-1 text-lg font-light">Meetings</h1>
        </div>
      </header>

      {live ? (
        <Recording meeting={live.meeting} recorder={live.recorder} state={state}
          onStopped={(id) => { setLive(null); setOpen(id); }} />
      ) : open ? (
        <Detail id={open} onDeleted={() => { setOpen(null); load(); }} />
      ) : (
        <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
          <div className="mx-auto max-w-3xl space-y-6 pb-8">
            <button onClick={() => setSheet('start')}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 py-3.5 font-medium text-white shadow-lg shadow-p1/25 transition active:scale-[0.98]">
              <Mic size={18} /> Record a meeting
            </button>

            <section>
              <h2 className="px-1 pb-2 text-[11px] font-medium tracking-[0.14em] text-mute">VOICES JARVIS KNOWS · {voices.length}</h2>
              <div className="flex flex-wrap gap-2">
                {voices.map((v) => (
                  <span key={v.id} className="flex items-center gap-1 rounded-full border border-stroke bg-white/[0.04] py-1 pl-3 pr-1 text-sm">
                    {v.name}
                    <button onClick={() => removeVoice(v)} aria-label={`Remove ${v.name}`} className="grid size-6 place-items-center rounded-full text-mute hover:text-bad"><Trash2 size={13} /></button>
                  </span>
                ))}
                <button onClick={() => setSheet('voice')} className="flex items-center gap-1 rounded-full border border-dashed border-white/25 px-3 py-1 text-sm text-mute hover:text-txt">
                  <Plus size={14} /> Add a voice
                </button>
              </div>
              {voices.length === 0 && <p className="mt-2 px-1 text-sm text-mute">Add each person once — an 8-second sample — so the transcript shows their name.</p>}
            </section>

            <section>
              <h2 className="px-1 pb-2 text-[11px] font-medium tracking-[0.14em] text-mute">PAST MEETINGS</h2>
              {meetings === null ? <Loader2 className="mx-auto animate-spin text-mute" />
                : meetings.length === 0 ? <p className="px-1 text-sm text-mute">No meetings yet.</p>
                : (
                  <ul className="space-y-1">
                    {meetings.map((m) => (
                      <li key={m.id}>
                        <button onClick={() => setOpen(m.id)} className="w-full rounded-2xl px-3 py-3 text-left transition hover:bg-white/5">
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate">{titleOf(m)}</span>
                            <Status m={m} />
                          </span>
                          <span className="block text-xs text-mute">{dated(m.created_at)}{m.duration_s ? ` · ${length(m.duration_s)}` : ''}</span>
                          {m.summary?.summary && <span className="mt-1 line-clamp-2 block text-sm text-mute">{m.summary.summary}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </section>
          </div>
        </div>
      )}

      {sheet === 'start' && <StartSheet voices={voices} onClose={() => setSheet(null)} onStart={start} onAddVoice={() => setSheet('voice')} />}
      {sheet === 'voice' && <VoiceSheet onClose={() => setSheet(null)} onSaved={load} />}
    </div>
  );
}
