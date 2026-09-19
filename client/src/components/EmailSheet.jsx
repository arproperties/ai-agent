import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import Icon from './Icon';
import Sheet from './Sheet';

// Connect / disconnect Outlook. `returned` is set when coming back from the Microsoft sign-in page.
export default function EmailSheet({ returned, onClose }) {
  const [state, setState] = useState(null); // { enabled, account }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(returned?.status === 'error' ? returned.message || 'Could not connect Outlook' : null);

  const load = () => api.get('/outlook').then(setState).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    window.addEventListener('focus', load); // sign-in may finish in another window
    return () => window.removeEventListener('focus', load);
  }, []);

  const disconnect = async () => {
    if (!confirm('Disconnect Outlook? Your agents will no longer be able to read your email.')) return;
    setBusy(true);
    await api.del('/outlook').catch((e) => setError(e.message));
    setBusy(false);
    load();
  };

  return (
    <Sheet title="Email" onClose={onClose}
      icon={<span className="grid size-8 place-items-center rounded-full bg-cyan-400/20 text-cyan-300"><Icon name="mail" size={17} /></span>}>
      {returned?.status === 'connected' && state?.account && (
        <p className="mb-3 flex items-start gap-2 rounded-2xl bg-ok/10 px-3.5 py-2.5 text-sm text-ok">
          <CheckCircle2 size={17} className="mt-0.5 shrink-0" /> Outlook is connected. Try asking “Any important emails today?”
        </p>
      )}
      {error && (
        <p className="mb-3 flex items-start gap-2 rounded-2xl bg-bad/10 px-3.5 py-2.5 text-sm text-bad">
          <AlertCircle size={17} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      <div className="flex items-center gap-3 rounded-2xl border border-stroke bg-white/[0.04] p-3.5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-700 text-white"><Icon name="mail" size={20} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Outlook</p>
          <p className="truncate text-xs text-mute">
            {!state ? 'Checking…'
              : state.account ? `Connected · ${state.account.email || 'Microsoft account'}`
              : 'Outlook.com, Hotmail or Microsoft 365'}
          </p>
        </div>
        {!state ? <Loader2 size={18} className="animate-spin text-mute" />
          : state.account ? (
            <button onClick={disconnect} disabled={busy}
              className="rounded-full border border-stroke px-3.5 py-1.5 text-sm text-mute hover:border-bad/60 hover:text-bad disabled:opacity-50">Disconnect</button>
          ) : state.enabled ? (
            <a href="/api/outlook/connect"
              className="rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-1.5 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98]">Connect</a>
          ) : null}
      </div>

      {state && !state.enabled && (
        <p className="mt-3 rounded-2xl bg-warn/10 px-3.5 py-2.5 text-sm text-warn">
          Not set up on the server yet: add <code>MS_CLIENT_ID</code> and <code>MS_CLIENT_SECRET</code> to <code>.env</code> (see README), then restart.
        </p>
      )}
      <p className="mt-4 text-xs leading-relaxed text-mute">
        Your agents can search and read your email when you ask about it, e.g. “What did the landlord send last week?”.
        They can’t send, reply, move or delete anything. Emails are fetched only when needed, not copied into Jarvis.
      </p>
    </Sheet>
  );
}
