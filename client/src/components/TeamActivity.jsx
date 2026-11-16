import { useCallback, useEffect, useState } from 'react';
import { Loader2, ChevronRight, Info, EyeOff, Eye } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Sheet from './Sheet';

// Settings → Team activity, the master's alone (server/teamActivity.js): how each person is
// using Reem today, this week or this month, beside their own usual pace. It only counts and
// lists titles; it never opens anyone's chat or file, so nobody's "who looked" list changes.

const RANGES = [['today', 'Today'], ['week', '7 days'], ['month', 'This month']];
const SORTS = [['active', 'Most active'], ['below', 'Below usual'], ['overdue', 'Most overdue'], ['name', 'Name']];

const clock = (s) => (s ? new Date(s * 1000).toLocaleTimeString([], { timeZone: 'Asia/Dubai', hour: 'numeric', minute: '2-digit' }) : '');
const when = (s) => (s ? new Date(s * 1000).toLocaleString([], { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');
const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
const ago = (s) => {
  if (!s) return 'never';
  const days = Math.floor((Date.now() / 1000 - s) / 86400);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const Card = ({ title, hint, children }) => (
  <section className="space-y-3 rounded-3xl border border-stroke bg-white/[0.03] p-4">
    {title && (
      <div>
        <h2 className="font-medium">{title}</h2>
        {hint && <p className="text-sm text-mute">{hint}</p>}
      </div>
    )}
    {children}
  </section>
);

const Tile = ({ label, value, sub }) => (
  <div className="rounded-3xl border border-stroke bg-white/[0.03] p-4">
    <p className="text-xs text-mute">{label}</p>
    <p className="mt-1 text-2xl font-light tabular-nums">{value}</p>
    {sub && <p className="text-xs text-mute">{sub}</p>}
  </div>
);

const Chip = ({ tone, children }) => {
  const look = { bad: 'border-bad/40 text-bad', warn: 'border-warn/40 text-warn', mute: 'border-stroke text-mute' }[tone];
  return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${look}`}>{children}</span>;
};

function sorted(people, sort) {
  const list = [...people];
  if (sort === 'name') return list.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'overdue') return list.sort((a, b) => b.overdue - a.overdue || b.open - a.open);
  if (sort === 'below') return list.sort((a, b) => (b.below - a.below) || (b.usual - b.asked) - (a.usual - a.asked));
  return list.sort((a, b) => b.asked - a.asked || b.usual - a.usual);
}

// One person's line: what they did in the range, then the flags worth a second look.
function PersonRow({ p, range, onOpen }) {
  const hours = range === 'today' && p.firstAt ? `${clock(p.firstAt)} – ${clock(p.lastAt)}` : null;
  return (
    <li>
      <button onClick={() => onOpen(p)} className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left hover:bg-white/5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm">{p.name}</span>
            {p.below && <Chip tone="warn">below usual</Chip>}
            {p.overdue >= 10 && <Chip tone="bad">{p.overdue} overdue</Chip>}
          </div>
          <p className="mt-0.5 text-xs text-mute tabular-nums">
            {plural(p.asked, 'question')}
            {range === 'today' ? ` · usual ${p.usual}` : ` on ${plural(p.activeDays, 'day')} · usual ${p.usual} a day`}
            {hours ? ` · ${hours}` : ''}
          </p>
          <p className="text-xs text-mute tabular-nums">
            {plural(p.sent, 'email')} sent · {plural(p.files, 'file')} added · {p.ticked} done · {p.open} open{p.overdue ? ` (${p.overdue} late)` : ''}
          </p>
        </div>
        <ChevronRight size={16} className="shrink-0 text-mute" />
      </button>
    </li>
  );
}

// One bar per day for the last 30 days. Hover or tap a bar for its day.
function Days({ days }) {
  const [on, setOn] = useState(null);
  const today = new Date();
  const list = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today); d.setDate(d.getDate() - 29 + i);
    const key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
    return { day: key, asked: days.find((x) => x.day === key)?.asked || 0 };
  });
  const max = Math.max(...list.map((d) => d.asked), 1);
  const pick = list[on ?? list.length - 1];
  return (
    <div>
      <p className="mb-2 text-sm tabular-nums"><span className="text-mute">{dayName(pick.day)}: </span>{plural(pick.asked, 'question')}</p>
      <div className="flex h-28 items-end gap-[2px] border-b border-stroke" onMouseLeave={() => setOn(null)}>
        {list.map((d, i) => (
          <button key={d.day} onMouseEnter={() => setOn(i)} onClick={() => setOn(i)} aria-label={`${dayName(d.day)}: ${d.asked}`} className="flex h-full flex-1 items-end">
            <span className={`block w-full rounded-t-[4px] bg-chart transition-opacity ${on === null || on === i ? 'opacity-100' : 'opacity-45'}`}
              style={{ height: d.asked ? `${Math.max(3, (d.asked / max) * 100)}%` : 0 }} />
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-mute"><span>{dayName(list[0].day)}</span><span>Today</span></div>
    </div>
  );
}

// A long backlog shows its first ten; "Show all" opens the rest.
function List({ title, empty, items, render }) {
  const [all, setAll] = useState(false);
  const list = all ? items : items.slice(0, 10);
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">{title} <span className="font-normal text-mute">{items.length || ''}</span></h3>
      {items.length ? <ul className="divide-y divide-stroke">{list.map(render)}</ul> : <p className="text-sm text-mute">{empty}</p>}
      {items.length > 10 && !all && (
        <button onClick={() => setAll(true)} className="mt-1 text-xs text-p1 hover:underline">Show all {items.length}</button>
      )}
    </div>
  );
}

function Person({ who, range, onClose, onHide }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/team-activity/${who.id}?range=${range}`).then(setData).catch((e) => setError(e.message));
  }, [who, range]);
  const rangeName = RANGES.find(([k]) => k === range)[1].toLowerCase();
  return (
    <Sheet title={who.name} onClose={onClose}>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!data ? !error && <Loader2 className="mx-auto my-8 animate-spin text-mute" /> : (
        <div className="space-y-5">
          <p className="text-xs text-mute">{data.person.email} · last opened Reem {when(data.person.lastSeen)}</p>
          <Days days={data.days} />
          <List title={`Chats, ${rangeName}`} empty="No questions asked." items={data.chats}
            render={(c) => (
              <li key={c.id} className="flex gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate" dir="auto">{c.title}</span>
                <span className="shrink-0 text-xs text-mute tabular-nums">{plural(c.asked, 'question')} · {when(c.lastAt)}</span>
              </li>
            )} />
          <List title={`Emails sent, ${rangeName}`} empty="None." items={data.sent}
            render={(e) => (
              <li key={e.id} className="py-2 text-sm">
                <p className="truncate" dir="auto">{e.subject}</p>
                <p className="truncate text-xs text-mute">to {e.to} · {when(e.at)}</p>
              </li>
            )} />
          <List title={`Files added, ${rangeName}`} empty="None." items={data.files}
            render={(f) => (
              <li key={f.id} className="flex gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate" dir="auto">{f.title}</span>
                <span className="shrink-0 text-xs text-mute">{f.folder || ''}</span>
              </li>
            )} />
          <List title={`To-dos done, ${rangeName}`} empty="None ticked off." items={data.ticked}
            render={(x) => <li key={x.id} className="truncate py-2 text-sm" dir="auto">{x.text}</li>} />
          <List title="Overdue, today and tomorrow" empty="Nothing due." items={data.due}
            render={(x) => (
              <li key={x.id} className="flex gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate" dir="auto">{x.text}</span>
                <span className={`shrink-0 text-xs tabular-nums ${x.overdue ? 'text-bad' : 'text-mute'}`}>{when(x.at)}</span>
              </li>
            )} />
          {data.undated > 0 && <p className="text-xs text-mute">Plus {plural(data.undated, 'open to-do')} with no date.</p>}
          <button onClick={() => onHide(who, !who.hidden)} className="flex items-center gap-2 text-sm text-mute hover:text-txt">
            {who.hidden ? <Eye size={15} /> : <EyeOff size={15} />}
            {who.hidden ? 'Show on this page again' : 'Hide from this page (shared or test account)'}
          </button>
        </div>
      )}
    </Sheet>
  );
}

export default function TeamActivity({ onBack }) {
  const [range, setRange] = useState('today');
  const [sort, setSort] = useState('active');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const load = useCallback(() => {
    api.get(`/team-activity?range=${range}`).then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const hide = async (who, hidden) => {
    try {
      await api.put(`/team-activity/${who.id}/hidden`, { hidden });
      setOpen(null);
      load();
    } catch (e) { alert(e.message); }
  };

  const shown = (data?.people || []).filter((p) => !p.hidden);
  const working = sorted(shown.filter((p) => !p.idle || p.asked > 0), sort);
  const idle = shown.filter((p) => p.idle && p.asked === 0).sort((a, b) => (b.lastChat || 0) - (a.lastChat || 0));
  const hidden = (data?.people || []).filter((p) => p.hidden);
  const rangeName = RANGES.find(([k]) => k === range)[1].toLowerCase();

  return (
    <Page title="Team activity" onBack={onBack}>
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex gap-1 rounded-full bg-white/5 p-1 text-sm" role="tablist" aria-label="Time">
          {RANGES.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={range === k} onClick={() => setRange(k)}
              className={`flex-1 rounded-full py-1.5 transition ${range === k ? 'bg-white/15 text-txt' : 'text-mute'}`}>{l}</button>
          ))}
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        {!data ? !error && <Loader2 className="mx-auto my-10 animate-spin text-mute" /> : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile label="People using Reem" value={`${data.totals.active} of ${data.totals.people}`} />
              <Tile label="Questions asked" value={data.totals.asked} />
              <Tile label="Emails sent" value={data.totals.sent} sub={`${plural(data.totals.files, 'file')} added`} />
              <Tile label="To-dos done" value={data.totals.ticked} />
            </div>

            <Card title="Each person" hint={`What they did in Reem, ${rangeName}, beside their usual pace (their average a day over the last 14 days). Tap a name for the detail.`}>
              <div className="flex flex-wrap gap-1 text-xs" role="tablist" aria-label="Sort">
                {SORTS.map(([k, l]) => (
                  <button key={k} role="tab" aria-selected={sort === k} onClick={() => setSort(k)}
                    className={`rounded-full border px-2.5 py-1 transition ${sort === k ? 'border-p1/60 bg-white/10 text-txt' : 'border-stroke text-mute'}`}>{l}</button>
                ))}
              </div>
              {working.length ? (
                <ul className="divide-y divide-stroke">{working.map((p) => <PersonRow key={p.id} p={p} range={range} onOpen={setOpen} />)}</ul>
              ) : <p className="text-sm text-mute">Nobody has used Reem in this time.</p>}
            </Card>

            {idle.length > 0 && (
              <Card title="Not using Reem" hint="No questions in the last 7 days.">
                <ul className="divide-y divide-stroke">
                  {idle.map((p) => (
                    <li key={p.id}>
                      <button onClick={() => setOpen(p)} className="flex w-full items-center gap-3 px-2 py-2 text-left text-sm hover:bg-white/5">
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        <span className="shrink-0 text-xs text-mute">last chat {ago(p.lastChat)} · opened {ago(p.lastSeen)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {hidden.length > 0 && (
              <div>
                <button onClick={() => setShowHidden((v) => !v)} className="text-xs text-mute hover:text-txt">
                  {showHidden ? 'Hide' : 'Show'} the {plural(hidden.length, 'hidden account')}
                </button>
                {showHidden && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {hidden.map((p) => (
                      <li key={p.id}><button onClick={() => setOpen(p)} className="rounded-full border border-stroke px-2.5 py-1 text-xs text-mute hover:text-txt">{p.name}</button></li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <p className="flex items-start gap-1.5 text-xs text-mute">
              <Info size={14} className="mt-px shrink-0" />
              This counts only work done inside Reem. Calls, saifsys and paper work don't show, so a quiet day here isn't always a quiet day.
              Looking at this page doesn't show up for the person. External people are never listed.
            </p>
          </>
        )}
      </div>
      {open && <Person who={open} range={range} onClose={() => setOpen(null)} onHide={hide} />}
    </Page>
  );
}
