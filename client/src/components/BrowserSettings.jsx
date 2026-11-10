import { useEffect, useState } from 'react';
import { Loader2, Globe, Trash2, Plus, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// Settings → Browser (server/browser/). The master's switches: the browser on or off for
// everyone, and how many steps one job may take. Everyone's own logins for websites,
// typed once: the password is kept encrypted, used only on that website, never shown again.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-p1/70';

function Switch({ on, onClick, disabled }) {
  return (
    <button role="switch" aria-checked={on} onClick={onClick} disabled={disabled}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${on ? 'bg-p1' : 'bg-white/15'}`}>
      <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

export default function BrowserSettingsPage({ onBack }) {
  const [s, setS] = useState(null);
  const [logins, setLogins] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: '', url: '', username: '', password: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/browser/settings').then(setS).catch((e) => setError(e.message));
    api.get('/browser/logins').then(setLogins).catch(() => setLogins([]));
  }, []);

  const run = async (what, fn) => {
    setBusy(what); setError('');
    try { return await fn(); } catch (e) { setError(e.message); return null; } finally { setBusy(''); }
  };
  const change = (patch) => run('settings', async () => setS(await api.put('/browser/settings', patch)));
  const add = async (e) => {
    e.preventDefault();
    const r = await run('add', () => api.post('/browser/logins', form));
    if (r) { setLogins(r); setForm({ label: '', url: '', username: '', password: '' }); setAdding(false); }
  };
  const remove = (l) => confirm(`Remove the login for ${l.label}?`) && run(`rm${l.id}`, async () => setLogins(await api.del(`/browser/logins/${l.id}`)));

  return (
    <Page title="Browser" onBack={onBack}>
      <p className="mb-4 text-sm leading-relaxed text-mute">
        Reem can open websites and do the job for you from the chat — look things up, fill in forms, download files — while you watch.
        It always asks before anything is submitted, paid, sent or deleted.
      </p>

      {!s ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
        <div className="space-y-2.5">
          <div className="flex items-center gap-3 rounded-[1.25rem] border border-stroke bg-white/[0.035] p-3.5">
            <Globe size={16} className="shrink-0 text-mute" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Browser</p>
              <p className="text-xs text-mute">{s.enabled ? 'On: Reem can use websites in chats.' : 'Off: Reem won\'t open any website.'}</p>
            </div>
            {s.master ? <Switch on={s.enabled} disabled={busy === 'settings'} onClick={() => change({ enabled: !s.enabled })} />
              : <span className="text-xs text-mute">{s.enabled ? 'On' : 'Off'}</span>}
          </div>

          {s.master && (
            <div className="rounded-[1.25rem] border border-stroke bg-white/[0.035] p-3.5">
              <p className="text-sm font-medium">Steps per job</p>
              <p className="text-xs text-mute">After this many steps Reem stops and says what it got done. You can ask it to carry on.</p>
              <div className="mt-2.5 flex gap-1.5">
                {s.steps.map((n) => (
                  <button key={n} onClick={() => change({ max_steps: n })} disabled={busy === 'settings'}
                    className={`rounded-full px-4 py-1.5 text-sm ${s.max_steps === n ? 'bg-p1 text-white' : 'border border-stroke text-mute hover:text-txt'}`}>{n}</button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-[1.25rem] border border-ok/30 bg-ok/[0.05] p-3.5 text-xs leading-relaxed text-mute">
            <ShieldCheck size={15} className="mt-px shrink-0 text-ok" />
            <span>Always on: Reem asks before Submit, Pay, Send, Delete or Sign; it never gets around a CAPTCHA, a code or UAE Pass (you do that step in the window); and it never sees your passwords.</span>
          </div>
        </div>
      )}

      <h2 className="mb-2 mt-6 flex items-center gap-2 text-sm font-medium"><KeyRound size={15} className="text-mute" /> My logins</h2>
      <p className="mb-3 text-xs leading-relaxed text-mute">Add a website's login once. Reem types it in when it opens that website for you. Only you can use your logins.</p>
      {logins === null ? <Loader2 size={18} className="mx-auto my-4 animate-spin text-mute" /> : (
        <div className="space-y-2">
          {logins.map((l) => (
            <div key={l.id} className="flex items-center gap-3 rounded-[1.25rem] border border-stroke bg-white/[0.035] px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{l.label}</p>
                <p className="truncate text-xs text-mute">{l.host} · {l.username} · ••••••</p>
              </div>
              <button onClick={() => remove(l)} aria-label={`Remove ${l.label}`} title="Remove"
                className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad">
                {busy === `rm${l.id}` ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              </button>
            </div>
          ))}
          {!logins.length && !adding && <p className="text-xs text-mute">No logins yet.</p>}
          {adding ? (
            <form onSubmit={add} className="space-y-2 rounded-[1.25rem] border border-stroke bg-white/[0.035] p-3.5">
              <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="Website, e.g. rdc.gov.ae" className={FIELD} autoComplete="off" spellCheck={false} />
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Name (optional), e.g. RDC portal" className={FIELD} autoComplete="off" />
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="Username or email" className={FIELD} autoComplete="off" spellCheck={false} />
              <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} type="password" placeholder="Password" className={`${FIELD} font-mono`} autoComplete="new-password" />
              <div className="flex gap-2">
                <button disabled={busy === 'add' || !form.url || !form.username || !form.password}
                  className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
                  {busy === 'add' && <Loader2 size={14} className="animate-spin" />} Save
                </button>
                <button type="button" onClick={() => setAdding(false)} className="px-2 text-sm text-mute hover:text-txt">Cancel</button>
              </div>
            </form>
          ) : (
            <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt">
              <Plus size={14} /> Add a login
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </Page>
  );
}
