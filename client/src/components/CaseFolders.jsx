import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Briefcase, Loader2, PenLine, RefreshCw, Share2, Trash2, Type, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import Sheet from './Sheet';
import { FileCard } from './Knowledge';
import CaseShareSheet from './CaseShareSheet';

// An external person's case folders, first on their Shelf: each one a case's emails as PDFs
// and attachments, kept up to date from their mailbox (server/caseRoutes.js).

const TOKENS = ['[Case Number]', '[Party A]', '[Party B]'];
const when = (at) => (at ? new Date(at * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const field = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const primary = 'w-full rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white disabled:opacity-60';

/** The folders, loaded only for an external person; checked again while a file is being read. */
export function useCaseFolders(enabled) {
  const [folders, setFolders] = useState(null);
  const load = useCallback(() => (enabled ? api.get('/cases').then(setFolders).catch(() => setFolders([])) : Promise.resolve()), [enabled]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!folders?.some((f) => f.files.some((d) => d.status === 'processing' || d.status === 'queued'))) return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [folders, load]);
  return { folders: enabled ? folders : [], load };
}

export function CaseFolders({ folders, onOpen }) {
  const [pattern, setPattern] = useState(false);
  if (!folders) return <Loader2 size={18} className="mx-auto animate-spin text-mute" />;
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex-1 text-[11px] font-medium tracking-[0.14em] text-mute">CASE FOLDERS</h2>
        <button onClick={() => setPattern(true)} className="flex items-center gap-1.5 rounded-full border border-stroke px-3 py-1 text-xs text-mute hover:bg-white/[0.06] hover:text-txt">
          <Type size={13} /> Name pattern
        </button>
      </div>
      {folders.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-stroke px-4 py-5 text-center text-sm text-mute">Ask Reem in chat to pull a case from your inbox. Its folder appears here.</p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {folders.map((f) => (
            <button key={f.id} onClick={() => onOpen(f.id)}
              className="flex items-center gap-3 rounded-2xl border border-stroke bg-white/[0.035] p-3 text-left transition hover:border-white/20 hover:bg-white/[0.06]">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-400/30 to-amber-400/5 text-amber-300"><Briefcase size={19} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{f.name}</span>
                <span className="block truncate text-xs text-mute">{plural(f.email_count, 'email')} · updated {when(f.updated_at || f.last_checked_at)}</span>
              </span>
              {f.last_error && <AlertCircle size={16} className="shrink-0 text-bad" />}
              {f.new_count > 0 && <span className="shrink-0 rounded-full bg-p1/85 px-2 py-0.5 text-[11px] font-medium text-white">{f.new_count} new</span>}
            </button>
          ))}
        </div>
      )}
      {pattern && <PatternSheet onClose={() => setPattern(false)} />}
    </section>
  );
}

function PatternSheet({ onClose }) {
  const [value, setValue] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef();
  useEffect(() => { api.get('/cases/settings').then((s) => setValue(s.pattern)).catch((e) => setError(e.message)); }, []);
  // A chip goes in where the cursor is, or at the end.
  const insert = (t) => {
    const el = ref.current;
    const at = el && document.activeElement === el ? el.selectionStart : (value || '').length;
    setValue((v) => `${(v || '').slice(0, at)}${t}${(v || '').slice(at)}`);
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.put('/cases/settings', { pattern: value }); onClose(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Sheet title="Name pattern" onClose={onClose}>
      {value === null && !error ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
        <form onSubmit={save} className="space-y-3">
          <p className="text-sm text-mute">New case folders are named this way. Folders you already have keep their names.</p>
          <input ref={ref} value={value || ''} onChange={(e) => setValue(e.target.value)} className={field} />
          <div className="flex flex-wrap gap-2">
            {TOKENS.map((t) => (
              <button type="button" key={t} onClick={() => insert(t)} className="rounded-full border border-p1/40 bg-p1/10 px-3 py-1 text-xs hover:bg-p1/20">{t}</button>
            ))}
          </div>
          {error && <p className="text-sm text-bad">{error}</p>}
          <button disabled={busy} className={primary}>{busy ? 'Saving…' : 'Save'}</button>
        </form>
      )}
    </Sheet>
  );
}

/** One folder open: its files and what can be done with it. */
export function CaseFolder({ folder: f, onBack, onOpenFile, onChanged }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(null); // 'rename' | 'delete' | 'share'
  const [name, setName] = useState(f.name);

  // Opening it is seeing what is new.
  useEffect(() => {
    if (f.new_count > 0) api.post(`/cases/${f.id}/seen`, {}).then(onChanged).catch(() => {});
  }, [f.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what, fn) => {
    setBusy(what); setError('');
    try { await fn(); await onChanged(); return true; } catch (e) { setError(e.message); await onChanged(); return false; } finally { setBusy(''); }
  };
  const update = () => act('update', () => api.post(`/cases/${f.id}/update`, {}));
  const track = () => act('track', () => api.patch(`/cases/${f.id}`, { tracking: !f.tracking }));
  const rename = async (e) => {
    e.preventDefault();
    if (await act('rename', () => api.patch(`/cases/${f.id}`, { name }))) setSheet(null);
  };
  const remove = async () => {
    if (await act('delete', () => api.del(`/cases/${f.id}`))) onBack();
  };

  const btn = 'glass flex items-center gap-2 rounded-full px-3.5 py-2 text-sm transition hover:bg-white/10 active:scale-95 disabled:opacity-60';
  return (
    <section className="space-y-4">
      <button onClick={onBack} className="-ml-1 flex items-center gap-1 text-sm text-mute transition hover:text-txt"><ChevronLeft size={17} /> Shelf</button>
      <div>
        <h2 className="text-xl font-light">{f.name}</h2>
        <p className="text-xs text-mute">{plural(f.email_count, 'email')} · updated {when(f.updated_at || f.last_checked_at)} · last checked {when(f.last_checked_at)}</p>
        {f.last_error && <p className="mt-1 text-sm text-bad">The last update failed: {f.last_error}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => { setName(f.name); setSheet('rename'); }} className={btn}><PenLine size={15} /> Rename</button>
        <button onClick={update} disabled={!!busy || !f.tracking} title={f.tracking ? '' : 'Keep updating is off'} className={btn}>
          <RefreshCw size={15} className={busy === 'update' ? 'animate-spin' : ''} /> {busy === 'update' ? 'Updating…' : 'Update now'}
        </button>
        <button onClick={() => setSheet('share')} className={btn}><Share2 size={15} /> Share</button>
        <button onClick={() => setSheet('delete')} className={`${btn} text-bad`}><Trash2 size={15} /> Delete</button>
        <span className="ml-auto flex items-center gap-2.5 text-sm">
          Keep updating
          <button role="switch" aria-checked={f.tracking} aria-label="Keep updating" disabled={!!busy} onClick={track}
            className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-40 ${f.tracking ? 'bg-p1' : 'bg-white/15'}`}>
            <span className={`absolute top-1 size-5 rounded-full bg-white transition-all ${f.tracking ? 'left-6' : 'left-1'}`} />
          </button>
        </span>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {f.files.length === 0 ? <p className="py-10 text-center text-sm text-mute">No files in this folder</p> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {f.files.map((d) => <FileCard key={d.id} d={d} onOpen={onOpenFile} />)}
        </div>
      )}

      {sheet === 'rename' && (
        <Sheet title="Rename folder" onClose={() => setSheet(null)}>
          <form onSubmit={rename} className="space-y-3">
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={field} />
            <p className="text-xs text-mute">Only the name changes. New emails of this case still come in.</p>
            {error && <p className="text-sm text-bad">{error}</p>}
            <button disabled={!!busy || !name.trim()} className={primary}>{busy === 'rename' ? 'Saving…' : 'Save'}</button>
          </form>
        </Sheet>
      )}
      {sheet === 'share' && <CaseShareSheet folder={f} onClose={() => setSheet(null)} onChanged={onChanged} />}
      {sheet === 'delete' && (
        <Sheet title="Delete this folder?" onClose={() => setSheet(null)}>
          <div className="space-y-3">
            <p className="text-sm text-mute">“{f.name}” and its {plural(f.files.length, 'file')} are deleted from your Shelf. The emails stay in your mailbox.</p>
            {error && <p className="text-sm text-bad">{error}</p>}
            <button onClick={remove} disabled={!!busy} className="w-full rounded-full bg-bad/90 py-2.5 text-sm font-medium text-white disabled:opacity-60">
              {busy === 'delete' ? 'Deleting…' : 'Delete folder'}
            </button>
            <button onClick={() => setSheet(null)} className="w-full rounded-full border border-stroke py-2.5 text-sm text-mute hover:bg-white/5">Keep it</button>
          </div>
        </Sheet>
      )}
    </section>
  );
}
