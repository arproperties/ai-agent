import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, RefreshCw, Coins, Fuel, ArrowLeftRight, Droplet, Landmark, TrendingUp, CloudSun, Newspaper, Sparkles, Send, Bell, ExternalLink, TriangleAlert, MonitorPlay } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import YouTubeBrowser from './YouTubeBrowser';

// Feeds, the master's morning page (server/feeds.js): what Reem looked up at 6 - gold,
// petrol, currency, oil, EIBOR, property shares, weather and the property news - each
// beside yesterday's number, with a month of history, and a chat at the foot that answers
// from it. The buzz time sits at the top, so it is changed where it is felt.

const fmt = (n, d = 2) => (n == null ? '–' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
const timeOf = (secs) => new Date(secs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' });

// Up or down against the day before. Petrol and EIBOR going up is bad news for the company;
// gold and shares going up is just up - so the colour follows the direction, not a verdict.
function Change({ now, before, digits = 2, pct = true }) {
  if (now == null || before == null || before === 0) return null;
  const diff = now - before;
  if (Math.abs(diff) < 1e-9) return <span className="text-xs text-mute">no change</span>;
  const up = diff > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs tabular-nums ${up ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad'}`}>
      {up ? '▲' : '▼'} {pct ? `${Math.abs((diff / before) * 100).toFixed(2)}%` : fmt(Math.abs(diff), digits)}
    </span>
  );
}

// A month at a glance: a line through the days that have a number, scaled to their own range.
function Spark({ values, className = 'text-chart' }) {
  const pts = values.filter((v) => v != null);
  if (pts.length < 2) return <p className="text-[11px] text-mute">The chart fills in as the days add up.</p>;
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const W = 200, H = 44;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * W, H - 4 - ((v - min) / span) * (H - 8)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`h-11 w-full ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.3" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill="url(#spark-fill)" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={xy.at(-1)[0]} cy={xy.at(-1)[1]} r="3" fill="currentColor" />
    </svg>
  );
}

const Card = ({ icon: I, title, tint = 'text-chart bg-chart/15', source, children, className = '' }) => (
  <section className={`flex flex-col gap-3 rounded-3xl border border-stroke bg-transparent p-5 ${className}`}>
    <div className="flex items-center gap-2.5">
      <span className={`grid size-9 place-items-center rounded-2xl ${tint}`}><I size={18} strokeWidth={1.75} /></span>
      <h2 className="flex-1 font-medium">{title}</h2>
    </div>
    {children}
    {source && <p className="mt-auto text-[11px] text-mute">Source: {source}</p>}
  </section>
);

const Line = ({ label, value, unit, change }) => (
  <div className="flex items-center justify-between gap-3 border-t border-stroke/50 py-1.5 text-sm first:border-t-0">
    <span className="text-mute">{label}</span>
    <span className="flex items-center gap-2 tabular-nums">{value}{unit && <span className="text-xs text-mute">{unit}</span>}{change}</span>
  </div>
);

// The buzz: on or off, and when (Dubai time).
function BuzzSetting({ value, onSaved }) {
  const [time, setTime] = useState(value || '07:00');
  const [saving, setSaving] = useState(false);
  const on = !!value;
  const save = async (push_at) => {
    setSaving(true);
    try { const r = await api.put('/feeds/settings', { push_at }); onSaved(r.push_at); } catch (e) { alert(e.message); }
    setSaving(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-stroke px-4 py-2.5 text-sm">
      <Bell size={16} className="text-mute" />
      <span className="flex-1">Morning buzz on my phone</span>
      {on && (
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} onBlur={() => time !== value && time && save(time)}
          aria-label="Buzz time (Dubai)" className="rounded-lg bg-white/5 px-2 py-1 tabular-nums outline-none" />
      )}
      <button role="switch" aria-checked={on} aria-label="Morning buzz" disabled={saving} onClick={() => save(on ? '' : time || '07:00')}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-p1' : 'bg-white/15'}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}

const STARTERS = ['Why did gold move today?', 'Petrol this month vs last month', 'How much is 50,000 INR in AED?', 'What does the news mean for our rents?'];

// The chat at the foot of the page. It lives only while the page is open: the feed itself
// is what is kept, and every question is answered from it.
function FeedChat() {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [msgs, busy]);
  const ask = async (q) => {
    const question = (q ?? text).trim();
    if (!question || busy) return;
    const next = [...msgs, { role: 'user', content: question }];
    setMsgs(next); setText(''); setBusy(true);
    try {
      const { answer } = await api.post('/feeds/ask', { messages: next });
      setMsgs([...next, { role: 'assistant', content: answer || 'No answer came back.' }]);
    } catch (e) {
      setMsgs([...next, { role: 'assistant', content: `Something went wrong: ${e.message}`, failed: true }]);
    }
    setBusy(false);
  };
  return (
    <Card icon={Sparkles} title="Ask Reem about today" tint="text-p2 bg-p2/15" className="md:col-span-2 xl:col-span-3">
      {msgs.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {STARTERS.map((s) => (
            <button key={s} onClick={() => ask(s)} className="rounded-full border border-stroke px-3 py-1.5 text-sm text-mute transition hover:bg-white/10 hover:text-txt">{s}</button>
          ))}
        </div>
      )}
      {msgs.length > 0 && (
        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {msgs.map((m, i) => (m.role === 'user' ? (
            <p key={i} className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-gradient-to-br from-p1 to-p2 px-3.5 py-2 text-[15px] text-white">{m.content}</p>
          ) : (
            <div key={i} className={`md max-w-[92%] break-words text-[15px] ${m.failed ? 'text-bad' : ''}`}><Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown></div>
          )))}
          {busy && <p className="flex items-center gap-2 text-sm text-mute"><Loader2 size={15} className="animate-spin" /> Thinking…</p>}
          <div ref={end} />
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="flex items-center gap-2 rounded-full border border-stroke bg-white/5 py-1 pl-4 pr-1">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about prices, rates or the news…"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] outline-none placeholder:text-mute/70" />
        <button type="submit" disabled={busy || !text.trim()} aria-label="Ask"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-p1 to-p2 text-white transition disabled:opacity-40">
          <Send size={16} />
        </button>
      </form>
    </Card>
  );
}

export default function Feeds({ onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // Which tab, remembered on this device; opens on Feeds when the browser keeps nothing.
  const [view, setView] = useState(() => { try { return localStorage.getItem('jarvis:feedsTab') === 'youtube' ? 'youtube' : 'feeds'; } catch { return 'feeds'; } });
  const pickView = (k) => { setView(k); try { localStorage.setItem('jarvis:feedsTab', k); } catch { /* private window */ } };
  const load = useCallback(() => api.get('/feeds').then((d) => { setData(d); setError(''); return d; }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  // The morning search is still running on the server: look again every 20 seconds.
  useEffect(() => {
    if (!data?.running) return undefined;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [data?.running, load]);

  // The search runs on the server; the page shows it running and looks again until done.
  const refresh = async () => {
    setRefreshing(true);
    try { await api.post('/feeds/refresh'); } catch (e) { setError(e.message); }
    await load();
    setRefreshing(false);
  };

  const action = (
    <button onClick={refresh} disabled={refreshing || data?.running} aria-label="Look everything up again" title="Look everything up again"
      className="grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt disabled:opacity-50">
      <RefreshCw size={18} className={refreshing || data?.running ? 'animate-spin' : ''} />
    </button>
  );

  if (!data) {
    return (
      <Page title="Feeds" onBack={onBack} action={action}>
        {error ? <p className="text-sm text-bad">{error}</p> : <p className="flex items-center gap-2 text-sm text-mute"><Loader2 size={16} className="animate-spin" /> Loading…</p>}
      </Page>
    );
  }

  // Today's feed, or the latest one there is while today's is being made.
  const latest = data.today?.data ? { day: data.day, data: data.today.data } : data.history[0];
  const f = latest?.data;
  const prev = latest ? data.history.find((h) => h.day < latest.day)?.data : null;
  // Oldest first, for the charts: the last 30 days that have a feed.
  const days = [...data.history].reverse().slice(-30).map((h) => h.data);
  const series = (pick) => days.map(pick);
  const stale = latest && latest.day !== data.day;

  return (
    <Page title="Feeds" onBack={onBack} action={view === 'feeds' ? action : null}>
      <div className="space-y-4">
        <div role="tablist" aria-label="Feeds or YouTube" className="mx-auto flex w-full max-w-sm gap-1 rounded-full bg-white/5 p-1 text-sm">
          {[['feeds', 'Feeds', Newspaper], ['youtube', 'YouTube', MonitorPlay]].map(([k, label, I]) => (
            <button key={k} role="tab" aria-selected={view === k} onClick={() => pickView(k)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-full py-2 transition ${view === k ? 'bg-white/15 font-medium text-txt shadow' : 'text-mute hover:text-txt'}`}>
              <I size={16} className={view === k && k === 'youtube' ? 'text-red-500' : ''} />{label}
            </button>
          ))}
        </div>

        {view === 'youtube' ? (
          <YouTubeBrowser connected={!!data.youtube} videos={data.videos || []} onVideos={(videos) => setData((d) => ({ ...d, videos }))} onConnected={() => setData((d) => ({ ...d, youtube: true }))} />
        ) : (
        <>
        <BuzzSetting value={data.settings.push_at} onSaved={(push_at) => setData((d) => ({ ...d, settings: { push_at } }))} />

        {(refreshing || data.running) && (
          <p className="flex items-center gap-2 rounded-2xl bg-p1/10 px-4 py-3 text-sm"><Loader2 size={16} className="animate-spin text-p1" /> Reem is looking everything up. This takes a minute or two.</p>
        )}
        {error && <p className="rounded-2xl bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>}
        {!refreshing && !data.running && data.today?.error && !data.today?.data && (
          <p className="flex items-start gap-2 rounded-2xl bg-warn/10 px-4 py-3 text-sm text-warn"><TriangleAlert size={16} className="mt-0.5 shrink-0" /> Today's feed could not be gathered ({data.today.error}). Reem tries again within the hour, or tap ↻.</p>
        )}

        {!f ? (
          !(refreshing || data.running) && (
            <div className="flex flex-col items-center gap-3 rounded-3xl border border-stroke px-6 py-12 text-center">
              <Sparkles size={28} className="text-p1" />
              <p className="max-w-sm text-sm text-mute">Every morning at 6 Reem gathers gold, petrol, currency, oil, EIBOR, property shares, the weather and the property news here. Nothing has been gathered yet.</p>
              <button onClick={refresh} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2.5 font-medium text-white shadow-lg shadow-p1/25 transition active:scale-[0.98]">Gather today's feed now</button>
            </div>
          )
        ) : (
          <>
            {/* The morning in two or three lines. */}
            <section className="relative overflow-hidden rounded-3xl border border-stroke bg-gradient-to-br from-p1/20 via-p2/10 to-transparent p-6">
              <p className="text-sm text-mute">{dayName(latest.day)}{data.today?.made_at && !stale ? ` · gathered at ${timeOf(data.today.made_at)}` : ''}{stale ? ' · the latest there is' : ''}</p>
              <p className="mt-1 text-2xl font-light">Good morning</p>
              {f.brief && <p className="mt-3 max-w-3xl text-[15px] leading-relaxed">{f.brief}</p>}
            </section>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <Card icon={Coins} title="Gold" tint="text-amber-400 bg-amber-400/15" source={[f.gold.source, f.gold.as_of].filter(Boolean).join(' · ')}>
                <div className="flex items-baseline gap-2">
                  <p className="text-3xl font-light tabular-nums">{fmt(f.gold.k24)}</p>
                  <span className="text-sm text-mute">AED/g · 24K</span>
                  <Change now={f.gold.k24} before={prev?.gold?.k24} />
                </div>
                <Spark values={series((d) => d.gold?.k24)} className="text-amber-400" />
                <div>
                  <Line label="22K" value={fmt(f.gold.k22)} change={<Change now={f.gold.k22} before={prev?.gold?.k22} />} />
                  <Line label="21K" value={fmt(f.gold.k21)} />
                  <Line label="18K" value={fmt(f.gold.k18)} />
                </div>
              </Card>

              <Card icon={Fuel} title={`Petrol & diesel${f.fuel.month ? ` · ${new Date(`${f.fuel.month}-01T12:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' })}` : ''}`} tint="text-rose-400 bg-rose-400/15" source={f.fuel.source}>
                <div>
                  {[['Super 98', 'super98'], ['Special 95', 'special95'], ['E-Plus 91', 'eplus91'], ['Diesel', 'diesel']].map(([label, k]) => (
                    <Line key={k} label={label} value={fmt(f.fuel[k])} unit="AED/L"
                      change={prev?.fuel?.month && prev.fuel.month !== f.fuel.month ? <Change now={f.fuel[k]} before={prev.fuel[k]} pct={false} /> : null} />
                  ))}
                </div>
                <p className="text-[11px] text-mute">Set once a month by the UAE Fuel Price Committee.</p>
              </Card>

              <Card icon={ArrowLeftRight} title="Currency to AED" tint="text-sky-400 bg-sky-400/15" source={f.fx.source}>
                <div>
                  {['USD', 'EUR', 'GBP'].map((c) => (
                    <Line key={c} label={`1 ${c}`} value={fmt(f.fx[c], 4)} unit="AED" change={<Change now={f.fx[c]} before={prev?.fx?.[c]} />} />
                  ))}
                  {/* Rupees are small against the dirham: the way people say it is "1 AED = x". */}
                  {['INR', 'PKR'].map((c) => (
                    <Line key={c} label={`1 AED`} value={f.fx[c] ? fmt(1 / f.fx[c], 2) : '–'} unit={c} change={<Change now={f.fx[c] ? 1 / f.fx[c] : null} before={prev?.fx?.[c] ? 1 / prev.fx[c] : null} />} />
                  ))}
                </div>
              </Card>

              <Card icon={Droplet} title="Brent oil" tint="text-emerald-400 bg-emerald-400/15" source={f.brent.source}>
                <div className="flex items-baseline gap-2">
                  <p className="text-3xl font-light tabular-nums">${fmt(f.brent.usd)}</p>
                  <span className="text-sm text-mute">a barrel</span>
                  <Change now={f.brent.usd} before={prev?.brent?.usd} />
                </div>
                <Spark values={series((d) => d.brent?.usd)} className="text-emerald-400" />
                <p className="text-[11px] text-mute">Moves the UAE economy and next month's petrol price.</p>
              </Card>

              <Card icon={Landmark} title="EIBOR" tint="text-violet-400 bg-violet-400/15" source={[f.eibor.source, f.eibor.as_of].filter(Boolean).join(' · ')}>
                <div className="flex items-baseline gap-2">
                  <p className="text-3xl font-light tabular-nums">{fmt(f.eibor.m3, 3)}%</p>
                  <span className="text-sm text-mute">3 months</span>
                  <Change now={f.eibor.m3} before={prev?.eibor?.m3} digits={3} pct={false} />
                </div>
                <Spark values={series((d) => d.eibor?.m3)} className="text-violet-400" />
                <div>
                  <Line label="1 month" value={`${fmt(f.eibor.m1, 3)}%`} />
                  <Line label="6 months" value={`${fmt(f.eibor.m6, 3)}%`} />
                </div>
                <p className="text-[11px] text-mute">UAE mortgage rates are set from this.</p>
              </Card>

              <Card icon={CloudSun} title="Dubai weather" tint="text-orange-400 bg-orange-400/15">
                <div className="flex items-baseline gap-3">
                  <p className="text-3xl font-light tabular-nums">{f.weather.high != null ? `${Math.round(f.weather.high)}°` : '–'}</p>
                  <span className="text-sm text-mute">low {f.weather.low != null ? `${Math.round(f.weather.low)}°` : '–'}{f.weather.humidity != null ? ` · humidity ${Math.round(f.weather.humidity)}%` : ''}</span>
                </div>
                {f.weather.summary && <p className="text-sm">{f.weather.summary}</p>}
                {f.weather.warning && <p className="flex items-start gap-2 rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn"><TriangleAlert size={15} className="mt-0.5 shrink-0" />{f.weather.warning}</p>}
              </Card>

              {f.stocks.length > 0 && (
                <Card icon={TrendingUp} title="Property shares" tint="text-teal-400 bg-teal-400/15" className="md:col-span-2 xl:col-span-3">
                  <div className="grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
                    {f.stocks.map((s) => (
                      <Line key={s.symbol || s.name} label={<span><span className="text-txt">{s.name}</span> <span className="text-[11px]">{s.market}</span></span>}
                        value={fmt(s.price)} unit="AED"
                        change={s.change_pct != null && (
                          <span className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${s.change_pct >= 0 ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad'}`}>
                            {s.change_pct >= 0 ? '▲' : '▼'} {Math.abs(s.change_pct).toFixed(2)}%
                          </span>
                        )} />
                    ))}
                  </div>
                  <p className="text-[11px] text-mute">Last trading day's close.</p>
                </Card>
              )}

              {f.news.length > 0 && (
                <Card icon={Newspaper} title="Property news" tint="text-pink-400 bg-pink-400/15" className="md:col-span-2 xl:col-span-3">
                  <ul className="grid gap-4 md:grid-cols-2">
                    {f.news.map((n, i) => (
                      <li key={i} className="space-y-1">
                        <p className="font-medium leading-snug">{n.title}</p>
                        {n.summary && <p className="text-sm text-mute">{n.summary}</p>}
                        <p className="text-[11px] text-mute">
                          {n.url ? <a href={n.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-txt">{n.source || 'Read'} <ExternalLink size={11} /></a> : n.source}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <FeedChat />
            </div>
          </>
        )}
        </>
        )}
      </div>
    </Page>
  );
}
