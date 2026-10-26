import { useEffect, useState } from 'react';
import { Check, Copy, Loader2, Share2 } from 'lucide-react';
import { api } from '../lib/api';
import Sheet from './Sheet';

// Share a case folder: the case PDF by email, or a link to its files (server/caseShare.js).

const field = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';

export default function CaseShareSheet({ folder: f, onClose, onChanged }) {
  const [tab, setTab] = useState('email');
  return (
    <Sheet title={`Share ${f.name}`} icon={<Share2 size={18} className="text-p1" />} onClose={onClose}
      tabs={[['email', 'Email'], ['link', 'Link']]} tab={tab} onTab={setTab}>
      {tab === 'email' ? <EmailTab f={f} /> : <LinkTab f={f} onChanged={onChanged} />}
    </Sheet>
  );
}

function EmailTab({ f }) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');
  const send = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { setDone((await api.post(`/cases/${f.id}/email`, { to, cc, body })).via); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  if (done) {
    return (
      <div className="space-y-3 py-4 text-center">
        <Check size={28} className="mx-auto text-ok" />
        <p className="text-sm">{done === 'mailbox' ? 'Sent from your mailbox, with the case PDF attached.' : 'Sent with the case PDF attached. Replies come to your own address.'}</p>
        <button onClick={() => { setDone(null); setTo(''); setCc(''); setBody(''); }} className="text-sm text-mute underline underline-offset-2 hover:text-txt">Send to someone else</button>
      </div>
    );
  }
  return (
    <form onSubmit={send} className="space-y-3">
      <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To" inputMode="email" className={field} />
      <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Cc (optional)" inputMode="email" className={field} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5}
        placeholder="Message. Left empty, it is the case's latest position."
        className={`${field} resize-none leading-relaxed`} />
      <p className="text-xs text-mute">The full case PDF goes with it. The subject is the folder's name.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <button disabled={busy || !to.trim()} className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white disabled:opacity-60">
        {busy && <Loader2 size={15} className="animate-spin" />} {busy ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}

function LinkTab({ f, onChanged }) {
  const [on, setOn] = useState(f.share_on);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const set = async (v) => {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/cases/${f.id}/link`, { on: v });
      setOn(r.on); setUrl(r.url || '');
      if (v !== f.share_on) onChanged?.();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  // An open link is asked for again to show it: turning on what is on gives the same link.
  useEffect(() => { if (f.share_on) set(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError('Could not copy. Select the link and copy it.'); }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="flex-1 text-sm">{on ? 'Link is on' : 'Link is off'}</span>
        <button role="switch" aria-checked={on} aria-label="Share by link" disabled={busy} onClick={() => set(!on)}
          className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-40 ${on ? 'bg-p1' : 'bg-white/15'}`}>
          <span className={`absolute top-1 size-5 rounded-full bg-white transition-all ${on ? 'left-6' : 'left-1'}`} />
        </button>
      </div>
      {on && url && (
        <div className="flex items-center gap-2">
          <input readOnly value={url} onFocus={(e) => e.target.select()} className={`${field} min-w-0 flex-1 text-sm`} />
          <button onClick={copy} className="glass flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-sm hover:bg-white/10">
            {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <p className="text-xs text-mute">Anyone with this link can open these files.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}
