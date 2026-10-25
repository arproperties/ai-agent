import { useState } from 'react';
import { Loader2, Check, X, FolderOpen } from 'lucide-react';
import { api } from '../lib/api';

// A case Reem got ready from the inbox in chat: the folder name, the emails found, and how
// to keep them. Nothing is stored until Save is tapped here (server/caseFolders.js, decide).

const STATE = {
  pending: { label: 'Ready — tap Save', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  saved: { label: 'Saved', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  cancelled: { label: 'Cancelled', tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute' },
};
const day = (at) => (at ? new Date(at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const who = (s) => String(s || '').replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '') || s || 'Unknown sender';
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function CaseCard({ card: c, onChanged, onOpenShelf }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState(c.name || '');
  const [skip, setSkip] = useState(() => new Set()); // the emails unticked
  const [fullPdf, setFullPdf] = useState(true);
  const [perEmail, setPerEmail] = useState(false);
  const s = STATE[c.status] || STATE.pending;
  const open = c.status === 'pending';
  const kept = c.emails.length - skip.size;

  const toggle = (key) => setSkip((was) => {
    const next = new Set(was);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const act = async (what) => {
    setBusy(what);
    setError(null);
    const body = what === 'save' ? { name: name.trim(), full_pdf: fullPdf, per_email: perEmail, exclude: [...skip] } : undefined;
    try { onChanged(await api.post(`/cases/proposals/${c.id}/${what}`, body)); } catch (e) { setError(e.message); }
    setBusy(null);
  };

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <FolderOpen size={13} strokeWidth={2} />
        Case {c.case_number} · {s.label}
      </p>

      {open ? (
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={!!busy} aria-label="Folder name"
          className="w-full rounded-xl border border-stroke bg-white/[0.04] px-3 py-2 text-[15px] font-medium outline-none focus:border-p1/60 disabled:opacity-60" />
      ) : (
        <p className="text-[15px] font-medium leading-snug">{c.name}</p>
      )}
      <p className="mt-1.5 text-xs text-mute">{count(c.count, 'email')} · {day(c.from)} – {day(c.to)}</p>

      <ul className="mt-2.5 max-h-72 space-y-1 overflow-y-auto">
        {c.emails.map((e) => (
          <li key={e.mail_key}>
            <label className={`flex items-start gap-2.5 rounded-lg px-1 py-1 ${open ? 'cursor-pointer hover:bg-white/[0.03]' : ''}`}>
              {open && (
                <input type="checkbox" checked={!skip.has(e.mail_key)} disabled={!!busy} onChange={() => toggle(e.mail_key)}
                  className="mt-0.5 size-4 shrink-0 accent-p1 disabled:opacity-60" />
              )}
              <span className={`min-w-0 flex-1 ${skip.has(e.mail_key) ? 'text-mute line-through' : 'text-txt/85'}`}>
                <span className="text-mute">{day(e.at)} · {who(e.sender)} · </span>{e.subject || '(no subject)'}
              </span>
            </label>
          </li>
        ))}
      </ul>

      {open && (
        <div className="mt-3 space-y-1.5">
          <p className="text-[13px] font-medium">{c.question}</p>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-txt/85">
            <input type="checkbox" checked={fullPdf} disabled={!!busy} onChange={(e) => setFullPdf(e.target.checked)} className="size-4 accent-p1 disabled:opacity-60" />
            One full case PDF (summary + all emails)
          </label>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-txt/85">
            <input type="checkbox" checked={perEmail} disabled={!!busy} onChange={(e) => setPerEmail(e.target.checked)} className="size-4 accent-p1 disabled:opacity-60" />
            A separate PDF per email
          </label>
        </div>
      )}

      {c.status === 'saved' && (
        <p className="mt-2.5 flex flex-wrap items-center gap-x-2 text-xs text-ok">
          Saved to your Shelf
          {onOpenShelf && <button onClick={onOpenShelf} className="font-medium underline underline-offset-2 hover:text-txt">Open the Shelf</button>}
        </p>
      )}

      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      {open && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => act('save')} disabled={!!busy || kept === 0 || (!fullPdf && !perEmail)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
            {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {busy === 'save' ? 'Saving…' : 'Save'}
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
