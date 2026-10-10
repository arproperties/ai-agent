import { useEffect, useState } from 'react';
import { AlertCircle, FileText, Loader2, Plus, Search } from 'lucide-react';
import { api } from '../lib/api';
import Select from './Select';
import DocumentSheet, { CHIP, chipText } from './DocumentSheet';
import Renewal from './Renewal';

// The documents register: every document of every company, building and unit in one list,
// the most pressing first (expired, then due inside its renewal window, then the rest), each
// a card. A card opens the document: its file, its details and the renewals under it. The server is the
// documents part of server/properties.js. Given a building, it is that building's list.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
// The colour behind a card's icon says how pressing it is, before anything is read.
const TINT = { expired: 'bg-bad/15', due: 'bg-warn/10', valid: 'bg-white/[0.04]', on_file: 'bg-white/[0.04]' };
const STATUS = [['', 'Any status'], ['expired', 'Expired'], ['due', 'Due for renewal'], ['valid', 'Valid'], ['on_file', 'On file']];

export default function Documents({ openId, openRenewal, onOpened, building }) {
  const [d, setD] = useState(null); // { documents, master }
  const [places, setPlaces] = useState(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ company: '', building: '', status: '' });
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // a row of the list, or 'new'
  const [renewing, setRenewing] = useState(null); // the id of the renewal that is open, in place of the list
  const [under, setUnder] = useState(new Map()); // a document → its renewal under way (the master's to see)
  const load = () => {
    api.get('/properties/renewals').then((x) => setUnder(new Map(x.renewals.map((r) => [r.document_id, r])))).catch(() => {});
    return api.get('/properties/documents').then(setD).catch((e) => setError(e.message));
  };
  // Renewing a document begins its renewal, or opens the one already under way.
  const renew = (doc) => api.post('/properties/renewals', { document_id: doc.id }).then((r) => { setOpen(null); setRenewing(r.id); }).catch((e) => setError(e.message));
  useEffect(() => { load(); api.get('/properties/places').then(setPlaces).catch(() => {}); }, []);
  // Arriving from an alert: the document it is about opens once the list is here. Saying so
  // (onOpened) lets whoever sent us forget it, so it does not open again on the next visit.
  useEffect(() => {
    if (!d || (!openId && !openRenewal)) return;
    // A renewal is the master's to run: for anybody else the alert opens the document itself.
    if (openRenewal && d.master) setRenewing(openRenewal);
    else { const row = d.documents.find((x) => x.id === openId); if (row) setOpen(row); }
    onOpened?.();
  }, [openId, openRenewal, d]);

  // A renewal takes the page; back is the list, read again. Filing the new policy opens the document it renews.
  if (renewing) return (
    <Renewal key={renewing} id={renewing} onBack={() => { setRenewing(null); load(); }}
      onFile={(doc) => { setRenewing(null); load(); setOpen(d?.documents.find((x) => x.id === doc.id) || null); }} />
  );

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!d) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  const mine = building ? d.documents.filter((x) => x.in_building === building.id) : d.documents;
  // Every word typed must appear in the document's name, number or where it belongs.
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = mine.filter((x) => (!f.company || String(x.in_company) === String(f.company)) && (!f.building || String(x.in_building) === String(f.building))
    && (!f.status || x.status === f.status) && words.every((w) => [x.title, x.number, x.where, x.company].join(' ').toLowerCase().includes(w)));
  const buildings = places ? places.buildings.filter((b) => !f.company || String(b.company_id) === String(f.company)) : [];
  const counts = { expired: mine.filter((x) => x.status === 'expired').length, due: mine.filter((x) => x.status === 'due').length };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {counts.expired > 0 && <span className="rounded-full bg-bad/15 px-2.5 py-1 text-xs text-bad">{counts.expired} expired</span>}
        {counts.due > 0 && <span className="rounded-full bg-warn/15 px-2.5 py-1 text-xs text-warn">{counts.due} due for renewal</span>}
        {d.master && (
          <button onClick={() => setOpen('new')} className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white">
            <Plus size={16} /> Add document
          </button>
        )}
      </div>

      {mine.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, number or place" className={`${FIELD} pl-10`} />
          </label>
          {!building && places && <>
            <Select value={f.company} onChange={(e) => setF({ ...f, company: e.target.value, building: '' })} options={[['', 'All companies'], ...places.companies.map((c) => [c.id, c.name])]} aria-label="Company" className={FIELD} />
            <Select value={f.building} onChange={(e) => setF({ ...f, building: e.target.value })} options={[['', 'All buildings'], ...buildings.map((b) => [b.id, b.name])]} aria-label="Building" className={FIELD} />
          </>}
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={STATUS} aria-label="Status" className={FIELD} />
        </div>
      )}

      {shown.length === 0 ? <p className="rounded-2xl border border-stroke px-4 py-6 text-center text-sm text-mute">{mine.length ? 'No document matches.' : 'No documents yet.'}</p> : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {shown.map((x) => (
            <button key={x.id} onClick={() => setOpen(x)} className="group flex flex-col overflow-hidden rounded-2xl border border-stroke bg-surface text-left transition hover:border-p1/60">
              <div className={`relative grid h-28 w-full place-items-center ${TINT[x.status]}`}>
                <span className="absolute left-3 top-3 rounded-md bg-black/30 px-2 py-0.5 text-[11px] font-medium tracking-wide text-white/90">{x.has_file ? 'PDF' : 'NO FILE'}</span>
                {(x.status === 'expired' || x.status === 'due') && <AlertCircle size={18} className={`absolute right-3 top-3 ${x.status === 'expired' ? 'text-bad' : 'text-warn'}`} />}
                <FileText size={30} className="text-mute transition group-hover:text-txt" />
                {under.has(x.id) && <span className="absolute bottom-2 left-3 rounded-full bg-p3/20 px-2 py-0.5 text-[11px] text-p3">Renewing · {under.get(x.id).quotes} quote{under.get(x.id).quotes === 1 ? '' : 's'}</span>}
              </div>
              <div className="w-full px-3.5 py-3">
                <p className="line-clamp-2 text-sm font-medium">{x.title}{x.count > 1 && <span className="ml-1.5 rounded-full bg-white/15 px-1.5 text-[10px] font-normal">×{x.count}</span>}</p>
                <p className="mt-1 truncate text-xs text-mute">{[!building && x.where, x.number].filter(Boolean).join(' · ') || (building && x.owner === 'unit' ? x.where : '')}</p>
                <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] ${CHIP[x.status]}`}>{x.status === 'on_file' && x.has_file ? 'No expiry date' : chipText(x)}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {open && (
        <DocumentSheet doc={open === 'new' ? null : open} label={open === 'new' ? '' : open.where} places={places} master={d.master}
          // Inside a building, a new document is that building's: there is nothing to choose.
          owner={open === 'new' && building ? { building_id: building.id } : undefined}
          onRenew={d.master && open !== 'new' ? renew : undefined} renewing={open !== 'new' && under.has(open.id)}
          onClose={() => setOpen(null)} onChanged={load} />
      )}
    </div>
  );
}
