import { useCallback, useEffect, useState } from 'react';
import {
  ExternalLink, Loader2, AlertTriangle, Send, Check, X, Mail, Inbox, FileText, ShieldCheck, ShieldAlert, Scale,
  CircleDot, Clock, ChevronLeft, Paperclip, Reply, HandCoins, Ban, Repeat, Users, FolderDown,
} from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Sheet from './Sheet';
import Picker from './Picker';
import Avatar from './Avatar';

// Lease renewals (server/leaseRenewals.js): saifsys's leases ending within 120 days, and each
// renewal run with its tenant by email from here, step by step. Every email is shown to the
// person before it goes; the renewal's timeline has the newest at the top.

const DLD_RENTAL_INDEX = 'https://dubailand.gov.ae/en/eservices/rental-index/rental-index/#/';
const aed = (n) => (n === null || n === undefined ? '' : `AED ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const day = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const when = (secs) => {
  const d = new Date(secs * 1000);
  const same = d.toDateString() === new Date().toDateString();
  return same ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const STATUS = {
  offer_sent: ['Offer sent', 'p1'], negotiating: ['Negotiating', 'p1'], agreed: ['Waiting for papers', 'p1'], papers_ok: ['Ready to convert', 'ok'],
  converted: ['Renewed', 'ok'], not_renewing: ['Not renewing', 'mute'], closed: ['Closed', 'mute'],
};
const WAITING = { reply: ['Tenant replied', 'warn'], papers: ['Papers to check', 'warn'], no_answer: ['No answer', 'bad'], error: ['Problem', 'bad'] };
const CHIP = { warn: 'bg-warn/15 text-warn', p1: 'bg-p1/20 text-txt', bad: 'bg-bad/15 text-bad', ok: 'bg-ok/15 text-ok', mute: 'bg-white/10 text-mute' };
const DONE = ['converted', 'not_renewing', 'closed'];

/** What a lease's card says: its renewal's state, or how near the end is. */
function chipOf(l) {
  const r = l.renewal;
  if (r?.dispute && !DONE.includes(r.status)) return ['Dispute', 'bad'];
  if (r?.waiting) return WAITING[r.waiting];
  if (r) return STATUS[r.status];
  if (l.saifsys_renewal) return ['Staff in saifsys', 'mute'];
  return [l.days_left < 0 ? 'Ended' : l.days_left === 0 ? 'Ends today' : `${l.days_left} days`, l.days_left <= 30 ? 'bad' : l.days_left <= 90 ? 'warn' : 'mute'];
}
const needsYou = (l) => !!(l.renewal?.waiting || (l.renewal?.dispute && !DONE.includes(l.renewal.status)) || l.renewal?.status === 'papers_ok');

const Chip = ({ c: [label, tone] }) => <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${CHIP[tone]}`}>{label}</span>;

const Btn = ({ primary, busy, children, className = '', ...p }) => (
  <button {...p} disabled={busy || p.disabled}
    className={`${primary
      ? 'bg-gradient-to-br from-p1 to-p2 font-medium text-white shadow-lg shadow-p1/25'
      : 'border border-stroke text-mute hover:text-txt'} flex items-center gap-1.5 rounded-full px-4 py-2 text-sm transition active:scale-[0.98] disabled:opacity-40 ${className}`}>
    {busy && <Loader2 size={14} className="animate-spin" />} {children}
  </button>
);

const Problem = ({ text }) => (text ? <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {text}</p> : null);

const Money = ({ value, onChange, placeholder = 'AED a year', autoFocus }) => (
  <input inputMode="numeric" value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))} placeholder={placeholder}
    className="w-full rounded-2xl border border-stroke bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-p1/60" />
);

// ---------- the list ----------

export default function LeaseRenewalsPage({ onBack, open: openFirst }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('all');
  const [open, setOpen] = useState(openFirst || null); // a renewal's id
  const [starting, setStarting] = useState(null); // a lease to start

  const load = useCallback(() => api.get('/lease-renewals').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (open) return <Renewal id={open} onBack={() => { setOpen(null); load(); }} />;

  const leases = data?.leases || [];
  const tabs = [
    ['all', 'All', leases],
    ['you', 'Needs you', leases.filter(needsYou)],
    ['going', 'In progress', leases.filter((l) => l.renewal && !DONE.includes(l.renewal.status))],
    ['new', 'Not started', leases.filter((l) => !l.renewal && !l.saifsys_renewal)],
    ['done', 'Done', leases.filter((l) => l.renewal && DONE.includes(l.renewal.status))],
  ];
  const shown = (tabs.find((t) => t[0] === tab) || tabs[0])[2];
  const dld = (
    <a href={DLD_RENTAL_INDEX} target="_blank" rel="noopener noreferrer"
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute transition hover:text-txt">
      Rental Index <ExternalLink size={14} />
    </a>
  );

  return (
    <Page title="Lease renewals" onBack={onBack} action={dld}>
      {error ? <div className="pt-6"><Problem text={error} /></div> : !data ? (
        <div className="grid place-items-center pt-16 text-mute"><Loader2 className="animate-spin" /></div>
      ) : (
        <div className="space-y-4 pb-8">
          {!data.inbox && <Problem text="The Tenant care inbox is not connected, so no email can go to a tenant. Connect it under Tenant care." />}
          {!data.saifsys && <Problem text="saifsys is not connected for actions, so renewals cannot be priced or saved." />}
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {tabs.map(([k, label, list]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${tab === k ? 'bg-white/15 text-txt' : 'text-mute hover:text-txt'}`}>
                {label}
                <span className={`rounded-full px-1.5 text-xs ${k === 'you' && list.length ? 'bg-warn/20 text-warn' : 'bg-white/10'}`}>{list.length}</span>
              </button>
            ))}
          </div>
          {shown.length === 0 ? <p className="pt-12 text-center text-sm text-mute">Nothing here.</p> : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((l) => <LeaseCard key={`${l.lease_id}:${l.end_date}`} l={l} onOpen={() => (l.renewal ? setOpen(l.renewal.id) : l.saifsys_renewal ? null : setStarting(l))} />)}
            </ul>
          )}
          {data.master && <Settings s={data.settings} agents={data.agents} onSaved={load} />}
        </div>
      )}
      {starting && <StartSheet lease={starting} onClose={() => setStarting(null)} onDone={(r) => { setStarting(null); load(); if (r?.id) setOpen(r.id); }} />}
    </Page>
  );
}

function LeaseCard({ l, onOpen }) {
  const r = l.renewal;
  const live = r && !DONE.includes(r.status);
  return (
    <li>
      <button onClick={onOpen} disabled={!r && !!l.saifsys_renewal}
        className={`flex h-full w-full flex-col gap-2 rounded-2xl border bg-white/[0.04] p-4 text-left transition hover:bg-white/[0.07] disabled:cursor-default ${needsYou(l) ? 'border-warn/50' : 'border-stroke'}`}>
        <div className="flex w-full items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{l.building}</p>
            <p className="text-sm text-mute">Unit {l.unit} · {l.unit_type || (l.bedrooms ? `${l.bedrooms} bed` : 'unit')}</p>
          </div>
          <Chip c={chipOf(l)} />
        </div>
        <p className="truncate text-sm">{l.tenant}</p>
        <div className="mt-auto flex w-full items-baseline justify-between gap-2 border-t border-stroke pt-2">
          {live ? (
            <span className="text-sm"><span className="text-mute line-through">{aed(l.annual_rent)}</span> <span className="text-base font-medium">{aed(r.agreed ?? r.offer)}</span></span>
          ) : <span className="text-base font-medium">{aed(l.annual_rent)}</span>}
          <span className="text-xs text-mute">ends {day(l.end_date)}</span>
        </div>
        {r?.dispute && live && <p className="flex items-start gap-1.5 text-xs text-bad"><Scale size={13} className="mt-0.5 shrink-0" /> {r.dispute}</p>}
        {!r && (l.premises_number || l.ejari) && (
          <p className="truncate text-xs text-mute">{[l.premises_number && `Premises ${l.premises_number}`, l.ejari && `Ejari ${l.ejari}`].filter(Boolean).join(' · ')}</p>
        )}
        {!r && !l.saifsys_renewal && <p className="text-xs text-p1">Tap to start the renewal</p>}
      </button>
    </li>
  );
}

// ---------- writing and sending ----------

/** Start: the rent we choose and the cheques, then the offer to read before it goes. */
function StartSheet({ lease, onClose, onDone }) {
  const [rent, setRent] = useState(String(Math.round(lease.annual_rent)));
  const [cheques, setCheques] = useState(String(lease.cheques || 4));
  const [step, setStep] = useState(null);
  if (step) return <Compose ask={step} onClose={onClose} onSent={onDone} />;
  return (
    <Sheet title="Start the renewal" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-mute">{lease.building} · Unit {lease.unit} · {lease.tenant}<br />Now {aed(lease.annual_rent)} a year, ends {day(lease.end_date)}</p>
        <label className="block space-y-1.5 text-sm">
          <span>New yearly rent: your choice</span>
          <Money value={rent} onChange={setRent} autoFocus />
          {rent && Number(rent) !== Number(lease.annual_rent) && (
            <span className="block text-xs text-mute">{Number(rent) > lease.annual_rent ? 'Up' : 'Down'} {Math.abs(((Number(rent) - lease.annual_rent) / lease.annual_rent) * 100).toFixed(1)}% on the current rent</span>
          )}
        </label>
        <label className="block space-y-1.5 text-sm">
          <span>Cheques</span>
          <div className="flex flex-wrap gap-1.5">
            {[1, 2, 3, 4, 6, 12].map((n) => (
              <button key={n} onClick={() => setCheques(String(n))}
                className={`rounded-full px-3.5 py-1.5 text-sm ${Number(cheques) === n ? 'bg-p1/30 text-txt' : 'bg-white/5 text-mute'}`}>{n}</button>
            ))}
          </div>
        </label>
        <div className="flex justify-end">
          <Btn primary disabled={!rent} onClick={() => setStep({ action: 'start', lease_id: lease.lease_id, rent: Number(rent), cheques: Number(cheques) })}>
            <Mail size={14} /> Write the offer
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}

const TITLES = {
  start: 'Renewal offer', counter: 'Counter-offer', index: 'RERA index rent', accept: 'Agree', not_renewing: 'Not renewing',
  reply: 'Reply', fix: 'What to fix', convert: 'Renew in saifsys',
};

/** The email a step sends, written by Reem, read (and changed if need be) by the person, then sent. */
function Compose({ ask, onClose, onSent }) {
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.post('/lease-renewals/draft', ask).then((x) => { setD(x); setText(x.text); }).catch((e) => setError(e.message));
  }, [ask]);
  const send = async () => {
    setBusy(true); setError('');
    try { onSent(await api.post('/lease-renewals/send', { ...ask, text })); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Sheet title={TITLES[ask.action]} onClose={onClose}>
      {!d ? (error ? <Problem text={error} /> : <div className="grid place-items-center py-10 text-mute"><Loader2 className="animate-spin" /></div>) : (
        <div className="space-y-3">
          <p className="text-xs text-mute">To <span className="text-txt">{d.to}</span> · {d.subject}</p>
          {d.rent && ask.action !== 'convert' && (
            <div className="rounded-2xl border border-stroke bg-black/20 p-3 text-sm">
              <p><span className="text-mute">Rent:</span> <b>{aed(d.rent)}</b> a year{d.source?.kind === 'rera_index' ? ` · RERA index${d.source.pct !== undefined ? ` (+${d.source.pct}%)` : ''}` : ''}</p>
              {d.schedule && <p className="mt-1 text-xs text-mute">{d.schedule.length} cheques: {d.schedule.map((c) => `${day(c.date)} ${aed(c.amount)}`).join(' · ')}</p>}
            </div>
          )}
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12}
            className="w-full rounded-2xl border border-stroke bg-black/20 p-3 text-sm leading-relaxed outline-none focus:border-p1/60" />
          {d.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">{d.attachments.map((a) => <span key={a} className="flex items-center gap-1 rounded-full bg-white/5 px-2.5 py-1 text-xs text-mute"><Paperclip size={12} /> {a}</span>)}</div>
          )}
          {ask.action === 'convert' && <p className="text-xs text-mute">saifsys makes the new lease and its cheques now, then this email goes to the tenant.</p>}
          <Problem text={error} />
          <div className="flex justify-end gap-2">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn primary busy={busy} disabled={!text.trim()} onClick={send}><Send size={14} /> Send</Btn>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** A step that needs a figure first: the counter rent, the index increase, or the agreed rent. */
function AskFigure({ r, action, onClose, onNext }) {
  const [value, setValue] = useState(action === 'accept' ? String(Math.round(r.renewal.tenantOffer ?? r.renewal.offer)) : '');
  const [mode, setMode] = useState('pct'); // for the index: the % the calculator allows, or the rent it gives
  const current = Number(r.annual_rent);
  const index = action === 'index';
  const preview = index && mode === 'pct' && value !== '' ? Math.max(current, Math.floor((current * (1 + Number(value) / 100)) / 100) * 100) : null;
  const ask = index
    ? (mode === 'pct' ? { id: r.renewal.id, action, pct: Number(value) } : { id: r.renewal.id, action, rent: Number(value) })
    : { id: r.renewal.id, action, rent: Number(value) };
  return (
    <Sheet title={TITLES[action]} onClose={onClose}>
      <div className="space-y-4">
        {index && (
          <>
            <p className="text-sm text-mute">Check this unit on DLD's Rental Index calculator, then enter what it allows. Current rent {aed(current)}.</p>
            <a href={DLD_RENTAL_INDEX} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-p1 underline">Open the calculator <ExternalLink size={13} /></a>
            <div className="grid grid-cols-2 rounded-full bg-white/5 p-1 text-sm">
              {[['pct', 'Allowed increase %'], ['rent', 'Index rent']].map(([k, l]) => (
                <button key={k} onClick={() => { setMode(k); setValue(''); }} className={`rounded-full py-1.5 ${mode === k ? 'bg-white/15 text-txt' : 'text-mute'}`}>{l}</button>
              ))}
            </div>
          </>
        )}
        {index && mode === 'pct' ? (
          <div className="flex flex-wrap gap-1.5">
            {[0, 5, 10, 15, 20].map((p) => (
              <button key={p} onClick={() => setValue(String(p))} className={`rounded-full px-4 py-2 text-sm ${value === String(p) ? 'bg-p1/30 text-txt' : 'bg-white/5 text-mute'}`}>{p}%</button>
            ))}
          </div>
        ) : (
          <label className="block space-y-1.5 text-sm">
            <span>{action === 'accept' ? 'The rent agreed' : index ? 'The index rent' : 'Your counter-offer'}</span>
            <Money value={value} onChange={setValue} autoFocus />
          </label>
        )}
        {preview !== null && <p className="text-sm">The offer will be <b>{aed(preview)}</b> a year.</p>}
        <div className="flex justify-end"><Btn primary disabled={value === ''} onClick={() => onNext(ask)}><Mail size={14} /> Write the email</Btn></div>
      </div>
    </Sheet>
  );
}

// ---------- one renewal ----------

function Renewal({ id, onBack }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(null); // { figure: action } | { compose: ask }
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api.get(`/lease-renewals/${id}`).then(setR).catch((e) => setError(e.message)), [id]);
  const askAdvisors = async () => {
    setBusy('advise'); setError('');
    try { await api.post(`/lease-renewals/${id}/advise`); await load(); } catch (e) { setError(e.message); }
    setBusy('');
  };
  useEffect(() => { load(); }, [load]);

  const mark = async (what) => {
    if (what === 'close' && !confirm('Take this renewal out of Reem? No more emails or reminders go to the tenant, and you handle it yourself.')) return;
    setBusy(what);
    try { await api.post(`/lease-renewals/${id}/mark`, { what }); await load(); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const done = () => { setSheet(null); load(); };

  if (!r) {
    return (
      <Page title="Lease renewal" onBack={onBack}>
        {error ? <div className="pt-6"><Problem text={error} /></div> : <div className="grid place-items-center pt-16 text-mute"><Loader2 className="animate-spin" /></div>}
      </Page>
    );
  }
  const rn = r.renewal;
  const s = rn.status;
  const can = (...st) => st.includes(s);

  return (
    <Page title={`${r.building} · ${r.unit}`} onBack={onBack}>
      <div className="mx-auto max-w-3xl space-y-4 pb-10">
        {/* Where it stands */}
        <div className="rounded-3xl border border-stroke bg-white/[0.04] p-4">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{r.tenant}</p>
              <p className="truncate text-sm text-mute">{r.email} · ends {day(r.end_date)} · {r.days_left} days left</p>
            </div>
            <Chip c={chipOf(r)} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <Figure label="Current" value={aed(r.annual_rent)} />
            <Figure label={rn.agreed ? 'Agreed' : 'Our offer'} value={aed(rn.agreed ?? rn.offer)} strong
              sub={rn.rentSource?.kind === 'rera_index' ? 'RERA index' : rn.rentSource?.kind === 'dld_api' ? 'DLD API' : null} />
            <Figure label="Tenant asks" value={rn.tenantOffer ? aed(rn.tenantOffer) : '—'} />
          </div>
          {rn.dispute && !DONE.includes(s) && (
            <div className="mt-3 flex items-start gap-2 rounded-2xl border border-bad/40 bg-bad/10 p-3 text-sm">
              <Scale size={16} className="mt-0.5 shrink-0 text-bad" />
              <div><p className="font-medium text-bad">The tenant disputes this renewal</p><p className="text-mute">{rn.dispute}</p>
                {can('offer_sent', 'negotiating') && <p className="mt-1 text-mute">You can stay with your offer, or offer the RERA index rent.</p>}</div>
            </div>
          )}
          {error && <div className="mt-3"><Problem text={error} /></div>}

          {/* What can be done now */}
          {!DONE.includes(s) && (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-stroke pt-4">
              {can('offer_sent', 'negotiating') && <>
                <Btn primary onClick={() => setSheet({ figure: 'accept' })}><Check size={14} /> Agree{rn.tenantOffer ? ` ${aed(rn.tenantOffer)}` : ''}</Btn>
                <Btn onClick={() => setSheet({ figure: 'counter' })}><HandCoins size={14} /> Counter</Btn>
                <Btn onClick={() => setSheet({ figure: 'index' })} className={rn.dispute ? 'border-bad/50 text-txt' : ''}><Scale size={14} /> RERA index rent</Btn>
              </>}
              {can('agreed') && rn.papers && !rn.papers.complete && <Btn primary onClick={() => setSheet({ compose: { id, action: 'fix' } })}><Repeat size={14} /> Ask to fix</Btn>}
              {can('agreed') && <Btn primary={!!rn.papers?.complete} busy={busy === 'papers_ok'} onClick={() => mark('papers_ok')}><ShieldCheck size={14} /> Papers OK</Btn>}
              {can('papers_ok', 'agreed') && <Btn primary={s === 'papers_ok'} disabled={s !== 'papers_ok'} title={s !== 'papers_ok' ? 'Mark the papers OK first' : ''}
                onClick={() => setSheet({ compose: { id, action: 'convert' } })}><FileText size={14} /> Renew in saifsys</Btn>}
              <Btn onClick={() => setSheet({ compose: { id, action: 'reply' } })}><Reply size={14} /> Reply</Btn>
              {rn.waiting === 'reply' && <Btn busy={busy === 'seen'} onClick={() => mark('seen')}><Check size={14} /> No reply needed</Btn>}
              <Btn onClick={() => setSheet({ compose: { id, action: 'not_renewing' } })}><Ban size={14} /> Not renewing</Btn>
              <Btn busy={busy === 'close'} onClick={() => mark('close')}><X size={14} /> Handle outside Reem</Btn>
            </div>
          )}
        </div>

        {rn.schedule && (
          <p className="px-1 text-xs text-mute">
            {day(rn.start)} – {day(rn.end)} · {rn.schedule.length} cheques: {rn.schedule.map((c) => `${day(c.date)} ${aed(c.amount)}`).join(' · ')}
            {rn.workflowId ? ` · saifsys renewal #${rn.workflowId}` : ''}
          </p>
        )}

        <div className="flex flex-wrap gap-2 px-1">
          <Btn busy={busy === 'advise'} disabled={!r.advisors} title={r.advisors ? '' : 'The master picks the advisors in the settings'} onClick={askAdvisors}>
            <Users size={14} /> {busy === 'advise' ? 'Asking the advisors…' : 'Ask advisors'}
          </Btn>
          <a href={`/api/lease-renewals/${id}/case-pack`} download
            className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute transition hover:text-txt">
            <FolderDown size={14} /> RDC case pack
          </a>
        </div>

        <Timeline r={r} onReply={!DONE.includes(s) ? (words) => setSheet({ compose: { id, action: 'reply', words } }) : null} />
      </div>
      {sheet?.figure && <AskFigure r={r} action={sheet.figure} onClose={() => setSheet(null)} onNext={(ask) => setSheet({ compose: ask })} />}
      {sheet?.compose && <Compose ask={sheet.compose} onClose={() => setSheet(null)} onSent={done} />}
    </Page>
  );
}

const Figure = ({ label, value, strong, sub }) => (
  <div className="rounded-2xl bg-white/5 px-2 py-2.5">
    <p className="text-xs text-mute">{label}</p>
    <p className={`truncate ${strong ? 'text-base font-medium' : 'text-sm'}`}>{value}</p>
    {sub && <p className="text-[11px] text-p1">{sub}</p>}
  </div>
);

// ---------- the timeline: newest first ----------

const DOT = {
  out: ['bg-p1/20 text-p1', Send], in: ['bg-white/10 text-txt', Inbox], step: ['bg-white/5 text-mute', CircleDot],
};

function Timeline({ r, onReply }) {
  return (
    <ol className="relative space-y-3 pl-11">
      <span className="absolute bottom-3 left-[17px] top-3 w-px bg-gradient-to-b from-p1/50 via-stroke to-transparent" aria-hidden />
      {r.events.map((e, i) => (e.kind === 'advice'
        ? <Advice key={e.id} e={e} newest={i === 0} onReply={onReply} />
        : <Event key={e.id} e={e} r={r} newest={i === 0} />))}
    </ol>
  );
}

// Each advisor's bubble in its own colour, as on the team.
const TINT = {
  violet: 'border-violet-400/40 bg-violet-500/[0.07]', blue: 'border-sky-400/40 bg-sky-500/[0.07]', teal: 'border-emerald-400/40 bg-emerald-500/[0.07]',
  amber: 'border-amber-400/40 bg-amber-500/[0.07]', rose: 'border-rose-400/40 bg-rose-500/[0.07]', slate: 'border-slate-400/40 bg-slate-500/[0.07]',
};

/** One advisor's view, and the reply it suggests: opened in Compose to change and send. */
function Advice({ e, newest, onReply }) {
  const a = e.data?.agent || {};
  const reply = e.data?.reply;
  const [openReply, setOpenReply] = useState(false);
  return (
    <li className="relative">
      <span className="absolute -left-11 top-1 rounded-full ring-4 ring-[var(--color-surface)]"><Avatar icon={a.icon} color={a.color} size={36} /></span>
      <div className={`rounded-2xl border p-3.5 ${TINT[a.color] || TINT.violet} ${newest ? 'shadow-lg shadow-black/20' : ''}`}>
        <p className="font-medium leading-snug">{e.title}</p>
        <p className="text-xs text-mute">{e.data?.asked ? `Asked by ${e.by || 'someone'}` : 'On the dispute, by itself'} · {when(e.at)}{newest ? ' · latest' : ''}</p>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{e.body}</p>
        {reply && (
          <>
            {openReply && <pre className="mt-2.5 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-xl bg-black/20 p-3 font-sans text-sm leading-relaxed">{reply}</pre>}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button onClick={() => setOpenReply(!openReply)} className="flex items-center gap-1 text-xs text-p1">
                <ChevronLeft size={12} className={`transition ${openReply ? 'rotate-90' : '-rotate-90'}`} /> {openReply ? 'Hide the reply' : 'Read the suggested reply'}
              </button>
              {onReply && <button onClick={() => onReply(reply)} className="flex items-center gap-1 text-xs text-p1"><Reply size={12} /> Use this reply</button>}
            </div>
          </>
        )}
      </div>
    </li>
  );
}

function Event({ e, r, newest }) {
  const [openBody, setOpenBody] = useState(newest && e.kind === 'in');
  const papers = e.kind === 'papers';
  const ok = papers && e.data?.check?.complete;
  const [tint, Ico] = papers ? [ok ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn', ok ? ShieldCheck : ShieldAlert]
    : e.reading?.dispute ? ['bg-bad/15 text-bad', Scale] : DOT[e.kind];
  const who = e.kind === 'in' ? r.tenant : e.kind === 'out' ? (e.by || 'Reem') : e.by || 'Reem';

  if (e.kind === 'step') {
    return (
      <li className="relative flex min-h-9 items-center">
        <span className={`absolute -left-11 grid size-9 place-items-center rounded-full ${tint}`}><Ico size={15} /></span>
        <p className="text-sm text-mute"><span className="text-txt">{e.title}</span> · {who} · {when(e.at)}</p>
      </li>
    );
  }
  return (
    <li className="relative">
      <span className={`absolute -left-11 top-1 grid size-9 place-items-center rounded-full ring-4 ring-[var(--color-surface)] ${tint}`}><Ico size={15} /></span>
      <div className={`rounded-2xl border p-3.5 ${e.kind === 'out' ? 'border-p1/25 bg-p1/[0.06]' : e.reading?.dispute ? 'border-bad/40 bg-bad/[0.06]' : 'border-stroke bg-white/[0.04]'} ${newest ? 'shadow-lg shadow-black/20' : ''}`}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium leading-snug">{e.title}</p>
            <p className="text-xs text-mute">{who} · {when(e.at)}{newest ? ' · latest' : ''}</p>
          </div>
          {e.kind === 'out' && e.status === 'failed' && <span className="flex items-center gap-1 text-xs text-bad"><Clock size={12} /> Not sent yet</span>}
          {e.reading?.dispute && <span className="rounded-full bg-bad/15 px-2 py-0.5 text-xs text-bad">Dispute</span>}
        </div>

        {e.reading?.dispute && e.reading.disputeNote && <p className="mt-2 text-sm text-bad">{e.reading.disputeNote}</p>}
        {e.kind === 'out' && e.status === 'failed' && e.error && <p className="mt-2 text-xs text-bad">{e.error} Reem tries again by itself.</p>}

        {papers && (
          <ul className="mt-2 space-y-1 text-sm">
            {(e.data?.check?.wrong || []).map((w) => <li key={w} className="flex gap-1.5"><X size={14} className="mt-0.5 shrink-0 text-bad" /> {w}</li>)}
            {(e.data?.check?.missing || []).map((m) => <li key={m} className="flex gap-1.5"><Clock size={14} className="mt-0.5 shrink-0 text-warn" /> Missing: {m}</li>)}
            {ok && <li className="flex gap-1.5 text-ok"><Check size={14} className="mt-0.5 shrink-0" /> Signed agreement and every cheque match saifsys's schedule.</li>}
          </ul>
        )}

        {e.body && (
          <>
            {openBody && <pre className="mt-2.5 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-xl bg-black/20 p-3 font-sans text-sm leading-relaxed">{e.body}</pre>}
            <button onClick={() => setOpenBody(!openBody)} className="mt-2 flex items-center gap-1 text-xs text-p1">
              <ChevronLeft size={12} className={`transition ${openBody ? 'rotate-90' : '-rotate-90'}`} /> {openBody ? 'Hide the email' : 'Read the email'}
            </button>
          </>
        )}

        {e.files?.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {e.files.map((f) => (
              <a key={f.id} href={`/api/lease-renewals/${r.renewal.id}/files/${f.id}`} target="_blank" rel="noreferrer"
                className="flex items-center gap-1 rounded-full bg-white/5 px-2.5 py-1 text-xs text-mute hover:text-txt">
                {f.mime === 'application/pdf' ? <FileText size={12} /> : <Paperclip size={12} />} {f.name}
              </a>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

// ---------- the master's settings ----------

function Settings({ s, agents, onSaved }) {
  const [payee, setPayee] = useState(s.payee);
  const [reminders, setReminders] = useState(s.reminders);
  const [advisors, setAdvisors] = useState(s.advisors || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { await api.put('/lease-renewals/settings', { payee, reminders, advisors }); onSaved(); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  return (
    <div className="mt-6 space-y-3 rounded-3xl border border-stroke bg-white/[0.04] p-4">
      <p className="font-medium">Settings</p>
      <label className="block space-y-1.5 text-sm">
        <span className="text-mute">Cheques are payable to</span>
        <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="The landlord company's name"
          className="w-full rounded-2xl border border-stroke bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-p1/60" />
      </label>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm">Reminders by Reem</p>
          <p className="text-xs text-mute">{reminders ? 'On: a silent tenant gets a reminder a week apart, twice.' : 'Off: nobody is reminded.'}</p>
        </div>
        <button role="switch" aria-checked={reminders} aria-label="Reminders by Reem" onClick={() => setReminders(!reminders)}
          className={`relative h-7 w-12 shrink-0 rounded-full transition ${reminders ? 'bg-p1' : 'bg-white/15'}`}>
          <span className={`absolute top-1 size-5 rounded-full bg-white transition-all ${reminders ? 'left-6' : 'left-1'}`} />
        </button>
      </div>
      <div className="space-y-1.5 text-sm">
        <span className="text-mute">Advisors</span>
        <Picker multi value={advisors} onChange={setAdvisors} placeholder="Nobody advises yet" searchPlaceholder="Search the team"
          options={agents.map((a) => ({ value: a.id, label: a.name }))} />
        <p className="text-xs text-mute">They read each dispute and give their view and a reply you can send. They never file a case or say whether an increase is legal.</p>
      </div>
      <p className="text-xs text-mute">saifsys records the renewals as {s.actor ? s.actor.name : 'whoever saves these settings'}: their company email must be connected under Email.</p>
      <Problem text={error} />
      <div className="flex justify-end"><Btn primary busy={busy} onClick={save}>Save</Btn></div>
    </div>
  );
}
