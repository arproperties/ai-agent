import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Mic, Square, Loader2, Trash2, Pencil, Copy, Check, AlertTriangle, ArrowLeftRight, Volume2, VolumeX, RotateCw } from 'lucide-react';
import { api } from '../lib/api';
import { listenUntilSilence, finishListening, stopListening, speakText, stopSpeaking, unlockAudio } from '../lib/voice';
import { ParticleField } from './ParticleField';
import Picker from './Picker';

// Live Translator: two people who share no language, one phone between them. Each has a
// button in their own language: tap, speak, and the other hears it in theirs. The hearing
// and translating happen on the server (server/translate.js); this page records, shows
// both versions, and reads the translation aloud. Every conversation is kept as text.

const timed = (secs) => new Date(secs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dated = (secs) => new Date(secs * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// What this phone remembers between visits. Storage can be missing (a private window),
// and the page works the same without it.
const saved = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const keep = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* nowhere to keep it */ } };

function Bubble({ turn, from, to, busy, onSay, onRetry }) {
  const left = turn.side === 'a';
  return (
    <li className={`flex ${left ? 'justify-start' : 'justify-end'}`}>
      <div className={`max-w-[88%] rounded-3xl border border-stroke px-4 py-3 ${left ? 'bg-white/[0.04]' : 'bg-p1/10'}`}>
        <p dir={from.rtl ? 'rtl' : 'ltr'} className="whitespace-pre-wrap text-sm text-mute">{turn.original}</p>
        {turn.error ? (
          <div className="mt-2 flex items-center gap-2 text-sm">
            <AlertTriangle size={15} className="shrink-0 text-bad" />
            <span className="flex-1">Not translated.</span>
            <button onClick={onRetry} disabled={busy} className="flex items-center gap-1.5 rounded-full border border-stroke px-3 py-1.5 text-mute hover:text-txt disabled:opacity-40">
              <RotateCw size={13} /> Try again
            </button>
          </div>
        ) : (
          // Tapping the translation reads it again.
          <button onClick={onSay} disabled={busy} dir={to.rtl ? 'rtl' : 'ltr'} aria-label={`Read aloud: ${turn.translated}`}
            className="mt-1.5 block w-full whitespace-pre-wrap text-start text-lg leading-snug">
            {turn.translated}
          </button>
        )}
        <p className="mt-1.5 text-[11px] text-mute/70">{from.name} · {timed(turn.created_at)}</p>
      </div>
    </li>
  );
}

function MicButton({ lang, listening, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`flex flex-col items-center gap-2 rounded-3xl border px-3 py-5 transition active:scale-[0.98] disabled:opacity-40
        ${listening ? 'border-bad/60 bg-bad/20' : 'border-stroke bg-white/[0.04] hover:bg-white/[0.07]'}`}>
      {listening ? <Square size={24} fill="currentColor" className="text-bad" /> : <Mic size={26} className="text-p1" />}
      <span dir={lang.rtl ? 'rtl' : 'ltr'} className="text-lg font-medium">{lang.native}</span>
      <span className="text-xs text-mute">{listening ? 'Tap when finished' : lang.name}</span>
    </button>
  );
}

export default function TranslatePage({ onBack }) {
  const [setup, setSetup] = useState(null); // { languages, voice }
  const [list, setList] = useState(null);
  const [pair, setPair] = useState(() => saved('translate.pair', { a: 'en', b: 'ar' }));
  const [muted, setMuted] = useState(() => saved('translate.muted', false));
  const [conv, setConv] = useState(null);   // the open conversation; id is null until its first turn
  const [phase, setPhase] = useState('idle'); // 'idle' | 'a' | 'b' | 'working' | 'speaking'
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const end = useRef(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // Goes up each time the open conversation is left. An answer that comes back from the
  // server afterwards belongs to a conversation nobody is looking at: it is saved there,
  // but must not be spoken, or added to whatever is open now.
  const visit = useRef(0);

  const load = useCallback(() => api.get('/translate').then(setList).catch(() => setList((l) => l || [])), []);
  useEffect(() => {
    api.get('/translate/languages').then(setSetup).catch((e) => setError(e.message));
    load();
  }, [load]);
  // Leaving the page lets go of the microphone and stops the voice.
  useEffect(() => () => { visit.current++; stopListening(); stopSpeaking(); }, []);
  useEffect(() => { keep('translate.pair', pair); }, [pair]);
  useEffect(() => { keep('translate.muted', muted); if (muted) stopSpeaking(); }, [muted]);
  const turnCount = conv?.turns.length;
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turnCount, phase]);

  const lang = (code) => setup?.languages.find((l) => l.code === code) || { code, name: code, native: code };
  const options = (setup?.languages || []).map((l) => ({ value: l.code, label: l.name, hint: l.native }));

  const say = (turn) => {
    if (!turn.translated) return;
    unlockAudio(); // a tap straight after a reload: the phone needs it before it will play
    setPhase('speaking');
    speakText(turn.translated, null, (s) => { if (s === 'idle' || s === 'error') setPhase('idle'); })
      .catch(() => setPhase('idle'));
  };

  const talk = async (side) => {
    if (phase === side) return finishListening(); // second tap: that is everything, send it
    if (phase !== 'idle') return;                 // one thing at a time
    const here = visit.current;
    const left = () => visit.current !== here;
    unlockAudio();
    setError('');
    setPhase(side);
    try {
      const blob = await listenUntilSilence({ raw: true, onCaptured: () => { if (!left()) setPhase('working'); } });
      if (left()) return;
      if (!blob) return setPhase('idle');
      const form = new FormData();
      form.append('side', side);
      if (conv.id) form.append('id', conv.id);
      else { form.append('langA', conv.lang_a); form.append('langB', conv.lang_b); }
      form.append('audio', blob, `turn.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
      const r = await api.upload('/translate/turns', form);
      if (left()) return;
      if (!r.turn) return setPhase('idle');
      setConv((c) => (c ? { ...c, id: r.id, turns: [...c.turns, r.turn] } : c));
      if (mutedRef.current || r.turn.error) setPhase('idle');
      else say(r.turn);
    } catch (e) {
      if (left()) return;
      setError(e.message);
      setPhase('idle');
    }
  };

  const retry = async (turn) => {
    if (phase !== 'idle') return;
    const here = visit.current;
    const left = () => visit.current !== here;
    unlockAudio();
    setError('');
    setPhase('working');
    try {
      const again = await api.post(`/translate/${conv.id}/turns/${turn.id}/retry`);
      if (left()) return;
      setConv((c) => (c ? { ...c, turns: c.turns.map((t) => (t.id === again.id ? again : t)) } : c));
      if (mutedRef.current || again.error) setPhase('idle');
      else say(again);
    } catch (e) {
      if (left()) return;
      setError(e.message);
      setPhase('idle');
    }
  };

  const start = () => {
    setError('');
    visit.current++;
    setConv({ id: null, title: `${lang(pair.a).name} ↔ ${lang(pair.b).name}`, lang_a: pair.a, lang_b: pair.b, turns: [] });
  };
  const openPast = async (id) => {
    setError('');
    const here = ++visit.current;
    try {
      const past = await api.get(`/translate/${id}`);
      if (visit.current === here) setConv(past);
    } catch (e) { setError(e.message); }
  };
  const close = () => { visit.current++; stopListening(); stopSpeaking(); setPhase('idle'); setError(''); setConv(null); load(); };
  const back = () => (conv ? close() : onBack());

  const rename = async () => {
    const title = prompt('Title', conv.title);
    if (title === null) return;
    setConv(await api.patch(`/translate/${conv.id}`, { title }));
  };
  const copy = async () => {
    const text = conv.turns.map((t) => {
      const [from, to] = t.side === 'a' ? [lang(conv.lang_a), lang(conv.lang_b)] : [lang(conv.lang_b), lang(conv.lang_a)];
      return `[${timed(t.created_at)}] ${from.name}: ${t.original}\n${to.name}: ${t.translated || '(not translated)'}`;
    }).join('\n\n');
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const remove = async () => {
    if (!confirm('Delete this conversation?')) return;
    await api.del(`/translate/${conv.id}`);
    close();
  };

  const busy = phase !== 'idle';
  const a = conv && lang(conv.lang_a);
  const b = conv && lang(conv.lang_b);

  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      <ParticleField className="fx-canvas-panel" />
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full items-center gap-1 pt-1">
          <button onClick={back} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <ChevronLeft size={22} />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-light">{conv ? conv.title : 'Live Translator'}</h1>
          {conv && (
            <button onClick={() => setMuted((m) => !m)} aria-pressed={muted} aria-label={muted ? 'Turn the voice on' : 'Turn the voice off'} title={muted ? 'Voice is off' : 'Voice is on'}
              className="grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
              {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
            </button>
          )}
        </div>
      </header>

      {conv ? (
        <>
          <div className="flex-1 overflow-y-auto px-4 md:px-8">
            <div className="mx-auto w-full pb-4">
              {conv.turns.length === 0 && (
                <p className="px-1 pt-10 text-center text-sm text-mute">Tap your language below and speak. It stops by itself when you go quiet.</p>
              )}
              <ul className="space-y-3">
                {conv.turns.map((t) => (
                  <Bubble key={t.id} turn={t} busy={busy}
                    from={t.side === 'a' ? a : b} to={t.side === 'a' ? b : a}
                    onSay={() => phase === 'idle' && say(t)} onRetry={() => retry(t)} />
                ))}
              </ul>
              {conv.id && (
                <div className="flex flex-wrap gap-2 pt-5">
                  <button onClick={rename} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt">
                    <Pencil size={14} /> Rename
                  </button>
                  <button onClick={copy} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt">
                    {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy text'}
                  </button>
                  <button onClick={remove} disabled={busy} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-bad disabled:opacity-40">
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              )}
              <div ref={end} />
            </div>
          </div>

          <footer className="px-4 pb-safe pt-2 md:px-8">
            <div className="mx-auto w-full pb-4">
              <p role="status" className="flex h-6 items-center justify-center gap-2 text-sm text-mute">
                {error ? <span className="text-bad">{error}</span>
                  : phase === 'a' || phase === 'b' ? 'Listening…'
                  : phase === 'working' ? <><Loader2 size={14} className="animate-spin" /> Translating…</>
                  : phase === 'speaking' ? <button onClick={stopSpeaking} className="flex items-center gap-2 hover:text-txt"><Volume2 size={14} /> Speaking… tap to stop</button>
                  : null}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <MicButton lang={a} listening={phase === 'a'} disabled={!setup?.voice || (busy && phase !== 'a')} onClick={() => talk('a')} />
                <MicButton lang={b} listening={phase === 'b'} disabled={!setup?.voice || (busy && phase !== 'b')} onClick={() => talk('b')} />
              </div>
            </div>
          </footer>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
          <div className="mx-auto w-full space-y-6 pb-8">
            {!setup ? (error ? <p className="text-sm text-bad">{error}</p> : <Loader2 className="mx-auto animate-spin text-mute" />)
              : !setup.voice ? <p className="rounded-2xl bg-bad/10 p-4 text-sm">Voice is not set up on this server yet, so Live Translator cannot listen. Ask the administrator to add the voice key.</p>
              : (
                <section className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Picker className="min-w-0 flex-1" value={pair.a} onChange={(v) => setPair((p) => ({ ...p, a: v }))} options={options} searchPlaceholder="Search languages" />
                    <button onClick={() => setPair((p) => ({ a: p.b, b: p.a }))} aria-label="Swap the two languages" title="Swap"
                      className="grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
                      <ArrowLeftRight size={18} />
                    </button>
                    <Picker className="min-w-0 flex-1" value={pair.b} onChange={(v) => setPair((p) => ({ ...p, b: v }))} options={options} searchPlaceholder="Search languages" />
                  </div>
                  {pair.a === pair.b && <p className="px-1 text-sm text-warn">Choose two different languages.</p>}
                  <button onClick={start} disabled={pair.a === pair.b}
                    className="flex w-full items-center justify-center gap-2 rounded-full bg-p1 px-6 py-3.5 font-medium text-white transition active:scale-[0.98] disabled:opacity-40">
                    <Mic size={18} /> Start a conversation
                  </button>
                  {error && <p className="text-sm text-bad">{error}</p>}
                </section>
              )}

            <section>
              <h2 className="px-1 pb-2 text-[11px] font-medium tracking-[0.14em] text-mute">PAST CONVERSATIONS</h2>
              {list === null ? <Loader2 className="mx-auto animate-spin text-mute" />
                : list.length === 0 ? <p className="px-1 text-sm text-mute">Nothing yet.</p>
                : (
                  <ul className="space-y-1">
                    {list.map((c) => (
                      <li key={c.id}>
                        <button onClick={() => openPast(c.id)} className="w-full rounded-2xl px-3 py-3 text-left transition hover:bg-white/5">
                          <span className="block truncate">{c.title}</span>
                          <span className="block text-xs text-mute">
                            {lang(c.lang_a).name} ↔ {lang(c.lang_b).name} · {dated(c.updated_at)} · {c.turns} {c.turns === 1 ? 'turn' : 'turns'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
