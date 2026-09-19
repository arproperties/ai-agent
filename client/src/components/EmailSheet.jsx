import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, AtSign } from 'lucide-react';
import { api } from '../lib/api';
import Icon from './Icon';
import Sheet from './Sheet';

const Notice = ({ ok, children }) => (
  <p className={`mb-3 flex items-start gap-2 rounded-2xl px-3.5 py-2.5 text-sm ${ok ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad'}`}>
    {ok ? <CheckCircle2 size={17} className="mt-0.5 shrink-0" /> : <AlertCircle size={17} className="mt-0.5 shrink-0" />} <span>{children}</span>
  </p>
);
const field = 'w-full rounded-xl border border-stroke bg-white/[0.04] px-3.5 py-2.5 text-sm outline-none placeholder:text-mute/70 focus:border-p1/60';

// Any IMAP mailbox: Titan, Gmail, Zoho… The server finds the mail server from the address.
function ImapCard({ account, onChange }) {
  const [form, setForm] = useState({ email: '', password: '', host: '', port: '' });
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const connect = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/imap', form);
      onChange('connected');
    } catch (err) {
      setError(err.message);
      setAdvanced((a) => a || /server|port/i.test(err.message));
    }
    setBusy(false);
  };
  const disconnect = async () => {
    if (!confirm('Disconnect this email? Your agents will no longer be able to read it, and the saved password is deleted.')) return;
    await api.del('/imap').catch((err) => setError(err.message));
    onChange();
  };

  return (
    <div className="rounded-2xl border border-stroke bg-white/[0.04] p-3.5">
      <div className="flex items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-p1 to-p2 text-white"><AtSign size={20} strokeWidth={1.75} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Email account</p>
          <p className="truncate text-xs text-mute">{account ? `Connected · ${account.email}` : 'Company email (Titan), Gmail, Zoho or any IMAP mailbox'}</p>
        </div>
        {account && (
          <button onClick={disconnect}
            className="rounded-full border border-stroke px-3.5 py-1.5 text-sm text-mute hover:border-bad/60 hover:text-bad">Disconnect</button>
        )}
      </div>

      {!account && (
        <form onSubmit={connect} className="mt-3.5 space-y-2.5">
          {error && <Notice>{error}</Notice>}
          <input type="email" required autoComplete="username" placeholder="you@company.com" value={form.email} onChange={set('email')} className={field} />
          <input type="password" required autoComplete="current-password" placeholder="Email password" value={form.password} onChange={set('password')} className={field} />
          {advanced ? (
            <div className="grid grid-cols-[1fr_88px] gap-2">
              <input placeholder="Server (automatic)" value={form.host} onChange={set('host')} className={field} />
              <input inputMode="numeric" placeholder="993" value={form.port} onChange={set('port')} className={field} />
            </div>
          ) : (
            <button type="button" onClick={() => setAdvanced(true)} className="text-xs text-mute underline-offset-2 hover:text-txt hover:underline">Advanced</button>
          )}
          <button disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
            {busy ? <><Loader2 size={16} className="animate-spin" /> Connecting…</> : 'Connect'}
          </button>
        </form>
      )}
    </div>
  );
}

// Outlook via Microsoft sign-in: only shown when the server has Microsoft keys (or an account is already connected)
function OutlookCard({ state, onChange }) {
  const disconnect = async () => {
    if (!confirm('Disconnect Outlook? Your agents will no longer be able to read it.')) return;
    await api.del('/outlook').catch(() => {});
    onChange();
  };
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-stroke bg-white/[0.04] p-3.5">
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-700 text-white"><Icon name="mail" size={20} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Outlook</p>
        <p className="truncate text-xs text-mute">{state.account ? `Connected · ${state.account.email || 'Microsoft account'}` : 'Outlook.com, Hotmail or Microsoft 365'}</p>
      </div>
      {state.account ? (
        <button onClick={disconnect}
          className="rounded-full border border-stroke px-3.5 py-1.5 text-sm text-mute hover:border-bad/60 hover:text-bad">Disconnect</button>
      ) : (
        <a href="/api/outlook/connect"
          className="rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-1.5 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98]">Connect</a>
      )}
    </div>
  );
}

// `returned` is set when coming back from the Microsoft sign-in page
export default function EmailSheet({ returned, onClose }) {
  const [imap, setImap] = useState(null);
  const [outlook, setOutlook] = useState(null);
  const [done, setDone] = useState(returned?.status === 'connected');
  const [error, setError] = useState(returned?.status === 'error' ? returned.message || 'Could not connect Outlook' : null);

  const load = () => Promise.all([
    api.get('/imap').then(setImap),
    api.get('/outlook').then(setOutlook),
  ]).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    window.addEventListener('focus', load); // Microsoft sign-in may finish in another window
    return () => window.removeEventListener('focus', load);
  }, []);
  const changed = (status) => { setDone(status === 'connected'); setError(null); load(); };

  return (
    <Sheet title="Email" onClose={onClose}
      icon={<span className="grid size-8 place-items-center rounded-full bg-cyan-400/20 text-cyan-300"><Icon name="mail" size={17} /></span>}>
      {done && (imap?.account || outlook?.account) && <Notice ok>Email connected. Try asking “Any important emails today?”</Notice>}
      {error && <Notice>{error}</Notice>}

      {!imap || !outlook ? <Loader2 size={20} className="mx-auto my-6 animate-spin text-mute" /> : (
        <div className="space-y-3">
          <ImapCard account={imap.account} onChange={changed} />
          {(outlook.enabled || outlook.account) && <OutlookCard state={outlook} onChange={changed} />}
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-mute">
        Your agents can search and read your email when you ask about it, e.g. “What did the landlord send last week?”.
        They can’t send, reply, move or delete anything, and reading doesn’t mark emails as read.
        Emails are fetched only when needed, not copied into Jarvis. Your password is stored encrypted.
      </p>
    </Sheet>
  );
}
