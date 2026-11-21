import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// Needs you (server/needsYou.js): everything Reem has got ready that is waiting on your tap,
// across all your chats, oldest first. Each one is a card in the chat it came from: "Open chat"
// goes there. Nothing is approved or cancelled from this page.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function NeedsYouPage({ onBack, onOpenChat }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setError('');
    try { setData(await api.get('/needs-you')); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  useEffect(() => { load(); }, []);

  const refresh = (
    <button onClick={load} disabled={busy} aria-label="Refresh" title="Refresh"
      className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt disabled:opacity-50">
      <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
    </button>
  );

  return (
    <Page title="Needs you" onBack={onBack} action={refresh}>
      <p className="mb-4 text-sm leading-relaxed text-mute">
        What Reem has got ready and is waiting for your tap, from all your chats. Open the chat to approve or cancel it there.
      </p>
      {error && <p className="mb-3 text-sm text-bad">{error}</p>}
      {!data ? (error ? null : <Loader2 size={18} className="mx-auto my-8 animate-spin text-mute" />) : data.items.length === 0 ? (
        <p className="rounded-2xl bg-white/[0.03] px-4 py-3 text-sm text-mute">Nothing is waiting on you.</p>
      ) : (
        <>
          <h2 className="mb-2 text-xs font-medium tracking-[0.12em] text-mute">WAITING ({data.total})</h2>
          <div className="space-y-1.5">
            {data.items.map((n) => (
              <div key={`${n.kind}-${n.id}`} className="flex items-center gap-3 rounded-2xl bg-white/5 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px]">{n.label}{n.title ? ` · ${n.title}` : ''}</p>
                  <p className="text-xs text-mute">{n.waiting_days === 0 ? 'Today' : `Waiting ${plural(n.waiting_days, 'day')}`}</p>
                </div>
                {n.conversation_id ? (
                  <button onClick={() => onOpenChat(n.conversation_id)}
                    className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs text-mute transition hover:bg-white/10 hover:text-txt">
                    Open chat <ChevronRight size={13} />
                  </button>
                ) : <span className="shrink-0 text-xs text-mute">chat removed</span>}
              </div>
            ))}
          </div>
          {data.total > data.items.length && (
            <p className="px-2 pt-2 text-xs text-mute">Showing the {data.items.length} oldest of {data.total}.</p>
          )}
        </>
      )}
    </Page>
  );
}
