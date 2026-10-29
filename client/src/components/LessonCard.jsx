import { useEffect, useState } from 'react';
import { Loader2, Check, X, Pencil, Lightbulb } from 'lucide-react';
import { api } from '../lib/api';

// A rule Reem wrote from the master's correction, waiting on Approve (server/lessons.js).
// Nothing changes until Approve; then the agent (or every agent) follows it in every chat,
// with anyone. The screens say Rule, never Lesson.

const STATE = {
  pending: { tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  approved: { tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  declined: { tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute' },
};

let agentsOnce = null; // one list for every card in the chat
const loadAgents = () => (agentsOnce ??= api.get('/agents').catch(() => { agentsOnce = null; return []; }));

export default function LessonCard({ proposal: p, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [rule, setRule] = useState(p.rule);
  const [scope, setScope] = useState(p.agent_id === null ? '' : String(p.agent_id));
  const [replace, setReplace] = useState(true);
  const [agents, setAgents] = useState([]);
  const s = STATE[p.status] || STATE.pending;
  const pending = p.status === 'pending';

  useEffect(() => { if (pending) loadAgents().then(setAgents); }, [pending]);

  const act = async (what) => {
    setBusy(what);
    setError(null);
    try {
      const body = what === 'approve'
        ? { agent_id: scope === '' ? null : Number(scope), replace, ...(editing || rule !== p.rule ? { rule } : {}) }
        : undefined;
      onChanged(await api.post(`/lessons/proposals/${p.id}/${what}`, body));
      setEditing(false);
    } catch (e) { setError(e.message); }
    setBusy(null);
  };

  if (!pending) {
    return (
      <div className={`rounded-2xl border px-3.5 py-2.5 text-sm ${s.tone}`}>
        <p className={`flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
          <Lightbulb size={13} strokeWidth={2} />
          {p.status === 'approved' ? `Rule added for ${p.agent_name || 'All agents'}` : 'Not added'}
        </p>
        <p className={`mt-1 ${p.status === 'declined' ? 'line-through opacity-70' : ''}`}>{p.rule}</p>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <Lightbulb size={13} strokeWidth={2} /> Learn this?
      </p>
      {editing
        ? <textarea value={rule} onChange={(e) => setRule(e.target.value)} rows={2} maxLength={300} autoFocus
            className="w-full resize-none rounded-xl border border-stroke bg-white/5 px-3 py-2 text-[15px] outline-none focus:border-p1/60" />
        : <p className="text-[15px] font-medium">“{rule}”</p>}

      <label className="mt-3 flex items-center gap-2 text-xs text-mute">
        For:
        <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={!!busy}
          className="rounded-lg border border-stroke bg-white/5 px-2 py-1 text-sm text-txt outline-none">
          {/* The card's own agent first, even before the list has loaded */}
          {p.agent_id !== null && !agents.some((a) => a.id === p.agent_id) && <option value={String(p.agent_id)}>{p.agent_name}</option>}
          {agents.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
          <option value="">All agents</option>
        </select>
      </label>

      {p.replaces_rule && (
        <div className="mt-2.5 rounded-xl border border-stroke bg-white/[0.03] p-2.5 text-xs">
          <p className="text-mute">Clashes with the rule: <span className="text-txt">“{p.replaces_rule}”</span></p>
          <label className="mt-1.5 flex items-center gap-2">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace it
          </label>
        </div>
      )}

      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      <div className="mt-3 flex gap-2">
        <button onClick={() => act('approve')} disabled={!!busy || !rule.trim()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
          {busy === 'approve' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Approve
        </button>
        {!editing && (
          <button onClick={() => setEditing(true)} disabled={!!busy}
            className="flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt disabled:opacity-60">
            <Pencil size={14} /> Edit
          </button>
        )}
        <button onClick={() => act('decline')} disabled={!!busy}
          className="flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:border-bad/60 hover:text-bad disabled:opacity-60">
          {busy === 'decline' ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />} No
        </button>
      </div>
    </div>
  );
}
