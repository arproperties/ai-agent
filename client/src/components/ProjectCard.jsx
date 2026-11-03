import { useState } from 'react';
import { Loader2, Check, X, Send, Truck, PackageMinus, Users, ClipboardCheck, TrendingUp, ShieldCheck, LayoutGrid, CircleHelp, CircleCheck, BrickWall } from 'lucide-react';
import { api } from '../lib/api';

// A delivery, material given out, or a day's manpower that Reem got ready from chat for a
// building project (server/projects.js). Nothing is recorded until it is tapped here.
// A delivery has its checks: all ticked, Accept; any not, Send to manager. The manager
// decides the same card from the Projects screen (or here, if it was their own).
// Progress on a step, and a manager's sign-off of a hold point, are confirmed the same way.

const STATE = {
  pending: { label: 'Ready — check and tap', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  sent: { label: 'Waiting for the manager', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  accepted: { label: 'Accepted · in stock', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  accepted_note: { label: 'Accepted with note · in stock', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  confirmed: { label: 'Recorded', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  rejected: { label: 'Rejected', tone: 'border-bad/40 bg-bad/[0.06]', dot: 'text-bad' },
  cancelled: { label: 'Cancelled', tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute' },
};
const KIND = { delivery: ['Delivery', Truck], out: ['Material out', PackageMinus], manpower: ['Manpower', Users], count: ['Count', ClipboardCheck], progress: ['Progress', TrendingUp], signoff: ['Sign-off', ShieldCheck], area: ['Room', LayoutGrid], issue: ['Issue', CircleHelp], issue_close: ['Issue closed', CircleCheck], inspection: ['Wall check', BrickWall] };
const STEP_STATUS = { not_started: 'Not started', in_progress: 'In progress', done: 'Done', blocked: 'Blocked' };
const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.04] px-3 py-2 text-sm outline-none focus:border-p1/70';
const MAIN = 'flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-50';
const SIDE = 'flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:border-bad/60 hover:text-bad disabled:opacity-50';

export default function ProjectCard({ card: c, onChanged }) {
  const [passed, setPassed] = useState(() => (c.kind === 'inspection' ? c.data.checks.filter((x) => !c.data.failed.includes(x)) : []));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const s = STATE[c.status] || STATE.pending;
  const [kindLabel, KindIcon] = KIND[c.kind];
  const d = c.data;

  const act = async (what, body = {}) => {
    setBusy(what);
    setError(null);
    try { onChanged(await api.post(`/projects/proposals/${c.id}/${what}`, body)); } catch (e) { setError(e.message); }
    setBusy(null);
  };
  const tick = (check) => setPassed((p) => (p.includes(check) ? p.filter((x) => x !== check) : [...p, check]));
  const allPassed = c.kind === 'delivery' && d.checks.every((x) => passed.includes(x));

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <KindIcon size={13} strokeWidth={2} /> {c.project.name} · {kindLabel} · {s.label}
      </p>

      {/* A count puts the record right: what was counted against what Reem had. */}
      {c.kind === 'count' && (
        <>
          <p className="text-[15px] font-medium leading-snug">{num(d.counted)} {d.counted_in} {d.item} left</p>
          <p className="mt-0.5 text-xs text-mute">{[d.day, c.by && `by ${c.by}`].filter(Boolean).join(' · ')}</p>
          {c.status === 'pending' && (
            <p className="mt-1 text-txt/85">
              Reem had {num(c.on_site)} {d.counted_in}
              {d.counted !== c.on_site ? ` — confirming corrects it by ${d.counted > c.on_site ? '+' : '−'}${num(Math.abs(d.counted - c.on_site))}.` : ' — already right.'}
            </p>
          )}
          {d.notes && <p className="mt-1 text-txt/85">{d.notes}</p>}
        </>
      )}

      {c.kind === 'progress' && (
        <>
          <p className="text-[15px] font-medium leading-snug">{d.floor} · {d.step}</p>
          <p className={`mt-0.5 ${d.status === 'blocked' ? 'text-bad' : 'text-txt/85'}`}>
            {STEP_STATUS[d.status]}{d.status === 'in_progress' && ` ${d.percent}%`}
            <span className="text-xs text-mute"> · was {STEP_STATUS[d.was.status].toLowerCase()}{d.was.status === 'in_progress' && ` ${d.was.percent}%`}</span>
          </p>
          {d.note && <p className="mt-1 text-txt/85">{d.note}</p>}
          {d.points.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {d.points.map((pt) => <li key={pt.id} className="flex items-center gap-1.5 text-txt/85"><Check size={13} className="text-ok" /> {pt.text}</li>)}
            </ul>
          )}
          {c.status === 'pending' && d.status === 'blocked' && <p className="mt-1 text-xs text-mute">The managers get a push with the reason.</p>}
          <p className="mt-0.5 text-xs text-mute">{c.by && `by ${c.by}`}</p>
        </>
      )}

      {c.kind === 'area' && (
        <>
          <p className="text-[15px] font-medium leading-snug">{d.floor} · {d.area}</p>
          <p className="mt-0.5 text-txt/85">{d.percent === 100 ? 'Done' : `${d.percent}%`}<span className="text-xs text-mute"> · was {d.was}%</span></p>
          {d.note && <p className="mt-1 text-txt/85">{d.note}</p>}
          <p className="mt-0.5 text-xs text-mute">{c.by && `by ${c.by}`}</p>
        </>
      )}

      {c.kind === 'issue' && (
        <>
          <p className="text-[15px] font-medium leading-snug">{d.text}</p>
          <p className="mt-0.5 text-xs text-mute">{[d.floor && d.step ? `holds ${d.floor} · ${d.step}` : d.floor, d.asked && `asked: ${d.asked}`, c.by && `by ${c.by}`].filter(Boolean).join(' · ')}</p>
        </>
      )}

      {c.kind === 'issue_close' && (
        <>
          <p className="text-[15px] leading-snug text-txt/85">#{d.issue_id} {d.text}</p>
          <p className="mt-1 flex items-start gap-1.5 text-ok"><Check size={14} className="mt-0.5 shrink-0" /> {d.answer}</p>
        </>
      )}

      {c.kind === 'inspection' && (
        <>
          <p className="text-[15px] font-medium leading-snug">{[d.floor, d.area].filter(Boolean).join(' · ') || 'Wall check'}</p>
          <p className="mt-0.5 text-xs text-mute">{[d.day, c.by && `by ${c.by}`].filter(Boolean).join(' · ')}</p>
          {d.note && <p className="mt-1 text-txt/85">{d.note}</p>}
          {c.can.act ? (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-mute">Tick each check that passed (not ticked = failed, the managers get it):</p>
              {d.checks.map((check) => (
                <label key={check} className="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/[0.04]">
                  <input type="checkbox" checked={passed.includes(check)} onChange={() => tick(check)} className="mt-0.5 size-4 accent-p1" />
                  <span>{check}</span>
                </label>
              ))}
            </div>
          ) : d.failed.length > 0 && c.status === 'pending' && <p className="mt-1 text-xs text-bad">Failing: {d.failed.join('; ')}</p>}
        </>
      )}

      {c.kind === 'signoff' && (
        <>
          <p className="text-[15px] font-medium leading-snug">{d.floor} · {d.step}</p>
          <p className="mt-0.5 text-txt/85">Hold point: {d.hold_point}</p>
          {(d.signer || d.note) && <p className="mt-1 text-txt/85">{[d.signer && `Checked by ${d.signer}`, d.note].filter(Boolean).join(' · ')}</p>}
          <p className="mt-0.5 text-xs text-mute">{c.by && `by ${c.by}`}</p>
        </>
      )}

      {['delivery', 'out'].includes(c.kind) && (
        <>
          <p className="text-[15px] font-medium leading-snug">
            {c.kind === 'out' && '− '}{num(d.quantity)} {d.counted_in} {d.item}
          </p>
          <p className="mt-0.5 text-xs text-mute">
            {[d.day, d.floor, d.area, d.supplier && `from ${d.supplier}`, d.delivery_note && `DN ${d.delivery_note}`, d.party && `to ${d.party}`, c.by && `by ${c.by}`].filter(Boolean).join(' · ')}
          </p>
          {d.notes && <p className="mt-1 text-txt/85">{d.notes}</p>}
          {c.kind === 'out' && c.status === 'pending' && c.on_site < d.quantity && (
            <p className="mt-1 text-xs text-warn">Only {num(c.on_site)} {d.counted_in} on record — old stock not counted yet? Tell Reem what is left, e.g. "{d.item} left: 50".</p>
          )}
        </>
      )}

      {c.kind === 'manpower' && (
        <>
          <p className="text-[15px] font-medium leading-snug">{d.day}{d.floor && <span className="text-mute"> · {d.floor}</span>}</p>
          <ul className="mt-1 space-y-0.5">
            {d.rows.map((r, i) => (
              <li key={i} className="flex items-baseline gap-2 text-txt/85">
                <span className="w-10 shrink-0 text-right tabular-nums">{r.count}</span>
                <span>{r.trade}{r.subcontractor && <span className="text-mute"> · {r.subcontractor}</span>}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-mute">{d.rows.reduce((n, r) => n + r.count, 0)} people in all
            {c.status === 'pending' && d.replaces && ' · this day was already sent: confirming replaces it'}</p>
        </>
      )}

      {d.photos?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {d.photos.map((doc) => (
            <a key={doc} href={`/api/projects/proposals/${c.id}/photo/${doc}`} target="_blank" rel="noreferrer">
              <img src={`/api/projects/proposals/${c.id}/photo/${doc}`} alt="" loading="lazy" className="size-14 rounded-lg object-cover" />
            </a>
          ))}
        </div>
      )}

      {/* The checks: ticked by the store keeper while the card waits on her. */}
      {c.kind === 'delivery' && c.can.act && (
        <div className="mt-3 space-y-1">
          <p className="text-xs text-mute">Tick each check that is fine:</p>
          {d.checks.map((check) => (
            <label key={check} className="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 hover:bg-white/[0.04]">
              <input type="checkbox" checked={passed.includes(check)} onChange={() => tick(check)} className="size-4 accent-p1" />
              <span>{check}</span>
            </label>
          ))}
          {!allPassed && <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is wrong? (for the manager)" className={`${FIELD} mt-1`} />}
        </div>
      )}

      {/* What failed, once it has gone to the manager. */}
      {c.failed?.length > 0 && <p className="mt-2 text-xs text-bad">Failed: {c.failed.join(', ')}</p>}
      {c.note && c.status !== 'pending' && <p className="mt-1 text-xs text-txt/80">Note: {c.note}</p>}
      {c.decided_by && ['accepted_note', 'rejected'].includes(c.status) && <p className="mt-1 text-xs text-mute">Decided by {c.decided_by}</p>}

      {c.can.decide && (
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (needed to reject)" className={`${FIELD} mt-3`} />
      )}

      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      {c.can.act && c.kind === 'delivery' && (
        <div className="mt-3 flex flex-wrap gap-2">
          {allPassed ? (
            <button onClick={() => act('accept', { passed })} disabled={!!busy} className={MAIN}>
              {busy === 'accept' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Accept
            </button>
          ) : (
            <button onClick={() => act('send', { passed, note })} disabled={!!busy} className={MAIN}>
              {busy === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Send to manager
            </button>
          )}
          <button onClick={() => act('cancel')} disabled={!!busy} className={SIDE}>
            {busy === 'cancel' ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />} Cancel
          </button>
        </div>
      )}
      {c.can.act && c.kind !== 'delivery' && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => act('confirm', c.kind === 'inspection' ? { passed } : {})} disabled={!!busy} className={MAIN}>
            {busy === 'confirm' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Confirm
          </button>
          <button onClick={() => act('cancel')} disabled={!!busy} className={SIDE}>
            {busy === 'cancel' ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />} Cancel
          </button>
        </div>
      )}
      {c.can.decide && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => act('decide', { verdict: 'accept', note })} disabled={!!busy} className={MAIN}>
            {busy === 'decide' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Accept with note
          </button>
          <button onClick={() => act('decide', { verdict: 'reject', note })} disabled={!!busy || !note.trim()} className={SIDE}>
            <X size={15} /> Reject
          </button>
        </div>
      )}
    </div>
  );
}
