import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Plus, X } from 'lucide-react';
import { api } from '../lib/api';

// Issues on a project (server/projectIssues.js): questions for the consultant and problems
// holding work up, open until a manager closes them with the answer; and the latest wall
// checks with what failed. Both are usually raised in chat; here they can be added and
// closed too.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const LABEL = 'text-[11px] font-medium tracking-[0.14em] text-mute';
const when = (at) => new Date(Number(at) * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });
const date = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

function Issue({ i, manager, onChanged }) {
  const [closing, setClosing] = useState(false);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const close = async () => {
    setError('');
    try { onChanged(await api.post(`/projects/issues/${i.id}/close`, { answer })); } catch (e) { setError(e.message); }
  };
  return (
    <div className="px-4 py-3 text-sm">
      <p className="text-[15px] leading-snug">{i.text}</p>
      <p className="mt-0.5 text-xs text-mute">
        {[`#${i.id}`, i.floor && i.step ? `${i.floor} · ${i.step}` : i.floor, i.asked && `asked: ${i.asked}`, i.opened_by && `by ${i.opened_by}`, when(i.opened_at)].filter(Boolean).join(' · ')}
      </p>
      {i.status === 'closed' && (
        <p className="mt-1 flex items-start gap-1.5 text-ok"><Check size={14} className="mt-0.5 shrink-0" />
          <span>{i.answer}<span className="text-xs text-mute">{i.closed_by && ` · ${i.closed_by}`}{i.closed_at && ` · ${when(i.closed_at)}`}</span></span>
        </p>
      )}
      {i.status === 'open' && manager && (closing ? (
        <div className="mt-2 flex gap-2">
          <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="The answer, or what settled it" className={`${FIELD} py-1.5 text-sm`} />
          <button onClick={close} disabled={!answer.trim()} className="rounded-full bg-p1/30 px-3 text-sm text-txt disabled:opacity-50">Close</button>
          <button onClick={() => setClosing(false)} aria-label="Cancel" className="px-1 text-mute"><X size={15} /></button>
        </div>
      ) : (
        <button onClick={() => setClosing(true)} className="mt-2 rounded-full border border-stroke px-3 py-1 text-xs text-mute hover:text-txt">Close with the answer</button>
      ))}
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

export default function ProjectIssues({ id }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [asked, setAsked] = useState('');
  const load = useCallback(() => api.get(`/projects/${id}/issues`).then(setR).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  if (error && !r) return <p className="py-10 text-center text-bad">{error}</p>;
  if (!r) return <Loader2 className="mx-auto mt-10 animate-spin text-mute" />;
  const manager = ['manager', 'master'].includes(r.role);
  const open = r.issues.filter((i) => i.status === 'open');
  const closed = r.issues.filter((i) => i.status === 'closed');
  const add = async () => {
    setError('');
    try { setR(await api.post(`/projects/${id}/issues`, { text, asked })); setAdding(false); setText(''); setAsked(''); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-mute">Raise one in chat, e.g. "ask the consultant the pool level", or here.</p>
      {adding ? (
        <div className="glass space-y-2 rounded-2xl p-4">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="What is the question or problem?" className={FIELD} />
          <input value={asked} onChange={(e) => setAsked(e.target.value)} placeholder="Asked whom? (optional)" className={FIELD} />
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex gap-2">
            <button onClick={add} disabled={!text.trim()} className="flex-1 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 font-medium text-white disabled:opacity-50">Add</button>
            <button onClick={() => setAdding(false)} className="rounded-full border border-stroke px-5 py-2 text-mute">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt"><Plus size={15} /> Add an issue</button>
      )}

      <p className={LABEL}>OPEN ({open.length})</p>
      {!open.length ? <p className="text-sm text-mute">Nothing open.</p> : (
        <div className="glass divide-y divide-stroke/60 rounded-2xl">{open.map((i) => <Issue key={i.id} i={i} manager={manager} onChanged={setR} />)}</div>
      )}

      {closed.length > 0 && (
        <>
          <p className={`${LABEL} pt-2`}>CLOSED</p>
          <div className="glass divide-y divide-stroke/60 rounded-2xl">{closed.map((i) => <Issue key={i.id} i={i} manager={manager} onChanged={setR} />)}</div>
        </>
      )}

      <p className={`${LABEL} pt-2`}>WALL CHECKS</p>
      {!r.checks.length ? <p className="text-sm text-mute">None yet. After walking the walls, tell Reem, e.g. "checked the pump room, all fine".</p> : (
        <div className="glass divide-y divide-stroke/60 rounded-2xl">
          {r.checks.map((k) => (
            <div key={k.id} className="px-4 py-2.5 text-sm">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1">{[k.floor, k.area].filter(Boolean).join(' · ') || 'Site'}</span>
                <span className={`text-xs ${k.failed.length ? 'text-bad' : 'text-ok'}`}>{k.failed.length ? `${k.failed.length} failed` : 'All passed'}</span>
              </div>
              <p className="text-xs text-mute">{[date(k.day), k.by_name].filter(Boolean).join(' · ')}</p>
              {k.failed.length > 0 && <p className="mt-0.5 text-xs text-bad">{k.failed.join(' · ')}</p>}
              {k.note && <p className="mt-0.5 text-xs text-txt/80">{k.note}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
