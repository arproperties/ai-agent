import { useCallback, useEffect, useState } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Select from './Select';

// The activity log: who added, changed or deleted what, and when, across the whole app,
// each change old → new. The master's, and whoever holds the Activity module. Riley reads
// the same log (activity_search). The server is server/activity.js.

const FIELD = 'glass w-full rounded-xl px-3 py-2.5 text-sm outline-none focus:border-p1/70';
const ACTIONS = [['', 'Any change'], ['added', 'Added'], ['changed', 'Changed'], ['deleted', 'Deleted']];
const VERB = { insert: 'added', update: 'changed', delete: 'deleted' };
const TONE = { insert: 'text-emerald-400', update: 'text-sky-400', delete: 'text-bad' };
const EMPTY = { person: '', kind: '', action: '', text: '', from: '', to: '', system: false };

export default function ActivityLogPage({ onBack }) {
  const [f, setF] = useState(EMPTY);
  const [entries, setEntries] = useState(null);
  const [kinds, setKinds] = useState([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const load = useCallback(async (before) => {
    const q = new URLSearchParams(Object.entries({ ...f, system: f.system ? '1' : '', before: before || '' }).filter(([, v]) => v));
    try {
      const r = await api.get(`/activity?${q}`);
      setEntries((old) => (before ? [...(old || []), ...r.entries] : r.entries));
      setKinds(r.kinds);
      setMore(r.entries.length === 100);
      setError('');
    } catch (e) { setError(e.message); }
  }, [f]);
  // typing in a box waits a moment, so the list is not asked for at each letter
  useEffect(() => { const t = setTimeout(() => load(), 300); return () => clearTimeout(t); }, [load]);

  return (
    <Page title="Activity log" onBack={onBack}>
      <div className="space-y-4 rounded-3xl border border-stroke p-5 md:p-7">
        <p className="text-sm text-mute">Every record anyone added, changed or deleted, newest first, with what it was before and after. You can also ask Riley, like “who deleted a payment this week?” or “how much did Jeff collect this month?”.</p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <input value={f.person} onChange={set('person')} placeholder="Person" aria-label="Person" className={FIELD} />
          <Select value={f.kind} onChange={set('kind')} options={[['', 'Any record'], ...kinds.map((k) => [k.key, k.label])]} aria-label="Kind of record" className={FIELD} />
          <Select value={f.action} onChange={set('action')} options={ACTIONS} aria-label="Change" className={FIELD} />
          <input value={f.text} onChange={set('text')} placeholder="Words, unit, tenant…" aria-label="Search" className={FIELD} />
          <input type="date" value={f.from} onChange={set('from')} aria-label="From" className={FIELD} />
          <input type="date" value={f.to} onChange={set('to')} aria-label="To" className={FIELD} />
          <label className="col-span-2 flex items-center gap-2 text-sm text-mute">
            <input type="checkbox" checked={f.system} onChange={set('system')} /> Also what the app did by itself
          </label>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        {!entries && !error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />}
        {entries?.length === 0 && <p className="py-6 text-center text-sm text-mute">Nothing matches.</p>}
        <ul className="divide-y divide-stroke">
          {entries?.map((e) => (
            <li key={e.id} className="py-3">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="text-xs tabular-nums text-mute">{e.when}</span>
                <span className="font-medium">{e.who}</span>
                {e.via === 'chat' && <span className="inline-flex items-center gap-1 rounded-full bg-p1/15 px-2 text-xs text-p1"><MessageSquare size={11} /> via chat</span>}
                <span className={TONE[e.action]}>{VERB[e.action]}</span>
                <span>{e.kind}</span>
                {e.about && <span className="min-w-0 truncate text-mute">{e.about}</span>}
              </div>
              {e.changes.length > 0 && (
                <ul className="mt-1 space-y-0.5 pl-1 text-xs">
                  {e.changes.slice(0, 12).map((c) => (
                    <li key={c.field} className="break-words">
                      <span className="text-mute">{c.field}: </span>
                      {e.action === 'update'
                        ? <><span className="text-mute line-through">{c.from ?? '—'}</span> → <span>{c.to ?? '—'}</span></>
                        : <span className={e.action === 'delete' ? 'text-mute line-through' : ''}>{e.action === 'delete' ? c.from : c.to}</span>}
                    </li>
                  ))}
                  {e.changes.length > 12 && <li className="text-mute">and {e.changes.length - 12} more</li>}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {more && <button onClick={() => load(entries.at(-1).id)} className="mx-auto block rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5">Load more</button>}
      </div>
    </Page>
  );
}
