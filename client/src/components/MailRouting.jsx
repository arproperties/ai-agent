import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Loader2, Search, CheckCircle2, XCircle, AlertTriangle, Send, KeyRound, Play, ArrowRight, Sparkles, Undo2, Mic, Square } from 'lucide-react';
import { api } from '../lib/api';
import { useRecorder } from '../lib/useRecorder';

// Mail routing, the master's alone: the one mailbox the company is written to, and who each
// email in it is passed on to (server/mailRouting.js). The master only writes the rules;
// Reem finds the people they name among the staff. The Log says, for every email, where
// it went and why, and what each person sent from their own mailbox. An email sent from the
// shared mailbox that Reem did not send is marked: someone used it by hand.

const dated = (secs) => secs ? new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const field = 'w-full rounded-2xl border border-stroke bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-p1/60';
const primary = 'flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-50';
const quiet = 'flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt disabled:opacity-40';

const Status = ({ ok, text }) => (
  <p className={`flex items-start gap-1.5 text-sm ${ok ? 'text-emerald-400' : 'text-bad'}`}>
    {ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />} {text}
  </p>
);

const Card = ({ title, children }) => (
  <section className="space-y-3 rounded-3xl border border-stroke bg-white/[0.03] p-4">
    {title && <h2 className="font-medium">{title}</h2>}
    {children}
  </section>
);

// ---------- settings ----------

// What the box holds before the master has saved any rules: a start to change, not a blank.
const DEFAULT_RULES = [
  'Legal emails (courts, lawyers, contracts, notices) go to Mohammad.',
  'Accounts emails (invoices, payments, bank, cheques) go to the accountant and Tauqeer.',
  'Everything else goes to Rona.',
  'Adverts and newsletters go to nobody.',
].join('\n');
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function SharedMailbox({ front, onChanged }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connect = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.post('/mail-routing/front', { email, password }); setPassword(''); onChanged(); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const disconnect = async () => {
    if (!confirm('Disconnect the shared mailbox? Reem will stop passing its emails on.')) return;
    await api.del('/mail-routing/front');
    onChanged();
  };
  return (
    <Card title="Shared mailbox">
      {front ? (
        <div className="space-y-2">
          <Status ok={!front.error} text={front.error ? `Problem: ${front.error}` : `Connected: ${front.email}`} />
          <p className="text-sm text-mute">{front.checkedAt ? `Last checked ${dated(front.checkedAt)} · every 3 minutes` : 'Not checked yet'}</p>
          <button onClick={disconnect} className="text-sm text-mute underline hover:text-txt">Disconnect</button>
        </div>
      ) : (
        <form onSubmit={connect} className="space-y-2">
          <p className="text-sm text-mute">The email everyone writes to. For Gmail, use an app password (Google Account → Security → App passwords). Reem starts from new emails; old ones are left alone.</p>
          <input type="email" required placeholder="shared@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
          <input type="password" required placeholder="App password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
          {error && <p className="text-sm text-bad">{error}</p>}
          <button disabled={busy} className={primary}>{busy && <Loader2 size={14} className="animate-spin" />} Connect</button>
        </form>
      )}
    </Card>
  );
}

function Person({ p, onPeople }) {
  const [pw, setPw] = useState(null); // null: closed; a string: typing a password
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn) => {
    setBusy(true); setError('');
    try { onPeople((await fn()).people); setPw(null); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const logged = p.watched && !p.error;
  return (
    <div className="space-y-2 rounded-2xl border border-stroke bg-black/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{p.name}</p>
          <p className="truncate text-xs text-mute">{p.email}</p>
          {!p.inRules && <p className="mt-1 text-xs text-mute">No longer in the rules, so gets no email. What they send is still logged.</p>}
        </div>
        {pw === null && (
          <button onClick={() => setPw('')} title={p.watched ? 'Change the password Reem uses' : 'Give Reem their mailbox password to log every email they send'}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${
              logged ? 'border-emerald-500/40 text-emerald-400' : p.watched ? 'border-bad/50 text-bad' : 'border-stroke text-mute hover:text-txt'}`}>
            {logged ? <><CheckCircle2 size={13} /> Logging what they send</> : p.watched ? <><XCircle size={13} /> Logging stopped: fix password</> : <><KeyRound size={13} /> Log what they send</>}
          </button>
        )}
      </div>
      {p.watched && p.error && pw === null && <p className="text-xs text-bad">{p.error}</p>}
      {pw !== null && (
        <div className="space-y-2">
          <p className="text-xs text-mute">The password of {p.email}. Reem only reads its Sent folder, to log who they wrote to and why. It never sends from it.</p>
          <input type="password" autoFocus placeholder="Mailbox password" value={pw} onChange={(e) => setPw(e.target.value)} className={field} />
          <div className="flex flex-wrap gap-2">
            <button disabled={busy || !pw} onClick={() => act(() => api.patch(`/mail-routing/people/${p.id}`, { password: pw }))} className={primary}>
              {busy && <Loader2 size={14} className="animate-spin" />} Start logging
            </button>
            {p.watched && <button disabled={busy} onClick={() => act(() => api.patch(`/mail-routing/people/${p.id}`, { forget: true }))} className={quiet}>Stop logging</button>}
            <button disabled={busy} onClick={() => setPw(null)} className={quiet}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}

// Who sends what from their own mailbox: the people in the rules, each logged only once the
// master gives Reem that mailbox's password. Who gets which email is the rules' business,
// not this card's.
function People({ people, onPeople }) {
  if (!people.length) return null;
  return (
    <Card title="Log what staff send">
      <p className="text-sm text-mute">Give Reem a person's mailbox password and every email they send shows in the Log: who they wrote to and what it was about. Reem only reads their Sent folder; it never sends from it.</p>
      {people.map((p) => <Person key={p.id} p={p} onPeople={onPeople} />)}
    </Card>
  );
}

function Rules({ data, onSaved }) {
  const [text, setText] = useState(data.rules || DEFAULT_RULES);
  const [auto, setAuto] = useState(data.auto);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tried, setTried] = useState(null);
  const save = async (next = auto) => {
    setBusy('save'); setError('');
    try { const r = await api.put('/mail-routing/rules', { rules: text, auto: next }); setAuto(r.auto); onSaved(r); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const [before, setBefore] = useState(null); // the text before Reem wrote over it, for Undo
  const draft = async (spoken = '') => {
    setBusy('draft'); setError('');
    try {
      const r = await api.post('/mail-routing/rules/draft', { rules: text, spoken });
      setBefore(text); setText(r.rules); setTried(null);
    } catch (e) { setError(e.message); }
    setBusy('');
  };
  // Said instead of typed: the words are turned into text, then Reem works them into the rules.
  const heard = async (blob) => {
    setBusy('voice'); setError('');
    try {
      const form = new FormData();
      form.append('audio', blob, `rules.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
      const said = (await api.upload('/voice/transcribe', form)).text?.trim();
      if (!said) { setError('Reem did not hear anything. Try again, a little closer to the microphone.'); setBusy(''); return; }
      await draft(said);
    } catch (e) { setError(e.message); setBusy(''); }
  };
  const rec = useRecorder(heard, 180);
  const tryIt = async () => {
    setBusy('try'); setError(''); setTried(null);
    try { setTried(await api.post('/mail-routing/try', { rules: text })); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const changed = text !== data.rules;
  return (
    <Card title="Rules">
      <p className="text-sm text-mute">Write who gets what, in plain words, by name or by job. Reem finds each person among the staff in Reem, then reads each new email and follows this.</p>
      <textarea value={text} onChange={(e) => { setText(e.target.value); setBefore(null); }} rows={7} disabled={busy === 'draft' || busy === 'voice'}
        placeholder="Who gets which emails, one line each"
        className={`${field} resize-y`} />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => (rec.recording ? rec.stop() : rec.start().catch((e) => setError(e.message)))}
          disabled={!!busy && !rec.recording}
          className={rec.recording ? 'flex items-center gap-1.5 rounded-full border border-bad/60 bg-bad/15 px-4 py-2 text-sm text-bad' : quiet}>
          {rec.recording
            ? <><Square size={13} fill="currentColor" /> <span className="font-mono tabular-nums">{clock(rec.secs)}</span> Tap to stop</>
            : busy === 'voice' ? <><Loader2 size={14} className="animate-spin" /> Reem is listening back…</> : <><Mic size={14} /> Speak</>}
        </button>
        <button onClick={() => draft()} disabled={!!busy || rec.recording} className={quiet}>
          {busy === 'draft' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {busy === 'draft' ? 'Reem is writing…' : text.trim() ? 'Improve with Reem' : 'Write with Reem'}
        </button>
        {before !== null && (
          <button onClick={() => { setText(before); setBefore(null); }} disabled={!!busy} className={quiet}><Undo2 size={14} /> Undo</button>
        )}
        <button onClick={() => save()} disabled={!!busy || rec.recording || !changed} className={primary}>{busy === 'save' && <Loader2 size={14} className="animate-spin" />} {busy === 'save' ? 'Reem is reading the rules…' : 'Save rules'}</button>
        <button onClick={tryIt} disabled={!!busy || !text.trim()} className={quiet}>
          {busy === 'try' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Try on the newest 10 emails
        </button>
      </div>
      {/* A name in the saved rules Reem could not match: until fixed, those emails go to nobody. */}
      {!changed && data.missing?.length > 0 && (
        <div className="space-y-1 rounded-2xl border border-warn/40 bg-warn/[0.06] p-3 text-sm">
          {data.missing.map((m) => <p key={m} className="flex items-start gap-1.5"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" /> {m}</p>)}
          <p className="text-xs text-mute">Reem could not tell who this is, so those emails go to nobody. Use a person's name in the rules, or write their email.</p>
        </div>
      )}
      {rec.recording && <p className="text-xs text-mute">Say who should get which emails, in any language. Tap stop when done.</p>}
      {before !== null && <p className="text-xs text-mute">Reem wrote this. Read it, change anything, fill in any ___, then Save rules.</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      {tried && (
        <div className="space-y-2">
          {changed && tried.people && (
            <p className="text-xs text-mute">Tried with: {tried.people.map((p) => p.name).join(', ')}{tried.missing.length ? `. Not found: ${tried.missing.join('; ')}` : ''}</p>
          )}
          {tried.results.length === 0 && <p className="text-sm text-mute">No emails in the shared mailbox to try on.</p>}
          {tried.results.map((t, i) => (
            <div key={i} className="rounded-2xl border border-stroke bg-black/10 p-3 text-sm">
              <p className="truncate font-medium">{t.subject || '(no subject)'}</p>
              <p className="truncate text-xs text-mute">{t.name || t.from}</p>
              <p className="mt-1 flex items-center gap-1.5">
                <ArrowRight size={14} className="shrink-0 text-p1" />
                {t.error ? <span className="text-bad">{t.error}</span> : <span>{t.to.length ? t.to.join(', ') : 'Nobody'}</span>}
              </p>
              {t.reason && <p className="text-xs text-mute">{t.reason}</p>}
            </div>
          ))}
          <p className="text-xs text-mute">Nothing was sent. Change the rules and try again until this looks right.</p>
        </div>
      )}
      {/* A switch, not a checkbox: on is the point of the whole page. */}
      <div className="flex items-center gap-3 border-t border-stroke/60 pt-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Forward by itself</p>
          <p className="text-xs text-mute">{auto ? 'On: each new email is forwarded as soon as Reem reads it.' : 'Off: Reem only writes in the Log who it would forward each email to.'}</p>
        </div>
        <button role="switch" aria-checked={auto} aria-label="Forward by itself" disabled={!!busy || changed} onClick={() => save(!auto)}
          title={changed ? 'Save the rules first' : ''}
          className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-40 ${auto ? 'bg-p1' : 'bg-white/15'}`}>
          <span className={`absolute top-1 size-5 rounded-full bg-white transition-all ${auto ? 'left-6' : 'left-1'}`} />
        </button>
      </div>
    </Card>
  );
}

// ---------- log ----------

const IN_STATUS = {
  would: ['Would go to', 'bg-white/10 text-mute'],
  forwarded: ['Forwarded to', 'bg-emerald-500/15 text-emerald-400'],
  failed: ['Not passed on', 'bg-bad/15 text-bad'],
  none: ['Nobody', 'bg-white/10 text-mute'],
};

function Entry({ l, names, people, onChanged }) {
  const [picking, setPicking] = useState(null); // emails ticked to forward to
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const who = (list) => String(list || '').split(',').map((e) => e.trim()).filter(Boolean).map((e) => names.get(e) || e).join(', ');
  const send = async () => {
    setBusy(true); setError('');
    try { await api.post(`/mail-routing/log/${l.id}/forward`, { to: picking }); setPicking(null); onChanged(); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const open = ['would', 'failed', 'none'].includes(l.status);

  if (l.kind === 'out') {
    const direct = l.status === 'direct';
    // A staff reply Reem sent on from the shared mailbox: it carries the person's own name.
    const relayed = l.status === 'replied' || (l.status === 'failed' && l.mailbox !== l.from);
    return (
      <div className={`space-y-1 rounded-2xl border p-3 text-sm ${direct || l.status === 'failed' ? 'border-bad/50 bg-bad/[0.06]' : 'border-stroke bg-white/[0.03]'}`}>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate">
            <span className="font-medium">{relayed ? l.name || names.get(l.from) || l.from : names.get(l.mailbox) || l.name || l.mailbox}</span>
            <span className="text-mute">{relayed ? ' replied to ' : ' sent to '}</span>{who(l.to) || '—'}
          </p>
          <span className="shrink-0 text-xs text-mute">{dated(l.at)}</span>
        </div>
        {relayed && l.status === 'replied' && <p className="text-xs text-emerald-400">Sent from the shared mailbox by Reem</p>}
        {relayed && l.status === 'failed' && <p className="flex items-center gap-1.5 text-xs text-bad"><AlertTriangle size={13} /> Not sent: {l.error}</p>}
        {direct && <p className="flex items-center gap-1.5 text-xs font-medium text-bad"><AlertTriangle size={13} /> Sent from the shared mailbox directly, not through Reem</p>}
        <p className="truncate">{l.subject || '(no subject)'}</p>
        {l.reason && <p className="text-xs text-mute">{l.reason}</p>}
      </div>
    );
  }

  const [label, tone] = IN_STATUS[l.status];
  return (
    <div className="space-y-1.5 rounded-2xl border border-stroke bg-white/[0.03] p-3 text-sm">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 truncate"><span className="font-medium">{l.name || l.from}</span>{l.name && <span className="text-mute"> · {l.from}</span>}</p>
        <span className="shrink-0 text-xs text-mute">{dated(l.at)}</span>
      </div>
      <p className="truncate">{l.subject || '(no subject)'}</p>
      <p className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-xs ${tone}`}>{label}</span>
        {l.routeTo && l.status !== 'none' && <span className="text-xs">{who(l.routeTo)}</span>}
        {l.by && <span className="text-xs text-mute">by {l.by}</span>}
      </p>
      {l.reason && <p className="text-xs text-mute">{l.reason}</p>}
      {l.status === 'failed' && l.error && <p className="text-xs text-bad">{l.error}</p>}
      {open && picking === null && (
        <button onClick={() => setPicking(String(l.routeTo || '').split(',').map((e) => e.trim()).filter(Boolean))} className="text-xs text-p1 underline">
          Forward…
        </button>
      )}
      {picking !== null && (
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap gap-2">
            {people.filter((p) => p.inRules).map((p) => {
              const on = picking.includes(p.email);
              return (
                <button key={p.id} onClick={() => setPicking(on ? picking.filter((e) => e !== p.email) : [...picking, p.email])}
                  className={`rounded-full border px-3 py-1.5 text-xs ${on ? 'border-p1/60 bg-p1/20 text-txt' : 'border-stroke text-mute hover:text-txt'}`}>{p.name}</button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button disabled={busy || !picking.length} onClick={send} className={primary}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Forward</button>
            <button disabled={busy} onClick={() => setPicking(null)} className={quiet}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}

const KINDS = [['', 'All'], ['in', 'Incoming'], ['out', 'Sent'], ['direct', 'Sent outside Reem']];

function Log({ people, front }) {
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const names = new Map([...people.map((p) => [p.email, p.name]), ...(front ? [[front.email, 'Shared mailbox']] : [])]);
  const load = useCallback(async (before) => {
    setError('');
    try {
      const qs = new URLSearchParams({ ...(kind ? { kind } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(before ? { before } : {}) });
      const r = await api.get(`/mail-routing/log?${qs}`);
      setRows((cur) => (before ? [...(cur || []), ...r.log] : r.log));
      setMore(r.more);
    } catch (e) { setError(e.message); }
  }, [kind, q]);
  useEffect(() => {
    const t = setTimeout(() => load(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  useEffect(() => {
    const t = setInterval(() => load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {KINDS.map(([k, label]) => (
          <button key={k} onClick={() => setKind(k)}
            className={`rounded-full border px-3 py-1.5 text-sm ${kind === k ? 'border-p1/60 bg-p1/20 text-txt' : 'border-stroke text-mute hover:text-txt'}`}>{label}</button>
        ))}
      </div>
      <label className="flex items-center gap-2 rounded-2xl border border-stroke bg-black/20 px-3 py-2 focus-within:border-p1/60">
        <Search size={15} className="shrink-0 text-mute" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search who, subject or reason" className="w-full bg-transparent text-sm outline-none" />
      </label>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!rows && !error && <div className="grid place-items-center py-10"><Loader2 className="animate-spin text-mute" /></div>}
      {rows?.length === 0 && <p className="py-6 text-center text-mute">Nothing yet. New emails show up here within a few minutes.</p>}
      {rows?.map((l) => <Entry key={`${l.id}-${l.status}`} l={l} names={names} people={people} onChanged={() => load()} />)}
      {more && <button onClick={() => load(rows[rows.length - 1].id)} className={`${quiet} mx-auto`}>Show older</button>}
    </div>
  );
}

// ---------- page ----------

export default function MailRoutingPage({ onBack }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get('/mail-routing').then((d) => {
    setData(d);
    setTab((t) => t || (d.front && d.rules.trim() ? 'log' : 'settings'));
  }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full items-center gap-2 pt-1">
          <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <ChevronLeft size={22} />
          </button>
          <h1 className="flex-1 text-lg font-light">Mail routing</h1>
        </div>
        {data && (
          <div className="mx-auto mt-2 flex w-full gap-1 rounded-full border border-stroke p-1">
            {[['log', 'Log'], ['settings', 'Settings']].map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`flex-1 rounded-full py-1.5 text-sm ${tab === k ? 'bg-white/10 text-txt' : 'text-mute hover:text-txt'}`}>{label}</button>
            ))}
          </div>
        )}
      </header>
      <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
        <div className="mx-auto w-full space-y-4 pb-8">
          {error && <p className="text-bad">{error}</p>}
          {!data && !error && <div className="grid place-items-center py-10"><Loader2 className="animate-spin text-mute" /></div>}
          {data && tab === 'log' && <Log people={data.people} front={data.front} />}
          {data && tab === 'settings' && (
            <>
              <SharedMailbox front={data.front} onChanged={load} />
              <Rules key={data.rules} data={data} onSaved={(r) => setData((d) => ({ ...d, ...r }))} />
              <People people={data.people} onPeople={(people) => setData((d) => ({ ...d, people }))} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
