import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X, Sparkles } from 'lucide-react';
import { COLORS, barShare, barValue, slices, arcPath, linePoints, askAbout } from '../../../server/dashboardCore.js';

// A dashboard Reem wrote in a reply (server/dashboardCore.js): number boxes, then charts of
// the kinds the agent picked for the question (bars, donut rings, a trend line, gauges, a
// timeline), then the colour key. A dark glowing panel whose bars grow and rings draw in.
// Tapping a bar, slice, point, gauge or date asks Reem about it in the chat (`onAsk`), and the
// whole dashboard opens full screen for a meeting. Drawn here, so it costs no AI to show.

const rgb = (c) => COLORS[c] || COLORS.blue;
const glow = (c, a = 0.45) => `0 0 14px rgba(${rgb(c)}, ${a})`;
const delay = (k) => ({ animationDelay: `${Math.min(k, 12) * 60}ms` });

// A part of a chart that can be tapped to ask about it - or plain, when there is no chat to ask in.
function Tap({ ask, className = '', children, title, style }) {
  if (!ask) return <div className={className} style={style}>{children}</div>;
  return (
    <button type="button" onClick={ask} title={title || 'Tap to ask Reem about this'} style={style}
      className={`${className} rounded-lg text-left outline-none transition hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-p1/60`}>
      {children}
    </button>
  );
}

function Tile({ t, k }) {
  const c = t.color || 'purple';
  return (
    <div className="dash-fade relative overflow-hidden rounded-2xl border border-stroke bg-white/[0.035] px-3.5 py-3" style={delay(k)}>
      <span className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, rgb(${rgb(c)}), transparent)` }} />
      <span className="pointer-events-none absolute -right-6 -top-8 size-20 rounded-full blur-2xl" style={{ background: `rgba(${rgb(c)}, 0.14)` }} />
      <p dir="auto" className="relative text-[10.5px] font-medium uppercase tracking-[0.08em] text-mute">{t.label}</p>
      <p dir="auto" className="relative mt-1 text-[26px] font-semibold leading-none tabular-nums text-hi" style={{ textShadow: `0 0 18px rgba(${rgb(c)}, 0.55)` }}>{t.value}</p>
      {t.note && <p dir="auto" className="relative mt-1 text-[11px] text-mute">{t.note}</p>}
    </div>
  );
}

function Bars({ chart, ask }) {
  // Every row is its own button, so the label column is the same width on each: as wide as the
  // longest label, up to 40% of the card. On a phone the label sits above its bar instead.
  const longest = Math.max(...chart.items.map((b) => b.label.length));
  return (
    <div className="space-y-0.5" style={{ '--dash-label': `min(${longest + 1}ch, 40%)` }}>
      {chart.items.map((b, i) => (
        <Tap key={i} ask={ask && (() => ask(b))} className="block w-full px-1 py-1 sm:grid sm:grid-cols-[var(--dash-label)_minmax(0,1fr)] sm:items-center sm:gap-3">
          <span dir="auto" className="block truncate text-[12px] text-txt/90">{b.label}</span>
          <span className="mt-1 flex min-w-0 items-center gap-2 sm:mt-0">
            <span className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
              <span className="dash-grow absolute inset-y-0 left-0 rounded-full"
                style={{ ...delay(i), width: `${Math.max(2, barShare(chart, b) * 100)}%`, background: `linear-gradient(90deg, rgba(${rgb(b.color)}, 0.45), rgb(${rgb(b.color)}))`, boxShadow: glow(b.color) }} />
            </span>
            <span className="w-[72px] shrink-0 text-right text-[12px] tabular-nums text-mute">{barValue(chart, b)}</span>
          </span>
        </Tap>
      ))}
    </div>
  );
}

function Donut({ chart, ask }) {
  const parts = slices(chart);
  const total = chart.items.reduce((a, i) => a + i.value, 0);
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
      <svg viewBox="0 0 120 120" className="size-36 shrink-0" style={{ filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.25))' }}>
        <circle cx="60" cy="60" r="46" fill="none" stroke="currentColor" className="text-white/[0.06]" strokeWidth="14" />
        {parts.filter((p) => p.share > 0).map((p, i) => (
          <path key={i} d={arcPath(60, 60, 46, p.from + 0.004, p.to - 0.004)} fill="none" stroke={`rgb(${rgb(p.color)})`} strokeWidth="14"
            pathLength="1" className="dash-draw" style={{ ...delay(i * 2), filter: `drop-shadow(0 0 4px rgba(${rgb(p.color)}, 0.6))`, cursor: ask ? 'pointer' : undefined }}
            onClick={ask ? () => ask(p) : undefined} />
        ))}
        <text x="60" y="58" textAnchor="middle" className="fill-hi" style={{ fontSize: 20, fontWeight: 600 }}>{total.toLocaleString('en-US', { maximumFractionDigits: 1 })}</text>
        <text x="60" y="74" textAnchor="middle" className="fill-mute" style={{ fontSize: 9, letterSpacing: '0.08em' }}>{(chart.unit || 'TOTAL').toUpperCase()}</text>
      </svg>
      <div className="w-full min-w-0 space-y-0.5">
        {parts.map((p, i) => (
          <Tap key={i} ask={ask && (() => ask(p))} className="flex w-full items-center gap-2 px-1.5 py-1">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: `rgb(${rgb(p.color)})`, boxShadow: glow(p.color, 0.7) }} />
            <span dir="auto" className="min-w-0 flex-1 truncate text-[12px] text-txt/90">{p.label}</span>
            <span className="shrink-0 text-[12px] tabular-nums text-mute">{barValue(chart, p)} · {Math.round(p.share * 100)}%</span>
          </Tap>
        ))}
      </div>
    </div>
  );
}

function Line({ chart, ask }) {
  // The line and its shading stretch to the card at a fixed height; the points are placed over
  // them as buttons, so they stay round and can be tapped.
  const W = 300, H = 100;
  const pts = linePoints(chart, W, H);
  const c = rgb(chart.color);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const id = `dash-area${useId().replace(/:/g, '')}`;
  const label = (k) => pts[k] && <span dir="auto" className="truncate">{pts[k].label}</span>;
  const top = Math.max(...chart.items.map((i) => i.value));
  const small = pts.length > 24;
  return (
    <div>
      <div className="mb-2 flex justify-between text-[11px] text-mute">
        <span>Highest {barValue(chart, { value: top })}</span>
        <span>Latest <b className="font-semibold text-hi">{barValue(chart, pts.at(-1))}</b></span>
      </div>
      <div className="relative mx-1.5 h-36">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="dash-reveal absolute inset-0 size-full overflow-visible">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={`rgb(${c})`} stopOpacity="0.35" />
              <stop offset="1" stopColor={`rgb(${c})`} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="currentColor" className="text-white/[0.07]" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />)}
          <path d={`${path} L ${W} ${H} L 0 ${H} Z`} fill={`url(#${id})`} className="dash-fade" />
          <path d={path} fill="none" stroke={`rgb(${c})`} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
            style={{ filter: `drop-shadow(0 0 5px rgba(${c}, 0.8))` }} />
        </svg>
        {pts.map((p, i) => {
          const dot = <span className={`dash-fade block rounded-full ${small ? 'size-1.5' : 'size-2.5'}`} style={{ ...delay(i), background: `rgb(${rgb(p.color === 'blue' ? chart.color : p.color)})`, boxShadow: `0 0 8px rgba(${c}, 0.9)` }} />;
          const at = { left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` };
          const tip = `${p.label}: ${barValue(chart, p)}`;
          return ask ? (
            <button key={i} type="button" onClick={() => ask(p)} title={tip} aria-label={tip} style={at}
              className="absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-p1/60">{dot}</button>
          ) : <span key={i} title={tip} style={at} className="absolute -translate-x-1/2 -translate-y-1/2">{dot}</span>;
        })}
      </div>
      <div className="mt-2 grid grid-cols-3 text-[11px] text-mute">
        {label(0)}<span className="text-center">{pts.length > 2 && label(Math.floor((pts.length - 1) / 2))}</span><span className="text-right">{label(pts.length - 1)}</span>
      </div>
    </div>
  );
}

function Gauges({ chart, ask }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {chart.items.map((g, i) => {
        const share = Math.min(1, g.value / g.max);
        return (
          <Tap key={i} ask={ask && (() => ask(g))} className="flex flex-col items-center px-1 py-1.5">
            <svg viewBox="0 0 100 100" className="size-24">
              <path d={arcPath(50, 50, 38, -0.375, 0.375)} fill="none" stroke="currentColor" className="text-white/[0.07]" strokeWidth="9" strokeLinecap="round" />
              {share > 0 && (
                <path d={arcPath(50, 50, 38, -0.375, -0.375 + 0.75 * share)} fill="none" stroke={`rgb(${rgb(g.color)})`} strokeWidth="9" strokeLinecap="round"
                  pathLength="1" className="dash-draw" style={{ ...delay(i * 2), filter: `drop-shadow(0 0 5px rgba(${rgb(g.color)}, 0.7))` }} />
              )}
              <text x="50" y="55" textAnchor="middle" className="fill-hi" style={{ fontSize: 19, fontWeight: 600 }}>{Math.round(share * 100)}%</text>
              <text x="50" y="72" textAnchor="middle" className="fill-mute" style={{ fontSize: 8.5 }}>{`${g.value.toLocaleString('en-US')} / ${g.max.toLocaleString('en-US')}`}</text>
            </svg>
            <span dir="auto" className="-mt-1 line-clamp-2 text-center text-[12px] text-txt/90">{g.label}</span>
          </Tap>
        );
      })}
    </div>
  );
}

function Timeline({ chart, ask }) {
  return (
    <ol className="relative ml-1.5 border-l border-white/10 pl-0">
      {chart.items.map((t, i) => (
        <li key={i} className="dash-fade relative" style={delay(i)}>
          <span className="absolute -left-[5px] top-[11px] size-2.5 rounded-full" style={{ background: `rgb(${rgb(t.color)})`, boxShadow: glow(t.color, 0.8) }} />
          <Tap ask={ask && (() => ask(t))} className="ml-3 block w-[calc(100%-0.75rem)] px-2 py-1.5">
            {t.date && <span className="block font-mono text-[11px] tracking-wide" style={{ color: `rgb(${rgb(t.color)})` }}>{t.date}</span>}
            <span dir="auto" className="block text-[13px] text-txt/90">{t.label}</span>
            {t.note && <span dir="auto" className="block text-[11.5px] text-mute">{t.note}</span>}
          </Tap>
        </li>
      ))}
    </ol>
  );
}

const DRAW = { bar: Bars, donut: Donut, line: Line, gauge: Gauges, timeline: Timeline };
// Bars and timelines need the width; rings, gauges and lines sit two to a row on a wide screen.
const WIDE = new Set(['bar', 'timeline']);

function Chart({ chart, ask, k, wide }) {
  const Draw = DRAW[chart.type] || Bars;
  return (
    <div className={`dash-fade rounded-2xl border border-stroke bg-white/[0.03] px-3.5 py-3 ${wide ? 'md:col-span-2' : ''}`} style={delay(k + 2)}>
      {chart.title && <p dir="auto" className="mb-2.5 text-[12px] font-medium uppercase tracking-[0.08em] text-mute">{chart.title}</p>}
      <Draw chart={chart} ask={ask && ((item) => ask(chart, item))} />
    </div>
  );
}

function Body({ d, ask, big }) {
  // Rings, gauges and lines sit two to a row; one left over takes the whole row, so no row is half empty.
  const narrow = d.charts.filter((c) => !WIDE.has(c.type));
  const wide = (c) => WIDE.has(c.type) || (narrow.length % 2 === 1 && c === narrow.at(-1));
  return (
    <div className="space-y-2.5">
      {d.tiles.length > 0 && (
        <div className={`grid grid-cols-2 gap-2 ${big ? 'md:grid-cols-4' : 'sm:grid-cols-4'}`}>
          {d.tiles.map((t, i) => <Tile key={i} t={t} k={i} />)}
        </div>
      )}
      <div className="grid gap-2.5 md:grid-cols-2">
        {d.charts.map((c, i) => <Chart key={i} chart={c} ask={ask} k={i} wide={wide(c)} />)}
      </div>
      {d.legend.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-1">
          {d.legend.map((l) => (
            <span key={l.color} dir="auto" className="flex items-center gap-1.5 text-xs text-mute">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: `rgb(${rgb(l.color)})`, boxShadow: glow(l.color, 0.7) }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      {ask && <p className="flex items-center gap-1.5 px-1 text-[11px] text-mute/80"><Sparkles size={12} className="text-p1" /> Tap any bar, ring or date to ask Reem about it.</p>}
    </div>
  );
}

function Head({ d, children }) {
  return (
    <div className="mb-3 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        {d.title && <p dir="auto" className="bg-gradient-to-r from-txt to-p1 bg-clip-text text-[16px] font-semibold text-transparent">{d.title}</p>}
        {d.subtitle && <p dir="auto" className="text-xs text-mute">{d.subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

// The whole dashboard over the screen, for showing in a meeting. Esc or ✕ closes it.
function FullScreen({ d, ask, onClose }) {
  useEffect(() => {
    const key = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-bg/95 backdrop-blur-xl" role="dialog" aria-modal="true" aria-label={d.title || 'Dashboard'}>
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(167,139,250,0.16),transparent_60%)]" />
      <div className="relative mx-auto max-w-6xl px-4 py-5 md:px-8 md:py-8">
        <Head d={d}>
          <button onClick={onClose} aria-label="Close full screen" className="glass grid size-10 shrink-0 place-items-center rounded-full hover:bg-white/10"><X size={18} /></button>
        </Head>
        <Body d={d} big ask={ask && ((c, i) => { onClose(); ask(c, i); })} />
      </div>
    </div>,
    document.body,
  );
}

export function DashboardCard({ dashboard: d, onAsk }) {
  const [full, setFull] = useState(false);
  if (!d) return <div className="my-3 rounded-2xl border border-stroke px-4 py-3 text-sm text-mute">This dashboard could not be shown.</div>;
  const ask = onAsk && ((chart, item) => onAsk(askAbout(d, chart, item)));
  return (
    <div className="relative my-3 overflow-hidden rounded-3xl border border-p1/25 bg-surface/70 p-3.5 shadow-[0_0_40px_-12px_rgba(167,139,250,0.45)] md:p-4">
      {/* The glow at the top and a light that sweeps across once as it arrives. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(167,139,250,0.14),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(56,189,248,0.10),transparent_55%)]" />
      <div className="pointer-events-none absolute inset-0 overflow-hidden"><div className="dash-sweep h-full w-1/2 bg-gradient-to-r from-transparent via-white/[0.05] to-transparent" /></div>
      <div className="relative">
        <Head d={d}>
          <button onClick={() => setFull(true)} aria-label="Open full screen" title="Full screen"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-stroke px-2.5 text-xs text-mute transition hover:bg-white/10 hover:text-txt">
            <Maximize2 size={13} /> Full screen
          </button>
        </Head>
        <Body d={d} ask={ask} />
      </div>
      {full && <FullScreen d={d} ask={ask} onClose={() => setFull(false)} />}
    </div>
  );
}

export function DashboardPending() {
  return (
    <div className="relative my-3 overflow-hidden rounded-3xl border border-p1/25 bg-surface/70 px-4 py-4 text-sm text-mute">
      <div className="pointer-events-none absolute inset-0 overflow-hidden"><div className="dash-sweep h-full w-1/2 bg-gradient-to-r from-transparent via-p1/10 to-transparent" style={{ animationIterationCount: 'infinite' }} /></div>
      <span className="relative flex items-center gap-2"><Sparkles size={14} className="animate-pulse text-p1" /> Building the dashboard…</span>
    </div>
  );
}
