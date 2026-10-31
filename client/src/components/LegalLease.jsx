import { useEffect, useRef, useState } from 'react';
import {
  Loader2, AlertTriangle, Search, X, RefreshCw, Sparkles, Info, OctagonAlert, Building2, UserRound, Link2, Unlink, ChevronDown, ShieldAlert, Banknote,
} from 'lucide-react';
import { api } from '../lib/api';

// Legal cases ↔ saifsys leases (server/legalLease.js): the lease behind a case, what is
// wrong or missing on it (the checks), and Reem's advice when asked. Also the leases that
// may need a case, for the list. Drawn beside LegalCases.jsx, which owns the case itself.

const aed = (n) => (n === null || n === undefined || n === '' ? '-' : `AED ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '-');
const when = (secs) => new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const words = (s) => String(s || '').replace(/_/g, ' ');

const TONE = { bad: 'text-bad', warn: 'text-warn', info: 'text-mute' };
const ICON = { bad: OctagonAlert, warn: AlertTriangle, info: Info };
const POSITION = { strong: ['Strong position', 'bg-ok/15 text-ok'], fair: ['Fair position', 'bg-warn/15 text-warn'], weak: ['Weak position', 'bg-bad/15 text-bad'], unclear: ['Unclear', 'bg-white/10 text-mute'] };
const CHEQUE_TONE = { bounced: 'text-bad', legal_escalated: 'text-bad', cleared: 'text-ok', returned: 'text-warn', hold: 'text-warn' };

const Small = ({ busy, children, ...p }) => (
  <button {...p} disabled={busy || p.disabled} className="flex items-center gap-1.5 rounded-full border border-stroke px-3 py-1.5 text-xs text-mute transition hover:text-txt disabled:opacity-40">
    {busy && <Loader2 size={12} className="animate-spin" />} {children}
  </button>
);

/** Search saifsys's leases and pick one. */
export function LeaseFinder({ onPick, autoFocus }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setFound(null); return undefined; }
    const n = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true); setError('');
      api.get(`/legal-cases/leases/search?q=${encodeURIComponent(s)}`)
        .then((r) => { if (n === seq.current) setFound(r.leases); })
        .catch((e) => { if (n === seq.current) setError(e.message); })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-2xl border border-stroke bg-black/20 px-3 py-2.5">
        {busy ? <Loader2 size={15} className="shrink-0 animate-spin text-mute" /> : <Search size={15} className="shrink-0 text-mute" />}
        <input value={q} autoFocus={autoFocus} onChange={(e) => setQ(e.target.value)} placeholder="Tenant, building, unit or lease number"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-mute/70" />
        {q && <button type="button" onClick={() => setQ('')} aria-label="Clear" className="text-mute hover:text-txt"><X size={14} /></button>}
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      {found && (found.length === 0 ? <p className="px-1 text-xs text-mute">No lease in saifsys matches that.</p> : (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {found.map((l) => (
            <li key={l.lease_id}>
              <button type="button" onClick={() => { onPick(l); setQ(''); setFound(null); }}
                className="w-full rounded-xl border border-stroke bg-white/[0.03] px-3 py-2 text-left text-sm transition hover:bg-white/[0.08]">
                <span className="font-medium">{l.tenant}</span>
                <span className="block text-xs text-mute">{l.building} · Unit {l.unit} · {l.lease_number || `#${l.lease_id}`} · {words(l.status)} · ends {day(l.end_date)}</span>
              </button>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

/** What needs attention, and Reem's advice: the first thing on a case. */
export function ReemCard({ c, ins, onInsight }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  if (!ins) return null;
  const a = ins.advice;
  const ask = async () => {
    setBusy(true); setError('');
    try { onInsight(await api.post(`/legal-cases/${c.id}/advice`)); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const serious = ins.checks.filter((x) => x.level !== 'info').length;
  return (
    <div className="rounded-3xl border border-stroke bg-white/[0.04] p-5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
        <ShieldAlert size={17} className={serious ? 'text-warn' : 'text-mute'} />
        <span className="flex-1 font-medium">What needs attention{ins.checks.length ? ` (${ins.checks.length})` : ''}</span>
        <ChevronDown size={16} className={`text-mute transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          {ins.checks.length === 0 ? <p className="text-sm text-mute">Nothing found on the case or its lease.</p> : (
            <ul className="space-y-2">
              {ins.checks.map((x) => {
                const I = ICON[x.level];
                return <li key={x.key} className="flex items-start gap-2 text-sm"><I size={15} className={`mt-0.5 shrink-0 ${TONE[x.level]}`} /> <span>{x.text}</span></li>;
              })}
            </ul>
          )}

          <div className="rounded-2xl border border-p1/30 bg-p1/[0.06] p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="flex flex-1 items-center gap-2 font-medium"><Sparkles size={16} className="text-p1" /> Reem's advice</p>
              {a && <span className={`rounded-full px-2.5 py-0.5 text-xs ${POSITION[a.position]?.[1]}`}>{POSITION[a.position]?.[0]}</span>}
              {(a || !busy) && <Small busy={busy} onClick={ask}>{a ? 'Ask again' : 'Ask Reem'}</Small>}
            </div>
            {busy && <p className="mt-2 flex items-center gap-2 text-sm text-mute"><Loader2 size={14} className="animate-spin" /> Reem is reading the case and the lease from saifsys… about half a minute.</p>}
            {error && <p className="mt-2 text-sm text-bad">{error}</p>}
            {!a && !busy && <p className="mt-2 text-sm text-mute">Reem reads the case, its timeline and the lease in saifsys, then says what is wrong, what to do next, the options and what is missing. It helps the lawyer decide; it does not decide.</p>}
            {a && (
              <div className="mt-3 space-y-3 text-sm">
                <p className="whitespace-pre-wrap">{a.summary}</p>
                {a.positionWhy && <p className="text-xs text-mute">{a.positionWhy}</p>}
                {a.wrong?.length > 0 && <Section title="What is wrong">{a.wrong.map((w) => <li key={w}>{w}</li>)}</Section>}
                {a.next?.length > 0 && (
                  <Section title="Next steps" ordered>
                    {a.next.map((s) => (
                      <li key={s.step}>
                        <span className="font-medium">{s.step}</span>
                        {(s.who || s.by) && <span className="text-mute"> · {[s.who, s.by && `by ${day(s.by)}`].filter(Boolean).join(' · ')}</span>}
                        {s.why && <span className="block text-xs text-mute">{s.why}</span>}
                      </li>
                    ))}
                  </Section>
                )}
                {a.options?.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs font-medium tracking-[0.12em] text-mute">OPTIONS FOR THE DECISION</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {a.options.map((o) => (
                        <div key={o.option} className="rounded-xl border border-stroke bg-black/10 p-3">
                          <p className="font-medium">{o.option}</p>
                          {o.for && <p className="mt-1 text-xs"><span className="text-ok">For:</span> {o.for}</p>}
                          {o.against && <p className="mt-0.5 text-xs"><span className="text-bad">Against:</span> {o.against}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {a.missing?.length > 0 && <Section title="Get before the next step">{a.missing.map((m) => <li key={m}>{m}</li>)}</Section>}
                {a.questions?.length > 0 && <Section title="For the lawyer to answer">{a.questions.map((q) => <li key={q}>{q}</li>)}</Section>}
                <p className="text-xs text-mute">Asked {when(a.at)}{a.by ? ` by ${a.by}` : ''}. Points of law are to be confirmed by the lawyer.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const Section = ({ title, ordered, children }) => {
  const L = ordered ? 'ol' : 'ul';
  return (
    <div>
      <p className="mb-1 text-xs font-medium tracking-[0.12em] text-mute">{title.toUpperCase()}</p>
      <L className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5`}>{children}</L>
    </div>
  );
};

const Row = ({ k, v, tone = '' }) => (
  <div className="flex items-baseline justify-between gap-3 text-sm"><span className="text-mute">{k}</span><span className={`text-right tabular-nums ${tone}`}>{v}</span></div>
);

/** The case's lease from saifsys, in the side column. */
export function LeasePanel({ c, ins, onInsight }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [linking, setLinking] = useState(false);
  const [allCheques, setAllCheques] = useState(false);
  if (!ins) return <div className="grid place-items-center p-6 text-mute"><Loader2 size={16} className="animate-spin" /></div>;
  const run = async (what, call) => {
    setBusy(what); setError('');
    try { onInsight(await call()); setLinking(false); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const link = (l) => run('link', () => api.put(`/legal-cases/${c.id}/lease`, { lease_id: l.lease_id }));
  const L = ins.lease?.data;

  if (!L || linking) {
    return (
      <div className="space-y-3 p-4">
        <p className="flex items-center gap-2 text-xs font-medium tracking-[0.14em] text-mute"><Link2 size={13} /> LEASE IN SAIFSYS</p>
        {!ins.saifsys ? <p className="text-sm text-mute">saifsys is not connected on this server.</p> : (
          <>
            <p className="text-sm text-mute">{L ? 'Pick the right lease.' : 'Link the lease this case is about: Reem then checks the rent owed, cheques, Ejari and notices.'}</p>
            <LeaseFinder onPick={link} autoFocus={linking} />
            {busy === 'link' && <p className="flex items-center gap-2 text-xs text-mute"><Loader2 size={12} className="animate-spin" /> Reading the lease from saifsys…</p>}
            {L && <Small onClick={() => setLinking(false)}>Cancel</Small>}
          </>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
      </div>
    );
  }

  const l = L.lease || {};
  const m = L.money || {};
  const cheques = [...(L.cheques || [])].sort((x, y) => (['bounced', 'legal_escalated'].includes(y.status) ? 1 : 0) - (['bounced', 'legal_escalated'].includes(x.status) ? 1 : 0));
  const shown = allCheques ? cheques : cheques.slice(0, 4);
  const sl = L.saifsys_legal || {};
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <p className="flex flex-1 items-center gap-2 text-xs font-medium tracking-[0.14em] text-mute"><Link2 size={13} /> LEASE IN SAIFSYS</p>
        <button onClick={() => run('refresh', () => api.get(`/legal-cases/${c.id}/insight?fresh=1`))} disabled={!!busy} title="Fetch again from saifsys" aria-label="Fetch again from saifsys" className="text-mute hover:text-txt disabled:opacity-40">
          <RefreshCw size={14} className={busy === 'refresh' ? 'animate-spin' : ''} />
        </button>
      </div>
      {ins.lease.error && <p className="flex items-start gap-1.5 text-xs text-warn"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> saifsys did not answer, so this is the copy from {when(ins.lease.fetchedAt)}.</p>}
      {error && <p className="text-xs text-bad">{error}</p>}

      <div className="space-y-1.5 text-sm">
        <p className="font-medium">{l.number || `Lease #${l.id}`} <span className="text-xs font-normal text-mute">· {words(l.status)}</span></p>
        <p className="flex items-center gap-2"><UserRound size={14} className="shrink-0 text-mute" /> {L.tenant?.name}</p>
        {(L.tenant?.phone || L.tenant?.email) && <p className="pl-6 text-xs text-mute">{[L.tenant.phone, L.tenant.email].filter(Boolean).join(' · ')}</p>}
        <p className="flex items-center gap-2"><Building2 size={14} className="shrink-0 text-mute" /> {L.building} · Unit {L.unit}{L.unit_type ? ` · ${L.unit_type}` : ''}</p>
        <p className="pl-6 text-xs text-mute">{day(l.start_date)} – {day(l.end_date)} · {aed(l.annual_rent)} a year{l.installments ? ` · ${l.installments} payments` : ''}</p>
        {l.landlord && <p className="pl-6 text-xs text-mute">Landlord: {l.landlord}</p>}
      </div>

      <div className="space-y-1 rounded-2xl border border-stroke bg-black/10 p-3">
        <p className="mb-1 flex items-center gap-1.5 text-xs text-mute"><Banknote size={13} /> Money, as of {day(m.as_of)}</p>
        <Row k="Owed in total" v={aed(m.outstanding)} tone={m.outstanding > 0 ? 'text-warn' : ''} />
        <Row k={`Overdue${m.oldest_overdue_date ? ` since ${day(m.oldest_overdue_date)}` : ''}`} v={aed(m.overdue)} tone={m.overdue > 0 ? 'text-bad' : ''} />
        {m.penalties > 0 && <Row k="Penalties" v={aed(m.penalties)} />}
        <Row k="Paid so far" v={aed(m.paid_total)} />
        <Row k={`Deposit${L.deposit?.status ? ` (${words(L.deposit.status)})` : ''}`} v={aed(L.deposit?.amount)} />
        {m.last_payment?.payment_date && <Row k="Last payment" v={`${aed(m.last_payment.amount)} · ${day(m.last_payment.payment_date)}`} />}
      </div>

      {cheques.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-mute">Cheques ({cheques.length})</p>
          <ul className="space-y-1 text-xs">
            {shown.map((q, i) => (
              <li key={`${q.number}-${i}`} className="flex items-baseline justify-between gap-2">
                <span>#{q.number || '?'} · {day(q.date)}{q.bank ? ` · ${q.bank}` : ''}</span>
                <span className={`shrink-0 tabular-nums ${CHEQUE_TONE[q.status] || 'text-mute'}`}>{aed(q.amount)} · {words(q.status)}</span>
              </li>
            ))}
          </ul>
          {cheques.length > 4 && <button onClick={() => setAllCheques(!allCheques)} className="mt-1 text-xs text-p1">{allCheques ? 'Show fewer' : `Show all ${cheques.length}`}</button>}
        </div>
      )}

      <div className="space-y-1 text-xs">
        <Row k="Ejari" v={L.ejari?.number ? `${L.ejari.number}${L.ejari.expiry_date ? ` · to ${day(L.ejari.expiry_date)}` : ''}` : 'Not recorded'} tone={L.ejari?.number ? '' : 'text-bad'} />
        {L.renewal && <Row k="Renewal in saifsys" v={words(L.renewal)} tone="text-warn" />}
        {(L.violations || []).length > 0 && <Row k="Violations / complaints" v={L.violations.length} />}
        {(L.move_out_notices || []).length > 0 && <Row k="Move-out notice" v={`${day(L.move_out_notices[0].notice_date)} → ${day(L.move_out_notices[0].move_out_date)}`} />}
        {(L.other_leases || []).length > 0 && <Row k="Tenant's other leases" v={L.other_leases.map((o) => `${o.building} ${o.unit}`).join(', ')} />}
      </div>

      {(sl.cases?.length > 0 || sl.notices?.length > 0 || sl.escalations?.length > 0) && (
        <div className="space-y-1 text-xs">
          <p className="text-mute">saifsys legal desk</p>
          {(sl.cases || []).map((x) => <p key={x.number}>{x.number} · {words(x.type)} · {words(x.status)}{x.claim ? ` · claim ${aed(x.claim)}` : ''}</p>)}
          {(sl.notices || []).map((n, i) => <p key={`n${i}`}>Notice {n.reference || ''} · {words(n.type)} · {day(n.issue_date)} · {words(n.delivery_status)}</p>)}
          {(sl.escalations || []).map((e, i) => <p key={`e${i}`}>Cheque #{e.cheque_number} {words(e.type)} · {aed(e.amount)} · {words(e.status)}</p>)}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-stroke pt-3">
        <Small onClick={() => setLinking(true)}><Link2 size={12} /> Change</Small>
        <Small busy={busy === 'unlink'} onClick={() => { if (confirm('Unlink this lease from the case?')) run('unlink', () => api.del(`/legal-cases/${c.id}/lease`)); }}><Unlink size={12} /> Unlink</Small>
        <span className="ml-auto text-[11px] text-mute">Fetched {ins.lease.fetchedAt ? when(ins.lease.fetchedAt) : '-'}</span>
      </div>
    </div>
  );
}

/** Leases in saifsys that may need a case, for the list. Fetched when opened. */
export function AtRisk({ onOpenCase, onStart }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(30);
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setList(null); setError('');
    api.get(`/legal-cases/leases/at-risk?days=${days}`).then((r) => setList(r.leases)).catch((e) => setError(e.message));
  }, [open, days]);
  return (
    <div className="rounded-2xl border border-stroke bg-white/[0.03]">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm">
        <ShieldAlert size={16} className="text-warn" />
        <span className="flex-1 font-medium">Leases that may need a case</span>
        <span className="text-xs text-mute max-sm:hidden">bounced cheques, rent overdue · from saifsys</span>
        <ChevronDown size={15} className={`text-mute transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-stroke px-4 py-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-mute">
            Rent overdue more than
            {[30, 60, 90].map((d) => (
              <button key={d} onClick={() => setDays(d)} className={`rounded-full px-2.5 py-1 ${days === d ? 'bg-p1/30 text-txt' : 'bg-white/5'}`}>{d} days</button>
            ))}
            , or a cheque bounced.
          </div>
          {error ? <p className="text-sm text-bad">{error}</p> : !list ? <p className="flex items-center gap-2 py-2 text-sm text-mute"><Loader2 size={14} className="animate-spin" /> Asking saifsys…</p>
            : list.length === 0 ? <p className="py-2 text-sm text-mute">None. Every lease is paid up to {days} days, and no cheque is bounced.</p> : (
              <ul className="divide-y divide-stroke">
                {list.map((l) => (
                  <li key={l.lease_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="truncate font-medium">{l.tenant}</p>
                      <p className="truncate text-xs text-mute">{l.building} · Unit {l.unit} · {l.lease_number || `#${l.lease_id}`} · {words(l.status)}</p>
                    </div>
                    <div className="text-xs tabular-nums">
                      {l.bounced > 0 && <p className="text-bad">{l.bounced} bounced · {aed(l.bounced_amount)}</p>}
                      {l.overdue > 0 && <p className="text-warn">{aed(l.overdue)} overdue{l.oldest_overdue_date ? ` since ${day(l.oldest_overdue_date)}` : ''}</p>}
                    </div>
                    {l.case
                      ? <Small onClick={() => onOpenCase(l.case.id)}>{l.case.number}</Small>
                      : <Small onClick={() => onStart(l)}>Open a case</Small>}
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </div>
  );
}
