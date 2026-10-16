import { useEffect, useRef, useState } from 'react';
import { Loader2, Upload, X, Undo2, Check, FileText } from 'lucide-react';
import { api } from '../lib/api';
import Pager, { usePaged } from './Pager';

// Bringing in the tenant list from Rent Manager: its Tenants report as screenshots, a PDF or a CSV.
// Claude reads the rows, the server cleans them (server/tenantImport.js), and nothing is saved
// until the rows are looked at here and ticked. Clear new tenants start ticked; anything unclear does not.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3.5 py-2.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const TH = 'whitespace-nowrap px-3 py-2.5 font-medium';
const HEAD = 'border-b border-stroke text-left text-[11px] uppercase tracking-wider text-mute';
const STATUS = {
  new: ['New', 'bg-ok/15 text-ok'],
  update: ['Adds details', 'bg-p3/15 text-p3'],
  check: ['Check', 'bg-warn/15 text-warn'],
  exists: ['Already on file', 'bg-white/10 text-txt/70'],
  skip: ['Not a tenant', 'bg-white/5 text-mute'],
};
const FILTERS = [['all', 'All'], ['new', 'New'], ['update', 'Adds details'], ['check', 'Check'], ['exists', 'Already on file'], ['skip', 'Not a tenant']];
const WHY_SKIP = 'Looks like an account rather than a person (AIRBNB, FF, an employee or maintenance account).';

export default function TenantImport({ onClose, onDone }) {
  const [files, setFiles] = useState([]);
  const [job, setJob] = useState(null); // { done, total } while reading
  const [rows, setRows] = useState(null);
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
      const { id } = await api.upload('/leasing/tenants/import/read', form);
      setJob({ done: 0, total: files.length });
      const poll = async () => {
        try {
          const s = await api.get(`/leasing/tenants/import/read/${id}`);
          if (!s.finished) { setJob({ done: s.done, total: s.total }); timer.current = setTimeout(poll, 2000); return; }
          setJob(null);
          if (s.error) { setError(s.error); return; }
          setFailed(s.failed || []);
          setRows(s.rows.map((r, i) => ({ ...r, i })));
        } catch (e) { setJob(null); setError(e.message); }
      };
      timer.current = setTimeout(poll, 1500);
    } catch (e) { setError(e.message); }
  };

  const change = (i, patch) => setRows((rs) => rs.map((r) => (r.i === i ? { ...r, ...patch } : r)));
  const picked = rows?.filter((r) => r.pick) || [];
  const count = (s) => (s === 'all' ? rows.length : rows.filter((r) => r.status === s).length);
  const shown = rows?.filter((r) => filter === 'all' || r.status === filter) || [];
  const paged = usePaged(shown, filter); // a page at a time, not a box that scrolls inside the page

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await api.post('/leasing/tenants/import', { rows: picked.map(({ name, kind, accounts, notes, original, housing_authority, phone, email, tenant_id }) => ({ name, kind, accounts, notes, original, housing_authority, phone, email, tenant_id })) });
      // The preview is kept: the rows just saved are on file now, and the ones left to check can be gone back to.
      setRows((rs) => rs.map((x) => (x.pick ? { ...x, status: 'exists', pick: false, was: x.status, batch: r.batch } : x)));
      setResult(r);
      onDone();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };
  const undo = async () => {
    if (!confirm(`Take back the ${result.added} tenants this import added?`)) return;
    try {
      const u = await api.del(`/leasing/tenants/import/${result.batch}`);
      // Undo takes back the tenants it added; the details it filled in on tenants already on file stay.
      setRows((rs) => rs.map(({ was, batch, ...x }) => (batch === result.batch && was !== 'update' ? { ...x, status: was, pick: was === 'new' } : { was, batch, ...x })));
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
          <h2 className="text-base font-medium">Import tenants from Rent Manager</h2>
          <p className="text-xs text-mute">Screenshots of every page of the Tenants report, its PDF, or a CSV export. Nothing is saved until you press Import.</p>
        </div>
        <button onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={16} /></button>
      </div>

      {result ? (
        <div className="space-y-3">
          {result.undone
            ? <p className="text-sm">Taken back: {result.undone.removed} removed{result.undone.kept ? `, ${result.undone.kept} kept because they have a lease now` : ''}.</p>
            : <p className="flex items-center gap-2 text-sm"><Check size={16} className="text-ok" /> {result.added} tenant{result.added === 1 ? '' : 's'} added{result.updated ? `, ${result.updated} given their phone, email or account no.` : ''}{result.skipped ? `, ${result.skipped} already on file` : ''}.</p>}
          {!result.undone && result.added > 0 && result.updated > 0 && <p className="text-xs text-mute">Undo takes back the added tenants; the details filled in on tenants already on file stay.</p>}
          {left > 0 && <p className="text-sm text-warn">{left} row{left === 1 ? '' : 's'} still need{left === 1 ? 's' : ''} checking. They were not imported.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {!result.undone && result.added > 0 && <button onClick={undo} className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10"><Undo2 size={15} /> Undo this import</button>}
            {left > 0 && <button onClick={review} className="rounded-full border border-stroke/70 px-4 py-2 text-sm hover:bg-white/5">Review {left === 1 ? 'it' : `the ${left}`}</button>}
            <button onClick={onClose} className={PRIMARY}>Done</button>
          </div>
        </div>
      ) : job ? (
        <p className="flex items-center gap-2 py-4 text-sm text-mute"><Loader2 size={16} className="animate-spin" /> Reading {job.total === 1 ? 'the file' : `file ${Math.min(job.done + 1, job.total)} of ${job.total}`}… a page takes about half a minute, so a whole list a few minutes.</p>
      ) : !rows ? (
        <div className="space-y-3">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-stroke px-4 py-8 text-sm text-mute hover:border-p1/60 hover:text-txt">
            <Upload size={20} />
            <span>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} chosen` : 'Choose the screenshots, PDF or CSV'}</span>
            <input type="file" multiple accept="image/png,image/jpeg,image/webp,application/pdf,.csv,text/csv" className="hidden"
              onChange={(e) => setFiles([...e.target.files])} />
          </label>
          {files.length > 0 && <ul className="flex flex-wrap gap-2 text-xs text-mute">{files.map((f) => <li key={f.name} className="flex items-center gap-1 rounded-full border border-stroke px-2.5 py-1"><FileText size={12} />{f.name}</li>)}</ul>}
          <div className="flex justify-end"><button onClick={read} disabled={!files.length} className={PRIMARY}>Read the list</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">Found {rows.length} tenant{rows.length === 1 ? '' : 's'}. Clear new ones are ticked; look at the ones marked Check before ticking them.</p>
          {failed.length > 0 && <p className="text-sm text-bad">Could not read: {failed.join(', ')}. Upload {failed.length === 1 ? 'it' : 'them'} again, or add those tenants by hand.</p>}
          <div className="flex flex-wrap gap-2">
            {FILTERS.map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} className={`rounded-full border px-3 py-1 text-xs ${filter === k ? 'border-p1/70 bg-p1/15 text-txt' : 'border-stroke/70 text-mute hover:text-txt'}`}>{l} · {count(k)}</button>
            ))}
          </div>
          <div className="overflow-x-auto rounded-2xl border border-stroke">
            <table className="w-full text-sm">
              <thead><tr className={HEAD}><th className={TH} /><th className={TH}>Name to save</th><th className={TH}>Rent Manager account #</th><th className={TH}>Phone / email</th><th className={TH}>Status</th><th className={TH}>Noticed</th></tr></thead>
              <tbody className="divide-y divide-stroke/60">
                {paged.rows.map((r) => (
                  <tr key={r.i} className={r.pick ? '' : 'opacity-70'}>
                    <td className="px-3 py-2"><input type="checkbox" checked={r.pick} disabled={r.status === 'exists'} onChange={(e) => change(r.i, { pick: e.target.checked })} className="size-4 accent-p1" aria-label={`Import ${r.name}`} /></td>
                    <td className="min-w-48 px-3 py-2">
                      {/* A tenant on file keeps its name: only a new one is named here. */}
                      <input value={r.name} onChange={(e) => change(r.i, { name: e.target.value })} readOnly={r.tenant_id != null} className={`${FIELD} py-1.5 ${r.tenant_id != null ? 'opacity-70' : ''}`} aria-label="Name to save" />
                      {/* Only where the name to save is not what Rent Manager shows: a tag taken out, a cut-off name finished, accounts merged. */}
                      {(r.original.some((o) => o !== r.name) || r.kind === 'company') && (
                        <p className="mt-1 truncate text-xs text-mute" title={r.original.join(' / ')}>
                          {r.original.some((o) => o !== r.name) && `In Rent Manager: ${r.original.join(' / ')}`}{r.kind === 'company' && `${r.original.some((o) => o !== r.name) ? ' · ' : ''}Company`}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-mute">{r.accounts.join(', ') || '—'}</td>
                    <td className="px-3 py-2 text-xs text-mute">{r.phone || r.email ? <><p className="tabular-nums">{r.phone}</p><p className="max-w-56 truncate" title={r.email}>{r.email}</p></> : '—'}</td>
                    <td className="px-3 py-2"><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span></td>
                    <td className="px-3 py-2 text-xs text-mute">
                      {/* On file: only what an update adds is said; what a new tenant would get does not apply. */}
                      {(r.tenant_id != null
                        ? [r.status === 'update' && `Adds ${[r.fill.phone && `phone ${r.fill.phone}`, r.fill.email && `email ${r.fill.email}`, r.fill.accounts && `account #${r.fill.accounts.join(', ')}`].filter(Boolean).join(', ')}`]
                        : [...r.reasons, ...(r.housing_authority ? [`Housing tenant: ${r.housing_authority}`] : []), ...(r.status === 'skip' ? [WHY_SKIP] : []), ...(r.accounts.length > 1 ? [`On ${r.accounts.length} accounts in Rent Manager, saved as one tenant`] : []), r.notes]
                      ).filter(Boolean).map((x) => <p key={x}>{x}</p>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager {...paged.pager} />
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
            <button onClick={save} disabled={!picked.length || saving || picked.some((r) => !r.name.trim())} className={PRIMARY}>
              {saving && <Loader2 size={15} className="animate-spin" />} Import {picked.length} tenant{picked.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}
