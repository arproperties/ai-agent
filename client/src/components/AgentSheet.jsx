import { useState } from 'react';
import { api } from '../lib/api';
import { ChevronDown, Sparkles } from 'lucide-react';
import Sheet from './Sheet';
import { FilesPanel } from './Knowledge';
import Avatar, { AGENT_ICONS, AGENT_COLORS } from './Avatar';

const field = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const label = 'mb-1.5 block text-xs font-medium tracking-wide text-mute';

function Select({ value, onChange, children, className = '' }) {
  return (
    <div className="relative">
      <select value={value} onChange={onChange} className={`${field} appearance-none pr-9 ${className}`}>{children}</select>
      <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-mute" />
    </div>
  );
}

function PersonaTab({ agent, config, onSaved }) {
  const [f, setF] = useState({
    name: agent.name || '', icon: agent.icon || 'sparkles', color: agent.color || 'violet', persona: agent.persona || '',
    model: agent.model || config.models[0]?.id, voice: agent.voice || 'alloy',
    starters: (agent.starters || []).join('\n'),
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
          <span className="absolute -bottom-0.5 -right-0.5 grid size-5 place-items-center rounded-full border-2 border-[#141128] bg-white/90 text-[#141128]">
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
                className={`grid aspect-square place-items-center rounded-xl transition ${f.icon === k ? 'bg-white/15 text-white ring-1 ring-p1/70' : 'text-mute hover:bg-white/10 hover:text-txt'}`}>
                <Cmp size={17} strokeWidth={1.75} />
              </button>
            ))}
          </div>
          <div className="mt-2 flex justify-center gap-2.5 border-t border-stroke/60 pt-2.5">
            {Object.entries(AGENT_COLORS).map(([k, cls]) => (
              <button type="button" key={k} onClick={() => setF({ ...f, color: k })} aria-label={`${k} colour`}
                className={`size-6 rounded-full bg-gradient-to-br transition ${cls} ${f.color === k ? 'ring-2 ring-white ring-offset-2 ring-offset-[#141128]' : 'opacity-70 hover:opacity-100'}`} />
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

      <button type="button" onClick={() => setMore(!more)} className="flex items-center gap-1 text-xs text-mute hover:text-txt">
        <ChevronDown size={14} className={`transition ${more ? 'rotate-180' : ''}`} /> More options
      </button>
      {more && (
        <div className="rise space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>MODEL</label>
              <Select value={f.model} onChange={set('model')}>
                {config.models.map((m) => <option key={m.id} value={m.id} className="bg-bg">{m.label}</option>)}
              </Select>
            </div>
            <div>
              <label className={label}>VOICE</label>
              <Select value={f.voice} onChange={set('voice')} className="capitalize">
                {config.voices.map((v) => <option key={v} value={v} className="bg-bg">{v}</option>)}
              </Select>
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

export default function AgentSheet({ agent, config, me, onClose, onSaved }) {
  const [tab, setTab] = useState('persona');
  return (
    <Sheet title={agent.id ? agent.name : 'New agent'} onClose={onClose} tab={tab} onTab={setTab}
      tabs={agent.id ? [['persona', 'Persona'], ['files', 'Agent files']] : []}
      icon={agent.id && <Avatar icon={agent.icon} color={agent.color} size={32} className="shadow-none" />}>
      {tab === 'persona' ? <PersonaTab agent={agent} config={config} onSaved={onSaved} /> : (
        <FilesPanel agentId={agent.id} folders={config.folders || []} me={me} shelfName={agent.name} hint={`Only ${agent.name} uses these files. They also help Jarvis know when to pick ${agent.name}.`} />
      )}
    </Sheet>
  );
}
