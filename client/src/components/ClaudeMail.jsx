import { useEffect, useState } from 'react';
import { Loader2, Copy, Check, RefreshCw, Trash2, Plug } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// Settings → Email in Claude.ai (server/mailConnector.js): a person's own work mailbox in
// their own Claude.ai. The mailbox is the one already connected under Email, so there is
// no password to type here: one tap makes the private link to paste into Claude.ai.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const BUTTON = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';

export default function ClaudeMailPage({ onBack, onEmail }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.get('/mail-connector').then(setState).catch((e) => { setError(e.message); setState({}); }); }, []);

  const run = async (what, fn) => {
    setBusy(what); setError('');
    try { setState(await fn()); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const link = state?.link ? `${window.location.origin}${state.link}` : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the link is on screen to copy by hand */ }
  };
  const renew = () => confirm('Make a new link? The old one stops working at once, so you will need to add the connector in Claude again.')
    && run('renew', () => api.post('/mail-connector/link'));
  const remove = () => confirm('Remove the link? Claude.ai will stop reading your mail.')
    && run('remove', () => api.del('/mail-connector'));

  return (
    <Page title="Email in Claude.ai" onBack={onBack}>
      <p className="mb-4 text-sm leading-relaxed text-mute">
        Use your work mailbox inside your own Claude.ai: Claude can search and read your emails and attachments, and send for you.
      </p>
      {state === null ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : !state.mailbox ? (
        <div className="rounded-[1.25rem] border border-stroke bg-white/[0.035] p-3.5 text-sm">
          <p className="leading-relaxed">First connect your mailbox under <b className="font-medium">Email</b>. This page then gives you the link.</p>
          {onEmail && <button onClick={onEmail} className={`${BUTTON} mt-3`}>Open Email</button>}
        </div>
      ) : (
        <div className="rounded-[1.25rem] border border-stroke bg-white/[0.035] p-3.5">
          <div className="flex items-center gap-2">
            <Plug size={15} className="shrink-0 text-mute" />
            <span className="min-w-0 truncate text-sm font-medium">{state.mailbox.email}</span>
          </div>
          {!state.link ? (
            <button onClick={() => run('make', () => api.post('/mail-connector/link'))} disabled={!!busy} className={`${BUTTON} mt-3`}>
              {busy === 'make' && <Loader2 size={14} className="animate-spin" />} Make my link
            </button>
          ) : (
            <>
              <p className="mt-3 text-xs text-mute">Paste it in Claude.ai → Settings → Connectors → Add custom connector.</p>
              <div className="mt-1.5 flex items-center gap-2">
                <input readOnly value={link} onFocus={(e) => e.target.select()} className={`${FIELD} min-w-0 font-mono text-xs`} />
                <button onClick={copy} aria-label="Copy the link" title="Copy" className={BUTTON}>
                  {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-warn">Keep this link private: anyone who has it can read your mail.</p>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <button onClick={renew} disabled={!!busy} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-mute hover:bg-white/10 hover:text-txt">
                  {busy === 'renew' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} New link
                </button>
                <span className="flex-1" />
                <button onClick={remove} disabled={!!busy} aria-label="Remove the link" title="Remove"
                  className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad">
                  {busy === 'remove' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
              </div>
            </>
          )}
          <p className="mt-3 text-xs leading-relaxed text-mute">
            {state.mailbox.canSend
              ? 'Claude can send and mark emails, because Allow sending and actions is on under Email.'
              : 'Claude can only read. To let it send too, turn on Allow sending and actions under Email.'}
          </p>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </Page>
  );
}
