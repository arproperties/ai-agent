import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, ClipboardList, Download, Loader2, RotateCcw, X } from 'lucide-react';
import { api } from '../lib/api';

// A project plan being made from one file (server/projectPlans.js). The reading and the
// writing run in the background, so the card asks the server how far it is while it works.
// The questions come one at a time on the card: type an answer and tap Next, or "I don't
// know" to leave it to Reem. Each answer is saved as it is given (no AI), so the master can
// close the app and carry on. Answering in the chat still works too.

const STATE = {
  reading: { tone: 'border-p1/40 bg-p1/[0.06]', dot: 'text-p1', label: 'Reading the file' },
  asking: { tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn', label: 'Questions for you' },
  planning: { tone: 'border-p1/40 bg-p1/[0.06]', dot: 'text-p1', label: 'Writing the plan' },
  planned: { tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn', label: 'The plan is ready' },
  started: { tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok', label: 'Started' },
  cancelled: { tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute', label: 'Cancelled' },
  failed: { tone: 'border-bad/40 bg-bad/[0.06]', dot: 'text-bad', label: 'Stopped' },
};
const LABEL = 'text-[11px] font-medium tracking-[0.14em] text-mute';
const working = (s) => s === 'reading' || s === 'planning';

// The questions, one at a time, then a short list of the answers and Make the plan.
function OneAtATime({ p, onChanged, busy, setBusy, setError }) {
  const qs = p.questions;
  const given = p.card_answers || [];
  // Pick up at the first question not reached yet; all reached = the summary.
  const firstOpen = () => { const i = given.findIndex((a) => a === null || a === undefined); return i === -1 ? qs.length : i; };
  const [at, setAt] = useState(firstOpen);
  const [text, setText] = useState(given[at] || '');
  const box = useRef(null);

  useEffect(() => { setText(given[at] || ''); }, [at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (at < qs.length) box.current?.focus({ preventScroll: true }); }, [at, qs.length]);

  const post = async (what, path, body) => {
    setBusy(what);
    setError(null);
    try { const u = await api.post(`/plans/${p.id}/${path}`, body); onChanged(u); return u; } catch (e) { setError(e.message); return null; } finally { setBusy(null); }
  };
  const save = async (answer) => { if (await post('next', 'answer', { index: at, answer })) setAt(at + 1); };
  const makePlan = () => post('plan', 'plan');

  if (!qs.length) {
    return (
      <div className="mt-3">
        <p className="text-mute">Nothing to ask.</p>
        <MakeButton busy={busy} onClick={makePlan} />
      </div>
    );
  }

  if (at >= qs.length) {
    return (
      <div className="mt-3">
        <p className={LABEL}>YOUR ANSWERS</p>
        <ol className="mt-1 space-y-1.5">
          {qs.map((q, i) => (
            <li key={i}>
              <button onClick={() => setAt(i)} className="w-full text-left hover:opacity-80">
                <span className="block text-xs text-mute">{i + 1}. {q}</span>
                <span className={given[i] ? '' : 'italic text-mute'}>{given[i] || "I don't know: Reem plans it the usual way"}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="mt-1.5 text-xs text-mute">Tap an answer to change it.</p>
        <MakeButton busy={busy} onClick={makePlan} />
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between">
        <p className={LABEL}>QUESTION {at + 1} OF {qs.length}</p>
        <button onClick={makePlan} disabled={!!busy} className="text-xs text-p1 hover:underline disabled:opacity-60">Make the plan now</button>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-stroke/60">
        <div className="h-full rounded-full bg-p1 transition-all" style={{ width: `${(at / qs.length) * 100}%` }} />
      </div>
      <p className="mt-2.5 text-[15px] leading-snug">{qs[at]}</p>
      <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1000}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && text.trim()) { e.preventDefault(); save(text); } }}
        placeholder="Type your answer…"
        className="glass mt-2 w-full resize-none rounded-xl px-3 py-2 text-sm outline-none focus:border-p1/60" />
      <div className="mt-2 flex flex-wrap gap-2">
        {at > 0 && (
          <button onClick={() => setAt(at - 1)} disabled={!!busy}
            className="flex items-center gap-1 rounded-full border border-stroke px-3.5 py-2 text-sm text-mute hover:text-txt disabled:opacity-60">
            <ChevronLeft size={15} /> Back
          </button>
        )}
        <button onClick={() => save('')} disabled={!!busy}
          className="rounded-full border border-stroke px-3.5 py-2 text-sm text-mute hover:text-txt disabled:opacity-60">
          I don't know
        </button>
        <button onClick={() => save(text)} disabled={!!busy || !text.trim()}
          className="flex flex-1 items-center justify-center gap-1 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-50">
          {busy === 'next' ? <Loader2 size={15} className="animate-spin" /> : null} Next <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

function MakeButton({ busy, onClick }) {
  return (
    <button onClick={onClick} disabled={!!busy}
      className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
      {busy === 'plan' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Make the plan
    </button>
  );
}

export default function PlanCard({ plan: p, onChanged, onOpenProject }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const s = STATE[p.status] || STATE.reading;
  const changed = useRef(onChanged);
  changed.current = onChanged;

  // Follow the background work until it needs the master or is done.
  useEffect(() => {
    if (!working(p.status)) return undefined;
    const t = setInterval(() => api.get(`/plans/${p.id}`).then((u) => { if (u.status !== p.status || u.working !== p.working) changed.current(u); }).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [p.id, p.status, p.working]);

  const act = async (what) => {
    setBusy(what);
    setError(null);
    try { onChanged(await api.post(`/plans/${p.id}/${what}`)); } catch (e) { setError(e.message); }
    setBusy(null);
  };

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-1.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <ClipboardList size={13} strokeWidth={2} /> Project plan · {s.label}
      </p>
      <p className="text-[15px] font-medium">{p.project?.name || p.name || p.file.name}</p>
      <p className="text-xs text-mute">
        From {p.file.name}{p.project ? '' : ' · a new project'} · ${p.spent.toFixed(2)} of ${p.spend_limit.toFixed(2)}
      </p>

      {working(p.status) && (
        <p className="mt-2.5 flex items-center gap-2 text-mute"><Loader2 size={14} className="animate-spin" /> {p.working || 'Working…'}</p>
      )}
      {p.summary && <p className="mt-2.5 leading-snug">{p.summary}</p>}

      {p.status === 'asking' && (
        <>
          {p.facts.length > 0 && (
            <details className="mt-2.5">
              <summary className="cursor-pointer text-xs text-mute">What Reem read in the file ({p.facts.length})</summary>
              <ul className="mt-1.5 space-y-0.5 text-xs">{p.facts.map((f, i) => <li key={i}><span className="text-mute">{f.label}:</span> {f.value}</li>)}</ul>
            </details>
          )}
          <OneAtATime p={p} onChanged={onChanged} busy={busy} setBusy={setBusy} setError={setError} />
        </>
      )}

      {p.plan && ['planned', 'started'].includes(p.status) && (
        <div className="mt-2.5 space-y-2">
          <p className="text-xs text-mute">
            Start {p.plan.start_day} · {p.plan.weeks} weeks · {p.plan.counts.steps} steps · {p.plan.counts.holds} hold points · {p.plan.counts.materials} materials · {p.plan.counts.trades} trades · {p.plan.counts.risks} risks
          </p>
          <button onClick={() => setOpen((o) => !o)} className="text-xs text-p1 hover:underline">{open ? 'Hide the phases' : 'See the phases and floors'}</button>
          {open && (
            <div className="space-y-2">
              {p.plan.phases.map((ph, i) => (
                <div key={i}>
                  <p className="font-medium">{i + 1}. {ph.name}</p>
                  <p className="text-xs text-mute">{ph.goal}</p>
                  {ph.checks.length > 0 && <ul className="mt-0.5 list-disc pl-5 text-xs">{ph.checks.map((c, j) => <li key={j}>{c}</li>)}</ul>}
                </div>
              ))}
              <div className="glass divide-y divide-stroke/60 rounded-xl text-xs">
                {p.plan.floors.map((f) => (
                  <div key={f.name} className="flex justify-between px-3 py-1.5"><span>{f.name}</span><span className="text-mute">{f.steps} steps · weeks {f.weeks[0]}-{f.weeks[1]}</span></div>
                ))}
              </div>
            </div>
          )}
          {p.problems.length > 0 && (
            <div className="rounded-xl border border-warn/40 p-2.5 text-xs">
              <p className="font-medium text-warn">Still to look at</p>
              <ul className="mt-1 list-disc pl-4">{p.problems.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
          {p.status === 'planned' && <p className="text-xs text-mute">To change something, say it in the chat. Start puts the steps into {p.project?.name || 'a new project'}; nothing already recorded there is removed.</p>}
        </div>
      )}

      {p.status === 'started' && (
        <p className="mt-2 text-xs text-ok">
          The steps are in {p.project?.name}'s Progress. {p.merged && `${p.merged.added} added, ${p.merged.updated} given their weeks. `}
          Reem checks the site against it every morning.
        </p>
      )}
      {p.error && p.status !== 'cancelled' && <p className="mt-2.5 text-xs text-bad">{p.error}</p>}
      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {p.can.start && (
          <button onClick={() => act('start')} disabled={!!busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
            {busy === 'start' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Start
          </button>
        )}
        {p.can.retry && (
          <button onClick={() => act('retry')} disabled={!!busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-stroke py-2 text-sm text-txt disabled:opacity-60">
            {busy === 'retry' ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={14} />} Try again
          </button>
        )}
        {p.plan && ['planned', 'started'].includes(p.status) && (
          <a href={`/api/plans/${p.id}/pdf`} className="flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt">
            <Download size={14} /> PDF
          </a>
        )}
        {p.status === 'started' && p.project && onOpenProject && (
          <button onClick={() => onOpenProject(p.project.id)} className="rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt">Open project</button>
        )}
        {p.can.cancel && (
          <button onClick={() => act('cancel')} disabled={!!busy}
            className="flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:border-bad/60 hover:text-bad disabled:opacity-60">
            {busy === 'cancel' ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />} Cancel
          </button>
        )}
      </div>
    </div>
  );
}
