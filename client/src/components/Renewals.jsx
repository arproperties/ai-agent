import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronDown, Loader2, Send, Upload, ExternalLink, AlertTriangle, Check, RefreshCw, X, Paperclip, Plus } from 'lucide-react';
import { api } from '../lib/api';

// Lease renewals: Reem renews each lease with its tenant by email (server/renewals.js).
// What waits here is what only a person can do: upload the DLD rental index check for a
// renewal, and answer when Reem cannot decide within the boss's rules. Everything else -
// the notice, the replies, the papers, telling saifsys - Reem does by itself, and the
// whole email thread can be read on each renewal. The master sets the rules at the bottom.

const DLD_URL = 'https://dubailand.gov.ae/en/eservices/rental-index/rental-index/#/';
const aed = (n) => (n === null || n === undefined ? '' : `AED ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const day = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const when = (secs) => (secs ? new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

const STATUS = {
  dld_needed: ['DLD check needed', 'warn'], dld_read: ['Ready to send', 'warn'], boss: ['Needs you', 'warn'],
  notice_sent: ['Offer sent', 'p1'], negotiating: ['Negotiating', 'p1'], agreed: ['Waiting for papers', 'p1'],
  converting: ['Saving in saifsys', 'p1'], no_reply: ['No reply', 'bad'],
  renewed: ['Renewed', 'ok'], not_renewing: ['Not renewing', 'mute'], closed: ['Closed', 'mute'],
};
const NEEDS_YOU = ['dld_needed', 'dld_read', 'boss'];
const DONE = ['renewed', 'not_renewing', 'closed'];
const KIND = { notice: 'Renewal offer', counter: 'Counter-offer', agreed: 'Agreed', fix: 'What is missing', answer: 'Answer', reminder: 'Reminder', done: 'Renewal complete', not_renewing: 'Not renewing' };
const CHIP = { warn: 'bg-warn/15 text-warn', p1: 'bg-p1/20 text-txt', bad: 'bg-bad/15 text-bad', ok: 'bg-emerald-500/15 text-emerald-400', mute: 'bg-white/10 text-mute' };

const Btn = ({ primary, busy, children, ...p }) => (
  <button {...p} disabled={busy || p.disabled}
    className={primary
      ? 'flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-50'
      : 'flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt disabled:opacity-40'}>
    {busy && <Loader2 size={14} className="animate-spin" />} {children}
  </button>
);

const Problem = ({ text }) => text ? <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {text}</p> : null;

function Facts({ c }) {
  const l = c.lease;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <span className="text-mute">Tenant</span><span className="truncate">{l.tenant}</span>
      <span className="text-mute">Email</span><span className="truncate">{l.email || '—'}</span>
      <span className="text-mute">Current rent</span><span>{aed(l.annual_rent)} · {l.cheques} cheques</span>
      <span className="text-mute">Lease</span><span>{day(l.start_date)} – {day(l.end_date)}</span>
      {c.offer !== null && <><span className="text-mute">Offer now</span><span>{aed(c.offer)}{c.floor !== null && <span className="text-mute"> · lowest {aed(c.floor)}</span>}</span></>}
      {c.agreed !== null && <><span className="text-mute">Agreed</span><span className="text-emerald-400">{aed(c.agreed)}</span></>}
    </div>
  );
}

/** Step 1: the DLD check, done by a person; Reem reads the screenshot. */
function Dld({ c, onDone }) {
  const input = useRef(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const l = c.lease;
  const upload = async (file) => {
    if (!file) return;
    setBusy('upload'); setError('');
    const form = new FormData();
    form.append('screenshot', file);
    try { await api.upload(`/renewals/${c.id}/dld`, form); onDone(); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const send = async () => {
    setBusy('send'); setError('');
    try { await api.post(`/renewals/${c.id}/notice`, {}); onDone(); } catch (e) { setError(e.message); }
    setBusy('');
  };
  return (
    <div className="space-y-3">
      {c.status === 'dld_needed' && (
        <div className="space-y-2 rounded-2xl border border-stroke bg-black/20 p-3 text-sm">
          <p>Check the DLD Rental Index for this unit, then upload a screenshot of the result:</p>
          <p className="text-mute">{l.building} · {l.unit_type || 'unit'}{l.bedrooms ? ` · ${l.bedrooms} bedroom${l.bedrooms > 1 ? 's' : ''}` : ''} · rent {aed(l.annual_rent)} · ends {day(l.end_date)}{l.ejari ? ` · Ejari ${l.ejari}` : ''}{l.premises_number ? ` · DEWA premises ${l.premises_number}` : ''}</p>
          <a href={DLD_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-p1 underline">Open the DLD calculator <ExternalLink size={13} /></a>
        </div>
      )}
      {c.status === 'dld_read' && (
        <div className="space-y-1 rounded-2xl border border-p1/40 bg-p1/10 p-3 text-sm">
          <p>Reem read the screenshot: <b>increase up to {c.dld.pct}%</b>{c.dld.average ? `, average ${aed(c.dld.average)}` : ''}.</p>
          {c.dld.note && <p className="text-mute">{c.dld.note}</p>}
          <p>Reem will offer <b>{aed(c.offer)}</b> a year and go no lower than <b>{aed(c.floor)}</b>.</p>
          {c.dld.late && <p className="text-warn">Fewer than 90 days are left, so the law does not allow an increase: the offer is the current rent.</p>}
        </div>
      )}
      <Problem text={error} />
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { upload(e.target.files[0]); e.target.value = ''; }} />
      <div className="flex flex-wrap justify-end gap-2">
        <Btn busy={busy === 'upload'} onClick={() => input.current.click()}><Upload size={14} /> {c.status === 'dld_read' ? 'Upload again' : 'Upload screenshot'}</Btn>
        {c.status === 'dld_read' && <Btn primary busy={busy === 'send'} onClick={send}><Send size={14} /> Send the offer</Btn>}
      </div>
    </div>
  );
}

/** When Reem cannot decide: the boss answers with a tap, and Reem writes the email. */
function Decide({ c, onDone }) {
  const [rent, setRent] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const go = async (action, extra = {}) => {
    if (action === 'close' && !confirm('Stop Reem on this renewal? It will not email the tenant again, and you handle it yourself.')) return;
    setBusy(action); setError('');
    try { await api.post(`/renewals/${c.id}/decide`, { action, ...extra }); onDone(); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const canRetry = c.saifsys?.pending || !String(c.lease.email || '').includes('@');
  return (
    <div className="space-y-3">
      <p className="rounded-2xl border border-warn/40 bg-warn/10 p-3 text-sm">{c.needs}</p>
      <Problem text={error} />
      {canRetry ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Btn busy={busy === 'close'} onClick={() => go('close')}><X size={14} /> I'll handle it</Btn>
          <Btn primary busy={busy === 'retry'} onClick={() => go('retry')}><RefreshCw size={14} /> Try again</Btn>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {c.tenantOffer && <Btn primary busy={busy === 'accept'} onClick={() => go('accept')}><Check size={14} /> Accept {aed(c.tenantOffer)}</Btn>}
            <Btn busy={busy === 'not_renewing'} onClick={() => go('not_renewing')}>They are not renewing</Btn>
            <Btn busy={busy === 'close'} onClick={() => go('close')}><X size={14} /> I'll handle it</Btn>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); go('offer', { rent }); }} className="flex items-center gap-2">
            <input inputMode="numeric" value={rent} onChange={(e) => setRent(e.target.value.replace(/[^\d]/g, ''))} placeholder="Offer a different rent (AED a year)"
              className="min-w-0 flex-1 rounded-2xl border border-stroke bg-black/20 px-3 py-2 text-sm outline-none focus:border-p1/60" />
            <Btn primary busy={busy === 'offer'} disabled={!rent}><Send size={14} /> Offer</Btn>
          </form>
        </>
      )}
    </div>
  );
}

function Thread({ detail }) {
  const [open, setOpen] = useState(null);
  if (!detail.messages.length) return null;
  const filesOf = (mid) => detail.files.filter((f) => f.message_id === mid);
  return (
    <div className="space-y-2">
      <p className="text-sm text-mute">Emails</p>
      {detail.messages.map((m) => (
        <div key={m.id} className={`rounded-2xl border p-3 text-sm ${m.direction === 'in' ? 'border-stroke bg-black/20' : 'border-p1/30 bg-p1/5'}`}>
          <button onClick={() => setOpen(open === m.id ? null : m.id)} className="flex w-full items-center gap-2 text-left">
            <span className="flex-1 truncate">{m.direction === 'in' ? 'Tenant' : `Reem · ${KIND[m.kind] || m.kind}`}{m.reading?.summary ? ` · ${m.reading.summary}` : ''}</span>
            {m.status === 'failed' && <span className="text-xs text-bad">not sent</span>}
            <span className="shrink-0 text-xs text-mute">{when(m.at)}</span>
            <ChevronDown size={15} className={`shrink-0 text-mute transition ${open === m.id ? 'rotate-180' : ''}`} />
          </button>
          {open === m.id && (
            <div className="mt-2 space-y-2">
              <p className="whitespace-pre-wrap text-mute">{m.body}</p>
              {m.error && m.status === 'failed' && <Problem text={m.error} />}
              {filesOf(m.id).map((f) => (
                <a key={f.id} href={`/api/renewals/${detail.id}/files/${f.id}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-p1 underline">
                  <Paperclip size={13} /> {f.name}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Case({ c, onChanged }) {
  const [open, setOpen] = useState(NEEDS_YOU.includes(c.status));
  const [detail, setDetail] = useState(null);
  const load = useCallback(() => api.get(`/renewals/${c.id}`).then(setDetail).catch(() => {}), [c.id]);
  useEffect(() => { if (open) load(); }, [open, load, c.updatedAt]);
  const [label, tone] = STATUS[c.status] || [c.status, 'mute'];
  const line = c.status === 'boss' ? c.needs
    : c.agreed !== null ? `Agreed at ${aed(c.agreed)}`
      : c.offer !== null ? `Offer ${aed(c.offer)}${c.rounds ? ` after ${c.rounds} counter-offer${c.rounds > 1 ? 's' : ''}` : ''}`
        : `Ends ${day(c.lease.end_date)}`;
  const done = () => { onChanged(); load(); };
  return (
    <div className="rounded-3xl border border-stroke bg-white/[0.04] p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 text-left">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{c.lease.building} · {c.lease.unit}</p>
          <p className="truncate text-sm text-mute">{c.lease.tenant} · ends {day(c.lease.end_date)}</p>
          <p className="truncate text-sm text-mute">{line}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${CHIP[tone]}`}>{label}</span>
      </button>
      {open && (
        <div className="mt-4 space-y-4">
          <Facts c={c} />
          {c.error && <Problem text={c.error} />}
          {['dld_needed', 'dld_read'].includes(c.status) && <Dld c={c} onDone={done} />}
          {c.status === 'boss' && <Decide c={c} onDone={done} />}
          {c.status === 'agreed' && c.received && (
            <p className="text-sm text-mute">
              Received so far: {c.received.agreement === 'signed' ? 'signed agreement' : 'no signed agreement'}
              {c.lease.payment_method === 'cheque' ? `, ${(c.received.cheques || []).length} of ${(c.cheques || []).length} cheques` : ''}.
            </p>
          )}
          {detail ? <Thread detail={detail} /> : <Loader2 size={16} className="animate-spin text-mute" />}
        </div>
      )}
    </div>
  );
}

function Settings({ data, onChanged }) {
  const s = data.settings;
  const [form, setForm] = useState(() => ({ enabled: s.enabled, payee: s.payee, floorPct: String(s.floorPct), maxRounds: String(s.maxRounds), buildingFloors: { ...s.buildingFloors } }));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const buildings = [...new Set([...data.cases.map((c) => c.lease.building), ...Object.keys(form.buildingFloors)])].sort();
  const save = async (patch = {}) => {
    setBusy('save'); setError(''); setNote('');
    try {
      await api.put('/renewals/settings', { ...form, ...patch, floorPct: Number(form.floorPct), maxRounds: Number(form.maxRounds) });
      setForm((f) => ({ ...f, ...patch }));
      setNote('Saved.');
      onChanged();
    } catch (e) { setError(e.message); }
    setBusy('');
  };
  const openNow = async () => {
    setBusy('open'); setError(''); setNote('');
    try {
      const r = await api.post('/renewals/open', {});
      setNote(r.skipped ? `Nothing done: ${r.skipped}.` : `${r.due} lease${r.due === 1 ? '' : 's'} end within 120 days; ${r.opened} new renewal${r.opened === 1 ? '' : 's'}.`);
      onChanged();
    } catch (e) { setError(e.message); }
    setBusy('');
  };
  const field = 'w-24 rounded-2xl border border-stroke bg-black/20 px-3 py-2 text-sm outline-none focus:border-p1/60';
  return (
    <div className="space-y-4 rounded-3xl border border-stroke bg-white/[0.03] p-4 text-sm">
      <h2 className="font-medium">Settings</h2>
      <div className="flex items-center gap-3">
        <button role="switch" aria-checked={form.enabled} onClick={() => save({ enabled: !form.enabled })} disabled={!!busy}
          className={`relative h-7 w-12 shrink-0 rounded-full transition ${form.enabled ? 'bg-p1' : 'bg-white/15'}`}>
          <span className={`absolute top-1 size-5 rounded-full bg-white transition ${form.enabled ? 'left-6' : 'left-1'}`} />
        </button>
        <p>{form.enabled ? 'On: Reem opens renewals each morning and emails the tenants.' : 'Off: nothing is opened or emailed.'}</p>
      </div>
      <label className="block space-y-1">
        <span className="text-mute">Cheques are payable to</span>
        <input value={form.payee} onChange={(e) => set('payee', e.target.value)} placeholder="The landlord company's name"
          className="w-full rounded-2xl border border-stroke bg-black/20 px-3 py-2 outline-none focus:border-p1/60" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-mute">Lowest rent Reem may accept: current rent +</span>
        <input inputMode="decimal" value={form.floorPct} onChange={(e) => set('floorPct', e.target.value)} className={field} /> %
      </div>
      <div className="space-y-2">
        <p className="text-mute">A different lowest rent for a building:</p>
        {buildings.filter((b) => form.buildingFloors[b] !== undefined).map((b) => (
          <div key={b} className="flex items-center gap-2">
            <span className="flex-1 truncate">{b}</span>
            <input inputMode="decimal" value={form.buildingFloors[b]} onChange={(e) => set('buildingFloors', { ...form.buildingFloors, [b]: e.target.value })} className={field} /> %
            <button aria-label={`Remove ${b}`} onClick={() => { const f = { ...form.buildingFloors }; delete f[b]; set('buildingFloors', f); }} className="text-mute hover:text-txt"><X size={15} /></button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          {buildings.filter((b) => form.buildingFloors[b] === undefined).map((b) => (
            <button key={b} onClick={() => set('buildingFloors', { ...form.buildingFloors, [b]: form.floorPct })}
              className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1.5 text-mute hover:text-txt">
              <Plus size={13} /> {b}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-mute">Counter-offers before asking you:</span>
        <input inputMode="numeric" value={form.maxRounds} onChange={(e) => set('maxRounds', e.target.value)} className={field} />
      </div>
      <p className="text-mute">
        saifsys records the renewals as {s.actor ? `${s.actor.name}${s.actorEmail ? ` (${s.actorEmail})` : ''}` : 'whoever saves these settings'}.
        {' '}Emails go from {data.inbox || 'the Tenant care inbox, which is not connected'}.
      </p>
      {!data.saifsys && <Problem text="saifsys is not connected for actions, so renewals cannot be priced or saved." />}
      <Problem text={error} />
      {note && <p className="text-emerald-400">{note}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Btn busy={busy === 'open'} onClick={openNow}><RefreshCw size={14} /> Check saifsys now</Btn>
        <Btn primary busy={busy === 'save'} onClick={() => save()}>Save</Btn>
      </div>
    </div>
  );
}

export default function RenewalsPage({ onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get('/renewals').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const group = (pick) => (data?.cases || []).filter(pick);
  const groups = data ? [
    ['Needs you', group((c) => NEEDS_YOU.includes(c.status))],
    ['In progress', group((c) => !NEEDS_YOU.includes(c.status) && !DONE.includes(c.status))],
    ['Done', group((c) => DONE.includes(c.status))],
  ] : [];

  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full items-center gap-2 pt-1">
          <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <ChevronLeft size={22} />
          </button>
          <h1 className="flex-1 text-lg font-light">Lease renewals</h1>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
        <div className="mx-auto w-full space-y-4 pb-8">
          {error && <p className="text-bad">{error}</p>}
          {!data && !error && <div className="grid place-items-center py-10"><Loader2 className="animate-spin text-mute" /></div>}
          {data && (
            <>
              {!data.settings.enabled && <p className="rounded-2xl border border-warn/40 bg-warn/10 p-3 text-sm">Lease renewals is switched off: Reem opens no renewals and emails no tenants.{data.master ? ' Switch it on under Settings below.' : ''}</p>}
              {data.cases.length === 0 && <p className="py-6 text-center text-mute">No renewals yet. Each morning Reem opens one for every lease in saifsys that ends within 120 days.</p>}
              {groups.map(([title, list]) => list.length > 0 && (
                <section key={title} className="space-y-3">
                  <p className="text-sm text-mute">{title} · {list.length}</p>
                  {list.map((c) => <Case key={c.id} c={c} onChanged={load} />)}
                </section>
              ))}
              {data.master && <Settings data={data} onChanged={load} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
