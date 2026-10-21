import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Search, Send, Sparkles, Mic, Square, Paperclip, X, AlertTriangle, CheckCircle2, ChevronDown, FileText, Undo2 } from 'lucide-react';
import { api } from '../lib/api';
import { useRecorder } from '../lib/useRecorder';
import Page from './Page';

// Shared inbox: the emails Mail routing passed on to this person (server/sharedInbox.js),
// read and answered here. The answer goes out from the shared address, in the same thread,
// so whoever wrote only ever sees the address they wrote to. Typed, spoken, or written with
// Reem first; nothing goes out until Send.

const dated = (secs) => secs ? new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const primary = 'flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-50';
const quiet = 'flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt disabled:opacity-40';
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const size = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const newKey = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, '');

function Reply({ email, address, onSent }) {
  const [text, setText] = useState('');
  const [before, setBefore] = useState(null); // the text before Reem wrote, for Undo
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const key = useRef(newKey()); // the same key on a retry, so a reply is never sent twice
  const pick = useRef(null);

  const write = async (notes = text) => {
    setBusy('draft'); setError('');
    try {
      const r = await api.post(`/shared-inbox/${email.id}/draft`, { notes });
      setBefore(text); setText(r.text);
    } catch (e) { setError(e.message); }
    setBusy('');
  };
  // Spoken: the words are added to the box, to send as they are or have Reem write them up.
  const heard = async (blob) => {
    setBusy('voice'); setError('');
    try {
      const form = new FormData();
      form.append('audio', blob, `reply.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
      const said = (await api.upload('/voice/transcribe', form)).text?.trim();
      if (!said) setError('Reem did not hear anything. Try again, a little closer to the microphone.');
      else setText((t) => (t.trim() ? `${t.trim()}\n${said}` : said));
    } catch (e) { setError(e.message); }
    setBusy('');
  };
  const rec = useRecorder(heard, 300);
  const send = async () => {
    setBusy('send'); setError('');
    try {
      const form = new FormData();
      form.append('text', text);
      form.append('key', key.current);
      for (const f of files) form.append('files', f, f.name);
      const r = await api.upload(`/shared-inbox/${email.id}/reply`, form);
      setText(''); setFiles([]); setBefore(null); key.current = newKey();
      onSent(r.email);
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  const off = !!busy || rec.recording;
  return (
    <div className="space-y-2 border-t border-stroke/60 pt-3">
      <p className="text-xs text-mute">Your reply goes to {email.name || email.from} from {address || 'the shared address'}.</p>
      <textarea value={text} onChange={(e) => { setText(e.target.value); setBefore(null); }} rows={7} disabled={busy === 'draft' || busy === 'voice'}
        placeholder="Write your answer, speak it, or jot a few words and tap Write with Reem"
        className="w-full resize-y rounded-2xl border border-stroke bg-black/20 p-3 text-sm outline-none focus:border-p1/60" />
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-xs">
              <FileText size={12} /> <span className="max-w-[12rem] truncate">{f.name}</span>
              <button onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="text-mute hover:text-txt"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => (rec.recording ? rec.stop() : rec.start().catch((e) => setError(e.message)))}
          disabled={!!busy && !rec.recording}
          className={rec.recording ? 'flex items-center gap-1.5 rounded-full border border-bad/60 bg-bad/15 px-4 py-2 text-sm text-bad' : quiet}>
          {rec.recording
            ? <><Square size={13} fill="currentColor" /> <span className="font-mono tabular-nums">{clock(rec.secs)}</span> Tap to stop</>
            : busy === 'voice' ? <><Loader2 size={14} className="animate-spin" /> Listening back…</> : <><Mic size={14} /> Speak</>}
        </button>
        <button onClick={() => write()} disabled={off} className={quiet}>
          {busy === 'draft' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {busy === 'draft' ? 'Reem is writing…' : 'Write with Reem'}
        </button>
        {before !== null && <button onClick={() => { setText(before); setBefore(null); }} disabled={off} className={quiet}><Undo2 size={14} /> Undo</button>}
        <button onClick={() => pick.current?.click()} disabled={off || files.length >= 10} className={quiet}><Paperclip size={14} /> Attach</button>
        <input ref={pick} type="file" multiple hidden onChange={(e) => { setFiles([...files, ...e.target.files].slice(0, 10)); e.target.value = ''; }} />
        <span className="flex-1" />
        <button onClick={send} disabled={off || !text.trim()} className={primary}>
          {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send
        </button>
      </div>
    </div>
  );
}

function Email({ email, address, onChanged }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(null);
  const [error, setError] = useState('');
  const toggle = () => {
    setOpen(!open);
    if (!open && !full) api.get(`/shared-inbox/${email.id}`).then(setFull).catch((e) => setError(e.message));
  };
  const replied = email.replies.filter((r) => !r.failed);
  return (
    <div className="rounded-3xl border border-stroke bg-white/[0.04] p-4">
      <button onClick={toggle} className="flex w-full items-start gap-2 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate font-medium">{email.name || email.from}</p>
            <span className="shrink-0 text-xs text-mute">{dated(email.at)}</span>
          </div>
          <p className="truncate text-sm">{email.subject || '(no subject)'}</p>
          {email.reason && <p className="mt-0.5 line-clamp-2 text-xs text-mute">{email.reason}</p>}
          {replied.length > 0 && (
            <p className="mt-1 flex items-center gap-1 text-xs text-emerald-400">
              <CheckCircle2 size={13} /> Replied by {[...new Set(replied.map((r) => r.by))].join(', ')} · {dated(replied[replied.length - 1].at)}
            </p>
          )}
        </div>
        <ChevronDown size={18} className={`mt-0.5 shrink-0 text-mute transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {email.name && <p className="text-xs text-mute">{email.from}</p>}
          {error && <p className="text-sm text-bad">{error}</p>}
          {!full && !error && <div className="grid place-items-center py-4"><Loader2 className="animate-spin text-mute" /></div>}
          {full && (
            <>
              <div className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-2xl bg-black/20 p-3 text-sm" dir="auto">{full.text || '(no text)'}</div>
              {full.files.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {full.files.map((f) => (
                    <a key={f.i} href={`/api/shared-inbox/${email.id}/files/${f.i}`} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-xs hover:border-p1/60">
                      <FileText size={12} /> <span className="max-w-[14rem] truncate">{f.name}</span> <span className="text-mute">{size(f.size)}</span>
                    </a>
                  ))}
                </div>
              )}
            </>
          )}
          {email.replies.map((r) => (
            <div key={r.id} className={`rounded-2xl border p-3 text-sm ${r.failed ? 'border-bad/40' : 'border-stroke'}`}>
              <p className="mb-1 text-xs text-mute">{r.failed ? `Not sent: ${r.error || 'it failed'}` : `${r.by} replied · ${dated(r.at)}`}</p>
              <p className="line-clamp-4 whitespace-pre-wrap" dir="auto">{r.text}</p>
            </div>
          ))}
          <Reply email={email} address={address} onSent={onChanged} />
        </div>
      )}
    </div>
  );
}

export default function SharedInboxPage({ me, onBack }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => api.get(`/shared-inbox?q=${encodeURIComponent(q.trim())}`).then(setData).catch((e) => setError(e.message)), [q]);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  const sent = (email) => setData((d) => ({ ...d, emails: d.emails.map((e) => (e.id === email.id ? email : e)) }));

  return (
    <Page title="Shared inbox" onBack={onBack}>
      <div className="space-y-3">
        <p className="text-sm text-mute">
          {me.role === 'master' ? 'Every email that came to' : 'The emails passed on to you from'} {data?.address || 'the shared mailbox'}. Your replies go out from that address.
        </p>
        <label className="flex items-center gap-2 rounded-2xl border border-stroke bg-black/20 px-3 py-2 focus-within:border-p1/60">
          <Search size={15} className="shrink-0 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search who or what" className="w-full bg-transparent text-sm outline-none" />
        </label>
        {error && <p className="text-bad">{error}</p>}
        {!data && !error && <div className="grid place-items-center py-10"><Loader2 className="animate-spin text-mute" /></div>}
        {data && data.emails.length === 0 && <p className="py-6 text-center text-mute">{q ? 'Nothing matches.' : 'No emails yet.'}</p>}
        {data?.emails.map((e) => <Email key={e.id} email={e} address={data.address} onChanged={sent} />)}
      </div>
    </Page>
  );
}
