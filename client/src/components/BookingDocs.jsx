import { useEffect, useState } from 'react';
import { Loader2, Paperclip, Plus, Trash2, FileText } from 'lucide-react';
import { api } from '../lib/api';

// What is kept with one booking: the signed contract, the tenant's ID and passport, payment
// slips. Named freely; the usual names are offered as you type. The server is the booking
// documents part of server/leasing.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const USUAL = ['Signed contract', 'Ejari', 'Emirates ID', 'Passport', 'Visa', 'Trade License', 'Payment slip'];

const when = (ts) => new Date(Number(ts)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export default function BookingDocs({ booking }) {
  const [docs, setDocs] = useState(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => api.get(`/leasing/bookings/${booking.id}/docs`).then(setDocs).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [booking.id]);

  const add = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const form = new FormData();
    form.append('title', title);
    form.append('notes', notes);
    if (file) form.append('file', file);
    try {
      await api.upload(`/leasing/bookings/${booking.id}/docs`, form);
      setTitle(''); setNotes(''); setFile(null);
      e.target.reset(); // the file input keeps its own value
      await load();
    } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const remove = async (d) => {
    if (!confirm(`Delete ${d.title}?`)) return;
    try { await api.del(`/leasing/docs/${d.id}`); load(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-stroke">
        {!docs ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
          : docs.length === 0 ? <p className="px-4 py-4 text-sm text-mute">Nothing attached yet. Add the contract and the tenant's ID below.</p> : (
            <div className="divide-y divide-stroke/60">
              {docs.map((d) => (
                <div key={d.id} className="flex items-start gap-3 px-4 py-3">
                  <FileText size={16} className="mt-0.5 shrink-0 text-p1/80" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{d.title}<span className="ml-2 text-xs font-normal text-mute">{when(d.created_at)}</span></p>
                    {d.notes && <p className="mt-0.5 whitespace-pre-wrap text-sm text-txt/80">{d.notes}</p>}
                    {d.has_file
                      ? <a href={`/api/leasing/docs/${d.id}/file`} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1.5 text-sm text-p3 hover:underline"><Paperclip size={14} /> <span className="truncate">{d.file_name}</span></a>
                      : <p className="mt-1 text-xs text-mute">No file attached</p>}
                  </div>
                  <button onClick={() => remove(d)} aria-label={`Delete ${d.title}`} className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          )}
      </div>

      <form onSubmit={add} className="space-y-2 rounded-2xl border border-stroke p-4">
        <p className="text-[11px] font-medium uppercase tracking-widest text-mute">Add a document</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} required list="booking-doc-names" placeholder="Document name, e.g. Signed contract *" className={FIELD} />
          <datalist id="booking-doc-names">{USUAL.map((n) => <option key={n} value={n} />)}</datalist>
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
            <Paperclip size={15} className="shrink-0" /> <span className="truncate">{file ? file.name : 'Attach the scan (PDF or photo)'}</span>
            <input type="file" accept="application/pdf,image/*,.doc,.docx" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
        </div>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" className={FIELD} />
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end">
          <button disabled={busy} className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2 text-sm font-medium text-white disabled:opacity-60">
            <Plus size={16} /> {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}
