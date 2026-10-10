import { useEffect, useState } from 'react';
import { FileText, Loader2, Paperclip, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { usDate as fmt } from '../lib/usFormat';
import Sheet from './Sheet';
import DocumentForm, { DETAILS } from './DocumentForm';

// One document, whoever it belongs to: its current copy and the renewals under it. Open
// the file, edit, delete, or add the renewed copy. With no document it is a new one.
// Each copy has a status: valid, due (inside its renewal window), expired, or on file.

export const DOT = { valid: 'bg-ok', due: 'bg-warn', expired: 'bg-bad', on_file: 'bg-mute' };
export const CHIP = { valid: 'bg-ok/10 text-ok', due: 'bg-warn/10 text-warn', expired: 'bg-bad/10 text-bad', on_file: 'bg-white/10 text-txt/80' };

const daysLeft = (d) => Math.round((new Date(`${d}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);

export function chipText(doc) {
  if (doc.status === 'on_file') return 'On file';
  if (doc.status === 'expired') return `Expired ${fmt(doc.expiry_date)}`;
  if (doc.status === 'due') { const n = daysLeft(doc.expiry_date); return n === 0 ? 'Expires today' : `${n} day${n === 1 ? '' : 's'} left`; }
  return `Until ${fmt(doc.expiry_date)}`;
}

export default function DocumentSheet({ doc, owner, preset, places, label, master, onClose, onChanged }) {
  const [anchor, setAnchor] = useState(doc?.id || null); // any copy of it: its history is read by one
  const [docs, setDocs] = useState(doc ? null : []);
  const [editing, setEditing] = useState(doc ? null : 'new');
  const [error, setError] = useState('');
  const load = (id = anchor) => id && api.get(`/properties/documents/${id}/history`).then(setDocs).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const done = () => { onChanged(); if (!anchor) return onClose(); setEditing(null); load(); };
  const remove = async (d) => {
    if (!confirm(`Delete ${d.title}${d.number ? ` ${d.number}` : ''}?`)) return;
    try {
      await api.del(`/properties/docs/${d.id}`);
      onChanged();
      const rest = docs.filter((x) => x.id !== d.id);
      if (!rest.length) { onClose(); return; }
      setAnchor(rest[0].id);
      load(rest[0].id);
    } catch (e) { setError(e.message); }
  };
  // A renewal is filed where the document already is.
  const current = docs?.[0];
  const own = owner || (current && (current.unit_id ? { unit_id: current.unit_id } : current.building_id ? { building_id: current.building_id } : { company_id: current.company_id }));

  return (
    <Sheet title={[current?.title || doc?.title || 'New document', label].filter(Boolean).join(' · ')} icon={<FileText size={18} className="text-mute" />} onClose={onClose}>
      <div className="space-y-2.5">
        {error && <p className="text-sm text-bad">{error}</p>}
        {!docs ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : docs.map((d, i) => (editing === d.id
          ? <DocumentForm key={d.id} owner={own} start={d} onDone={done} onCancel={() => setEditing(null)} />
          : (
            <div key={d.id} className="rounded-2xl border border-stroke px-4 py-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{d.title}{d.number && <span className="text-mute"> · {d.number}</span>}
                    {i === 0 && docs.length > 1 && <span className="ml-2 rounded-full bg-p1/20 px-2 py-0.5 text-[11px] text-p1">current</span>}</p>
                  <p className="mt-0.5 text-xs text-mute">
                    {[d.issue_date && `Issued ${fmt(d.issue_date)}`, d.expiry_date ? `Expires ${fmt(d.expiry_date)}` : 'No expiry',
                      i === 0 && d.expiry_date && `Renewal starts ${d.renew_days} days before`].filter(Boolean).join(' · ')}
                  </p>
                  <span className={`mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs ${CHIP[d.status]}`}>{chipText(d)}</span>
                  {DETAILS.some(([k]) => d.details?.[k]) && (
                    <dl className="mt-2 space-y-0.5 text-sm">
                      {DETAILS.filter(([k]) => d.details[k]).map(([k, l]) => <div key={k} className="flex gap-3"><dt className="shrink-0 text-mute">{l}</dt><dd className="min-w-0 flex-1 break-words text-right">{d.details[k]}</dd></div>)}
                    </dl>
                  )}
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
          ? <DocumentForm owner={own} preset={preset} places={places} from={current} onDone={done} onCancel={() => (anchor ? setEditing(null) : onClose())} />
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
