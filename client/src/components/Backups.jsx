import { useEffect, useState } from 'react';
import { Loader2, Database, FolderArchive, Download, Lock } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// Settings → Backups (server/backups.js), the master's alone: the whole database and every
// uploaded file, each as one download. The password is asked again first; it then opens
// both downloads for ten minutes. The browser saves the file itself, so a 2.5 GB zip is
// never held in this page.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const when = (s) => {
  if (!s) return 'Never downloaded';
  const days = Math.floor((Date.now() / 1000 - s) / 86400);
  const date = new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `Last downloaded ${date}${days >= 7 ? ` · ${days} days ago` : ''}`;
};

function Item({ icon: I, title, hint, at, onDownload, open }) {
  const old = !at || Date.now() / 1000 - at >= 7 * 86400;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[1.25rem] border border-stroke bg-white/[0.035] p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-white/5 text-mute"><I size={19} strokeWidth={1.75} /></span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="text-xs text-mute">{hint}</p>
        <p className={`text-xs ${old ? 'text-warn' : 'text-mute'}`}>{when(at)}</p>
      </div>
      <button onClick={onDownload} disabled={!open} className={PRIMARY}><Download size={14} /> Download</button>
    </div>
  );
}

export default function BackupsPage({ onBack }) {
  const [info, setInfo] = useState(null);
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/backups').then(setInfo).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const unlock = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true); setError('');
    try {
      const { token: t, minutes } = await api.post('/backups/unlock', { password });
      setToken(t); setPassword('');
      // The server stops honouring it then; the page asks again rather than fail a download.
      setTimeout(() => setToken(null), minutes * 60_000 - 5_000);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  // A plain link: the browser downloads and saves it the usual way, with its own progress.
  const download = (kind) => {
    const a = document.createElement('a');
    a.href = `/api/backups/${kind}?t=${encodeURIComponent(token)}`;
    a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(load, 60_000); // the date updates once the download has finished on the server
  };

  return (
    <Page title="Backups" onBack={onBack}>
      <div className="mx-auto max-w-xl space-y-3">
        <p className="text-sm text-mute">
          A copy of everything in Reem, to keep somewhere safe. Download both every week: if the server is ever lost, these bring it back.
        </p>

        {!token ? (
          <form onSubmit={unlock} className="space-y-2 rounded-[1.25rem] border border-stroke bg-white/[0.035] p-4">
            <p className="flex items-center gap-2 text-sm"><Lock size={15} className="text-mute" /> Type your password to download</p>
            <div className="flex gap-2">
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password" className={`${FIELD} text-sm`} />
              <button disabled={busy || !password} className={PRIMARY}>{busy && <Loader2 size={14} className="animate-spin" />} Continue</button>
            </div>
            {error && <p className="text-sm text-bad">{error}</p>}
          </form>
        ) : (
          <p className="text-xs text-mute">Both downloads are open for 10 minutes.</p>
        )}

        <Item icon={Database} title="Database" open={!!token} at={info?.database_at} onDownload={() => download('database')}
          hint="Chats, to-dos, renewals, cases, people. About 70 MB." />
        <Item icon={FolderArchive} title="All files" open={!!token} at={info?.files_at} onDownload={() => download('files')}
          hint="Every uploaded PDF, photo and scan, as one zip. A few GB, so it takes a while." />

        <p className="text-xs leading-relaxed text-mute">
          Keep the downloads private: they hold everything, tenants' details included. If nobody downloads for 7 days, Reem buzzes you.
        </p>
      </div>
    </Page>
  );
}
