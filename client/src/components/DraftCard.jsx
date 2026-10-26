import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Check, X, Send, AlertCircle, EyeOff, Trash2, ChevronDown, Paperclip, FileText, Download, Pencil } from 'lucide-react';
import { api } from '../lib/api';
import { cleanEmail } from '../lib/email';

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

// When it went. A card that only says "Sent" still leaves you wondering which time you
// sent it; the clock is half the proof.
const sentWhen = (ts) => {
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date().toDateString() === d.toDateString();
  return today ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
};

const fileUrl = (draftId, i) => `/api/email/drafts/${draftId}/files/${i}`;
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const extOf = (name) => (/\.([a-z0-9]{1,4})$/i.exec(name)?.[1] || '').toLowerCase();
// What the app can show without leaving the card. The server decides the same way.
const modeOf = (name) => {
  const ext = extOf(name);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['txt', 'md', 'csv', 'json', 'log', 'tsv', 'yaml', 'yml', 'xml'].includes(ext)) return 'text';
  return null;
};

// The attachment, full screen, exactly as it will go out.
function FilePreview({ name, url, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const mode = modeOf(name);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#07061a]/95 backdrop-blur-xl" onClick={onClose}>
      <header className="flex items-center gap-2 px-3 pb-2 pt-safe md:px-5" onClick={(e) => e.stopPropagation()}>
        <Paperclip size={17} className="ml-1 shrink-0 text-mute" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{name}</p>
        <a href={`${url}?download=1`} aria-label="Download" title="Download"
          className="grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Download size={19} /></a>
        <button onClick={onClose} aria-label="Close" title="Close"
          className="grid size-10 place-items-center rounded-full bg-white/10 text-txt hover:bg-white/20"><X size={20} /></button>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center px-3 pb-3 md:px-8 md:pb-6" onClick={(e) => mode !== 'image' && e.stopPropagation()}>
        {mode === 'image' && <img src={url} alt={name} onClick={(e) => e.stopPropagation()} className="rise max-h-full max-w-full rounded-xl object-contain shadow-2xl" />}
        {mode && mode !== 'image' && (
          <iframe src={mode === 'docx' ? `${url}?preview=1` : url} title={name} className="rise h-full w-full max-w-4xl rounded-xl bg-white shadow-2xl" />
        )}
        {!mode && (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-mute">This file type can't be previewed here.</p>
            <a href={`${url}?download=1`} className="flex items-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2.5 text-sm font-medium text-white"><Download size={16} /> Download</a>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

const field = 'glass w-full rounded-xl px-3 py-2 text-[13px] outline-none focus:border-p1/70';

// A rough look only, to colour a chip that will not go: the server's check is the real one.
const LOOKS_LIKE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/i;
// One piece of what was typed or pasted: "Bob <bob@x.com>" keeps only the address.
const addressOf = (s) => cleanEmail(/<([^>]*)>/.exec(s)?.[1] ?? s).toLowerCase();
// A pasted list may be split by commas, spaces or new lines, and may carry names: pick out
// the addresses. Text with no @ in it at all is kept as typed, so a mistake shows as a red
// chip rather than vanishing.
const split = (s) => {
  const found = s.match(/<[^>]*>|[^\s,;<>"]*@[^\s,;<>"]*/g);
  return (found || s.split(/[,;\s]+/)).map(addressOf).filter(Boolean);
};

// Several recipients, each its own chip, so it is plain how to add another and easy to
// take one off. A comma, semicolon, space or Enter finishes an address; a pasted list
// becomes several chips at once; Backspace in the empty box takes the last one back.
function AddressBox({ label, list, onChange, typed, onType, placeholder }) {
  const input = useRef(null);
  const add = (text) => {
    const fresh = split(text).filter((a) => !list.includes(a));
    if (fresh.length) onChange([...list, ...fresh]);
    onType('');
  };
  const keyDown = (e) => {
    if ([',', ';', 'Enter'].includes(e.key) || (e.key === ' ' && !typed.includes('<'))) {
      e.preventDefault();
      add(typed);
    } else if (e.key === 'Backspace' && !typed && list.length) {
      e.preventDefault();
      onType(list[list.length - 1]); // back into the box to fix, not lost
      onChange(list.slice(0, -1));
    }
  };

  return (
    <div className="text-xs text-mute">
      {label}
      <div onClick={() => input.current?.focus()}
        className={`${field} mt-1 flex cursor-text flex-wrap items-center gap-1.5 focus-within:border-p1/70`}>
        {list.map((a) => (
          <span key={a} title={LOOKS_LIKE.test(a) ? a : 'This does not look like an email address'}
            className={`flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-[12.5px] ${LOOKS_LIKE.test(a) ? 'border-p1/30 bg-p1/10 text-txt' : 'border-bad/50 bg-bad/10 text-bad'}`}>
            <span className="truncate">{a}</span>
            <button type="button" onClick={(e) => { e.stopPropagation(); onChange(list.filter((x) => x !== a)); }}
              aria-label={`Remove ${a}`} className="grid size-4 shrink-0 place-items-center rounded-full text-mute hover:bg-white/20 hover:text-txt">
              <X size={11} />
            </button>
          </span>
        ))}
        <input ref={input} value={typed} autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="email"
          onChange={(e) => (/[,;\n]/.test(e.target.value) ? add(e.target.value) : onType(e.target.value))}
          onKeyDown={keyDown} onBlur={() => typed && add(typed)}
          placeholder={list.length ? 'Add another…' : placeholder}
          className="min-w-[9rem] flex-1 bg-transparent py-0.5 text-txt outline-none placeholder:text-mute/70" />
      </div>
    </div>
  );
}

// Fixing the draft by hand, for the small things that are not worth asking the agent to
// write again: a name spelt wrong, a figure, one more person on Cc. Opens on what is there.
function DraftEditor({ draft, onSaved, onCancel }) {
  const [f, setF] = useState({
    to: draft.to, cc: draft.cc, subject: draft.subject || '', body: draft.body || '',
  });
  const [typed, setTyped] = useState({ to: '', cc: '' }); // what is in each box, not yet a chip
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));
  const box = (k) => ({
    list: f[k], onChange: (list) => setF((v) => ({ ...v, [k]: list })),
    typed: typed[k], onType: (s) => setTyped((t) => ({ ...t, [k]: s })),
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // An address still being typed when Save is tapped counts: it is plainly meant.
      const to = [...f.to, ...split(typed.to)];
      const cc = [...f.cc, ...split(typed.cc)];
      onSaved((await api.patch(`/email/drafts/${draft.id}`, { ...f, to, cc })).draft);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <AddressBox label="To" placeholder="name@example.com" {...box('to')} />
      <AddressBox label="Cc" placeholder="Optional" {...box('cc')} />
      <p className="-mt-1 text-[11px] text-mute/80">Add several by typing a comma or pressing Enter after each address.</p>
      <label className="block text-xs text-mute">Subject
        <input value={f.subject} onChange={set('subject')} maxLength={200} className={`${field} mt-1`} />
      </label>
      <label className="block text-xs text-mute">Message
        <textarea value={f.body} onChange={set('body')} rows={Math.min(18, Math.max(6, f.body.split('\n').length + 1))} maxLength={20000}
          dir="auto" className={`${field} mt-1 resize-y leading-relaxed text-txt`} />
      </label>
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save changes
        </button>
        <button onClick={onCancel} disabled={saving}
          className="flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt disabled:opacity-60">
          Cancel
        </button>
      </div>
    </div>
  );
}

const EVERY = 2000;
const TRIES = 15; // about half a minute, which is longer than a healthy send takes

export default function DraftCard({ draft, from, onChanged, onRemoved }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [viewing, setViewing] = useState(null); // index of the attachment being looked at
  const [editing, setEditing] = useState(false);
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

  // Once it is settled the card has done its job. Nothing folds it away on its own: the
  // person chooses to hide it (one line, tap to open again) or delete it.
  const settled = SETTLED.includes(draft.status);
  const tidy = async (what) => {
    if (what === 'delete' && !window.confirm('Delete this email card? The email itself is not affected.')) return;
    setBusy(what);
    setError(null);
    try {
      if (what === 'delete') { await api.del(`/email/drafts/${draft.id}`); onRemoved?.(draft.id); }
      else onChanged((await api.post(`/email/drafts/${draft.id}/hide`, { hidden: what === 'hide' })).draft);
    } catch (e) {
      setError(e.message);
    }
    setBusy(null);
  };

  const status = (
    <>
      <Send size={13} strokeWidth={2} className="shrink-0" />
      <span className="shrink-0">{draft.isReply ? 'Reply' : 'Email'} · {s.label}
        {draft.status === 'sent' && draft.sentAt && ` · ${sentWhen(draft.sentAt)}`}</span>
    </>
  );

  if (settled && draft.hidden) {
    return (
      <button onClick={() => tidy('show')} disabled={!!busy} title="Show the whole email"
        className={`flex w-full items-center gap-1.5 rounded-full border px-3.5 py-2 text-left text-xs ${s.tone} ${s.dot} hover:brightness-125`}>
        {status}
        <span className="min-w-0 flex-1 truncate text-mute">· {draft.subject || '(no subject)'}</span>
        {busy ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <ChevronDown size={14} className="shrink-0" />}
      </button>
    );
  }

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <div className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        {status}
        {settled && (
          <span className="ml-auto flex shrink-0 gap-1">
            <button onClick={() => tidy('hide')} disabled={!!busy}
              className="flex items-center gap-1 rounded-full border border-stroke px-2.5 py-1 text-mute hover:text-txt disabled:opacity-60">
              {busy === 'hide' ? <Loader2 size={12} className="animate-spin" /> : <EyeOff size={12} />} Hide
            </button>
            {onRemoved && (
              <button onClick={() => tidy('delete')} disabled={!!busy}
                className="flex items-center gap-1 rounded-full border border-stroke px-2.5 py-1 text-mute hover:border-bad/60 hover:text-bad disabled:opacity-60">
                {busy === 'delete' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Delete
              </button>
            )}
          </span>
        )}
        {draft.status === 'pending' && !editing && (
          <button onClick={() => { setError(null); setEditing(true); }} disabled={!!busy}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-stroke px-2.5 py-1 text-mute hover:text-txt disabled:opacity-60">
            <Pencil size={12} /> Edit
          </button>
        )}
      </div>

      {editing && draft.status === 'pending' ? (
        <DraftEditor draft={draft} onCancel={() => setEditing(false)}
          onSaved={(d) => { onChanged(d); setEditing(false); }} />
      ) : (<>
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
      </>)}

      {draft.files?.length > 0 && (
        <div className="mt-2.5 border-t border-stroke/60 pt-2.5">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs text-mute"><Paperclip size={12} /> {draft.files.length === 1 ? '1 attachment' : `${draft.files.length} attachments`}</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {draft.files.map((f, i) => (
              <li key={i}>
                <button onClick={() => setViewing(i)} disabled={!f.here} title={f.here ? 'Preview' : 'No longer kept here'}
                  className="flex w-full items-center gap-2.5 rounded-xl border border-stroke bg-white/[0.04] p-2 text-left enabled:hover:border-p1/60 enabled:hover:bg-white/[0.08] disabled:opacity-70">
                  {f.here && modeOf(f.name) === 'image'
                    ? <img src={fileUrl(draft.id, i)} alt="" className="size-11 shrink-0 rounded-lg object-cover" />
                    : <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-white/[0.07] text-[10px] font-semibold uppercase text-mute">{extOf(f.name) || <FileText size={18} />}</span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-txt">{f.name}</span>
                    <span className="block text-[11px] text-mute">{[f.size && fmtSize(f.size), f.here && 'Tap to preview'].filter(Boolean).join(' · ')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {viewing !== null && draft.files?.[viewing] && (
        <FilePreview name={draft.files[viewing].name} url={fileUrl(draft.id, viewing)} onClose={() => setViewing(null)} />
      )}

      {draft.error && (
        <p className="mt-2.5 flex items-start gap-2 text-xs text-bad"><AlertCircle size={14} className="mt-0.5 shrink-0" />{draft.error}</p>
      )}
      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      {draft.status === 'pending' && !editing && (
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
