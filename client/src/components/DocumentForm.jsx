import { useRef, useState } from 'react';
import { Loader2, Paperclip, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import DateField from './DateField';
import Select from './Select';

// The form a document is filed with, whoever it belongs to: a company, a building or a unit.
// Choosing the file sends it to be read (server/documentReader.js), and what comes back fills
// the boxes still empty, outlined until somebody touches them: a suggestion, checked by a
// person before it is saved. A copy under a name already there is that document's renewal.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const SEGMENT = 'flex gap-1 rounded-full border border-stroke p-0.5 text-sm';
const KINDS = [['company', 'Company'], ['building', 'Building'], ['unit', 'Unit']];
const BY = [['remind', 'Just remind me'], ['quotes', 'Get quotes']];
export const DETAILS = [['insurer', 'Insurer or supplier'], ['premium', 'Premium / price'], ['sum_insured', 'Sum insured'], ['deductible', 'Deductible'], ['cover', 'What is covered']];
const BLANK = Object.fromEntries(DETAILS.map(([k]) => [k, '']));
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

export default function DocumentForm({ owner, preset, places, start, from, onDone, onCancel }) {
  const seed = start || from; // an edit starts from the document itself; a renewal from the copy it follows
  const [v, setV] = useState({ title: seed?.title || '', number: start?.number || '', issue_date: start?.issue_date || '', expiry_date: start?.expiry_date || '', notes: start?.notes || '',
    renew_days: seed?.renew_days ?? 90, renew_by: seed?.renew_by || 'remind' });
  const [details, setDetails] = useState({ ...BLANK, ...start?.details });
  const [at, setAt] = useState({ kind: 'building', company_id: '', building_id: '', unit_id: '', ...preset });
  const [file, setFile] = useState(null);
  const [reading, setReading] = useState(false);
  const [suggested, setSuggested] = useState([]); // the boxes filled in from the file and not yet touched
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What is in the boxes right now, for when the reading comes back: it may not overwrite what was typed meanwhile.
  const live = useRef();
  live.current = { v, details, suggested };
  const reads = useRef(0); // which reading is the latest: one that comes back after another file was chosen, or after saving, is dropped

  const touch = (f) => setSuggested((s) => s.filter((x) => x !== f));
  const set = (f) => (e) => { touch(f); setV({ ...v, [f]: e.target.value }); };
  const setDetail = (f) => (e) => { touch(f); setDetails({ ...details, [f]: e.target.value }); };
  const look = (f) => `${FIELD} ${suggested.includes(f) ? 'border-p3/70' : ''}`;

  // A new document's file is read while the form is filled in. Only boxes still empty take what was read.
  const choose = async (picked) => {
    setFile(picked);
    if (start) return;
    const mine = ++reads.current;
    // What the last file suggested and nobody touched goes with that file, not with this one.
    const was = live.current;
    const keptV = { ...was.v };
    const keptD = { ...was.details };
    for (const f of was.suggested) { if (f in keptD) keptD[f] = ''; else keptV[f] = ''; }
    setV(keptV); setDetails(keptD); setSuggested([]);
    live.current = { v: keptV, details: keptD, suggested: [] };
    setReading(!!picked);
    if (!picked) return;
    try {
      const form = new FormData();
      form.append('file', picked);
      const got = await api.upload('/properties/documents/read', form);
      if (mine !== reads.current) return;
      const now = live.current;
      const filled = [];
      const nextV = { ...now.v };
      for (const f of ['title', 'number', 'issue_date', 'expiry_date']) if (got[f] && !now.v[f]) { nextV[f] = got[f]; filled.push(f); }
      if (got.renew_by && !from) nextV.renew_by = got.renew_by;
      const nextD = { ...now.details };
      for (const [f] of DETAILS) if (got.details?.[f] && !now.details[f]) { nextD[f] = got.details[f]; filled.push(f); }
      setV(nextV); setDetails(nextD); setSuggested(filled);
    } catch { /* not read: the form is filled in by hand */ }
    if (mine === reads.current) setReading(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const own = owner || { [`${at.kind}_id`]: at[`${at.kind}_id`] };
    if (!start && !Object.values(own)[0]) { setError(`Choose the ${at.kind} this document belongs to.`); return; }
    // Saving does not wait for the reading: one still on its way is no longer wanted.
    reads.current += 1;
    setReading(false);
    setBusy(true);
    setError('');
    const form = new FormData();
    for (const [k, x] of Object.entries(v)) form.append(k, x);
    form.append('details', JSON.stringify(v.renew_by === 'quotes' ? details : {}));
    if (!start) for (const [k, x] of Object.entries(own)) form.append(k, x);
    if (file) form.append('file', file);
    try {
      if (start) await api.uploadPut(`/properties/docs/${start.id}`, form);
      else await api.upload('/properties/documents', form);
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
      {!owner && !start && places && <Owner places={places} at={at} onAt={setAt} />}
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
        {reading ? <Loader2 size={15} className="animate-spin" /> : <Paperclip size={15} />}
        <span className="truncate">{reading ? 'Reading the file…' : file ? file.name : start?.has_file ? `Replace file (${start.file_name})` : 'Attach the file (PDF or photo): it is read for you'}</span>
        <input type="file" accept="application/pdf,image/*,.doc,.docx" className="hidden" onChange={(e) => choose(e.target.files?.[0] || null)} />
      </label>
      {suggested.length > 0 && <p className="flex items-center gap-1.5 px-1 text-xs text-p3"><Sparkles size={13} /> Filled in from the file. Check the outlined boxes before you save.</p>}
      <input value={v.title} onChange={set('title')} required placeholder="Document name, e.g. Fire insurance *" className={look('title')} />
      <input value={v.number} onChange={set('number')} placeholder="Number / reference" className={look('number')} />
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-mute">Issue date<DateField value={v.issue_date} onChange={set('issue_date')} className={look('issue_date')} wrap="mt-1" /></label>
        <label className="text-xs text-mute">Expiry date<DateField value={v.expiry_date} onChange={set('expiry_date')} className={look('expiry_date')} wrap="mt-1" /></label>
      </div>
      <p className="px-1 text-xs text-mute">Leave expiry empty for documents that do not expire (e.g. MOA).</p>
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
      {v.renew_by === 'quotes' && (
        <div className="grid gap-2 sm:grid-cols-2">
          {DETAILS.map(([k, l]) => <input key={k} value={details[k]} onChange={setDetail(k)} placeholder={l} aria-label={l} className={`${look(k)} ${k === 'cover' ? 'sm:col-span-2' : ''}`} />)}
        </div>
      )}
      <textarea value={v.notes} onChange={set('notes')} rows={2} placeholder="Notes" className={`${FIELD} resize-none`} />
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2 text-sm font-medium text-white disabled:opacity-60">{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
