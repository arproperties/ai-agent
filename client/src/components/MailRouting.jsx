import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Loader2, Search, CheckCircle2, XCircle, AlertTriangle, Send, KeyRound, Play, ArrowRight, Sparkles, Undo2 } from 'lucide-react';
import { api } from '../lib/api';

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
  return (
    <div className="space-y-2 rounded-2xl border border-stroke bg-black/10 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{p.name}</p>
          <p className="truncate text-xs text-mute">{p.email}</p>
          {!p.inRules && <p className="mt-1 text-xs text-mute">No longer in the rules: gets no email, still logged while watched</p>}
          {p.watched
            ? <p className={`mt-1 text-xs ${p.error ? 'text-bad' : 'text-emerald-400'}`}>{p.error ? `Sent mail: ${p.error}` : 'Reem logs what they send'}</p>
            : <p className="mt-1 text-xs text-mute">Not watching what they send</p>}
        </div>
        <button onClick={() => setPw(pw === null ? '' : null)} title={p.watched ? 'Change password' : 'Add password to log what they send'}
          className="grid size-9 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><KeyRound size={16} /></button>
      </div>
      {pw !== null && (
        <div className="space-y-2">
          <input type="password" placeholder={`Password of ${p.email}`} value={pw} onChange={(e) => setPw(e.target.value)} className={field} />
          <div className="flex flex-wrap gap-2">
            <button disabled={busy || !pw} onClick={() => act(() => api.patch(`/mail-routing/people/${p.id}`, { password: pw }))} className={primary}>
              {busy && <Loader2 size={14} className="animate-spin" />} Save
            </button>
            {p.watched && <button disabled={busy} onClick={() => act(() => api.patch(`/mail-routing/people/${p.id}`, { forget: true }))} className={quiet}>Stop watching</button>}
          </div>
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}

// Who the rules name, as Reem found them among the staff: nothing to type here but, for
// anyone whose sent mail should be logged, their mailbox password.
function People({ people, missing, onPeople }) {
  return (
    <Card title="Who Reem found in the rules">
      {people.length === 0 && missing.length === 0 && <p className="text-sm text-mute">Nobody yet. Save the rules and Reem finds each person they name among the staff.</p>}
      {people.map((p) => <Person key={p.id} p={p} onPeople={onPeople} />)}
      {missing.map((m) => (
        <p key={m} className="flex items-start gap-1.5 text-sm text-warn"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {m}</p>
      ))}
      {missing.length > 0 && <p className="text-xs text-mute">For someone without an account in Reem, write their email in the rules, e.g. "accounts go to Tauqeer (tauqeer@ainalreempro.com)".</p>}
      {people.length > 0 && <p className="text-xs text-mute">Tap the key to add someone's mailbox password, and Reem logs every email they send.</p>}
    </Card>
  );
}

function Rules({ data, onSaved }) {
  const [text, setText] = useState(data.rules);
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
  const draft = async () => {
    setBusy('draft'); setError('');
    try {
      const r = await api.post('/mail-routing/rules/draft', { rules: text });
      setBefore(text); setText(r.rules); setTried(null);
    } catch (e) { setError(e.message); }
    setBusy('');
  };
  const tryIt = async () => {
    setBusy('try'); setError(''); setTried(null);
    try { setTried(await api.post('/mail-routing/try', { rules: text })); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const changed = text !== data.rules;
  return (
    <Card title="Rules">
      <p className="text-sm text-mute">Write who gets what, in plain words, by name or by job. Reem finds each person among the staff in Reem, then reads each new email and follows this.</p>
      <textarea value={text} onChange={(e) => { setText(e.target.value); setBefore(null); }} rows={7} disabled={busy === 'draft'}
        placeholder={'For example:\nLegal emails (courts, lawyers, contracts, notices) go to Mohammad.\nAccounts emails (invoices, payments, bank, cheques) go to the accountant and Tauqeer.\nEverything else goes to Rona.\nAdverts and newsletters go to nobody.'}
        className={`${field} resize-y`} />
      <div className="flex flex-wrap gap-2">
        <button onClick={draft} disabled={!!busy} className={quiet}>
          {busy === 'draft' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {busy === 'draft' ? 'Reem is writing…' : text.trim() ? 'Improve with Reem' : 'Write with Reem'}
        </button>
        {before !== null && (
          <button onClick={() => { setText(before); setBefore(null); }} disabled={!!busy} className={quiet}><Undo2 size={14} /> Undo</button>
        )}
        <button onClick={() => save()} disabled={!!busy || !changed} className={primary}>{busy === 'save' && <Loader2 size={14} className="animate-spin" />} {busy === 'save' ? 'Reem is reading the rules…' : 'Save rules'}</button>
        <button onClick={tryIt} disabled={!!busy || !text.trim()} className={quiet}>
          {busy === 'try' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Try on the newest 10 emails
        </button>
      </div>
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
    return (
      <div className={`space-y-1 rounded-2xl border p-3 text-sm ${direct ? 'border-bad/50 bg-bad/[0.06]' : 'border-stroke bg-white/[0.03]'}`}>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate"><span className="font-medium">{names.get(l.mailbox) || l.name || l.mailbox}</span> <span className="text-mute">sent to</span> {who(l.to) || '—'}</p>
          <span className="shrink-0 text-xs text-mute">{dated(l.at)}</span>
        </div>
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
              <People people={data.people} missing={data.missing} onPeople={(people) => setData((d) => ({ ...d, people }))} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
