import { useEffect, useRef, useState } from 'react';
import { Loader2, Upload, X, Undo2, Check, FileText } from 'lucide-react';
import { canDo } from '../lib/actions';
import { api } from '../lib/api';
import { currency } from '../lib/region';
import DateField from './DateField';
import Pager, { usePaged } from './Pager';

// Bringing in the leases from Rent Manager: its Rent Roll Analysis report as a PDF (or screenshots).
// Claude reads the rows, the server matches each to a unit and a tenant already on file
// (server/leaseImport.js), and nothing is saved until the rows are looked at here and ticked.
// Clear rows start ticked; anything to look at does not. The rent and the end date can be fixed here.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3 py-1.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const TH = 'whitespace-nowrap px-3 py-2.5 font-medium';
const HEAD = 'border-b border-stroke text-left text-[11px] uppercase tracking-wider text-mute';
const STATUS = {
  new: ['New', 'bg-ok/15 text-ok'],
  check: ['Check', 'bg-warn/15 text-warn'],
  missing: ['Not found', 'bg-bad/15 text-bad'],
  exists: ['Already leased', 'bg-white/10 text-txt/70'],
  skip: ['Vacant', 'bg-white/5 text-mute'],
};
const FILTERS = [['all', 'All'], ['new', 'New'], ['check', 'Check'], ['missing', 'Not found'], ['exists', 'Already leased'], ['skip', 'Vacant']];
const us = (iso) => (iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}/${iso.slice(2, 4)}` : '');
/** A row can be imported once it has its unit and tenant, a rent, and an end on or after the start. */
const ready = (r) => (r.status === 'new' || r.status === 'check') && r.unit_id && r.tenant_id && Number(r.rent) > 0 && r.start_date && r.end_date >= r.start_date;

export default function LeaseImport({ onClose, onDone }) {
  const [files, setFiles] = useState([]);
  const [job, setJob] = useState(null); // { done, total } while reading
  const [rows, setRows] = useState(null);
  const [billedFrom, setBilledFrom] = useState('');
  const [failed, setFailed] = useState([]);
  const [filter, setFilter] = useState('all');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const read = async () => {
    setError('');
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    try {
      const { id } = await api.upload('/leasing/bookings/import/read', form);
      setJob({ done: 0, total: files.length });
      const poll = async () => {
        try {
          const s = await api.get(`/leasing/bookings/import/read/${id}`);
          if (!s.finished) { setJob({ done: s.done, total: s.total }); timer.current = setTimeout(poll, 2000); return; }
          setJob(null);
          if (s.error) { setError(s.error); return; }
          setFailed(s.failed || []);
          setBilledFrom(s.billed_from || '');
          setRows(s.rows);
        } catch (e) { setJob(null); setError(e.message); }
      };
      timer.current = setTimeout(poll, 1500);
    } catch (e) { setError(e.message); }
  };

  const change = (i, patch) => setRows((rs) => rs.map((r) => (r.i === i ? { ...r, ...patch, pick: patch.pick ?? (r.pick && ready({ ...r, ...patch })) } : r)));
  const picked = rows?.filter((r) => r.pick && ready(r)) || [];
  const count = (s) => (s === 'all' ? rows.length : rows.filter((r) => r.status === s).length);
  const shown = rows?.filter((r) => filter === 'all' || r.status === filter) || [];
  const paged = usePaged(shown, filter);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await api.post('/leasing/bookings/import', { rows: picked.map(({ i, unit_no, name, unit_id, tenant_id, start_date, end_date, rent, notes }) => ({ i, unit_no, name, unit_id, tenant_id, start_date, end_date, rent: Number(rent), notes })) });
      const notSaved = new Set(r.failed.map((f) => f.i));
      // The preview is kept: the rows saved are leased now, and the ones left to check can be gone back to.
      setRows((rs) => rs.map((x) => (x.pick && ready(x) && !notSaved.has(x.i) ? { ...x, status: 'exists', pick: false, was: x.status, batch: r.batch } : x)));
      setResult(r);
      onDone();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };
  const undo = async () => {
    if (!confirm(`Take back the ${result.added} leases this import added?`)) return;
    try {
      const u = await api.del(`/leasing/bookings/import/${result.batch}`);
      setRows((rs) => rs.map(({ was, batch, ...x }) => (batch === result.batch ? { ...x, status: was, pick: was === 'new' } : { was, batch, ...x })));
      setResult({ ...result, undone: u });
      onDone();
    } catch (e) { setError(e.message); }
  };
  const left = rows?.filter((r) => r.status === 'check').length || 0;
  const review = () => { setResult(null); setFilter('check'); };

  return (
    <div className="space-y-4 rounded-2xl border border-p1/40 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium">Import leases from Rent Manager</h2>
          <p className="text-xs text-mute">The Rent Roll Analysis report as a PDF. Import the tenant list first: each lease is put on a tenant already on file. Nothing is saved until you press Import.</p>
        </div>
        <button onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={16} /></button>
      </div>

      {result ? (
        <div className="space-y-3">
          {result.undone
            ? <p className="text-sm">Taken back: {result.undone.removed} removed{result.undone.kept ? `, ${result.undone.kept} kept because they have a payment, a document or an inspection now` : ''}.</p>
            : <p className="flex items-center gap-2 text-sm"><Check size={16} className="text-ok" /> {result.added} lease{result.added === 1 ? '' : 's'} added{result.skipped ? `, ${result.skipped} already imported` : ''}. Rent is due from {us(result.billed_from)}.</p>}
          {!result.undone && result.failed.length > 0 && (
            <div className="text-sm text-bad">
              <p>{result.failed.length} could not be saved:</p>
              {result.failed.map((f) => <p key={f.unit} className="text-xs">{f.unit}: {f.reason}</p>)}
            </div>
          )}
          {left > 0 && <p className="text-sm text-warn">{left} row{left === 1 ? '' : 's'} still need{left === 1 ? 's' : ''} checking. They were not imported.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {canDo('delete') && !result.undone && result.added > 0 && <button onClick={undo} className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10"><Undo2 size={15} /> Undo this import</button>}
            {left > 0 && <button onClick={review} className="rounded-full border border-stroke/70 px-4 py-2 text-sm hover:bg-white/5">Review {left === 1 ? 'it' : `the ${left}`}</button>}
            <button onClick={onClose} className={PRIMARY}>Done</button>
          </div>
        </div>
      ) : job ? (
        <p className="flex items-center gap-2 py-4 text-sm text-mute"><Loader2 size={16} className="animate-spin" /> Reading {job.total === 1 ? 'the file' : `file ${Math.min(job.done + 1, job.total)} of ${job.total}`}… a few pages take a minute or two.</p>
      ) : !rows ? (
        <div className="space-y-3">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-stroke px-4 py-8 text-sm text-mute hover:border-p1/60 hover:text-txt">
            <Upload size={20} />
            <span>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} chosen` : 'Choose the Rent Roll Analysis PDF'}</span>
            <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => setFiles([...e.target.files])} />
          </label>
          {files.length > 0 && <ul className="flex flex-wrap gap-2 text-xs text-mute">{files.map((f) => <li key={f.name} className="flex items-center gap-1 rounded-full border border-stroke px-2.5 py-1"><FileText size={12} />{f.name}</li>)}</ul>}
          <div className="flex justify-end"><button onClick={read} disabled={!files.length} className={PRIMARY}>Read the report</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">Found {rows.length} unit{rows.length === 1 ? '' : 's'}. Clear leases are ticked; look at the ones marked Check before ticking them.</p>
          <p className="text-xs text-mute">Each lease starts on the move-in date and ends on the last day of its lease-end month. Rent is due here from {us(billedFrom)}: earlier months were billed in Rent Manager. Deposits and other charges are added on each lease by hand.</p>
          {failed.length > 0 && <p className="text-sm text-bad">Could not read: {failed.join(', ')}. Upload {failed.length === 1 ? 'it' : 'them'} again.</p>}
          <div className="flex flex-wrap gap-2">
            {FILTERS.map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} className={`rounded-full border px-3 py-1 text-xs ${filter === k ? 'border-p1/70 bg-p1/15 text-txt' : 'border-stroke/70 text-mute hover:text-txt'}`}>{l} · {count(k)}</button>
            ))}
          </div>
          <div className="overflow-x-auto rounded-2xl border border-stroke">
            <table className="w-full text-sm">
              <thead><tr className={HEAD}><th className={TH} /><th className={TH}>Unit</th><th className={TH}>Tenant</th><th className={TH}>Rent ({currency()})</th><th className={TH}>Start</th><th className={TH}>End</th><th className={TH}>Status</th><th className={TH}>Noticed</th></tr></thead>
              <tbody className="divide-y divide-stroke/60">
                {paged.rows.map((r) => {
                  const open = r.status === 'new' || r.status === 'check';
                  return (
                    <tr key={r.i} className={r.pick ? '' : 'opacity-70'}>
                      <td className="px-3 py-2"><input type="checkbox" checked={!!r.pick} disabled={!ready(r)} onChange={(e) => change(r.i, { pick: e.target.checked })} className="size-4 accent-p1" aria-label={`Import unit ${r.unit_no}`} /></td>
                      <td className="whitespace-nowrap px-3 py-2">{r.unit_no || '—'}<p className="text-xs text-mute">{r.unit_cell}</p></td>
                      <td className="min-w-44 px-3 py-2">{r.tenant || r.name || '—'}{r.tenant_cell && <p className="text-xs text-mute">In Rent Manager: {r.tenant_cell}</p>}</td>
                      <td className="w-28 px-3 py-2">{open
                        ? <input type="number" min="0" step="0.01" value={r.rent} onChange={(e) => change(r.i, { rent: e.target.value })} className={`${FIELD} tabular-nums`} aria-label="Rent" />
                        : <span className="tabular-nums text-mute">{r.rent || '—'}</span>}</td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{us(r.start_date) || '—'}</td>
                      <td className="w-40 px-3 py-2">{open && r.start_date
                        ? <DateField value={r.end_date || ''} min={r.start_date} onChange={(e) => change(r.i, { end_date: e.target.value })} className={FIELD} />
                        : <span className="tabular-nums text-mute">{us(r.end_date) || '—'}</span>}</td>
                      <td className="px-3 py-2"><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span></td>
                      <td className="px-3 py-2 text-xs text-mute">{[...(r.reasons || []), ...(r.tags?.length ? [`Rent Manager: ${r.tags.join(', ')}`] : [])].map((x) => <p key={x}>{x}</p>)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager {...paged.pager} />
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
            <button onClick={save} disabled={!picked.length || saving} className={PRIMARY}>
              {saving && <Loader2 size={15} className="animate-spin" />} Import {picked.length} lease{picked.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}
