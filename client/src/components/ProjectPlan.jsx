import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Download, Loader2, X } from 'lucide-react';
import { api } from '../lib/api';

// A project's plan (server/projectPlans.js): what is late against it, the weekly report, the
// phases with their quality checks, materials, manpower and risks. The steps themselves are
// on the Progress tab. Everyone on the project reads it; only the master accepts new weeks.

const LABEL = 'text-[11px] font-medium tracking-[0.14em] text-mute';
const KIND = { not_started: 'Not started', not_finished: 'Running over', material: 'Material', unsigned: 'Hold point', blocked: 'Blocked' };
const weeks = ([a, b]) => (a === b ? `wk ${a}` : `wk ${a}-${b}`);
const when = (at) => new Date(Number(at) * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });

function Alert({ a, canDecide, onDecided }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const decide = async (what) => {
    setBusy(what); setError('');
    try { onDecided(await api.post(`/plans/alerts/${a.id}/${what}`)); } catch (e) { setError(e.message); }
    setBusy(null);
  };
  return (
    <div className="px-4 py-3 text-sm">
      <p className="text-xs text-mute">{KIND[a.kind]} · {when(a.created_at)}</p>
      <p className="mt-0.5 leading-snug">{a.text}</p>
      {a.change?.length > 0 && (
        <div className="mt-1.5 text-xs">
          <p className="text-mute">{a.status === 'open' ? 'Reem suggests moving:' : 'Moving:'}</p>
          <ul className="mt-0.5 space-y-0.5">{a.change.map((c) => <li key={c.step_id}>{c.name}: {weeks(c.from)} → {weeks(c.to)}</li>)}</ul>
        </div>
      )}
      {a.status !== 'open' && <p className={`mt-1 text-xs ${a.status === 'accepted' ? 'text-ok' : 'text-mute'}`}>{a.status === 'accepted' ? 'Accepted' : 'Left as planned'}{a.decided_by && ` by ${a.decided_by}`}</p>}
      {a.status === 'open' && canDecide && (
        <div className="mt-2 flex gap-2">
          {a.change?.length > 0 && (
            <button onClick={() => decide('accept')} disabled={!!busy} className="flex items-center gap-1 rounded-full bg-p1/30 px-3 py-1 text-xs text-txt disabled:opacity-50">
              {busy === 'accept' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Accept new weeks
            </button>
          )}
          <button onClick={() => decide('decline')} disabled={!!busy} className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-xs text-mute hover:text-txt disabled:opacity-50">
            {busy === 'decline' ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} {a.change?.length ? 'Keep the plan' : 'Seen'}
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

export default function ProjectPlan({ id }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get(`/plans/project/${id}`).then(setR).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  if (error && !r) return <p className="py-10 text-center text-bad">{error}</p>;
  if (!r) return <Loader2 className="mx-auto mt-10 animate-spin text-mute" />;
  if (!r.plan) {
    return (
      <p className="py-10 text-center text-mute">
        No plan yet. {r.role === 'master' ? 'In a chat, attach the project file (one drawing set, PDF or DWG) and ask Reem to make the full plan.' : 'The master makes it from the project file.'}
      </p>
    );
  }
  const p = r.plan;
  const open = r.alerts.filter((a) => a.status === 'open');
  const done = r.alerts.filter((a) => a.status !== 'open');

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <p className="text-sm leading-snug">{p.summary}</p>
        <p className="text-xs text-mute">From {p.file_name} · start {p.start_day} · {p.weeks} weeks</p>
        <a href={`/api/plans/${p.id}/pdf`} className="inline-flex items-center gap-1.5 rounded-full border border-stroke px-3 py-1 text-xs text-mute hover:text-txt"><Download size={13} /> The full plan (PDF)</a>
      </div>

      <div className="space-y-1.5">
        <p className={LABEL}>BEHIND THE PLAN</p>
        {open.length ? (
          <div className="glass divide-y divide-stroke/60 rounded-2xl">
            {open.map((a) => <Alert key={a.id} a={a} canDecide={r.can_decide} onDecided={setR} />)}
          </div>
        ) : <p className="flex items-center gap-1.5 text-sm text-ok"><Check size={14} /> Nothing late. Reem checks every morning.</p>}
      </div>

      {p.report && (
        <div className="space-y-1.5">
          <p className={LABEL}>THIS WEEK{p.report_on && ` · ${p.report_on}`}</p>
          <p className="glass whitespace-pre-line rounded-2xl px-4 py-3 text-sm">{p.report}</p>
        </div>
      )}

      {p.problems.length > 0 && (
        <div className="rounded-2xl border border-warn/40 px-4 py-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-warn"><AlertTriangle size={14} /> Still to look at</p>
          <ul className="mt-1 list-disc pl-5 text-xs">{p.problems.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}

      <div className="space-y-1.5">
        <p className={LABEL}>PHASES AND QUALITY CHECKS</p>
        <div className="glass divide-y divide-stroke/60 rounded-2xl">
          {p.phases.map((ph, i) => (
            <div key={i} className="px-4 py-3 text-sm">
              <p className="font-medium">{i + 1}. {ph.name}</p>
              <p className="text-xs text-mute">{ph.goal}</p>
              {ph.checks.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs">{ph.checks.map((c, j) => <li key={j}>{c}</li>)}</ul>}
            </div>
          ))}
        </div>
      </div>

      {p.materials.length > 0 && (
        <div className="space-y-1.5">
          <p className={LABEL}>MATERIALS</p>
          <div className="glass divide-y divide-stroke/60 rounded-2xl text-sm">
            {p.materials.map((m, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block">{m.item}</span>
                  <span className="text-xs text-mute">{[m.quantity && `${m.quantity.toLocaleString()} ${m.counted_in || ''}`, m.floor].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="text-right text-xs text-mute">order by wk {m.order_by_week}<br />needed wk {m.needed_week}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {p.manpower.length > 0 && (
        <div className="space-y-1.5">
          <p className={LABEL}>MANPOWER</p>
          <div className="glass divide-y divide-stroke/60 rounded-2xl text-sm">
            {p.manpower.map((m, i) => (
              <div key={i} className="flex justify-between px-4 py-2"><span>{m.count} {m.trade}</span><span className="text-xs text-mute">{weeks([m.week_from, m.week_to])}</span></div>
            ))}
          </div>
        </div>
      )}

      {p.risks.length > 0 && (
        <div className="space-y-1.5">
          <p className={LABEL}>RISKS</p>
          <div className="glass divide-y divide-stroke/60 rounded-2xl text-sm">
            {p.risks.map((x, i) => (
              <div key={i} className="px-4 py-2.5"><p>{x.risk}</p><p className="text-xs text-mute">{x.owner} · {x.action}</p></div>
            ))}
          </div>
        </div>
      )}

      {done.length > 0 && (
        <details className="text-sm">
          <summary className={`${LABEL} cursor-pointer`}>DECIDED ({done.length})</summary>
          <div className="glass mt-1.5 divide-y divide-stroke/60 rounded-2xl">{done.map((a) => <Alert key={a.id} a={a} canDecide={false} onDecided={setR} />)}</div>
        </details>
      )}
    </div>
  );
}
