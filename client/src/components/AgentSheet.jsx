import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Check, ChevronDown, MessageSquare, Plus, Scale, Sparkles } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Sheet from './Sheet';
import Picker from './Picker';
import { FilesPanel } from './Knowledge';
import Avatar, { AGENT_ICONS, AGENT_COLORS } from './Avatar';

const field = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const label = 'mb-1.5 block text-xs font-medium tracking-wide text-mute';

/**
 * What an agent looks like to someone who was given it rather than made it: its name,
 * what it is for, and nothing to press. Every control in the editable version is
 * refused by the server for a non-master, so offering them would only ever produce an
 * error - and the persona is master-authored configuration they are not shown anyway.
 */
function PersonaReadOnly({ agent }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Avatar icon={agent.icon} color={agent.color} size={48} />
        <div className="min-w-0">
          <p className="truncate text-lg font-light">{agent.name}</p>
          <p className="text-xs text-mute">One of your agents</p>
        </div>
      </div>
      {agent.starters?.length > 0 && (
        <div>
          <span className={label}>THINGS TO ASK IT</span>
          <ul className="space-y-1.5">
            {agent.starters.map((q) => (
              <li key={q} className="rounded-xl bg-white/5 px-3 py-2 text-sm text-txt/85">{q}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-mute">Agents are set up for you. Ask whoever runs this workspace if you need a change.</p>
    </div>
  );
}

function Toggle({ on, onClick, title, children }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition ${on ? 'border-p1/50 bg-p1/10' : 'border-stroke bg-white/[0.03] hover:bg-white/[0.06]'}`}>
      <span className={`mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-md transition ${on ? 'bg-gradient-to-br from-p1 to-p2 text-white' : 'border border-white/20'}`}>
        {on && <Check size={12} strokeWidth={3.5} />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs leading-relaxed text-mute">{children}</span>
      </span>
    </button>
  );
}

const hours = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.round(s / 60)}m`);
const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const ago = (t) => (t ? new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

/**
 * The case brief (server/caseBrief.js): what earlier chats on the case settled, handed to every
 * new chat on it. Reem only suggests; it goes into the brief when the person approves it,
 * as it is or edited.
 */
function CaseBrief({ c, onChange }) {
  const [editing, setEditing] = useState(null); // 'brief' | 'suggestion' | null
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { brief, suggestion } = c;
  const call = async (p) => {
    setBusy(true); setError('');
    try { onChange(await p); setEditing(null); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const base = `/case-focus/brief/${encodeURIComponent(c.key)}`;
  const edit = (what, body) => { setText(body || ''); setEditing(what); };
  const btn = 'rounded-full px-3 py-1 text-xs transition disabled:opacity-50';

  return (
    <div className="space-y-2 border-t border-stroke/60 p-3">
      {suggestion && editing !== 'suggestion' && (
        <div className="rounded-xl border border-p1/40 bg-p1/10 p-3">
          <p className="mb-1.5 text-xs font-medium tracking-wide text-p1">SUGGESTED UPDATE TO THE BRIEF</p>
          <div className="md text-sm"><Markdown remarkPlugins={[remarkGfm]}>{suggestion.body}</Markdown></div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => call(api.post(`${base}/suggestions/${suggestion.id}/approve`, {}))}
              className={`${btn} bg-gradient-to-br from-p1 to-p2 text-white`}>Approve</button>
            <button type="button" disabled={busy} onClick={() => edit('suggestion', suggestion.body)} className={`${btn} bg-white/10 hover:bg-white/15`}>Edit</button>
            <button type="button" disabled={busy} onClick={() => call(api.post(`${base}/suggestions/${suggestion.id}/dismiss`, {}))}
              className={`${btn} text-mute hover:bg-white/10`}>Dismiss</button>
          </div>
        </div>
      )}
      {editing ? (
        <div className="space-y-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} className={`${field} resize-y text-sm leading-relaxed`} />
          <div className="flex gap-2">
            <button type="button" disabled={busy}
              onClick={() => call(editing === 'suggestion'
                ? api.post(`${base}/suggestions/${suggestion.id}/approve`, { body: text })
                : api.put(base, { number: c.number, body: text }))}
              className={`${btn} bg-gradient-to-br from-p1 to-p2 text-white`}>{editing === 'suggestion' ? 'Approve' : 'Save'}</button>
            <button type="button" disabled={busy} onClick={() => setEditing(null)} className={`${btn} text-mute hover:bg-white/10`}>Cancel</button>
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium tracking-wide text-mute">CASE BRIEF</span>
            <button type="button" onClick={() => edit('brief', brief?.body)} className="text-xs text-p1 hover:underline">{brief ? 'Edit' : 'Write'}</button>
          </div>
          {brief
            ? <div className="md text-sm text-txt/90"><Markdown remarkPlugins={[remarkGfm]}>{brief.body}</Markdown></div>
            : <p className="text-xs text-mute">No brief yet. After a chat on this case, Reem suggests one here for you to approve. New chats on the case start from it.</p>}
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}

/**
 * The cases this person has worked on with the case agent (server/caseFocus.js agentCases):
 * what they open the agent to see. A case opens to its chats; one tap goes back into one.
 */
function CasesTab({ agent, onOpenChat }) {
  const [cases, setCases] = useState(null);
  const [open, setOpen] = useState(null); // the case key shown with its chats
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/case-focus/agent/${agent.id}/cases`).then(setCases).catch((e) => { setError(e.message); setCases([]); });
  }, [agent.id]);

  if (!cases) return <p className="text-sm text-mute">Loading cases…</p>;
  return (
    <div className="space-y-3">
      <button type="button" onClick={() => onOpenChat(null, `@${agent.name} `)}
        className="flex w-full items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white">
        <Plus size={15} /> New case chat
      </button>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!cases.length && !error && (
        <p className="text-sm text-mute">No cases yet. Start a chat and name the case number, or attach its file, and it will appear here.</p>
      )}
      {cases.map((c) => (
        <div key={c.key} className="rounded-2xl border border-stroke bg-white/[0.03]">
          <button type="button" onClick={() => setOpen(open === c.key ? null : c.key)} className="w-full p-3 text-left">
            <div className="flex items-center gap-2">
              <Scale size={15} className="shrink-0 text-p1" />
              <span className="font-medium">{c.number}</span>
              <ChevronDown size={14} className={`ml-auto shrink-0 text-mute transition ${open === c.key ? 'rotate-180' : ''}`} />
            </div>
            {(c.partyA || c.partyB || c.title) && (
              <p className="mt-1 text-sm text-txt/85">{c.partyA || c.partyB ? `${c.partyA || '?'} vs ${c.partyB || '?'}` : c.title}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-mute">
              <span>{c.chats.length} {c.chats.length === 1 ? 'chat' : 'chats'}</span>
              <span>{c.files} {c.files === 1 ? 'file' : 'files'}</span>
              {c.seconds > 0 && <span>{hours(c.seconds)} spent</span>}
              {c.next && <span className="text-p1">Next: {c.next.what} · {day(c.next.due)}</span>}
              {c.suggestion && <span className="text-p1">Brief update waiting</span>}
            </div>
          </button>
          {open === c.key && (
            <CaseBrief c={c} onChange={(b) => setCases((all) => all.map((x) => (x.key === c.key ? { ...x, ...b } : x)))} />
          )}
          {open === c.key && (
            <div className="rise space-y-1 border-t border-stroke/60 p-2">
              {c.chats.map((ch) => (
                <button type="button" key={ch.id} onClick={() => onOpenChat(ch.id)}
                  className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm hover:bg-white/5">
                  <MessageSquare size={14} className="shrink-0 text-mute" />
                  <span className="min-w-0 flex-1 truncate">{ch.title}</span>
                  <span className="shrink-0 text-xs text-mute">{ago(ch.updated_at)}</span>
                </button>
              ))}
              <button type="button" onClick={() => onOpenChat(null, `Case ${c.number}: `)}
                className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm text-p1 hover:bg-p1/10">
                <Plus size={14} /> New chat on this case
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PersonaTab({ agent, config, onSaved }) {
  const [f, setF] = useState({
    name: agent.name || '', icon: agent.icon || 'sparkles', color: agent.color || 'violet', persona: agent.persona || '',
    model: agent.model || config.models[0]?.id, voice: agent.voice || 'alloy',
    starters: (agent.starters || []).join('\n'),
    private: !!agent.private,
    handles_cases: !!agent.handles_cases,
  });
  const [picker, setPicker] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(''); // '' | 'draft' | 'save'
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const draft = async () => {
    setBusy('draft'); setError('');
    try {
      const d = await api.post('/agents/draft', { name: f.name, persona: f.persona });
      setF({ ...f, ...d, starters: d.starters.join('\n') });
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy('save');
    const body = { ...f, starters: f.starters.split('\n').map((s) => s.trim()).filter(Boolean) };
    try {
      onSaved(agent.id ? await api.put(`/agents/${agent.id}`, body) : await api.post('/agents', body));
    } catch (err) { setError(err.message); setBusy(''); }
  };
  const remove = async () => {
    if (!confirm(`Delete ${agent.name} and its files?`)) return;
    try {
      await api.del(`/agents/${agent.id}`);
      onSaved(null, true);
    } catch (e) { setError(e.message); }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setPicker(!picker)} aria-label="Change icon" title="Change icon" className="relative shrink-0">
          <Avatar icon={f.icon} color={f.color} size={48} />
          <span className="absolute -bottom-0.5 -right-0.5 grid size-5 place-items-center rounded-full border-2 border-surface bg-hi/90 text-surface">
            <ChevronDown size={12} strokeWidth={2.5} />
          </span>
        </button>
        <input value={f.name} onChange={set('name')} required placeholder="Agent name, e.g. Marketing Pro" className={field} />
      </div>

      {picker && (
        <div className="rise rounded-2xl border border-stroke bg-white/[0.03] p-2">
          <div className="grid grid-cols-8 gap-1">
            {Object.entries(AGENT_ICONS).map(([k, Cmp]) => (
              <button type="button" key={k} onClick={() => setF({ ...f, icon: k })} aria-label={k}
                className={`grid aspect-square place-items-center rounded-xl transition ${f.icon === k ? 'bg-white/15 text-hi ring-1 ring-p1/70' : 'text-mute hover:bg-white/10 hover:text-txt'}`}>
                <Cmp size={17} strokeWidth={1.75} />
              </button>
            ))}
          </div>
          <div className="mt-2 flex justify-center gap-2.5 border-t border-stroke/60 pt-2.5">
            {Object.entries(AGENT_COLORS).map(([k, cls]) => (
              <button type="button" key={k} onClick={() => setF({ ...f, color: k })} aria-label={`${k} colour`}
                className={`size-6 rounded-full bg-gradient-to-br transition ${cls} ${f.color === k ? 'ring-2 ring-white ring-offset-2 ring-offset-surface' : 'opacity-70 hover:opacity-100'}`} />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium tracking-wide text-mute">WHAT DOES IT DO?</span>
          <button type="button" onClick={draft} disabled={!!busy}
            className="flex items-center gap-1.5 rounded-full bg-p1/15 px-3 py-1 text-xs text-p1 transition hover:bg-p1/25 disabled:opacity-50">
            <Sparkles size={13} /> {busy === 'draft' ? 'Writing…' : f.persona.length > 150 ? 'Improve' : 'Write it for me'}
          </button>
        </div>
        <textarea value={f.persona} onChange={set('persona')} rows={4}
          placeholder="One line is enough, e.g. “Helps me with Instagram marketing for my real estate company”. Then tap Write it for me."
          className={`${field} resize-none leading-relaxed`} />
      </div>

      <Toggle on={f.private} onClick={() => setF({ ...f, private: !f.private })} title="Private agent">
        Only the people you tick it for in People can use it. Nobody else sees it or reads its shelf,
        and your own chats use it only when you type @{f.name || 'its name'}.
      </Toggle>
      <Toggle on={f.handles_cases} onClick={() => setF({ ...f, handles_cases: !f.handles_cases })} title="Handles case chats">
        Every chat about a case goes to {f.name || 'this agent'} and stays with it. Only one agent can have this;
        ticking it here takes it off any other.
      </Toggle>

      <button type="button" onClick={() => setMore(!more)} className="flex items-center gap-1 text-xs text-mute hover:text-txt">
        <ChevronDown size={14} className={`transition ${more ? 'rotate-180' : ''}`} /> More options
      </button>
      {more && (
        <div className="rise space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>MODEL</label>
              <Picker value={f.model} onChange={(value) => set('model')({ target: { value } })}
                options={config.models.map((m) => ({ value: m.id, label: m.label }))} searchPlaceholder="Search models" />
            </div>
            <div>
              <label className={label}>VOICE</label>
              <Picker value={f.voice} onChange={(value) => set('voice')({ target: { value } })}
                options={config.voices.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))} searchPlaceholder="Search voices" />
            </div>
          </div>
          <div>
            <label className={label}>QUICK PROMPTS · one per line</label>
            <textarea value={f.starters} onChange={set('starters')} rows={3} className={`${field} resize-none`} />
          </div>
        </div>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex gap-3">
        {agent.id && (
          <button type="button" onClick={remove} className="rounded-full border border-bad/40 px-5 py-2.5 text-sm text-bad hover:bg-bad/10">Delete</button>
        )}
        <button disabled={!!busy} className="flex-1 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 font-medium text-white disabled:opacity-50">
          {busy === 'save' ? 'Saving…' : agent.id ? 'Save changes' : 'Create agent'}
        </button>
      </div>
    </form>
  );
}

export default function AgentSheet({ agent, config, me, modules = [], onClose, onSaved, onOpenChat }) {
  // The case agent opens on its cases: that is what someone tapping it wants to see.
  const casesTab = agent.id && agent.handles_cases && modules.includes('case_focus');
  const [tab, setTab] = useState(casesTab ? 'cases' : 'persona');
  return (
    <Sheet title={agent.id ? agent.name : 'New agent'} onClose={onClose} tab={tab} onTab={setTab}
      tabs={agent.id ? [...(casesTab ? [['cases', 'Cases']] : []), ['persona', 'About'], ['files', 'Agent files']] : []}
      icon={agent.id && <Avatar icon={agent.icon} color={agent.color} size={32} className="shadow-none" />}>
      {tab === 'cases' ? (
        <CasesTab agent={agent} onOpenChat={onOpenChat} />
      ) : tab === 'persona' ? (
        me?.role === 'master'
          ? <PersonaTab agent={agent} config={config} onSaved={onSaved} />
          : <PersonaReadOnly agent={agent} />
      ) : (
        <FilesPanel agentId={agent.id} folders={config.folders || []} me={me} hint={`Only ${agent.name} uses these files. They also help Reem know when to pick ${agent.name}.`} />
      )}
    </Sheet>
  );
}
