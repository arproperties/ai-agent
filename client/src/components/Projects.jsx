import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, HardHat, Loader2, Pencil, Plus } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import ProjectCard from './ProjectCard';

// Projects: a building job (the JVC school). The store keeper records deliveries, material
// given out and each day's manpower in chat; this screen is where it is looked at - what is
// on site, the deliveries waiting for a manager, the manpower day by day, and every move.
// The master sets a project up here: its name, floors, its agent and its people.
// The server is server/projects.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const LABEL = 'text-[11px] font-medium tracking-[0.14em] text-mute';
const ROLE = { store: 'Store keeper', manager: 'Manager', master: 'Master' };
const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
const TABS = [['stock', 'Stock'], ['waiting', 'Waiting'], ['manpower', 'Manpower'], ['history', 'History']];

// ---------- the master's set-up ----------

function ProjectForm({ start, agents, onSaved, onCancel }) {
  const [name, setName] = useState(start?.project.name || '');
  const [floors, setFloors] = useState((start?.project.floors || ['Basement', 'Ground', '1st', '2nd', '3rd', 'Roof']).join(', '));
  const [agentId, setAgentId] = useState(start?.project.agent_id || '');
  const [roles, setRoles] = useState(() => Object.fromEntries((start?.members || []).map((m) => [m.user_id, m.role])));
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.get('/admin/users').then((u) => setPeople(u.filter((x) => !x.external && !x.disabled && x.role !== 'master'))).catch(() => {}); }, []);

  const save = async () => {
    setBusy(true); setError('');
    const body = {
      name, agent_id: Number(agentId) || null,
      floors: floors.split(',').map((f) => f.trim()).filter(Boolean),
      members: Object.entries(roles).filter(([, r]) => r).map(([id, role]) => ({ user_id: Number(id), role })),
    };
    try { onSaved(await (start ? api.put(`/projects/${start.project.id}`, body) : api.post('/projects', body))); } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <div className="glass space-y-4 rounded-2xl p-4">
      <label className="block space-y-1.5"><span className={LABEL}>NAME</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="JVC School" className={FIELD} /></label>
      <label className="block space-y-1.5"><span className={LABEL}>FLOORS, IN ORDER</span>
        <input value={floors} onChange={(e) => setFloors(e.target.value)} className={FIELD} /></label>
      <label className="block space-y-1.5"><span className={LABEL}>AGENT FOR THIS PROJECT</span>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={FIELD}>
          <option value="">None</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <span className="block text-xs text-mute">Its chats use this project without being told which.</span>
      </label>
      <div className="space-y-1.5">
        <span className={LABEL}>PEOPLE</span>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {people.map((u) => (
            <div key={u.id} className="flex items-center gap-2 rounded-lg px-1 py-1">
              <span className="min-w-0 flex-1 truncate">{u.name}</span>
              <select value={roles[u.id] || ''} onChange={(e) => setRoles((r) => ({ ...r, [u.id]: e.target.value }))}
                className="glass rounded-lg px-2 py-1 text-sm outline-none">
                <option value="">Not on it</option>
                <option value="store">Store keeper</option>
                <option value="manager">Manager</option>
              </select>
            </div>
          ))}
        </div>
        <span className="block text-xs text-mute">They also need the Projects module ticked on their People profile to open this screen.</span>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={busy || !name.trim()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 font-medium text-white shadow-lg shadow-p1/25 disabled:opacity-50">
          {busy && <Loader2 size={15} className="animate-spin" />} Save
        </button>
        <button onClick={onCancel} className="rounded-full border border-stroke px-5 py-2.5 text-mute">Cancel</button>
      </div>
    </div>
  );
}

// ---------- one project ----------

function Stock({ p, onItem }) {
  if (!p.stock.length) return <p className="py-10 text-center text-mute">Nothing recorded yet. Deliveries sent in chat and accepted show up here.</p>;
  // Nobody counts the whole site on day one: old material is counted when its pile gets small.
  const below = p.stock.some((s) => s.on_site < 0);
  return (
    <div className="space-y-2">
    {below && <p className="text-xs text-mute">Red = more given out than recorded: old stock not counted yet. When that pile is small, tell Reem what is left (e.g. "cement left: 6 bags").</p>}
    <div className="glass divide-y divide-stroke/60 rounded-2xl">
      {p.stock.map((s) => (
        <button key={`${s.item}|${s.counted_in}`} onClick={() => onItem(s.item)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.04]">
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{s.item}</span>
            <span className="text-xs text-mute">received {num(s.received)} · given out {num(s.given)}</span>
          </span>
          <span className={`text-right tabular-nums ${s.on_site < 0 ? 'text-bad' : ''}`}>
            <span className="text-lg">{num(s.on_site)}</span> <span className="text-xs text-mute">{s.counted_in}</span>
          </span>
          <ChevronRight size={16} className="text-mute" />
        </button>
      ))}
    </div>
    </div>
  );
}

function Manpower({ id }) {
  const [days, setDays] = useState(null);
  useEffect(() => { api.get(`/projects/${id}/manpower`).then(setDays).catch(() => setDays([])); }, [id]);
  if (!days) return <Loader2 className="mx-auto mt-10 animate-spin text-mute" />;
  if (!days.length) return <p className="py-10 text-center text-mute">No manpower sent yet. The store keeper sends it in chat, e.g. "8 masons, 15 helpers".</p>;
  return (
    <div className="glass divide-y divide-stroke/60 rounded-2xl">
      {days.map((d) => (
        <div key={d.day} className="px-4 py-3">
          <div className="flex items-baseline justify-between">
            <span className="font-medium">{new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            <span className="tabular-nums text-mute">{d.total} people</span>
          </div>
          <p className="mt-0.5 text-sm text-txt/85">
            {d.rows.map((r) => `${r.count} ${r.trade}${r.subcontractor ? ` (${r.subcontractor})` : ''}`).join(' · ')}
          </p>
        </div>
      ))}
    </div>
  );
}

function History({ p, item, onClear }) {
  const moves = item ? p.moves.filter((m) => m.item.toLowerCase() === item.toLowerCase()) : p.moves;
  return (
    <div className="space-y-2">
      {item && (
        <button onClick={onClear} className="rounded-full border border-stroke px-3 py-1 text-xs text-mute">{item} · show all</button>
      )}
      {!moves.length ? <p className="py-10 text-center text-mute">Nothing recorded yet.</p> : (
        <div className="glass divide-y divide-stroke/60 rounded-2xl">
          {moves.map((m) => (
            <div key={m.id} className="flex items-baseline gap-3 px-4 py-2.5">
              <span className={`w-14 shrink-0 text-xs font-medium ${m.kind === 'in' ? 'text-ok' : m.kind === 'out' ? 'text-warn' : 'text-mute'}`}>
                {{ in: 'IN', out: 'OUT', count_up: 'COUNT +', count_down: 'COUNT −' }[m.kind]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">{num(m.quantity)} {m.counted_in} {m.item}</span>
                <span className="text-xs text-mute">
                  {[m.day, m.floor, m.supplier && `from ${m.supplier}`, m.party && `to ${m.party}`, m.by_name && `by ${m.by_name}`].filter(Boolean).join(' · ')}
                </span>
                {m.note && <span className="block text-xs text-txt/75">{m.note}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Project({ id, me, agents, onBack }) {
  const [p, setP] = useState(null);
  const [tab, setTab] = useState('stock');
  const [item, setItem] = useState(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get(`/projects/${id}`).then((r) => { setP(r); return r; }).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load().then((r) => { if (r?.waiting.length && ['manager', 'master'].includes(r.role)) setTab('waiting'); }); }, [load]);

  const action = me.role === 'master' && p && !editing && (
    <button onClick={() => setEditing(true)} aria-label="Edit project" className="grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
      <Pencil size={17} />
    </button>
  );

  return (
    <Page title={p?.project.name || 'Project'} onBack={onBack} action={action}>
      {error && <p className="py-6 text-center text-bad">{error}</p>}
      {!p && !error && <Loader2 className="mx-auto mt-10 animate-spin text-mute" />}
      {p && editing && <ProjectForm start={p} agents={agents} onSaved={(r) => { setP(r); setEditing(false); }} onCancel={() => setEditing(false)} />}
      {p && !editing && (
        <div className="space-y-4">
          <p className="text-sm text-mute">
            You are {ROLE[p.role]?.toLowerCase()} · {p.members.map((m) => `${m.name} (${ROLE[m.role]})`).join(', ') || 'nobody added yet'}
          </p>
          <div className="flex gap-1 overflow-x-auto">
            {TABS.map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)}
                className={`shrink-0 rounded-full px-4 py-1.5 text-sm transition ${tab === key ? 'bg-white/15 text-txt' : 'text-mute hover:bg-white/[0.06]'}`}>
                {label}{key === 'waiting' && p.waiting.length > 0 && <span className="ml-1.5 rounded-full bg-warn/25 px-1.5 text-xs text-warn">{p.waiting.length}</span>}
              </button>
            ))}
          </div>
          {tab === 'stock' && <Stock p={p} onItem={(i) => { setItem(i); setTab('history'); }} />}
          {tab === 'waiting' && (
            <div className="space-y-3">
              {!p.waiting.length && <p className="py-10 text-center text-mute">No delivery is waiting for a manager.</p>}
              {p.waiting.map((c) => <ProjectCard key={c.id} card={c} onChanged={() => load()} />)}
              {p.rejected.length > 0 && (
                <>
                  <p className={`${LABEL} pt-3`}>REJECTED LATELY</p>
                  {p.rejected.map((c) => <ProjectCard key={c.id} card={c} onChanged={() => load()} />)}
                </>
              )}
            </div>
          )}
          {tab === 'manpower' && <Manpower id={p.project.id} />}
          {tab === 'history' && <History p={p} item={item} onClear={() => setItem(null)} />}
        </div>
      )}
    </Page>
  );
}

// ---------- the list ----------

export default function ProjectsPage({ me, agents = [], start = null, onBack }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(start);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api.get('/projects').then((r) => {
    setList(r);
    if (r.length === 1 && me.role !== 'master') setOpen((o) => o || r[0].id); // one project: straight in
  }).catch(() => setList([])), [me.role]);
  useEffect(() => { load(); }, [load]);

  if (open) return <Project key={open} id={open} me={me} agents={agents} onBack={() => { setOpen(null); load(); if (list?.length === 1 && me.role !== 'master') onBack(); }} />;

  const action = me.role === 'master' && !adding && (
    <button onClick={() => setAdding(true)} aria-label="New project" className="grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
      <Plus size={19} />
    </button>
  );
  return (
    <Page title="Projects" onBack={onBack} action={action}>
      {adding && (
        <div className="mb-4">
          <ProjectForm agents={agents} onSaved={(r) => { setAdding(false); load(); setOpen(r.project.id); }} onCancel={() => setAdding(false)} />
        </div>
      )}
      {!list && <Loader2 className="mx-auto mt-10 animate-spin text-mute" />}
      {list && !list.length && !adding && (
        <p className="py-10 text-center text-mute">{me.role === 'master' ? 'No projects yet. Tap + to set one up.' : 'You are not on any project yet.'}</p>
      )}
      {list?.length > 0 && (
        <div className="glass divide-y divide-stroke/60 rounded-2xl">
          {list.map((p) => (
            <button key={p.id} onClick={() => setOpen(p.id)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-white/[0.04]">
              <HardHat size={18} className="text-mute" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{p.name}</span>
                <span className="text-xs text-mute">{ROLE[p.role]}</span>
              </span>
              <ChevronRight size={16} className="text-mute" />
            </button>
          ))}
        </div>
      )}
    </Page>
  );
}
