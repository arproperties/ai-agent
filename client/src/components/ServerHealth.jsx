import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Info } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// Server health, the master's alone (server/serverHealth.js): is the server all right today,
// and how fast is it filling up? The growth charts are the point: they say when a bigger
// server, or moving files off it, is needed, before anyone feels it slow down.

const size = (b) => {
  if (!b) return '0 MB';
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  return `${Math.round(b / 1e6)} MB`;
};
const pct = (part, whole) => `${Math.round((part / (whole || 1)) * 100)}%`;
const ago = (secs) => {
  const s = Date.now() / 1000 - secs;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const upFor = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);
const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });

const DOT = { green: 'bg-ok', amber: 'bg-warn', red: 'bg-bad' };
const WORD = { green: 'OK', amber: 'Keep an eye on it', red: 'Act soon' };

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

function Tile({ label, light, value, sub, bar }) {
  return (
    <div className="rounded-3xl border border-stroke bg-white/[0.03] p-4">
      <p className="flex items-center gap-1.5 text-xs text-mute">
        {light && <span className={`size-2 rounded-full ${DOT[light]}`} aria-label={WORD[light]} />}{label}
      </p>
      <p className="mt-1 text-2xl font-light tabular-nums">{value}</p>
      {bar != null && (
        <div className="mt-1.5 h-1.5 rounded-full bg-white/5">
          <div className={`h-full rounded-full ${DOT[light] || 'bg-chart'}`} style={{ width: `${Math.min(100, Math.max(1, bar * 100))}%` }} />
        </div>
      )}
      <p className="mt-1 text-xs text-mute tabular-nums">{sub}</p>
    </div>
  );
}

// What each chart shows, from the daily readings.
const SERIES = {
  disk: { label: 'Disk', value: (d) => d.disk_used, of: (d) => d.disk_total },
  memory: { label: 'Memory', value: (d) => d.mem_used, of: (d) => d.mem_total },
  database: { label: 'Database', value: (d) => d.db_bytes },
  uploads: { label: 'Uploads', value: (d) => d.uploads_bytes },
};

// Growth per week, from the first and last day in the chart. Only said when there are at
// least a few days, or one busy afternoon would read as a trend.
function growth(list, key) {
  if (list.length < 4) return null;
  const s = SERIES[key];
  const first = list[0], last = list[list.length - 1];
  const days = (new Date(last.day) - new Date(first.day)) / 864e5 || 1;
  const perWeek = ((s.value(last) - s.value(first)) / days) * 7;
  const room = s.of ? s.of(last) - s.value(last) : null;
  return { perWeek, weeksLeft: room != null && perWeek > 0 ? room / perWeek : null };
}

function Growth({ history }) {
  const [key, setKey] = useState('disk');
  const [on, setOn] = useState(null);
  if (!history.length) {
    return <p className="text-sm text-mute">The first reading is taken within the hour, then one every hour. Come back in a few days to see the trend.</p>;
  }
  const s = SERIES[key];
  const max = Math.max(...history.map((d) => (s.of ? s.of(d) : s.value(d))), 1);
  const pick = history[on ?? history.length - 1];
  const g = growth(history, key);
  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-full bg-white/5 p-1 text-sm" role="tablist" aria-label="What to show">
        {Object.entries(SERIES).map(([k, v]) => (
          <button key={k} role="tab" aria-selected={key === k} onClick={() => { setKey(k); setOn(null); }}
            className={`flex-1 rounded-full py-1.5 transition ${key === k ? 'bg-white/15 text-txt' : 'text-mute'}`}>{v.label}</button>
        ))}
      </div>
      <p className="text-sm tabular-nums">
        <span className="text-mute">{dayName(pick.day)}: </span>{size(s.value(pick))}
        {s.of && <span className="text-mute"> of {size(s.of(pick))} ({pct(s.value(pick), s.of(pick))})</span>}
      </p>
      <div className="flex h-36 items-end gap-[2px] border-b border-stroke" onMouseLeave={() => setOn(null)}>
        {history.map((d, i) => (
          <button key={d.day} onMouseEnter={() => setOn(i)} onClick={() => setOn(i)} aria-label={`${dayName(d.day)}: ${size(s.value(d))}`}
            className="flex h-full flex-1 items-end">
            <span className={`block w-full rounded-t-[4px] bg-chart transition-opacity ${on === null || on === i ? 'opacity-100' : 'opacity-45'}`}
              style={{ height: `${Math.max(2, (s.value(d) / max) * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-mute">
        <span>{dayName(history[0].day)}</span><span>Today</span>
      </div>
      {g && key !== 'memory' && (
        <p className="text-sm text-mute">
          Growing about <span className="text-txt">{size(Math.abs(g.perWeek))}</span> a week{g.perWeek < 0 ? ' (shrinking)' : ''}.
          {g.weeksLeft != null && <> At this pace it is full in about <span className="text-txt">{g.weeksLeft > 104 ? 'over 2 years' : `${Math.round(g.weeksLeft)} weeks`}</span>.</>}
        </p>
      )}
      {key === 'memory' && <p className="text-sm text-mute">Each day's busiest hour. If these bars keep reaching the top, the server needs more memory.</p>}
    </div>
  );
}

function Ranked({ rows }) {
  const max = Math.max(...rows.map((r) => r.bytes), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.name}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">{r.label || r.name}</span>
            <span className="shrink-0 tabular-nums text-mute">{size(r.bytes)}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-white/5">
            <div className="h-full rounded-full bg-chart" style={{ width: `${Math.max(1, (r.bytes / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// Plain names for the folders under data/ and the biggest database tables.
const FOLDER_NAMES = { uploads: 'Shelf uploads', tts: 'Read-aloud audio (cleans itself)', models: 'AI search model', 'draft-files': 'Email attachments', meetings: 'Meeting recordings', messenger: 'Messenger files' };
const TABLE_NAMES = { chunks: 'Shelf search data', memories: 'Memories', documents: 'Shelf documents', messages: 'Chat messages', voice_profiles: 'Voice profiles', document_texts: 'Document text', ai_costs: 'Billing records' };

// What to do about whatever is not green, in plain words.
function advice(now) {
  const out = [];
  if (now.memory.light !== 'green') out.push('Memory is running low. A bigger server size (4 GB RAM) is the fix: in AWS, stop the server, change its size, start it again. About 5 minutes down.');
  if (now.disk.light !== 'green') out.push('The disk is filling up. Delete old backups first; if it is still high, move Shelf uploads to S3 or make the disk bigger.');
  if (now.cpu.light !== 'green') out.push('The processor is busy. If this stays amber for days, a bigger server size helps.');
  if (now.backups.light !== 'green') out.push(now.backups.newest ? 'The newest database backup is several days old. Take a fresh one.' : 'No database backup found on the server.');
  if (now.backups.newest) out.push('Backups are kept on this same server: if the server is lost, they go with it. A nightly copy to S3 fixes this.');
  return out;
}

export default function ServerHealth({ onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setBusy(true);
    api.get('/server-health').then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)).finally(() => setBusy(false));
  }, []);
  // A minute is fresh enough for memory and load; the rest moves slowly.
  useEffect(() => { load(); const t = setInterval(load, 60e3); return () => clearInterval(t); }, [load]);

  const now = data?.now;
  const memUsed = now ? now.memory.total - now.memory.available : 0;
  return (
    <Page title="Server health" onBack={onBack}
      action={<button onClick={load} aria-label="Refresh" className="rounded-full p-2 text-mute hover:bg-white/5"><RefreshCw size={17} className={busy ? 'animate-spin' : ''} /></button>}>
      <div className="mx-auto max-w-3xl space-y-4">
        {error && <p className="text-sm text-bad">{error}</p>}
        {!now ? <Loader2 className="mx-auto my-10 animate-spin text-mute" /> : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile label="Disk" light={now.disk.light} value={pct(now.disk.used, now.disk.total)} bar={now.disk.used / now.disk.total}
                sub={`${size(now.disk.free)} free of ${size(now.disk.total)}`} />
              <Tile label="Memory" light={now.memory.light} value={pct(memUsed, now.memory.total)} bar={memUsed / now.memory.total}
                sub={`Reem ${size(now.memory.app)} · ${size(now.memory.available)} free${now.memory.swapUsed > 0 ? ` · swap ${size(now.memory.swapUsed)}` : ''}`} />
              <Tile label="Database" value={size(now.database.bytes)} sub="Shelf, chats, memories" />
              <Tile label="Backups" light={now.backups.light} value={now.backups.newest ? ago(now.backups.newest.at) : 'None'}
                sub={`${now.backups.count} kept · ${size(now.backups.bytes)}`} />
            </div>

            {advice(now).length > 0 && (
              <Card>
                <ul className="space-y-1.5 text-sm">
                  {advice(now).map((a) => <li key={a} className="flex gap-2"><Info size={15} className="mt-0.5 shrink-0 text-mute" />{a}</li>)}
                </ul>
              </Card>
            )}

            <Card title="Growth" hint="One bar per day, from the hourly readings. This is what tells you when to act.">
              <Growth history={data.history} />
            </Card>

            <Card title="Last 24 hours">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
                <p><span className="tabular-nums">{now.activity.people}</span> <span className="text-mute">people active</span></p>
                <p><span className="tabular-nums">{now.activity.messages}</span> <span className="text-mute">chat messages</span></p>
                <p><span className="tabular-nums">{now.activity.uploads}</span> <span className="text-mute">files added</span></p>
                <p><span className="tabular-nums">${now.activity.ai_usd.toFixed(2)}</span> <span className="text-mute">spent on AI</span></p>
                <p className={now.activity.server_errors ? 'text-warn' : ''}><span className="tabular-nums">{now.activity.server_errors}</span> <span className={now.activity.server_errors ? '' : 'text-mute'}>server errors</span></p>
                <p><span className="tabular-nums">{now.activity.client_errors}</span> <span className="text-mute">app errors</span></p>
              </div>
            </Card>

            <Card title="What takes the disk" hint={now.folders ? `Counted ${ago(now.folders.at)}.` : 'Being counted, check back in a minute.'}>
              {now.folders && <Ranked rows={Object.entries(now.folders.sizes).filter(([, b]) => b > 1e6).sort((a, b) => b[1] - a[1])
                .map(([name, bytes]) => ({ name, bytes, label: FOLDER_NAMES[name] }))} />}
            </Card>

            <Card title="What takes the database">
              <Ranked rows={now.database.tables.map((t) => ({ ...t, label: TABLE_NAMES[t.name] }))} />
            </Card>

            <Card title="The server">
              <ul className="space-y-1 text-sm">
                <li className="flex items-center gap-1.5"><span className={`size-2 rounded-full ${DOT[now.cpu.light]}`} />
                  <span className="text-mute">Processor:</span> {now.cpu.cores} cores, load {now.cpu.load.toFixed(2)}</li>
                <li><span className="text-mute">Reem running for:</span> {upFor(now.app.uptime)} <span className="text-mute">(it restarts with each update)</span></li>
                <li><span className="text-mute">Newest backup:</span> {now.backups.newest ? `${now.backups.newest.name}, ${size(now.backups.newest.bytes)}` : 'none'}</li>
                <li><span className="text-mute">Node:</span> {now.app.node}</li>
              </ul>
            </Card>
          </>
        )}
      </div>
    </Page>
  );
}
