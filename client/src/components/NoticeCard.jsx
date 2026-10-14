import { useState } from 'react';
import { Loader2, Send, X, Megaphone, RotateCw } from 'lucide-react';
import { api } from '../lib/api';

// A notice to a tenant Reem got ready from what was said or sent in chat. Nothing is
// emailed until Send is tapped here (server/notices.js, decideNotice).

const STATE = {
  draft: { label: 'Ready — tap Send', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  sending: { label: 'Sending…', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  sent: { label: 'Sent to the tenant', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  no_email: { label: 'Saved, not emailed: saifsys has no tenant email for this unit', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  failed: { label: 'Could not be sent', tone: 'border-bad/40 bg-bad/[0.06]', dot: 'text-bad' },
  cancelled: { label: 'Cancelled', tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute' },
};

export default function NoticeCard({ notice: n, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const s = STATE[n.status] || STATE.draft;

  const act = async (what) => {
    setBusy(what);
    setError(null);
    try {
      if (what === 'retry') {
        const r = await api.post(`/notices/${n.id}/send`);
        onChanged({ ...n, status: r.status, error: r.error });
      } else onChanged(await api.post(`/notices/chat/${n.id}/${what}`));
    } catch (e) { setError(e.message); }
    setBusy(null);
  };

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <Megaphone size={13} strokeWidth={2} />
        Tenant notice · {s.label}
      </p>
      <p className="text-[15px] font-medium leading-snug">{n.building}, Unit {n.unit}</p>
      <p className="mt-0.5 break-all text-xs text-mute">
        To: {n.to.length ? n.to.join(', ') : 'no tenant email in saifsys'}
      </p>
      <p className="mt-2 whitespace-pre-wrap text-txt/85">{n.description}</p>
      {n.photos.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {n.photos.map((p) => (
            <a key={p} href={`/api/notices/${n.id}/photos/${p}`} target="_blank" rel="noreferrer">
              <img src={`/api/notices/${n.id}/photos/${p}`} alt="" loading="lazy" className="size-16 rounded-xl border border-stroke object-cover" />
            </a>
          ))}
        </div>
      )}

      {n.status === 'failed' && n.error && <p className="mt-2.5 text-xs text-bad">{n.error}</p>}
      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      {n.status === 'draft' && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => act('send')} disabled={!!busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
            {busy === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {n.to.length ? 'Send' : 'Save'}
          </button>
          <button onClick={() => act('cancel')} disabled={!!busy}
            className="flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:border-bad/60 hover:text-bad disabled:opacity-60">
            {busy === 'cancel' ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />} Cancel
          </button>
        </div>
      )}
      {(n.status === 'failed' || n.status === 'no_email') && (
        <button onClick={() => act('retry')} disabled={!!busy}
          className="mt-3 flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt disabled:opacity-60">
          {busy === 'retry' ? <Loader2 size={15} className="animate-spin" /> : <RotateCw size={15} />} Try again
        </button>
      )}
    </div>
  );
}
