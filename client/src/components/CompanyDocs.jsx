import { useEffect, useState } from 'react';
import { Building2, DoorOpen, Loader2, ChevronRight, ChevronDown, Plus, Search } from 'lucide-react';
import { photoUrl } from './PropertyPhoto';
import { api } from '../lib/api';
import { usDate as fmt, usPhone, usAddress } from '../lib/usFormat';
import DocumentSheet, { DOT, CHIP, chipText } from './DocumentSheet';

// The Properties home: one card per company, with its details, its documents (each with
// its status: valid, due inside its renewal window, expired, or on file with no expiry) and
// its buildings. Documents are named freely; adding one under a name already there is its
// renewal. The form and the sheet are the ones every document uses (DocumentSheet.jsx);
// the server is the documents part of server/properties.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
// "ACE Real Estate L.L.C" → "AR": the first letters of the first two real words.
const initials = (name) => (name.match(/[A-Za-z0-9؀-ۿ]+/g) || ['?'])
  .filter((w) => !/^(llc|l|ltd|co|fze|fzco|inc)$/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || name[0];

const TABS = [['info', 'Info'], ['docs', 'Documents'], ['props', 'Properties']];

function Card({ c, master, onOpen, onDoc }) {
  const [tab, setTab] = useState('info');
  const tone = c.expired ? 'bad' : c.due ? 'warn' : null;
  const info = [['EIN', c.trade_license_no], ['Other tax ID', c.trn], ['Registered', c.registration_date && fmt(c.registration_date)], ['Phone', usPhone(c.phone)], ['Email', c.email], ['Address', usAddress(c.address, c.city, c.state, c.zip)], ['Notes', c.notes]];

  return (
    <div className="flex flex-col rounded-2xl border border-stroke">
      <div className="flex items-center gap-3 px-4 pt-4">
        <button onClick={onOpen} aria-label={`Open ${c.name}`}
          className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-p1/15 text-sm font-semibold text-p1">
          {photoUrl('companies', c) ? <img src={photoUrl('companies', c)} alt="" loading="lazy" className="size-full object-cover" /> : initials(c.name)}
        </button>
        <div className="min-w-0 flex-1">
          <button onClick={onOpen} className="block max-w-full truncate text-left font-medium hover:text-p1">{c.name}</button>
          <p className="truncate text-xs text-mute">{usAddress(c.address, c.city, c.state, c.zip) || 'No address yet'}</p>
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
                  <button onClick={() => onDoc(c, g.doc)} className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs ${CHIP[g.status]} hover:brightness-125`}>
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
  const [open, setOpen] = useState(null); // { company, doc } - no doc for a new document
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
          <Card key={c.id} c={c} master={master} onOpen={() => onOpen(c)} onDoc={(company, doc) => setOpen({ company, doc })} />
        ))}
      </div>
      {open && <DocumentSheet doc={open.doc} owner={{ company_id: open.company.id }} label={open.company.name} master={master} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}
