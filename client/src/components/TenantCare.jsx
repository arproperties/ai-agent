import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Loader2, Send, X, AlertTriangle, Check } from 'lucide-react';
import { api } from '../lib/api';
import { ParticleField } from './ParticleField';

// Tenant care: the shared tenant inbox. When a tenant's email does not say which building
// and unit it is about, Jarvis replies by itself asking (server/tenantCare.js). Only a reply
// that could not go out waits here, for whoever looks after the inbox to send or skip.
// The master connects the inbox and picks who looks after it, at the bottom.

const dated = (secs) => secs ? new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const MISSING = { both: 'No building or unit', building: 'No building', unit: 'No unit' };

function Ask({ a, onDone }) {
  const [reply, setReply] = useState(a.reply);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(a.status === 'failed' ? a.error : '');
  const act = async (what) => {
    setBusy(what); setError('');
    try {
      await api.post(`/tenant-care/asks/${a.id}/${what}`, what === 'send' ? { reply } : {});
      onDone();
    } catch (e) { setError(e.message); setBusy(''); }
  };
  return (
    <div className="space-y-3 rounded-3xl border border-stroke bg-white/[0.04] p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{a.name || a.from}</p>
          {a.name && <p className="truncate text-xs text-mute">{a.from}</p>}
        </div>
        <span className="shrink-0 rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn">{MISSING[a.missing]}</span>
      </div>
      <div className="text-sm">
        <p className="font-medium">{a.subject || '(no subject)'}</p>
        {a.preview && <p className="mt-1 line-clamp-3 text-mute">{a.preview}</p>}
        <p className="mt-1 text-xs text-mute">{dated(a.receivedAt)}</p>
      </div>
      <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={8}
        className="w-full resize-y rounded-2xl border border-stroke bg-black/20 p-3 text-sm outline-none focus:border-p1/60" />
      {error && <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={() => act('skip')} disabled={!!busy}
          className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt disabled:opacity-40">
          {busy === 'skip' ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Skip
        </button>
        <button onClick={() => act('send')} disabled={!!busy || !reply.trim()}
          className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-50">
          {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} {a.status === 'failed' ? 'Try again' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function Setup({ data, onChanged }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connect = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.post('/tenant-care/inbox', { email, password }); setPassword(''); onChanged(); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const disconnect = async () => {
    if (!confirm('Disconnect the Tenant care inbox? Jarvis will stop checking it.')) return;
    await api.del('/tenant-care/inbox');
    onChanged();
  };
  const toggle = async (id) => {
    const ids = data.people.filter((p) => (p.id === id ? !p.member : p.member)).map((p) => p.id);
    await api.put('/tenant-care/members', { userIds: ids });
    onChanged();
  };

  return (
    <div className="space-y-4 rounded-3xl border border-stroke bg-white/[0.03] p-4">
      <h2 className="font-medium">Settings</h2>
      {data.inbox ? (
        <div className="space-y-1 text-sm">
          <p>Inbox: <span className="font-medium">{data.inbox.email}</span></p>
          <p className="text-mute">{data.inbox.checkedAt ? `Last checked ${dated(data.inbox.checkedAt)}` : 'Not checked yet'}</p>
          {data.inbox.error && <p className="text-bad">Problem: {data.inbox.error}</p>}
          <button onClick={disconnect} className="text-sm text-mute underline hover:text-txt">Disconnect</button>
        </div>
      ) : (
        <form onSubmit={connect} className="space-y-2">
          <p className="text-sm text-mute">Connect the tenant email. Every 3 minutes Jarvis checks for new emails and replies to any that don't give a building and unit.</p>
          <input type="email" required placeholder="tenantcare@…" value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-2xl border border-stroke bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-p1/60" />
          <input type="password" required placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-2xl border border-stroke bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-p1/60" />
          {error && <p className="text-sm text-bad">{error}</p>}
          <button disabled={busy} className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />} Connect
          </button>
        </form>
      )}
      {!data.saifsys && <p className="text-sm text-bad">saifsys is not connected, so Jarvis cannot tell buildings apart yet.</p>}
      <div>
        <p className="mb-2 text-sm text-mute">Who to tell if a reply can't be sent:</p>
        <div className="flex flex-wrap gap-2">
          {data.people.map((p) => (
            <button key={p.id} onClick={() => toggle(p.id)}
              className={`flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm ${p.member ? 'border-p1/60 bg-p1/20 text-txt' : 'border-stroke text-mute hover:text-txt'}`}>
              {p.member && <Check size={13} />} {p.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function TenantCarePage({ me, onBack, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get('/tenant-care').then((d) => { setData(d); onChanged?.(); }).catch((e) => setError(e.message)), [onChanged]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      <ParticleField className="fx-canvas-panel" />
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 pt-1">
          <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <ChevronLeft size={22} />
          </button>
          <h1 className="flex-1 text-lg font-light">Tenant care</h1>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
        <div className="mx-auto max-w-3xl space-y-4 pb-8">
          {error && <p className="text-bad">{error}</p>}
          {!data && !error && <div className="grid place-items-center py-10"><Loader2 className="animate-spin text-mute" /></div>}
          {data && (
            <>
              {!data.inbox && me.role !== 'master' && <p className="text-mute">The Tenant care inbox is not connected yet.</p>}
              {data.inbox && data.open.length === 0 && (
                <p className="py-6 text-center text-mute">Nothing waiting. Jarvis replies to tenants who don't give their building or unit by itself. A reply only shows up here if it couldn't be sent.</p>
              )}
              {data.open.map((a) => <Ask key={`${a.id}-${a.status}`} a={a} onDone={load} />)}
              {data.done.length > 0 && (
                <div className="space-y-1 pt-2">
                  <p className="text-sm text-mute">Recently replied</p>
                  {data.done.map((a) => (
                    <p key={a.id} className="truncate text-sm text-mute">
                      {a.status === 'sent' ? '✓ Sent' : '– Skipped'} · {a.name || a.from} · {a.subject || '(no subject)'} · {a.by || 'Jarvis'}
                    </p>
                  ))}
                </div>
              )}
              {me.role === 'master' && data.people && <Setup data={data} onChanged={load} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
