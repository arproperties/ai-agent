import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileSignature, Building2, Receipt, Landmark, Scale, Users, IdCard, BadgeCheck, Mail, Megaphone, Image as ImageIcon,
  Folder, FolderOpen, Search, Download, ExternalLink, Loader2, AlertCircle, Upload, ChevronLeft, ChevronDown, Trash2, MessageSquare, X, Info, PenLine, Sparkles,
  FileArchive, FolderInput, CheckCircle2, Clock,
} from 'lucide-react';
import { api } from '../lib/api';
import { startImport, importState, onImport, clearImportError } from '../lib/importer';
import { describeIgnored } from '../lib/zip';
import Icon from './Icon';
import Sheet from './Sheet';

export const FILE_TYPES = 'image/*,.pdf,.docx,.txt,.md,.csv,.json,.html,.xml,.yaml,.yml,.log,.tsv';

// icon, icon colour, tinted background for each folder
const FOLDER_STYLE = {
  'Contracts & Agreements': [FileSignature, 'text-violet-300', 'from-violet-500/30 to-violet-500/5'],
  'Tenancy & Property': [Building2, 'text-sky-300', 'from-sky-500/30 to-sky-500/5'],
  'Invoices & Receipts': [Receipt, 'text-emerald-300', 'from-emerald-500/30 to-emerald-500/5'],
  'Financial & Tax': [Landmark, 'text-teal-300', 'from-teal-500/30 to-teal-500/5'],
  Legal: [Scale, 'text-slate-300', 'from-slate-400/30 to-slate-400/5'],
  'HR & Employees': [Users, 'text-rose-300', 'from-rose-500/30 to-rose-500/5'],
  'IDs & Personal': [IdCard, 'text-amber-300', 'from-amber-500/30 to-amber-500/5'],
  'Company & Licenses': [BadgeCheck, 'text-indigo-300', 'from-indigo-500/30 to-indigo-500/5'],
  Correspondence: [Mail, 'text-cyan-300', 'from-cyan-500/30 to-cyan-500/5'],
  Marketing: [Megaphone, 'text-pink-300', 'from-pink-500/30 to-pink-500/5'],
  Photos: [ImageIcon, 'text-fuchsia-300', 'from-fuchsia-500/30 to-fuchsia-500/5'],
  Other: [Folder, 'text-mute', 'from-white/15 to-white/[0.03]'],
};
const folderStyle = (f) => FOLDER_STYLE[f] || FOLDER_STYLE.Other;

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const ext = (name) => (name.includes('.') ? name.split('.').pop().slice(0, 4).toUpperCase() : 'FILE');
const fileUrl = (d) => `/api/documents/${d.id}/file`;

// ---------- data ----------
function useFiles(agentId) {
  const [docs, setDocs] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [notes, setNotes] = useState([]);
  const load = () => api.get(`/documents${agentId ? `?agent=${agentId}` : ''}`).then(setDocs);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // files attached in chat are organised in the background: refresh until they are done.
  // An import queues thousands at once, and reloading the whole list every few seconds
  // for an hour would be wasteful: while one is filing, look less often.
  useEffect(() => {
    if (!docs?.some((d) => d.status === 'processing' || d.status === 'queued')) return;
    const t = setTimeout(load, docs.some((d) => d.status === 'queued') ? 20000 : 2500);
    return () => clearTimeout(t);
  }, [docs]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (files) => {
    if (!files?.length) return;
    setUploading(true);
    const form = new FormData();
    if (agentId) form.append('agent', agentId);
    [...files].forEach((f) => form.append('files', f));
    try {
      const res = await api.upload('/documents', form);
      setNotes(res.filter((r) => r.duplicate).map((r) => `${r.name} is already in your files${r.shelf ? `, filed under ${r.shelf}` : ''}`));
    } catch (e) { setNotes([e.message]); }
    setUploading(false);
    load();
  };

  // A typed note takes the identical path as an upload on the server, so it is named,
  // filed and searchable the same way.
  const write = async (text) => {
    setUploading(true);
    try {
      const res = await api.post('/documents/note', { text, ...(agentId ? { agent: agentId } : {}) });
      setNotes(res.duplicate ? [`You have already written that note${res.shelf ? `, filed under ${res.shelf}` : ''}`] : []);
    } catch (e) { setNotes([e.message]); }
    setUploading(false);
    load();
  };
  return { docs, load, upload, write, uploading, notes };
}

function NoteSheet({ onSave, onClose }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    await onSave(text);
    onClose();
  };
  return (
    <Sheet title="Write a note" onClose={onClose}
      icon={<span className="grid size-8 place-items-center rounded-full bg-amber-400/20 text-amber-300"><PenLine size={17} /></span>}>
      <form onSubmit={save} className="space-y-3">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} autoFocus required
          placeholder="Anything worth keeping — a policy, a decision, a number you keep looking up…"
          className="glass w-full resize-none rounded-2xl px-3.5 py-3 leading-relaxed outline-none focus:border-p1/70" />
        <p className="text-xs text-mute">It will be named, filed and made searchable just like an uploaded file.</p>
        <button disabled={busy || !text.trim()}
          className="w-full rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white disabled:opacity-60">
          {busy ? 'Saving…' : 'Save note'}
        </button>
      </form>
    </Sheet>
  );
}

// ---------- pieces ----------
function Preview({ d, className = '', big }) {
  const [FolderIcon, tone, bg] = folderStyle(d.folder);
  if (d.kind === 'image') {
    return (
      <div className={`relative overflow-hidden bg-black/30 ${className}`}>
        <img src={fileUrl(d)} alt="" loading="lazy" className={`size-full ${big ? 'object-contain' : 'object-cover'}`} />
      </div>
    );
  }
  return (
    <div className={`relative grid place-items-center bg-gradient-to-br ${bg} ${className}`}>
      <FolderIcon size={big ? 48 : 34} strokeWidth={1.4} className={tone} />
      <span className="absolute left-2.5 top-2.5 rounded-md bg-black/35 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white/80">{ext(d.name)}</span>
    </div>
  );
}

// showShelf: on the main Shelf, say which agent a file was filed with. Inside an agent's
// own shelf that would just repeat the agent's name on every card.
export function FileCard({ d, onOpen, showShelf = false }) {
  const busy = d.status === 'processing' || d.status === 'queued';
  return (
    <button onClick={() => !busy && onOpen(d)}
      className="group flex flex-col overflow-hidden rounded-2xl border border-stroke bg-white/[0.035] text-left transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.06]">
      <div className="relative">
        <Preview d={d} className="aspect-[4/3]" />
        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-black/55 text-xs text-white/80">
            {d.status === 'queued'
              ? <span className="flex items-center gap-2"><Clock size={15} /> Waiting…</span>
              : <span className="flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Organising…</span>}
          </div>
        )}
        {d.status === 'error' && <AlertCircle size={18} className="absolute right-2.5 top-2.5 text-bad" />}
        {d.kind === 'fact' && !d.shared && (
          <span title="Noticed in a chat — not shared yet" className="absolute left-2.5 top-2.5 flex items-center gap-1 rounded-full bg-amber-400/90 px-2 py-0.5 text-[10px] font-medium text-[#141128]">
            <Sparkles size={11} /> Learned
          </span>
        )}
        {/* only master's files are ever shared, so this doubles as "staff can read this" */}
        {d.shared && (
          <span title="Shared" className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-full bg-p1/85 px-2 py-0.5 text-[10px] font-medium text-white">
            <Users size={11} /> Shared
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <p className="line-clamp-2 text-[13px] font-medium leading-snug">{busy ? d.name : d.title}</p>
        <p className="mt-auto truncate pt-1 text-[11px] text-mute">{[showShelf && d.shelf_name, fmtDate(d.doc_date || d.created_at * 1000), fmtSize(d.size)].filter(Boolean).join(' · ')}</p>
      </div>
    </button>
  );
}

// how a file can be shown inside the app
const viewMode = (d) => {
  if (d.kind === 'image') return 'image';
  if (/\.docx$/i.test(d.name)) return 'docx';
  if (d.mime === 'application/pdf') return 'pdf';
  if (d.mime?.startsWith('text/') || /\.(txt|md|csv|json|log|tsv|yaml|yml|xml)$/i.test(d.name)) return 'text';
  return null;
};

function TextView({ d }) {
  const [text, setText] = useState(null);
  useEffect(() => { fetch(fileUrl(d)).then((r) => r.text()).then(setText).catch(() => setText('Could not load this file.')); }, [d]);
  return (
    <div className="rise h-full w-full max-w-3xl overflow-auto rounded-2xl border border-stroke bg-[#141128] p-5 shadow-2xl md:p-8">
      {text === null ? <Loader2 size={20} className="mx-auto animate-spin text-mute" />
        : <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-relaxed text-txt/90">{text}</pre>}
    </div>
  );
}

// Full-screen in-app viewer (never a new tab). onInfo shows the details sheet.
export function FileViewer({ d, onClose, onInfo }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const mode = viewMode(d);
  const [FolderIcon, tone, bg] = folderStyle(d.folder);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#07061a]/95 backdrop-blur-xl" onClick={onClose}>
      <header className="flex items-center gap-2 px-3 pb-2 pt-safe md:px-5" onClick={(e) => e.stopPropagation()}>
        <span className={`grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${bg}`}><FolderIcon size={17} className={tone} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{d.status === 'processing' ? d.name : d.title}</p>
          <p className="truncate text-xs text-mute">{[d.folder, fmtDate(d.doc_date), fmtSize(d.size)].filter(Boolean).join(' · ')}</p>
        </div>
        {onInfo && (
          <button onClick={() => onInfo(d)} aria-label="File details" title="Details"
            className="grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Info size={19} /></button>
        )}
        <a href={`${fileUrl(d)}?download=1`} aria-label="Download" title="Download"
          className="grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Download size={19} /></a>
        <button onClick={onClose} aria-label="Close" title="Close"
          className="grid size-10 place-items-center rounded-full bg-white/10 text-txt hover:bg-white/20"><X size={20} /></button>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-3 pb-3 md:px-8 md:pb-6" onClick={(e) => mode !== 'image' && e.stopPropagation()}>
        {mode === 'image' && <img src={fileUrl(d)} alt={d.title} onClick={(e) => e.stopPropagation()} className="rise max-h-full max-w-full rounded-xl object-contain shadow-2xl" />}
        {mode === 'text' && <TextView d={d} />}
        {(mode === 'pdf' || mode === 'docx') && (
          <iframe src={mode === 'docx' ? `/api/documents/${d.id}/preview` : fileUrl(d)} title={d.title}
            className="rise h-full w-full max-w-4xl rounded-xl bg-white shadow-2xl" />
        )}
        {!mode && (
          <div className="flex flex-col items-center gap-3 text-center">
            <Preview d={d} big className="size-40 rounded-3xl" />
            <p className="text-sm text-mute">This file type can't be previewed here.</p>
            <a href={`${fileUrl(d)}?download=1`} className="flex items-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2.5 text-sm font-medium text-white"><Download size={16} /> Download</a>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// Folders whose contents are usually company-wide rather than personal. Only ever a
// nudge next to the control: forgetting the toggle must never publish anything.
const USUALLY_SHARED = ['HR & Employees', 'Company & Licenses'];

/**
 * Master's Private/Shared control. How far "shared" reaches depends on where the file
 * is filed, so the copy says which rather than leaving it to be guessed: on a shelf it
 * reaches the people assigned that shelf, in the library it reaches every user.
 */
function Visibility({ shared, folder, shelfName, onChange }) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium tracking-wide text-mute">VISIBILITY</span>
      <div className="grid grid-cols-2 rounded-full bg-white/5 p-1 text-sm">
        {[[false, 'Private'], [true, 'Shared']].map(([v, label]) => (
          <button type="button" key={label} onClick={() => onChange(v)}
            className={`rounded-full py-2 transition ${shared === v ? 'bg-white/15 text-txt' : 'text-mute'}`}>{label}</button>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-mute">
        {shared
          ? shelfName ? `Anyone given ${shelfName} can read this.` : 'Every user can read this.'
          : 'Only you can see this file.'}
      </p>
      {!shared && USUALLY_SHARED.includes(folder) && (
        <p className="mt-1 text-xs text-p1">{folder} files are usually shared.</p>
      )}
    </div>
  );
}

export function FileDetail({ d, folders, companies = [], me, shelfName, onClose, onChanged, onOpenChat }) {
  const [FolderIcon, tone] = folderStyle(d.folder);
  const [viewing, setViewing] = useState(false);
  // Held locally as well as on the row: one caller passes a no-op onChanged, and the
  // control still has to respond to being pressed.
  const [shared, setShared] = useState(!!d.shared);
  const move = async (folder) => { await api.patch(`/documents/${d.id}`, { folder }); onChanged(); onClose(); };
  // Saved on leaving the field, not per keystroke. Cleared means "Other".
  // Companies or Others, fixable by hand because the classifier does get it wrong.
  // Others clears the company at once; Companies asks which company, saved on leaving
  // the field. Leaving it empty keeps the file in Others.
  const [company, setCompany] = useState(d.company || '');
  const [inCompanies, setInCompanies] = useState(!!d.company);
  const companyRef = useRef();
  const saveCompany = async (value) => {
    const name = value.trim();
    if (!name) setInCompanies(false);
    if (name === (d.company || '')) return;
    const next = await api.patch(`/documents/${d.id}`, { company: name });
    setCompany(next.company || '');
    setInCompanies(!!next.company);
    onChanged();
  };
  const toOthers = () => { setCompany(''); setInCompanies(false); saveCompany(''); };
  const toCompanies = () => { setInCompanies(true); setTimeout(() => companyRef.current?.focus(), 0); };
  const share = async (next) => {
    setShared(next);
    try {
      await api.patch(`/documents/${d.id}`, { shared: next });
      onChanged();
    } catch { setShared(!next); }
  };
  const remove = async () => {
    if (!confirm(`Delete “${d.title}”?`)) return;
    await api.del(`/documents/${d.id}`);
    onChanged(); onClose();
  };

  return (
    <Sheet title="File details" onClose={onClose}>
      <div className="space-y-4">
        <button onClick={() => setViewing(true)} className="block w-full overflow-hidden rounded-2xl" aria-label="View file">
          <Preview d={d} big className="h-52 rounded-2xl" />
        </button>
        <div>
          <h3 className="text-lg font-medium leading-snug">{d.title}</h3>
          <p className="mt-1 text-xs text-mute">{[fmtDate(d.doc_date), fmtSize(d.size), d.name].filter(Boolean).join(' · ')}</p>
        </div>
        {d.status === 'error' && <p className="flex items-center gap-1.5 text-sm text-bad"><AlertCircle size={15} /> {d.error || 'Could not read this file'}</p>}
        {d.conversation_id && onOpenChat && (
          <button onClick={() => { onClose(); onOpenChat(d.conversation_id); }}
            className="flex w-full items-center gap-3 rounded-2xl border border-stroke bg-white/[0.04] px-3.5 py-2.5 text-left transition hover:bg-white/[0.08]">
            <MessageSquare size={17} className="shrink-0 text-p1" />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] tracking-wide text-mute">SHARED IN CHAT</span>
              <span className="block truncate text-sm">{d.conversation_title || 'Open chat'}</span>
            </span>
            <ChevronLeft size={16} className="rotate-180 text-mute" />
          </button>
        )}
        {d.summary && <p className="text-sm leading-relaxed text-txt/85">{d.summary}</p>}
        {d.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">{d.tags.map((t) => <span key={t} className="rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-mute">#{t}</span>)}</div>
        )}

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium tracking-wide text-mute">FOLDER</span>
          <span className="relative block">
            <FolderIcon size={16} className={`pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 ${tone}`} />
            <select value={d.folder} onChange={(e) => move(e.target.value)}
              className="glass w-full appearance-none rounded-xl py-2.5 pl-10 pr-9 outline-none focus:border-p1/70">
              {folders.map((f) => <option key={f} value={f} className="bg-bg">{f}</option>)}
            </select>
            <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-mute" />
          </span>
        </label>

        <div>
          <span className="mb-1.5 block text-xs font-medium tracking-wide text-mute">FILED UNDER</span>
          <div className="glass grid grid-cols-2 gap-1 rounded-xl p-1">
            {[[true, 'Companies', Building2, toCompanies], [false, 'Others', Folder, toOthers]].map(([on, label, BI, pick]) => (
              <button key={label} onClick={() => inCompanies !== on && pick()}
                className={`flex items-center justify-center gap-2 rounded-lg py-2 text-sm transition ${inCompanies === on ? 'bg-p1/20 text-txt' : 'text-mute hover:text-txt'}`}>
                <BI size={15} /> {label}
              </button>
            ))}
          </div>
          {inCompanies && (
            <span className="relative mt-2 block">
              <Building2 size={16} className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-sky-300" />
              <input ref={companyRef} value={company} onChange={(e) => setCompany(e.target.value)} onBlur={(e) => saveCompany(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                list={`companies-${d.id}`} placeholder="Which company?" aria-label="Company"
                className="glass w-full rounded-xl py-2.5 pl-10 pr-3 outline-none placeholder:text-mute/70 focus:border-p1/70" />
              <datalist id={`companies-${d.id}`}>{companies.map((c) => <option key={c} value={c} />)}</datalist>
            </span>
          )}
        </div>

        {d.kind === 'fact' && (
          <div className="space-y-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2.5">
            <p className="text-xs leading-relaxed text-amber-200">
              Your assistant noticed this in a conversation and wrote it down. Nobody else can read it until you
              switch it to Shared below.
            </p>
            {d.origin_conversation_id && onOpenChat && (
              <button onClick={() => { onClose(); onOpenChat(d.origin_conversation_id); }}
                className="inline-flex items-center gap-1.5 text-xs text-amber-200 underline-offset-2 hover:underline">
                <MessageSquare size={13} /> See the chat it came from
              </button>
            )}
          </div>
        )}
        {me?.role === 'master' && <Visibility shared={shared} folder={d.folder} shelfName={shelfName} onChange={share} />}

        <div className="flex gap-2 pt-1">
          <button onClick={() => setViewing(true)}
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white">
            <ExternalLink size={16} /> View
          </button>
          <a href={`${fileUrl(d)}?download=1`} aria-label="Download" title="Download"
            className="glass grid size-11 place-items-center rounded-full hover:bg-white/10"><Download size={17} /></a>
          <button onClick={remove} aria-label="Delete" title="Delete"
            className="grid size-11 place-items-center rounded-full border border-bad/40 text-bad hover:bg-bad/10"><Trash2 size={17} /></button>
        </div>
      </div>
      {viewing && <FileViewer d={d} onClose={() => setViewing(false)} />}
    </Sheet>
  );
}

function SearchBox({ value, onChange }) {
  return (
    <div className="glass flex items-center gap-2 rounded-full px-4">
      <Search size={16} className="shrink-0 text-mute" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Search by name, party, amount, tag…"
        className="w-full bg-transparent py-2.5 outline-none placeholder:text-mute/70" />
    </div>
  );
}

const matches = (d, q) => !q || [d.title, d.name, d.summary, d.folder, d.company, ...(d.tags || [])].join(' ').toLowerCase().includes(q.toLowerCase());

// A top-level card. `preview` ([name, count] pairs) shows what is inside, so the two
// cards say something before they are opened; `small` is the plain company tile.
function GroupCard({ icon: GI, tone, bg, label, sub, onClick, preview, empty, small = false }) {
  const head = (
    <span className="flex items-center gap-3">
      <span className={`grid shrink-0 place-items-center rounded-xl bg-gradient-to-br ${bg} ${small ? 'size-10' : 'size-12'}`}>
        <GI size={small ? 19 : 22} strokeWidth={1.6} className={tone} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`line-clamp-2 leading-tight ${small ? 'text-[13px]' : 'text-lg font-light'}`}>{label}</span>
        <span className="text-xs text-mute">{sub}</span>
      </span>
      {!small && <ChevronLeft size={18} className="rotate-180 text-mute" />}
    </span>
  );
  if (small) {
    return (
      <button onClick={onClick} className="rounded-2xl border border-stroke bg-white/[0.03] p-3 text-left transition hover:bg-white/[0.06]">{head}</button>
    );
  }
  return (
    <button onClick={onClick}
      className={`flex flex-col gap-4 rounded-3xl border border-stroke bg-gradient-to-br ${bg} p-5 text-left transition hover:-translate-y-0.5 hover:border-white/20`}>
      {head}
      <span className="flex min-h-[3.5rem] flex-wrap content-start gap-1.5">
        {preview?.length ? (
          <>
            {preview.slice(0, 5).map(([name, n]) => (
              <span key={name} className="max-w-full truncate rounded-full bg-black/25 px-2.5 py-1 text-xs text-txt/85">
                {name} <span className="opacity-60">{n}</span>
              </span>
            ))}
            {preview.length > 5 && <span className="rounded-full px-2 py-1 text-xs text-mute">+{preview.length - 5} more</span>}
          </>
        ) : <span className="text-xs text-mute">{empty}</span>}
      </span>
    </button>
  );
}

function FileGrid({ title, files, onOpen, empty = 'No matching files' }) {
  return (
    <section>
      <h2 className="mb-3 text-[11px] font-medium tracking-[0.14em] text-mute">{title}</h2>
      {files.length === 0 ? <p className="py-10 text-center text-sm text-mute">{empty}</p> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {files.map((d) => <FileCard key={d.id} d={d} onOpen={onOpen} showShelf />)}
        </div>
      )}
    </section>
  );
}

/**
 * Master's "share everything here" control, over whatever company or folder is open.
 * Learned facts are left out unless the Learned view itself is open: each one is meant
 * to be read before it is published, and a company-wide tap is not a read.
 */
function ShareAll({ files, label, withFacts, onDone }) {
  const [busy, setBusy] = useState(false);
  const pick = files.filter((d) => withFacts || d.kind !== 'fact');
  const priv = pick.filter((d) => !d.shared);
  const pub = pick.filter((d) => d.shared);
  const skipped = files.length - pick.length;
  if (!pick.length) return null;

  const apply = async (list, on) => {
    const n = `${list.length} ${list.length === 1 ? 'file' : 'files'}`;
    const ask = on
      ? `Share ${n} in ${label}?\n\nFiles filed with an agent can be read by the people given that agent; the rest by every user.`
        + (skipped ? `\n\n${skipped} learned in chat ${skipped === 1 ? 'stays' : 'stay'} private: review ${skipped === 1 ? 'it' : 'them'} under “Learned in chat”.` : '')
      : `Make ${n} in ${label} private again?`;
    if (!confirm(ask)) return;
    setBusy(true);
    try { await api.post('/documents/share', { ids: list.map((d) => d.id), shared: on }); } finally { setBusy(false); onDone(); }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-stroke bg-white/[0.035] px-3.5 py-2.5 text-sm">
      <Users size={16} className="shrink-0 text-p1" />
      <span className="min-w-0 flex-1 text-mute">{pub.length} of {pick.length} shared</span>
      {busy ? <Loader2 size={16} className="animate-spin text-mute" /> : (
        <>
          {pub.length > 0 && (
            <button onClick={() => apply(pub, false)} className="rounded-full px-3 py-1.5 text-xs text-mute transition hover:bg-white/10 hover:text-txt">Make all private</button>
          )}
          {priv.length > 0 && (
            <button onClick={() => apply(priv, true)} className="rounded-full bg-p1/25 px-3 py-1.5 text-xs font-medium text-txt transition hover:bg-p1/40">
              Share all {priv.length}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ---------- folder / ZIP imports: progress while it runs, a receipt when it is done ----------
function ImportBar({ onChanged }) {
  const [local, setLocal] = useState(importState()); // the browser sending files
  const [list, setList] = useState([]); // the server filing them
  const load = () => api.get('/imports').then(setList).catch(() => {});
  useEffect(() => onImport(setLocal), []);
  useEffect(() => { load(); }, [local?.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  // once the upload is done, the Shelf picks up the queued files (and keeps refreshing slowly)
  const prevPhase = useRef(local?.phase);
  useEffect(() => { if (prevPhase.current === 'uploading' && !local) onChanged(); prevPhase.current = local?.phase; }, [local]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = local?.phase === 'reading' || local?.phase === 'uploading' || list.some((i) => i.waiting > 0 || (!i.uploaded && !i.stalled));
  const waiting = list.reduce((n, i) => n + i.waiting, 0);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [list, active]); // eslint-disable-line react-hooks/exhaustive-deps
  // the Shelf behind catches up the moment the last file is filed
  const prevWaiting = useRef(waiting);
  useEffect(() => { if (prevWaiting.current > 0 && waiting === 0) onChanged(); prevWaiting.current = waiting; }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = async (id) => { setList((l) => l.filter((i) => i.id !== id)); await api.post(`/imports/${id}/dismiss`).catch(() => {}); };
  const box = 'flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm';

  return (
    <>
      {local?.phase === 'reading' && (
        <div className={`${box} border-stroke bg-white/[0.035]`}>
          <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin text-p1" />
          <p>Opening <b className="font-medium">{local.name}</b>…</p>
        </div>
      )}
      {local?.phase === 'uploading' && (
        <div className={`${box} border-stroke bg-white/[0.035]`}>
          <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin text-p1" />
          <div className="min-w-0 flex-1">
            <p>Uploading <b className="font-medium">{local.name}</b>: {local.sent.toLocaleString()} of {local.total.toLocaleString()}</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-p1 transition-all" style={{ width: `${(100 * local.sent) / local.total}%` }} /></div>
            <p className="mt-1.5 text-xs text-mute">Keep this tab open until the upload finishes. Filing carries on by itself after that.</p>
          </div>
        </div>
      )}
      {local?.phase === 'error' && (
        <div className={`${box} border-bad/40 bg-bad/10`}>
          <AlertCircle size={17} className="mt-0.5 shrink-0 text-bad" />
          <p className="flex-1">Could not import {local.name}: {local.error}</p>
          <button onClick={clearImportError} aria-label="Dismiss" className="text-mute hover:text-txt"><X size={16} /></button>
        </div>
      )}
      {list.map((i) => {
        const ignored = describeIgnored(i.ignored);
        const total = Object.values(i.ignored).reduce((a, b) => a + b, 0);
        if (!i.uploaded && !i.stalled) return null; // still uploading: the bar above covers it
        if (i.waiting > 0) {
          const done = i.filed + i.failed;
          return (
            <div key={i.id} className={`${box} border-stroke bg-white/[0.035]`}>
              {i.paused ? <Clock size={17} className="mt-0.5 shrink-0 text-warn" /> : <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin text-p1" />}
              <div className="min-w-0 flex-1">
                <p>Filing <b className="font-medium">{i.name}</b>: {done.toLocaleString()} of {(done + i.waiting).toLocaleString()}</p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-ok transition-all" style={{ width: `${(100 * done) / (done + i.waiting)}%` }} /></div>
                {i.paused === 'credits' && <p className="mt-1.5 text-xs text-warn">Paused: the Claude credit balance ran out. It carries on by itself once credits are topped up.</p>}
                {i.paused === 'busy' && <p className="mt-1.5 text-xs text-mute">Claude is busy; carrying on in a moment.</p>}
                {!i.paused && <p className="mt-1.5 text-xs text-mute">You can close this page; filing continues on the server.</p>}
              </div>
            </div>
          );
        }
        return (
          <div key={i.id} className={`${box} border-ok/30 bg-ok/10`}>
            <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-ok" />
            <div className="min-w-0 flex-1 space-y-1">
              <p><b className="font-medium">{i.name}</b>{i.stalled && !i.uploaded ? ' (upload stopped part-way)' : ''}: <b className="font-medium">{i.filed.toLocaleString()} files added</b>
                {i.duplicates > 0 && ` · ${i.duplicates.toLocaleString()} already on your shelf`}
                {i.failed > 0 && ` · ${i.failed.toLocaleString()} could not be read`}</p>
              {ignored && <p className="text-mute">Ignored {total.toLocaleString()}: {ignored}</p>}
            </div>
            <button onClick={() => dismiss(i.id)} aria-label="Dismiss" className="text-mute hover:text-txt"><X size={16} /></button>
          </div>
        );
      })}
    </>
  );
}

// ---------- full-screen Files page ----------
export function FilesPage({ folders, me, onBack, onOpenChat }) {
  const { docs, load, upload, write, uploading, notes } = useFiles(null);
  // Two levels: Companies (then one company) or Others (files naming no company).
  const [group, setGroup] = useState(null); // null = the two top cards, 'companies' | 'others'
  const [company, setCompany] = useState(null); // a company's name, inside Companies
  const [folder, setFolder] = useState('All');
  const [writing, setWriting] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // details sheet
  const [viewing, setViewing] = useState(null); // full-screen viewer
  const [dragging, setDragging] = useState(false);
  const [importMenu, setImportMenu] = useState(false);
  const ref = useRef();
  const zipRef = useRef();
  const dirRef = useRef();

  const companies = useMemo(() => {
    const n = (docs || []).reduce((m, d) => (d.company ? { ...m, [d.company]: (m[d.company] || 0) + 1 } : m), {});
    return { n, names: Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b)) };
  }, [docs]);
  const others = (docs || []).filter((d) => !d.company);
  // A company emptied by moving its last file out falls back to the list of companies.
  const inCompany = company && companies.n[company] ? company : null;
  const scope = group === 'others' ? others : inCompany ? docs.filter((d) => d.company === inCompany) : null;
  const go = (g, c = null) => { setGroup(g); setCompany(c); setFolder('All'); };

  // Folders narrow the files inside a company or Others. "Learned" is a pseudo-folder
  // over kind rather than folder: a plain list of captured facts to prune.
  const counts = (scope || []).reduce((m, d) => ({ ...m, [d.folder]: (m[d.folder] || 0) + 1 }), {});
  const learnedCount = (scope || []).filter((d) => d.kind === 'fact').length;
  const inFolder = (d) => (folder === 'All' ? true : folder === 'Learned' ? d.kind === 'fact' : d.folder === folder);
  // Search always covers every file, whichever level is open.
  const shown = q ? (docs || []).filter((d) => matches(d, q)) : (scope || []).filter(inFolder);
  const openDoc = open && docs?.find((d) => d.id === open);

  // A single ZIP dropped on the Shelf is an import; anything else is an ordinary upload.
  const drop = (e) => {
    e.preventDefault();
    setDragging(false);
    const files = e.dataTransfer.files;
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) startImport(files[0], files[0].name.replace(/\.zip$/i, ''));
    else upload(files);
  };

  return (
    <div className="sky absolute inset-0 z-20 flex flex-col"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={drop}>
      <input ref={ref} type="file" multiple hidden accept={FILE_TYPES} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      <input ref={zipRef} type="file" hidden accept=".zip,application/zip"
        onChange={(e) => { const f = e.target.files[0]; if (f) startImport(f, f.name.replace(/\.zip$/i, '')); e.target.value = ''; }} />
      <input ref={dirRef} type="file" hidden webkitdirectory=""
        onChange={(e) => { const fs = e.target.files; if (fs.length) startImport([...fs], fs[0].webkitRelativePath.split('/')[0] || 'Folder'); e.target.value = ''; }} />

      <header className="space-y-3 border-b border-stroke/60 px-4 pb-4 pt-safe md:px-8">
        <div className="flex items-center gap-2 pt-1">
          <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <ChevronLeft size={22} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] font-light leading-tight">Shelf</h1>
            <p className="text-xs text-mute">{docs ? `${docs.length} files · sorted automatically` : 'Loading…'}</p>
          </div>
          <button onClick={() => setWriting(true)} disabled={uploading}
            className="glass flex items-center gap-2 rounded-full px-3.5 py-2 text-sm transition hover:bg-white/10 active:scale-95 disabled:opacity-60">
            <PenLine size={16} /> Note
          </button>
          <div className="relative">
            <button onClick={() => setImportMenu((v) => !v)} title="Import a whole folder or ZIP"
              className="glass flex items-center gap-2 rounded-full px-3.5 py-2 text-sm transition hover:bg-white/10 active:scale-95">
              <FolderInput size={16} /> <span className="hidden sm:inline">Import</span>
            </button>
            {importMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setImportMenu(false)} />
                <div className="absolute right-0 top-full z-20 mt-2 w-60 overflow-hidden rounded-2xl border border-stroke bg-[#15132b] shadow-xl">
                  <button onClick={() => { setImportMenu(false); zipRef.current.click(); }} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-white/10">
                    <FileArchive size={17} className="text-p1" /> <span>ZIP file<span className="block text-xs text-mute">e.g. a WhatsApp chat export</span></span>
                  </button>
                  <button onClick={() => { setImportMenu(false); dirRef.current.click(); }} className="flex w-full items-center gap-3 border-t border-stroke px-4 py-3 text-left text-sm hover:bg-white/10">
                    <FolderOpen size={17} className="text-p3" /> <span>Folder<span className="block text-xs text-mute">every file inside it</span></span>
                  </button>
                </div>
              </>
            )}
          </div>
          <button onClick={() => ref.current.click()} disabled={uploading}
            className="flex items-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 transition active:scale-95 disabled:opacity-60">
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} {uploading ? 'Adding…' : 'Upload'}
          </button>
        </div>
        {docs?.length > 0 && <SearchBox value={q} onChange={setQ} />}
        {notes.map((n) => <p key={n} className="text-sm text-warn">{n}</p>)}
        <ImportBar onChanged={load} />
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
        {docs?.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span className="grid size-20 place-items-center rounded-3xl bg-gradient-to-br from-sky-500/25 to-p1/10 text-sky-300"><FolderOpen size={36} strokeWidth={1.4} /></span>
            <div>
              <p className="text-lg font-light">No files yet</p>
              <p className="max-w-xs text-sm text-mute">Upload here or attach files in chat. Each one is named, summarised and filed into the right folder for you.</p>
            </div>
          </div>
        ) : docs && (
          <div className="mx-auto max-w-6xl space-y-5 py-5">
            {!q && group && (
              <button onClick={() => (inCompany ? go('companies') : go(null))}
                className="-ml-1 flex items-center gap-1 text-sm text-mute transition hover:text-txt">
                <ChevronLeft size={17} /> {inCompany ? 'Companies' : 'Shelf'}
              </button>
            )}

            {q ? (
              <FileGrid title={`SEARCH · “${q}”`} files={shown} onOpen={setViewing} />
            ) : !group ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <GroupCard icon={Building2} tone="text-sky-300" bg="from-sky-500/30 to-sky-500/5" label="Companies"
                    sub={`${companies.names.length} ${companies.names.length === 1 ? 'company' : 'companies'} · ${docs.length - others.length} ${docs.length - others.length === 1 ? 'file' : 'files'}`}
                    preview={companies.names.map((c) => [c, companies.n[c]])} empty="Files that name a company gather here"
                    onClick={() => go('companies')} />
                  <GroupCard icon={Folder} tone="text-mute" bg="from-white/15 to-white/[0.03]" label="Others"
                    sub={`${others.length} ${others.length === 1 ? 'file' : 'files'}`}
                    preview={Object.entries(others.reduce((m, d) => ({ ...m, [d.folder]: (m[d.folder] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])}
                    empty="Everything else - personal papers, notes, photos" onClick={() => go('others')} />
                </div>
                <FileGrid title="RECENT FILES" files={[...docs].sort((a, b) => b.created_at - a.created_at || b.id - a.id).slice(0, 10)} onOpen={setViewing} />
              </>
            ) : group === 'companies' && !inCompany ? (
              <section>
                <h2 className="mb-3 text-[11px] font-medium tracking-[0.14em] text-mute">COMPANIES</h2>
                {companies.names.length === 0 ? (
                  <p className="py-10 text-center text-sm text-mute">No companies yet. Files that name a company appear here.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                    {companies.names.map((c) => (
                      <GroupCard key={c} icon={Building2} tone="text-sky-300" bg="from-sky-500/30 to-sky-500/5" label={c}
                        sub={`${companies.n[c]} ${companies.n[c] === 1 ? 'file' : 'files'}`} onClick={() => go('companies', c)} small />
                    ))}
                  </div>
                )}
              </section>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {['All', ...(learnedCount ? ['Learned'] : []), ...folders.filter((f) => counts[f])].map((f) => (
                    <button key={f} onClick={() => setFolder(f)}
                      className={`rounded-full border px-3 py-1.5 text-xs transition ${folder === f ? 'border-p1/60 bg-p1/15 text-txt' : 'border-stroke bg-white/[0.03] text-mute hover:bg-white/[0.06] hover:text-txt'}`}>
                      {f === 'All' ? 'All' : f === 'Learned' ? 'Learned in chat' : f}
                      <span className="ml-1.5 opacity-60">{f === 'All' ? scope.length : f === 'Learned' ? learnedCount : counts[f]}</span>
                    </button>
                  ))}
                </div>
                {me?.role === 'master' && (
                  <ShareAll files={shown} withFacts={folder === 'Learned'} onDone={load}
                    label={[inCompany || 'Others', folder !== 'All' && (folder === 'Learned' ? 'Learned in chat' : folder)].filter(Boolean).join(' · ')} />
                )}
                <FileGrid title={[inCompany || 'OTHERS', folder !== 'All' && (folder === 'Learned' ? 'LEARNED IN CHAT' : folder)].filter(Boolean).join(' · ').toUpperCase()}
                  files={shown} onOpen={setViewing} empty={group === 'others' && folder === 'All' ? 'Every file here names a company.' : 'No files'} />
              </>
            )}
          </div>
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-3xl border-2 border-dashed border-p1 bg-p1/10 backdrop-blur-sm">
          <p className="flex items-center gap-2 text-lg"><Upload size={22} /> Drop files to add them</p>
        </div>
      )}
      {viewing && <FileViewer d={viewing} onClose={() => setViewing(null)} onInfo={(d) => { setViewing(null); setOpen(d.id); }} />}
      {openDoc && <FileDetail d={openDoc} folders={folders} companies={companies.names} me={me} shelfName={openDoc.shelf_name} onClose={() => setOpen(null)} onChanged={load} onOpenChat={onOpenChat} />}
      {writing && <NoteSheet onSave={write} onClose={() => setWriting(false)} />}
    </div>
  );
}

// ---------- compact version for an agent's own files (inside the agent sheet) ----------
export function FilesPanel({ agentId, hint, folders, me, shelfName }) {
  const { docs, load, upload, write, uploading, notes } = useFiles(agentId);
  const [open, setOpen] = useState(null);
  const [writing, setWriting] = useState(false);
  const ref = useRef();
  const openDoc = open && docs?.find((d) => d.id === open);

  return (
    <div className="space-y-3">
      {hint && <p className="text-sm text-mute">{hint}</p>}
      <input ref={ref} type="file" multiple hidden accept={FILE_TYPES} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      <button onClick={() => ref.current.click()} disabled={uploading}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-p1/50 py-4 text-sm text-p1 hover:bg-p1/10 disabled:opacity-60">
        {uploading ? <><Loader2 size={16} className="animate-spin" /> Reading and organising…</> : <><Upload size={16} /> Upload files</>}
      </button>
      <button onClick={() => setWriting(true)} disabled={uploading}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-stroke py-2.5 text-sm text-mute hover:bg-white/5 hover:text-txt disabled:opacity-60">
        <PenLine size={15} /> Write a note
      </button>
      {notes.map((n) => <p key={n} className="text-sm text-warn">{n}</p>)}
      {docs?.length === 0 && <p className="py-4 text-center text-sm text-mute">No files yet</p>}
      <div className="grid grid-cols-2 gap-2.5">
        {docs?.map((d) => <FileCard key={d.id} d={d} onOpen={(x) => setOpen(x.id)} />)}
      </div>
      {openDoc && <FileDetail d={openDoc} folders={folders} me={me} shelfName={shelfName} onClose={() => setOpen(null)} onChanged={load} />}
      {writing && <NoteSheet onSave={write} onClose={() => setWriting(false)} />}
    </div>
  );
}

// ---------- memory ----------
export function MemoryPanel() {
  const [items, setItems] = useState(null);
  const [text, setText] = useState('');
  const load = () => api.get('/memories').then(setItems);
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    await api.post('/memories', { text });
    setText('');
    load();
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-mute">Your agents learn lasting facts about you from your chats, and all of them share this memory. Teach something new, or remove what they should forget.</p>
      <form onSubmit={add} className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. My company is AR Properties"
          className="glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70" />
        <button className="shrink-0 rounded-xl bg-p1/25 px-4 text-sm text-txt hover:bg-p1/40">Add</button>
      </form>
      <ul className="space-y-2">
        {items?.length === 0 && <li className="py-4 text-center text-sm text-mute">Nothing learned yet. Just start chatting.</li>}
        {items?.map((m) => (
          <li key={m.id} className="flex items-start gap-2 rounded-xl bg-white/5 py-2 pl-3.5 pr-1.5 text-sm">
            <span className="flex-1 py-1">{m.text}</span>
            <button onClick={async () => { await api.del(`/memories/${m.id}`); load(); }} aria-label="Forget"
              className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:text-bad"><Icon name="x" size={16} /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MemorySheet({ onClose }) {
  return (
    <Sheet title="Memory" onClose={onClose}
      icon={<span className="grid size-8 place-items-center rounded-full bg-p1/20 text-p1"><Icon name="brain" size={17} /></span>}>
      <MemoryPanel />
    </Sheet>
  );
}
