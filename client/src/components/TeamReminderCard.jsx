import { useState } from 'react';
import { Loader2, Check, X, BellRing, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

// A reminder for other people that Riley has got ready, waiting for the person sending it.
// Nothing goes to anyone until Send is tapped here. Once sent, the card becomes the answer
// to "has everyone done it?" — a tick beside each name.

const STATE = {
  pending: { label: 'Ready — tap Send', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  scheduled: { label: 'Will be sent', tone: 'border-p1/40 bg-p1/[0.06]', dot: 'text-p1' },
  delivered: { label: 'Sent', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  cancelled: { label: 'Cancelled', tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute' },
};

const at = (ts) => {
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString() ? `today ${time}` : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
};

export default function TeamReminderCard({ reminder: r, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const s = STATE[r.status] || STATE.pending;
  const done = r.people.filter((p) => p.done).length;

  const act = async (what) => {
    setBusy(what);
    setError(null);
    try {
      onChanged(what === 'refresh' ? await api.get(`/team-reminders/${r.id}`) : await api.post(`/team-reminders/${r.id}/${what}`));
    } catch (e) {
      setError(e.message);
    }
    setBusy(null);
  };

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <BellRing size={13} strokeWidth={2} />
        Reminder · {s.label}
        {r.status === 'scheduled' && r.remind_at && ` ${at(r.remind_at)}`}
        {r.status === 'delivered' && r.delivered_at && ` ${at(r.delivered_at)}`}
        {r.status === 'delivered' && (
          <button onClick={() => act('refresh')} disabled={!!busy} aria-label="Check who has done it" title="Check who has done it"
            className="ml-auto text-mute hover:text-txt">
            <RefreshCw size={13} className={busy === 'refresh' ? 'animate-spin' : ''} />
          </button>
        )}
      </p>

      <p className="text-[15px] font-medium leading-snug">{r.text}</p>

      <div className="mt-2.5 border-t border-stroke/60 pt-2.5 text-[13px]">
        <p className="mb-1.5 text-xs text-mute">
          {r.everyone ? `Everyone · ${r.people.length} people` : `To ${r.people.length === 1 ? '1 person' : `${r.people.length} people`}`}
          {r.status === 'pending' && ` · ${r.remind_at ? at(r.remind_at) : 'straight away'}`}
          {r.status === 'delivered' && ` · ${done} of ${r.people.length} done`}
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {r.people.map((p) => (
            <li key={p.id} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${p.done ? 'border-ok/40 text-ok' : 'border-stroke text-txt'}`}>
              {p.done && <Check size={12} />}{p.name}
            </li>
          ))}
        </ul>
      </div>

      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      {r.status === 'pending' && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => act('send')} disabled={!!busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
            {busy === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Send
          </button>
          <button onClick={() => act('cancel')} disabled={!!busy}
            className="flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:border-bad/60 hover:text-bad disabled:opacity-60">
            {busy === 'cancel' ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />} Cancel
          </button>
        </div>
      )}
    </div>
  );
}
