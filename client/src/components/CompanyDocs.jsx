import { useEffect, useState } from 'react';
import { Building2, DoorOpen, Loader2, Pencil, Trash2, ChevronRight, ChevronDown, FileText, Paperclip, Plus, Search } from 'lucide-react';
import { api } from '../lib/api';
import Sheet from './Sheet';

// The Properties home: one card per company, with its details, its documents (each with
// its status: valid, due within 30 days, expired, or on file with no expiry) and its buildings.
// Documents are named freely; adding one under a name already there is its renewal.
// The server is the documents part of server/properties.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const DOT = { valid: 'bg-ok', due: 'bg-warn', expired: 'bg-bad', on_file: 'bg-mute' };
const CHIP = { valid: 'bg-ok/10 text-ok', due: 'bg-warn/10 text-warn', expired: 'bg-bad/10 text-bad', on_file: 'bg-white/10 text-txt/80' };

const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const daysLeft = (d) => Math.round((new Date(`${d}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);
// "ACE Real Estate L.L.C" → "AR": the first letters of the first two real words.
const initials = (name) => (name.match(/[A-Za-z0-9؀-ۿ]+/g) || ['?'])
  .filter((w) => !/^(llc|l|ltd|co|fze|fzco|inc)$/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || name[0];

function chipText(doc) {
  if (doc.status === 'on_file') return 'On file';
  if (doc.status === 'expired') return `Expired ${fmt(doc.expiry_date)}`;
  if (doc.status === 'due') { const n = daysLeft(doc.expiry_date); return n === 0 ? 'Expires today' : `${n} day${n === 1 ? '' : 's'} left`; }
  return `Until ${fmt(doc.expiry_date)}`;
}

function DocForm({ companyId, title, start, onDone, onCancel }) {
  const [v, setV] = useState({ title: start?.title || title || '', number: start?.number || '', issue_date: start?.issue_date || '', expiry_date: start?.expiry_date || '', notes: start?.notes || '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const form = new FormData();
    for (const [k, x] of Object.entries(v)) form.append(k, x);
    if (file) form.append('file', file);
    try {
      if (start) await api.uploadPut(`/properties/docs/${start.id}`, form);
      else await api.upload(`/properties/companies/${companyId}/docs`, form);
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
      <input value={v.title} onChange={set('title')} required placeholder="Document name, e.g. Trade License *" className={FIELD} autoFocus={!title && !start} />
      <input value={v.number} onChange={set('number')} placeholder="Number / reference" className={FIELD} />
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-mute">Issue date<input type="date" value={v.issue_date} onChange={set('issue_date')} className={`${FIELD} mt-1`} /></label>
        <label className="text-xs text-mute">Expiry date<input type="date" value={v.expiry_date} onChange={set('expiry_date')} className={`${FIELD} mt-1`} /></label>
      </div>
      <p className="px-1 text-xs text-mute">Leave expiry empty for documents that do not expire (e.g. MOA).</p>
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
        <Paperclip size={15} /> <span className="truncate">{file ? file.name : start?.has_file ? `Replace file (${start.file_name})` : 'Attach the scan (PDF or photo)'}</span>
        <input type="file" accept="application/pdf,image/*,.doc,.docx" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </label>
      <textarea value={v.notes} onChange={set('notes')} rows={2} placeholder="Notes" className={`${FIELD} resize-none`} />
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2 text-sm font-medium text-white disabled:opacity-60">{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

/**
 * The documents under one name for one company (the current one and its renewals): open,
 * edit, delete, or add a renewal. With no name it is a new document.
 */
function DocSheet({ company, title, master, onClose, onChanged }) {
  const [docs, setDocs] = useState(title ? null : []);
  const [editing, setEditing] = useState(title ? null : 'new');
  const [error, setError] = useState('');
  const load = () => title && api.get(`/properties/companies/${company.id}/docs?title=${encodeURIComponent(title)}`).then(setDocs).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const done = () => { onChanged(); if (!title) return onClose(); setEditing(null); load(); };
  const remove = async (d) => {
    if (!confirm(`Delete ${d.title}${d.number ? ` ${d.number}` : ''}?`)) return;
    try { await api.del(`/properties/docs/${d.id}`); onChanged(); if (docs.length === 1) onClose(); else load(); } catch (e) { setError(e.message); }
  };

  return (
    <Sheet title={`${title || 'New document'} · ${company.name}`} icon={<FileText size={18} className="text-mute" />} onClose={onClose}>
      <div className="space-y-2.5">
        {error && <p className="text-sm text-bad">{error}</p>}
        {!docs ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : docs.map((d, i) => (editing === d.id
          ? <DocForm key={d.id} companyId={company.id} start={d} onDone={done} onCancel={() => setEditing(null)} />
          : (
            <div key={d.id} className="rounded-2xl border border-stroke px-4 py-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{d.title}{d.number && <span className="text-mute"> · {d.number}</span>}
                    {i === 0 && docs.length > 1 && <span className="ml-2 rounded-full bg-p1/20 px-2 py-0.5 text-[11px] text-p1">current</span>}</p>
                  <p className="mt-0.5 text-xs text-mute">
                    {[d.issue_date && `Issued ${fmt(d.issue_date)}`, d.expiry_date ? `Expires ${fmt(d.expiry_date)}` : 'No expiry'].filter(Boolean).join(' · ')}
                  </p>
                  <span className={`mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs ${CHIP[d.status]}`}>{chipText(d)}</span>
                  {d.notes && <p className="mt-1.5 whitespace-pre-wrap text-sm text-txt/80">{d.notes}</p>}
                  {d.has_file && <a href={`/api/properties/docs/${d.id}/file`} target="_blank" rel="noreferrer"
                    className="mt-1.5 flex items-center gap-1.5 text-sm text-p3 hover:underline"><Paperclip size={14} /> {d.file_name}</a>}
                </div>
                {master && <>
                  <button onClick={() => setEditing(d.id)} aria-label="Edit" className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
                  <button onClick={() => remove(d)} aria-label="Delete" className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
                </>}
              </div>
            </div>
          )))}
        {master && (editing === 'new'
          ? <DocForm companyId={company.id} title={title} onDone={done} onCancel={() => (title ? setEditing(null) : onClose())} />
          : (
            <button onClick={() => setEditing('new')}
              className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke/70 py-2.5 text-sm text-mute hover:bg-white/5 hover:text-txt">
              <Plus size={16} /> Add a renewal
            </button>
          ))}
      </div>
    </Sheet>
  );
}

const TABS = [['info', 'Info'], ['docs', 'Documents'], ['props', 'Properties']];

function Card({ c, master, onOpen, onDoc }) {
  const [tab, setTab] = useState('info');
  const tone = c.expired ? 'bad' : c.due ? 'warn' : null;
  const info = [['Trade licence', c.trade_license_no], ['TRN', c.trn], ['Phone', c.phone], ['Email', c.email], ['Address', c.address], ['Notes', c.notes]];

  return (
    <div className="flex flex-col rounded-2xl border border-stroke">
      <div className="flex items-center gap-3 px-4 pt-4">
        <button onClick={onOpen} aria-label={`Open ${c.name}`}
          className="grid size-10 shrink-0 place-items-center rounded-lg bg-p1/15 text-sm font-semibold text-p1">
          {initials(c.name)}
        </button>
        <div className="min-w-0 flex-1">
          <button onClick={onOpen} className="block max-w-full truncate text-left font-medium hover:text-p1">{c.name}</button>
          <p className="truncate text-xs text-mute">{c.address || 'No address yet'}</p>
        </div>
      </div>

      <div className="mt-3 flex gap-5 border-b border-stroke px-4 text-sm">
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2 pt-1 transition ${tab === k ? 'border-p1 text-txt' : 'border-transparent text-mute hover:text-txt'}`}>
            {l}
            {k === 'docs' && tone && <span className={`size-1.5 rounded-full ${tone === 'bad' ? 'bg-bad' : 'bg-warn'}`} />}
          </button>
        ))}
      </div>

      <div className="flex-1 px-4 pb-3 pt-1">
        {tab === 'info' && (
          <dl className="divide-y divide-stroke/60 text-sm">
            {info.map(([l, v]) => (
              <div key={l} className="flex gap-4 py-2.5">
                <dt className="shrink-0 text-mute">{l}</dt>
                <dd className={`min-w-0 flex-1 break-words text-right ${v ? '' : 'text-mute/50'} ${l === 'Notes' ? 'line-clamp-2' : ''}`}>
                  {v ? (l === 'Phone' ? <a href={`tel:${v}`} className="hover:text-p3">{v}</a> : l === 'Email' ? <a href={`mailto:${v}`} className="hover:text-p3">{v}</a> : v) : '—'}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {tab === 'docs' && (
          <div className="pt-1">
            {(c.expired > 0 || c.due > 0) && (
              <div className="flex gap-2 pt-2">
                {c.expired > 0 && <span className="rounded-full bg-bad/15 px-2 py-0.5 text-xs text-bad">{c.expired} expired</span>}
                {c.due > 0 && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn">{c.due} due</span>}
              </div>
            )}
            {c.docs.length === 0 && <p className="py-3 text-sm text-mute">No documents yet.</p>}
            <div className="divide-y divide-stroke/60">
              {c.docs.map((g) => (
                <div key={g.title.toLowerCase()} className="flex items-center gap-2.5 py-2">
                  <span className={`size-2 shrink-0 rounded-full ${DOT[g.status]}`} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {g.title}{g.count > 1 && <span className="ml-1.5 rounded-full bg-white/15 px-1.5 text-[10px]">×{g.count}</span>}
                  </span>
                  <button onClick={() => onDoc(c, g.title)} className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs ${CHIP[g.status]} hover:brightness-125`}>
                    {chipText(g.doc)} <ChevronDown size={12} />
                  </button>
                </div>
              ))}
            </div>
            {master && (
              <button onClick={() => onDoc(c, null)}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full border border-stroke/70 py-2 text-sm text-mute hover:bg-white/5 hover:text-txt">
                <Plus size={15} /> Add document
              </button>
            )}
          </div>
        )}

        {tab === 'props' && (
          <div className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-2">
              {[[Building2, c.buildings, 'Buildings'], [DoorOpen, c.units, 'Units']].map(([Ico, n, l]) => (
                <div key={l} className="rounded-xl border border-stroke/60 px-3 py-2.5">
                  <Ico size={15} className="text-p1" />
                  <p className="mt-1.5 text-2xl font-light leading-none">{n}</p>
                  <p className="mt-1 text-[11px] text-mute">{l}</p>
                </div>
              ))}
            </div>
            <button onClick={onOpen}
              className="flex w-full items-center justify-center gap-1 rounded-full border border-stroke/70 py-2 text-sm text-mute hover:bg-white/5 hover:text-txt">
              Open buildings & units <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CompanyDocs({ master, onOpen }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // { company, title } - no title for a new document
  const load = () => api.get('/properties/docs').then(setBoard).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!board) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  // Every word typed must appear somewhere in the company's details or its document names.
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? board.filter((c) => {
    const hay = [c.name, c.trade_license_no, c.trn, c.phone, c.email, c.address, c.notes, ...c.docs.map((g) => g.title)].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  }) : board;
  return (
    <div className="space-y-4">
      {board.length > 0 && (
        <label className="relative block">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies by name, licence, TRN, phone, email, address or document"
            className={`${FIELD} pl-10`} />
        </label>
      )}
      {board.length > 0 && shown.length === 0 && <p className="py-3 text-sm text-mute">No company matches "{q}".</p>}
      {board.length === 0 && <p className="py-3 text-sm text-mute">No companies registered yet.</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((c) => (
          <Card key={c.id} c={c} master={master} onOpen={() => onOpen(c)} onDoc={(company, title) => setOpen({ company, title })} />
        ))}
      </div>
      {open && <DocSheet {...open} master={master} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}
