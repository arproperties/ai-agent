import { useState } from 'react';
import { FileUp, Loader2, Paperclip, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import DateField from './DateField';
import Select from './Select';

// How a document is filed, whoever it belongs to: a company, a building or a unit.
//
// A new one is not typed in at all. Its PDF is chosen, read (server/documentReader.js) and
// kept in one go: its name, number, dates and figures are what the reader found, and it
// shows as a card straight away. If the reader finds no name, the file's own name is used;
// a date it did not find is simply not there. A copy filed under a document already there
// (its renewal) keeps that document's name.
//
// The boxes are only for a document that is already on file: to correct what was read.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const SEGMENT = 'flex gap-1 rounded-full border border-stroke p-0.5 text-sm';
const KINDS = [['company', 'Company'], ['building', 'Building'], ['unit', 'Unit']];
const BY = [['remind', 'Just remind me'], ['quotes', 'Get quotes']];
export const DETAILS = [['insurer', 'Insurer or supplier'], ['premium', 'Premium / price'], ['sum_insured', 'Sum insured'], ['deductible', 'Deductible'], ['cover', 'What is covered']];
const seg = (on) => `flex-1 rounded-full px-3 py-1.5 ${on ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`;

/** Whose document it is: a company, one of its buildings, or one of that building's units. */
function Owner({ places, at, onAt }) {
  const buildings = places.buildings.filter((b) => String(b.company_id) === String(at.company_id));
  const units = places.units.filter((u) => String(u.building_id) === String(at.building_id));
  // Choosing higher up clears what was chosen under it.
  const pick = (f) => (e) => onAt({ ...at, [f]: e.target.value, ...(f === 'company_id' ? { building_id: '', unit_id: '' } : f === 'building_id' ? { unit_id: '' } : {}) });
  return (
    <div className="space-y-2">
      <div className={SEGMENT}>
        {KINDS.map(([k, l]) => <button key={k} type="button" onClick={() => onAt({ ...at, kind: k })} aria-pressed={at.kind === k} className={seg(at.kind === k)}>{l}</button>)}
      </div>
      <Select value={at.company_id} onChange={pick('company_id')} options={places.companies.map((c) => [c.id, c.name])} placeholder="Company *" aria-label="Company" className={FIELD} />
      {at.kind !== 'company' && <Select value={at.building_id} onChange={pick('building_id')} options={buildings.map((b) => [b.id, b.name])} placeholder="Building *" aria-label="Building" disabled={!at.company_id} className={FIELD} />}
      {at.kind === 'unit' && <Select value={at.unit_id} onChange={pick('unit_id')} options={units.map((u) => [u.id, `Unit ${u.unit_no}`])} placeholder="Unit *" aria-label="Unit" disabled={!at.building_id} className={FIELD} />}
    </div>
  );
}

/** A new document: choose whose it is (when that is not already known), then its PDF. Nothing else. */
function Upload({ owner, preset, places, from, onDone, onCancel }) {
  const [at, setAt] = useState({ kind: 'building', company_id: '', building_id: '', unit_id: '', ...preset });
  const [busy, setBusy] = useState(''); // what is happening to the file just now
  const [error, setError] = useState('');
  const own = owner || { [`${at.kind}_id`]: at[`${at.kind}_id`] };
  const placed = !!Object.values(own)[0];

  const file = async (picked) => {
    if (!picked || busy) return;
    if (picked.type !== 'application/pdf' && !/\.pdf$/i.test(picked.name)) { setError('Only a PDF can be added here.'); return; }
    setError('');
    setBusy('Reading the document…');
    let got = {};
    try {
      const look = new FormData();
      look.append('file', picked);
      got = await api.upload('/properties/documents/read', look);
    } catch { /* not read: it is kept all the same, under its file name */ }
    setBusy('Saving…');
    const form = new FormData();
    const fields = { title: from?.title || got.title || picked.name.replace(/\.pdf$/i, ''), number: got.number || '', issue_date: got.issue_date || '', expiry_date: got.expiry_date || '',
      renew_days: from?.renew_days ?? 90, renew_by: from?.renew_by || got.renew_by || 'remind', details: JSON.stringify(got.details || {}) };
    for (const [k, x] of Object.entries({ ...fields, ...own })) form.append(k, x);
    form.append('file', picked);
    try {
      await api.upload('/properties/documents', form);
      onDone();
    } catch (e) { setError(e.message); setBusy(''); }
  };

  return (
    <div className="space-y-2 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
      {!owner && places && <Owner places={places} at={at} onAt={setAt} />}
      <label className={`flex flex-col items-center gap-2 rounded-xl border border-dashed border-stroke px-4 py-8 text-center text-sm text-mute ${placed && !busy ? 'cursor-pointer hover:bg-white/5' : 'opacity-60'}`}>
        {busy ? <Loader2 size={22} className="animate-spin text-p3" /> : <FileUp size={22} />}
        <span className="text-txt/90">{busy || (placed ? 'Choose the PDF' : `Choose the ${at.kind} first`)}</span>
        {!busy && <span className="flex items-center gap-1.5 text-xs text-p3"><Sparkles size={13} /> Its name, number and dates are read from it. Nothing to type.</span>}
        <input type="file" accept="application/pdf,.pdf" className="hidden" disabled={!placed || !!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; file(f); }} />
      </label>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end">
        <button type="button" onClick={onCancel} disabled={!!busy} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10 disabled:opacity-50">Cancel</button>
      </div>
    </div>
  );
}

export default function DocumentForm({ start, ...rest }) {
  return start ? <Correct start={start} {...rest} /> : <Upload {...rest} />;
}

/** A document already on file: its details as boxes, to put right what was read wrong, and its PDF to replace. */
function Correct({ start, onDone, onCancel }) {
  const [v, setV] = useState({ title: start.title || '', number: start.number || '', issue_date: start.issue_date || '', expiry_date: start.expiry_date || '', notes: start.notes || '',
    renew_days: start.renew_days ?? 90, renew_by: start.renew_by || 'remind' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const details = start.details || {};

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const form = new FormData();
    for (const [k, x] of Object.entries(v)) form.append(k, x);
    if (file) form.append('file', file);
    try {
      await api.uploadPut(`/properties/docs/${start.id}`, form);
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
      <input value={v.title} onChange={set('title')} required placeholder="Document name *" aria-label="Document name" className={FIELD} />
      <input value={v.number} onChange={set('number')} placeholder="Number / reference" aria-label="Number" className={FIELD} />
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-mute">Issue date<DateField value={v.issue_date} onChange={set('issue_date')} className={FIELD} wrap="mt-1" /></label>
        <label className="text-xs text-mute">Expiry date<DateField value={v.expiry_date} onChange={set('expiry_date')} className={FIELD} wrap="mt-1" /></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-sm">
        <span className="text-txt/80">Start renewing</span>
        <span className="flex items-center gap-2">
          <input value={v.renew_days} inputMode="numeric" aria-label="Days before it expires to start renewing"
            onChange={(e) => setV({ ...v, renew_days: e.target.value.replace(/\D/g, '').slice(0, 3) })}
            className="glass w-16 rounded-xl px-3 py-2 text-right tabular-nums outline-none focus:border-p1/70" />
          <span className="text-mute">days before it expires</span>
        </span>
      </div>
      <div className={SEGMENT}>
        {BY.map(([k, l]) => <button key={k} type="button" onClick={() => setV({ ...v, renew_by: k })} aria-pressed={v.renew_by === k} className={seg(v.renew_by === k)}>{l}</button>)}
      </div>
      {/* The figures are the reader's, not a person's: shown as read, and kept with the document. */}
      {DETAILS.some(([k]) => details[k]) && (
        <dl className="space-y-0.5 rounded-xl border border-stroke/60 px-3.5 py-2.5 text-sm">
          <dt className="flex items-center gap-1.5 pb-1 text-xs text-p3"><Sparkles size={13} /> Read from the file</dt>
          {DETAILS.filter(([k]) => details[k]).map(([k, l]) => <div key={k} className="flex gap-3"><dt className="shrink-0 text-mute">{l}</dt><dd className="min-w-0 flex-1 break-words text-right">{details[k]}</dd></div>)}
        </dl>
      )}
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
        <Paperclip size={15} /> <span className="truncate">{file ? file.name : start.has_file ? `Replace the PDF (${start.file_name})` : 'Attach the PDF'}</span>
        <input type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
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
