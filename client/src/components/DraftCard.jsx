import { useEffect, useRef, useState } from 'react';
import { Loader2, Check, X, Send, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';

// An email an agent wrote, waiting for the person whose name it would go out under.
// The whole body is shown, not a preview: approving something you have only seen the top
// of is not approving it.

const STATE = {
  pending: { label: 'Waiting for your approval', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  approved: { label: 'Approved — sending', tone: 'border-p1/40 bg-p1/[0.06]', dot: 'text-p1' },
  sending: { label: 'Sending…', tone: 'border-p1/40 bg-p1/[0.06]', dot: 'text-p1' },
  sent: { label: 'Sent', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  rejected: { label: 'Rejected', tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute' },
  failed: { label: 'Could not be sent', tone: 'border-bad/40 bg-bad/[0.06]', dot: 'text-bad' },
};

const SETTLED = ['sent', 'failed', 'rejected'];
const EVERY = 2000;
const TRIES = 15; // about half a minute, which is longer than a healthy send takes

export default function DraftCard({ draft, from, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const watch = useRef(null);
  const s = STATE[draft.status] || STATE.pending;

  useEffect(() => () => clearTimeout(watch.current), []);

  // Approving answers the moment the draft is queued, not when the email lands, so without
  // this the card would say "sending" for ever — whether it went or not. Ask the one draft
  // what became of it until it settles. Giving up shows the last thing known to be true
  // rather than a guess; the next time the screen loads drafts it will say.
  const follow = (id, left = TRIES) => {
    clearTimeout(watch.current);
    if (left <= 0) return;
    watch.current = setTimeout(async () => {
      const { draft: d } = await api.get(`/email/drafts/${id}`).catch(() => ({}));
      if (!d) return;
      onChanged(d);
      if (!SETTLED.includes(d.status)) follow(id, left - 1);
    }, EVERY);
  };

  const decide = async (what) => {
    setBusy(what);
    setError(null);
    try {
      const { draft: updated } = await api.post(`/email/drafts/${draft.id}/${what}`);
      onChanged(updated);
      if (!SETTLED.includes(updated.status)) follow(updated.id);
    } catch (e) {
      setError(e.message);
    }
    setBusy(null);
  };

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <Send size={13} strokeWidth={2} />
        {draft.isReply ? 'Reply' : 'Email'} · {s.label}
      </p>

      <dl className="space-y-1 text-[13px]">
        {from && (
          <div className="flex gap-2"><dt className="w-10 shrink-0 text-mute">From</dt><dd className="min-w-0 break-words">{from}</dd></div>
        )}
        <div className="flex gap-2"><dt className="w-10 shrink-0 text-mute">To</dt><dd className="min-w-0 break-words">{draft.to.join(', ')}</dd></div>
        {draft.cc.length > 0 && (
          <div className="flex gap-2"><dt className="w-10 shrink-0 text-mute">Cc</dt><dd className="min-w-0 break-words">{draft.cc.join(', ')}</dd></div>
        )}
        <div className="flex gap-2"><dt className="w-10 shrink-0 text-mute">Subject</dt><dd className="min-w-0 break-words font-medium">{draft.subject || '(no subject)'}</dd></div>
      </dl>

      <p className="mt-2.5 whitespace-pre-wrap border-t border-stroke/60 pt-2.5 text-[13px] leading-relaxed">{draft.body}</p>

      {draft.error && (
        <p className="mt-2.5 flex items-start gap-2 text-xs text-bad"><AlertCircle size={14} className="mt-0.5 shrink-0" />{draft.error}</p>
      )}
      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      {draft.status === 'pending' && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => decide('approve')} disabled={!!busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
            {busy === 'approve' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Approve and send
          </button>
          <button onClick={() => decide('reject')} disabled={!!busy}
            className="flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:border-bad/60 hover:text-bad disabled:opacity-60">
            {busy === 'reject' ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />} Reject
          </button>
        </div>
      )}
    </div>
  );
}
