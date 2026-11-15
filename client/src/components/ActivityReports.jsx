import { useEffect, useState } from 'react';
import { Loader2, Monitor, Trash2, Copy, Check, Plus } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// Settings → Activity reports (server/tracker.js), the master's alone. The activity tracker
// on each employee PC counts time per app and sends the day here; this page holds the
// switches, pairs PCs to people, and shows the last days. No AI is involved anywhere.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const when = (s) => (s ? new Date(s * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
const hm = (n) => { const m = Math.round((n || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };

function Switch({ on, label, note, onFlip }) {
  const [saving, setSaving] = useState(false);
  const flip = async () => { setSaving(true); try { await onFlip(!on); } catch (e) { alert(e.message); } setSaving(false); };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-stroke px-4 py-2.5 text-sm">
      <span className="flex-1">{label}<span className="block text-xs text-mute">{note}</span></span>
      <button role="switch" aria-checked={on} aria-label={label} disabled={saving} onClick={flip}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-p1' : 'bg-white/15'}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}

// The HR address and the send time are saved when the field loses focus, so there is no Save button to forget.
function TextSetting({ label, value, type = 'text', placeholder, onSave }) {
  const [v, setV] = useState(value);
  const [error, setError] = useState('');
  useEffect(() => setV(value), [value]);
  const save = async () => { if (v === value) return; try { setError(''); await onSave(v); } catch (e) { setError(e.message); } };
  return (
    <label className="block rounded-2xl border border-stroke px-4 py-2.5 text-sm">
      <span className="block text-xs text-mute">{label}</span>
      <input value={v} type={type} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} className="mt-1 w-full bg-transparent outline-none" />
      {error && <span className="block text-xs text-bad">{error}</span>}
    </label>
  );
}

function NewDevice({ people, onMade }) {
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState(null);
  const [copied, setCopied] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!userId || !name.trim() || busy) return;
    setBusy(true); setError('');
    try { const r = await api.post('/tracker/devices', { user_id: Number(userId), name }); setMade(r); setName(''); onMade(); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(made.key); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the key is on screen to copy by hand */ } };

  if (made) {
    return (
      <div className="rounded-[1.25rem] border border-p1/50 bg-white/[0.035] p-3.5">
        <p className="text-sm">Paste this key into the tracker on that PC. It is shown only now.</p>
        <div className="mt-2 flex items-center gap-2">
          <input readOnly value={made.key} onFocus={(e) => e.target.select()} className={`${FIELD} min-w-0 font-mono text-xs`} />
          <button onClick={copy} className="flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white">
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <button onClick={() => setMade(null)} className="mt-2 rounded-full px-3 py-1.5 text-xs text-mute hover:bg-white/10 hover:text-txt">Done</button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="rounded-[1.25rem] border border-stroke bg-white/[0.035] p-3.5">
      <div className="flex items-center gap-2 text-sm font-medium"><Plus size={15} className="text-mute" /> New device</div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <select value={userId} onChange={(e) => setUserId(e.target.value)} className={`${FIELD} flex-1 text-sm`}>
          <option value="">Whose PC?</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="PC name, like Front desk" className={`${FIELD} flex-1 text-sm`} />
        <button disabled={busy || !userId || !name.trim()}
          className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy && <Loader2 size={14} className="animate-spin" />} Make key
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
    </form>
  );
}

export default function ActivityReports({ onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = () => api.get('/tracker').then(setData).catch((e) => { setError(e.message); setData((d) => d || { settings: {}, devices: [], days: [], people: [] }); });
  useEffect(() => { load(); }, []);
  const save = async (patch) => { const settings = await api.put('/tracker/settings', patch); setData((d) => ({ ...d, settings })); };
  const remove = (d) => confirm(`Unpair ${d.name} (${d.person})? Its days are deleted and the tracker on that PC stops sending.`)
    && api.del(`/tracker/devices/${d.id}`).then(load).catch((e) => alert(e.message));

  return (
    <Page title="Activity reports" onBack={onBack}>
      <p className="mb-4 text-sm leading-relaxed text-mute">
        The tracker on each employee PC counts time per app and sends the day here. Every evening Reem emails HR one report for everyone.
      </p>
      {data === null ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
        <div className="space-y-2.5">
          <Switch on={!!data.settings.on} label="Email HR every evening" note={data.settings.on ? `Sent at ${data.settings.send_at} Dubai time.` : 'Off. Days still arrive and are kept.'} onFlip={(on) => save({ on })} />
          <TextSetting label="HR email" value={data.settings.hr_email || ''} type="email" placeholder="hr@…" onSave={(hr_email) => save({ hr_email })} />
          <TextSetting label="Send time (Dubai)" value={data.settings.send_at || '19:00'} type="time" onSave={(send_at) => save({ send_at })} />
          <Switch on={!!data.settings.titles_on} label="Include window titles" note={data.settings.titles_on ? 'The CSV lists the top window titles per app.' : 'App totals only.'} onFlip={(titles_on) => save({ titles_on })} />

          <h2 className="pt-3 text-sm font-medium">Paired PCs</h2>
          {data.devices.length === 0 && <p className="text-xs text-mute">No PC is paired yet.</p>}
          {data.devices.map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded-2xl border border-stroke px-4 py-2.5 text-sm">
              <Monitor size={15} className="shrink-0 text-mute" />
              <span className="flex-1 min-w-0 truncate">{d.person} · {d.name}<span className="block text-xs text-mute">last heard {when(d.last_seen_at)}</span></span>
              <button onClick={() => remove(d)} aria-label={`Unpair ${d.name}`} title="Unpair" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={14} /></button>
            </div>
          ))}
          <NewDevice people={data.people} onMade={load} />

          <h2 className="pt-3 text-sm font-medium">Last 7 days</h2>
          {data.days.length === 0 ? <p className="text-xs text-mute">Nothing has arrived yet.</p> : (
            <div className="overflow-x-auto rounded-2xl border border-stroke">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-mute">{['Date', 'Person', 'PC', 'First', 'Last', 'Active', 'Idle', 'Away'].map((h) => <th key={h} className="px-3 py-2 font-normal">{h}</th>)}</tr></thead>
                <tbody>
                  {data.days.map((d) => (
                    <tr key={`${d.device_id}-${d.date}`} className="border-t border-stroke">
                      <td className="px-3 py-1.5 whitespace-nowrap">{d.date}</td><td className="px-3 py-1.5">{d.person}</td><td className="px-3 py-1.5">{d.device}</td>
                      <td className="px-3 py-1.5">{d.first_seen}</td><td className="px-3 py-1.5">{d.last_seen}</td>
                      <td className="px-3 py-1.5">{hm(d.active_seconds)}</td><td className="px-3 py-1.5">{hm(d.idle_seconds)}</td><td className="px-3 py-1.5">{hm(d.away_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </Page>
  );
}
