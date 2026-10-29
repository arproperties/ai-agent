import { useEffect, useState } from 'react';
import { Loader2, Mail, Trash2, Copy, Check, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// Settings → Apps (server/apps.js), the master's alone: a mailbox connected to Claude.ai
// as a custom connector. Type the email and app password once; Reem checks them and gives
// the link to paste into Claude. The password never comes back to the browser.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const day = (s) => new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const HELP = {
  aol: 'In AOL: Account Security → Generate app password. Your normal AOL password will not work here.',
};

function AppBox({ app, onSaved }) {
  const account = app.account;
  const [editing, setEditing] = useState(!account);
  const [email, setEmail] = useState(account?.email || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const link = account ? `${window.location.origin}${account.link}` : '';

  const run = async (what, fn) => {
    setBusy(what); setError('');
    try { onSaved(await fn()); return true; } catch (e) { setError(e.message); return false; } finally { setBusy(''); }
  };
  const save = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password.trim() || busy) return;
    if (await run('save', () => api.put(`/apps/${app.key}`, { email, password }))) { setPassword(''); setEditing(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the link is on screen to copy by hand */ }
  };
  const renew = () => confirm('Make a new link? The old one stops working at once, so you will need to add the connector in Claude again.')
    && run('renew', () => api.post(`/apps/${app.key}/new-link`));
  const remove = () => confirm(`Disconnect ${app.name}? The link stops working.`)
    && run('remove', () => api.del(`/apps/${app.key}`)).then((ok) => ok && (setEditing(true), setEmail('')));

  return (
    <div className="rounded-[1.25rem] border border-stroke bg-white/[0.035] p-3.5">
      <div className="flex items-center gap-2">
        <Mail size={15} className="shrink-0 text-mute" />
        <span className="text-sm font-medium">{app.name}</span>
        {account && !editing && <span className="min-w-0 truncate text-xs text-mute">{account.email} · set {day(account.setAt)}</span>}
      </div>

      {editing ? (
        <form onSubmit={save} className="mt-2.5 space-y-2">
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="off" spellCheck={false}
            placeholder="you@aol.com" className={`${FIELD} text-sm`} />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" spellCheck={false}
            placeholder="App password" className={`${FIELD} font-mono text-sm`} />
          <p className="text-xs leading-relaxed text-mute">{HELP[app.key]}</p>
          <div className="flex gap-2">
            <button disabled={!!busy || !email.trim() || !password.trim()}
              className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
              {busy === 'save' && <Loader2 size={14} className="animate-spin" />} {busy === 'save' ? 'Checking…' : 'Save'}
            </button>
            {account && <button type="button" onClick={() => { setEditing(false); setPassword(''); setError(''); }} className="px-2 text-sm text-mute hover:text-txt">Cancel</button>}
          </div>
        </form>
      ) : (
        <>
          <p className="mt-3 text-xs text-mute">Connector link: paste it in Claude.ai → Settings → Connectors → Add custom connector.</p>
          <div className="mt-1.5 flex items-center gap-2">
            <input readOnly value={link} onFocus={(e) => e.target.select()} className={`${FIELD} min-w-0 font-mono text-xs`} />
            <button onClick={copy} aria-label="Copy the link" title="Copy"
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white">
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-warn">Keep this link private: anyone who has it can read and send this mail.</p>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <button onClick={() => setEditing(true)} className="rounded-full px-3 py-1.5 text-xs text-mute hover:bg-white/10 hover:text-txt">Change login</button>
            <button onClick={renew} disabled={!!busy} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-mute hover:bg-white/10 hover:text-txt">
              {busy === 'renew' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} New link
            </button>
            <span className="flex-1" />
            <button onClick={remove} disabled={!!busy} aria-label={`Disconnect ${app.name}`} title="Disconnect"
              className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad">
              {busy === 'remove' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            </button>
          </div>
        </>
      )}

      {account?.unreadable && <p className="mt-2 text-xs text-warn">This login was saved on another server and can't be read here. Save it again.</p>}
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
    </div>
  );
}

export default function AppsPage({ onBack }) {
  const [apps, setApps] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/apps').then(setApps).catch((e) => { setError(e.message); setApps([]); }); }, []);

  return (
    <Page title="Apps" onBack={onBack}>
      <p className="mb-4 text-sm leading-relaxed text-mute">
        Connect a mailbox to Claude.ai. Claude can then read your emails and attachments and send email from it.
      </p>
      {apps === null ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
        <div className="space-y-2.5">
          {apps.map((a) => <AppBox key={a.key} app={a} onSaved={setApps} />)}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </Page>
  );
}
