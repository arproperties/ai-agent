import { useEffect, useState } from 'react';
import { Loader2, Link2, Search } from 'lucide-react';
import { api } from '../lib/api';

// Which saifsys HR employee this Reem account is, by employee code (server/hrLinks.js).
// Typing a code shows who HR has under it first; only Link saves it.

export default function HrLink({ person }) {
  const [link, setLink] = useState(undefined); // undefined = loading, null = not linked
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLink(undefined); setOpen(false); setFound(null); setError('');
    api.get(`/hr-link/user/${person.id}`).then(setLink).catch(() => setLink(null));
  }, [person.id]);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const lookup = (e) => { e.preventDefault(); setFound(null); run(async () => setFound(await api.get(`/hr-link/lookup?code=${encodeURIComponent(code.trim())}`))); };
  const save = () => run(async () => { setLink(await api.put(`/hr-link/user/${person.id}`, { code: found.code })); setOpen(false); setFound(null); });
  const unlink = () => confirm(`Unlink ${person.name} from HR ${link.code}?`) && run(async () => { await api.del(`/hr-link/user/${person.id}`); setLink(null); });

  if (link === undefined) return <Loader2 size={18} className="mx-auto my-3 animate-spin text-mute" />;
  const btn = 'rounded-full px-2.5 py-1 text-xs text-mute hover:bg-white/10 hover:text-txt';

  return (
    <div className="space-y-1.5">
      <span className="text-[11px] font-medium tracking-[0.14em] text-mute">HR EMPLOYEE</span>
      {!open && (
        <p className="flex flex-wrap items-center gap-1.5 rounded-xl bg-white/5 px-3 py-2.5 text-sm text-mute">
          <Link2 size={14} />
          {link ? <><span className="text-txt">{link.code}</span>{link.name && ` · ${link.name}`}</> : 'Not linked to HR yet'}
          <span className="flex-1" />
          <button onClick={() => { setOpen(true); setCode(link?.code || ''); }} className={btn}>{link ? 'Change' : 'Link'}</button>
          {link && <button onClick={unlink} disabled={busy} className={`${btn} hover:text-bad`}>Unlink</button>}
        </p>
      )}
      {open && (
        <div className="space-y-2 rounded-xl text-xs border border-stroke/60 bg-white/[0.03] p-2.5">
          <form onSubmit={lookup} className="flex gap-2">
            <input value={code} onChange={(e) => { setCode(e.target.value); setFound(null); }} autoFocus placeholder="Employee code, e.g. E00012"
              className="glass min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm uppercase outline-none focus:border-p1/70" />
            <button disabled={busy || !code.trim()} className="flex items-center gap-1 rounded-full border border-stroke px-3 text-sm text-mute hover:text-txt disabled:opacity-50">
              {busy && !found ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Look up
            </button>
          </form>
          {found && (
            <div className="rounded-lg bg-white/5 px-3 py-2 text-sm">
              <p className="font-medium">{found.name} <span className="text-mute">· {found.code}</span></p>
              <p className="text-xs text-mute">{[found.position, found.company, found.status].filter(Boolean).join(' · ')}</p>
              {found.left && <p className="mt-1 text-xs text-warn">HR says this person has left.</p>}
              <p className="mt-1.5 text-xs text-mute">Is this {person.name}?</p>
            </div>
          )}
          {error && <p className="text-bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => { setOpen(false); setFound(null); setError(''); }} className="rounded-full px-3 py-1.5 text-sm text-mute hover:bg-white/10">Cancel</button>
            {found && (
              <button onClick={save} disabled={busy} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-1.5 text-sm font-medium text-white disabled:opacity-60">
                {busy ? 'Linking…' : 'Link'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
