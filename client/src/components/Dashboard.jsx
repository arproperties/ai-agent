import { COLORS, barShare, barValue } from '../../../server/dashboardCore.js';

// A dashboard Reem wrote in a reply (server/dashboardCore.js): number boxes, then bar charts,
// then the colour key. Drawn with plain boxes, so it follows the light and dark themes.
// Bars run sideways, so a long label ("21791/2026 (Appeal 24757/2026)") still fits on a phone.

const rgb = (c) => COLORS[c] || COLORS.blue;

function Tile({ t }) {
  return (
    <div className="glass rounded-2xl px-3.5 py-3" style={t.color ? { boxShadow: `inset 3px 0 0 rgb(${rgb(t.color)})` } : undefined}>
      <p dir="auto" className="text-[11px] font-medium tracking-wide text-mute">{t.label}</p>
      <p dir="auto" className="mt-0.5 text-2xl font-semibold leading-tight text-hi">{t.value}</p>
      {t.note && <p dir="auto" className="mt-0.5 text-[11px] text-mute">{t.note}</p>}
    </div>
  );
}

function Chart({ chart }) {
  return (
    <div className="glass rounded-2xl px-3.5 py-3">
      {chart.title && <p dir="auto" className="mb-2.5 text-[13px] font-medium">{chart.title}</p>}
      {/* On a phone the label sits above its bar, so the bars keep the width. */}
      <div className="space-y-2 sm:grid sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)] sm:items-center sm:gap-x-3 sm:gap-y-2 sm:space-y-0">
        {chart.bars.map((b, i) => (
          <div key={i} className="sm:contents">
            <span dir="auto" title={b.note || b.label} className="block truncate text-[12px] text-txt/90 sm:max-w-[260px]">{b.label}</span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-3.5 rounded-full" style={{ width: `${Math.max(2, barShare(chart, b) * 85)}%`, background: `rgb(${rgb(b.color)})` }} />
              <span className="shrink-0 text-[12px] tabular-nums text-mute">{barValue(chart, b)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardCard({ dashboard: d }) {
  if (!d) return <div className="my-3 rounded-2xl border border-stroke px-4 py-3 text-sm text-mute">This dashboard could not be shown.</div>;
  return (
    <div className="my-3 space-y-2.5">
      {(d.title || d.subtitle) && (
        <div>
          {d.title && <p dir="auto" className="text-[15px] font-semibold">{d.title}</p>}
          {d.subtitle && <p dir="auto" className="text-xs text-mute">{d.subtitle}</p>}
        </div>
      )}
      {d.tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {d.tiles.map((t, i) => <Tile key={i} t={t} />)}
        </div>
      )}
      {d.charts.map((c, i) => <Chart key={i} chart={c} />)}
      {d.legend.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-1">
          {d.legend.map((l) => (
            <span key={l.color} dir="auto" className="flex items-center gap-1.5 text-xs text-mute">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: `rgb(${rgb(l.color)})` }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function DashboardPending() {
  return (
    <div className="my-3 flex items-center gap-2 rounded-2xl border border-stroke px-4 py-3 text-sm text-mute">
      <span className="size-2 animate-pulse rounded-full bg-p1" /> Making the dashboard…
    </div>
  );
}
