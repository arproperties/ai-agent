import { useCallback, useEffect, useState } from 'react';
import { Loader2, ChevronRight, Info } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Sheet from './Sheet';

// Billing, the master's alone: what Reem's AI work cost, in dollars and dirhams, by person,
// by job and by model (server/billing.js). Every call is priced as its answer comes back,
// so the numbers start on the day this went live; older days are on the Anthropic site.

const RANGES = [['today', 'Today'], ['week', '7 days'], ['month', 'This month'], ['d30', '30 days']];

const usd = (n) => `$${n < 1000 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}`;
const aed = (n, rate) => `AED ${(n * rate).toFixed(n * rate < 100 ? 2 : 0)}`;
const small = (n) => n < 0.01 ? (n > 0 ? 'under 1¢' : '$0') : usd(n);
const tokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const when = (secs) => new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });

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

function Tile({ label, value, rate, sub }) {
  return (
    <div className="rounded-3xl border border-stroke bg-white/[0.03] p-4">
      <p className="text-xs text-mute">{label}</p>
      <p className="mt-1 text-2xl font-light tabular-nums">{usd(value)}</p>
      <p className="text-xs text-mute tabular-nums">{aed(value, rate)}{sub ? ` · ${sub}` : ''}</p>
    </div>
  );
}

// One bar per day for the last 30 days. Hover or tap a bar for its day and amount.
function Days({ days }) {
  const [on, setOn] = useState(null);
  const today = new Date();
  const list = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today); d.setDate(d.getDate() - 29 + i);
    const key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
    const row = days.find((x) => x.day === key);
    return { day: key, usd: row?.usd || 0, calls: row?.calls || 0 };
  });
  const max = Math.max(...list.map((d) => d.usd), 0.01);
  const shown = on ?? list.length - 1;
  const pick = list[shown];
  return (
    <div>
      <p className="mb-2 text-sm tabular-nums">
        <span className="text-mute">{dayName(pick.day)}: </span>{usd(pick.usd)} <span className="text-mute">· {pick.calls} calls</span>
      </p>
      <div className="flex h-36 items-end gap-[2px] border-b border-stroke" onMouseLeave={() => setOn(null)}>
        {list.map((d, i) => (
          <button key={d.day} onMouseEnter={() => setOn(i)} onClick={() => setOn(i)} aria-label={`${dayName(d.day)}: ${usd(d.usd)}`}
            className="flex h-full flex-1 items-end">
            <span className={`block w-full rounded-t-[4px] transition-opacity ${on === null || on === i ? 'opacity-100' : 'opacity-45'} bg-chart`}
              style={{ height: d.usd ? `${Math.max(2, (d.usd / max) * 100)}%` : 0 }} />
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-mute">
        <span>{dayName(list[0].day)}</span><span>Today</span>
      </div>
    </div>
  );
}

// Ranked rows: name, a bar for its share, and the money. Tap for its calls when onOpen is given.
function Ranked({ rows, rate, onOpen }) {
  const total = rows.reduce((t, r) => t + r.usd, 0) || 1;
  const max = Math.max(...rows.map((r) => r.usd), 0.0001);
  if (!rows.length) return <p className="text-sm text-mute">Nothing yet in this time.</p>;
  return (
    <ul className="space-y-1">
      {rows.map((r) => {
        const Tag = onOpen ? 'button' : 'div';
        return (
          <li key={r.key}>
            <Tag onClick={onOpen ? () => onOpen(r) : undefined}
              className={`flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left ${onOpen ? 'hover:bg-white/5' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm">{r.name}</span>
                  <span className="shrink-0 text-xs text-mute">{Math.round((r.usd / total) * 100)}%</span>
                </div>
                {r.about && <p className="truncate text-xs text-mute">{r.about}</p>}
                <div className="mt-1.5 h-1.5 rounded-full bg-white/5">
                  <div className="h-full rounded-full bg-chart" style={{ width: `${Math.max(1, (r.usd / max) * 100)}%` }} />
                </div>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <p className="text-sm">{small(r.usd)}</p>
                <p className="text-xs text-mute">{aed(r.usd, rate)} · {r.calls} {r.calls === 1 ? 'call' : 'calls'}</p>
              </div>
              {onOpen && <ChevronRight size={16} className="shrink-0 text-mute" />}
            </Tag>
          </li>
        );
      })}
    </ul>
  );
}

// Every call for one person (or for the background work), newest first.
function Calls({ who, range, rate, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.get(`/billing/calls?range=${range}&user=${who.id ?? 'none'}`).then(setRows).catch(() => setRows([]));
  }, [who, range]);
  const total = (rows || []).reduce((t, r) => t + r.usd, 0);
  return (
    <Sheet title={who.name} onClose={onClose}>
      <div>
        {!rows ? <Loader2 className="mx-auto my-8 animate-spin text-mute" /> : (
          <>
            <p className="mb-3 text-sm text-mute tabular-nums">{rows.length} calls · {usd(total)} · {aed(total, rate)}{rows.length === 300 ? ' (the latest 300)' : ''}</p>
            <ul className="divide-y divide-stroke">
              {rows.map((r) => (
                <li key={r.id} className="flex gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{r.note || r.jobName}</p>
                    <p className="text-xs text-mute">
                      {when(r.at)} · {r.jobName} · {r.modelName}
                      {r.provider === 'anthropic' ? ` · ${tokens(r.input)} in, ${tokens(r.output)} out` : ''}
                      {r.searches ? ` · ${r.searches} web search${r.searches > 1 ? 'es' : ''}` : ''}
                      {KEY_PAID[r.key_source] ? ` · ${KEY_PAID[r.key_source]}` : ''}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm tabular-nums">{small(r.usd)}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Sheet>
  );
}

function Prices({ prices, rate }) {
  return (
    <Card title="How the price is worked out" hint="Each answer says how many tokens (pieces of words) went in and came out. Billing multiplies them by these list prices.">
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-xs text-mute">
            <tr><th className="py-1 pr-3 font-normal">Claude model</th><th className="py-1 pr-3 font-normal">In, per 1M</th><th className="py-1 pr-3 font-normal">Out, per 1M</th><th className="py-1 font-normal">Re-read, per 1M</th></tr>
          </thead>
          <tbody className="divide-y divide-stroke">
            {prices.claude.map((p) => (
              <tr key={p.id}><td className="py-1.5 pr-3">{p.name}</td><td className="pr-3">${p.input.toFixed(2)}</td><td className="pr-3">${p.output.toFixed(2)}</td><td>${p.read.toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-1 text-sm text-mute">
        <li>"In" is what Reem sends: its instructions, the earlier messages, files it looks at, and the question.</li>
        <li>"Out" is what Reem writes back. It costs 5 times more than "in".</li>
        <li>"Re-read" is the part sent again unchanged, which Anthropic charges at a tenth of the price or less.</li>
        <li>A web search is {usd(prices.webSearch)} each.</li>
        <li>Voice and pictures are OpenAI's: voice to text {prices.openai[0].perMinute * 100}¢ a minute, meetings {prices.openai[1].perMinute * 100}¢ a minute, read aloud about 1.5¢ a minute, a picture about 6¢. These are close estimates.</li>
        <li>$1 = AED {rate}.</li>
      </ul>
    </Card>
  );
}

// Which key paid for a call (server/aiKeys.js). Older calls were made before keys were noted.
const KEY_PAID = { own: 'their own key', company: 'company key', server: 'server key (.env)' };

export default function Billing({ onBack }) {
  const [range, setRange] = useState('week');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const load = useCallback(() => {
    api.get(`/billing?range=${range}`).then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const rate = data?.aed || 3.6725;
  const rangeName = RANGES.find(([k]) => k === range)[1].toLowerCase();
  return (
    <Page title="Billing" onBack={onBack}>
      <div className="mx-auto max-w-3xl space-y-4">
        {error && <p className="text-sm text-bad">{error}</p>}
        {!data ? <Loader2 className="mx-auto my-10 animate-spin text-mute" /> : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile label="Today" value={data.totals.today} rate={rate} />
              <Tile label="Yesterday" value={data.totals.yesterday} rate={rate} />
              <Tile label="Last 7 days" value={data.totals.week} rate={rate} />
              <Tile label="This month" value={data.totals.month} rate={rate} />
            </div>

            <p className="flex items-start gap-1.5 text-xs text-mute">
              <Info size={14} className="mt-px shrink-0" />
              {data.totals.since
                ? `Counting since ${when(data.totals.since)}. Earlier days are on console.anthropic.com → Usage. These are worked out from the same counts Anthropic bills on, so they match the bill to within a few cents.`
                : 'Nothing counted yet. Every AI call from now on shows up here.'}
            </p>

            <Card title="Each day" hint="The last 30 days. Tap a bar to see that day.">
              <Days days={data.days} />
            </Card>

            <div className="flex gap-1 rounded-full bg-white/5 p-1 text-sm" role="tablist" aria-label="Time">
              {RANGES.map(([k, l]) => (
                <button key={k} role="tab" aria-selected={range === k} onClick={() => setRange(k)}
                  className={`flex-1 rounded-full py-1.5 transition ${range === k ? 'bg-white/15 text-txt' : 'text-mute'}`}>{l}</button>
              ))}
            </div>

            <Card title="By person" hint={`Who the money went on, ${rangeName}. Tap a name to see each question and what it cost.`}>
              <Ranked rate={rate} onOpen={setOpen}
                rows={data.people.map((p) => ({ key: p.id ?? 'none', id: p.id, name: p.id ? (p.name || p.email) : 'Reem by itself', about: p.id ? p.email : 'Background work nobody asked for in person: renewals, shared inboxes', usd: p.usd, calls: p.calls }))} />
            </Card>

            <Card title="By job" hint={`What the money was spent doing, ${rangeName}.`}>
              <Ranked rate={rate} rows={data.jobs.map((j) => ({ key: j.job, name: j.name, about: j.about, usd: j.usd, calls: j.calls }))} />
            </Card>

            <Card title="By model" hint={`Which AI did the work, ${rangeName}. The bigger models cost far more per word.`}>
              <Ranked rate={rate} rows={data.models.map((m) => ({
                key: `${m.provider}:${m.model}`, name: m.name,
                about: m.provider === 'anthropic' ? `${m.about} · ${tokens(m.input)} in, ${tokens(m.output)} out${m.searches ? `, ${m.searches} searches` : ''}` : m.about,
                usd: m.usd, calls: m.calls,
              }))} />
            </Card>

            <Prices prices={data.prices} rate={rate} />
          </>
        )}
      </div>
      {open && <Calls who={open} range={range} rate={rate} onClose={() => setOpen(null)} />}
    </Page>
  );
}
