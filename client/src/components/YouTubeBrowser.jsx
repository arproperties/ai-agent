import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Loader2, Pin, PinOff, X, ExternalLink, Radio, KeyRound, MonitorPlay, Flame, ChevronDown } from 'lucide-react';
import { api } from '../lib/api';
import YouTube, { youTubeId } from './YouTube';

// YouTube inside the Feeds page (server/youtube.js): search, trending in the UAE, a channel's
// latest, and the videos the master pinned. Tapping a video plays it at the top in YouTube's
// own player. Search needs the master's YouTube key; pinned videos and pasted links do not.

const views = (n) => (n == null ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B views` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M views` : n >= 1e3 ? `${Math.round(n / 1e3)}K views` : `${n} views`);
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`;
  if (s < 86400 * 365) return `${Math.round(s / 86400 / 30)} months ago`;
  return `${Math.round(s / 86400 / 365)} years ago`;
}
const pinnedTile = (v) => ({ id: v.video_id, title: v.title, thumb: `https://i.ytimg.com/vi/${v.video_id}/hqdefault.jpg`, pinId: v.id });

function Tile({ v, onPlay, active }) {
  return (
    <button onClick={() => onPlay(v)} className="group flex flex-col gap-2 text-left">
      <span className={`relative block aspect-video w-full overflow-hidden rounded-xl bg-white/5 ring-2 transition ${active ? 'ring-red-500' : 'ring-transparent'}`}>
        <img src={v.thumb} alt="" loading="lazy" className="size-full object-cover transition duration-300 group-hover:scale-105" />
        {v.live ? (
          <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white"><Radio size={11} /> LIVE</span>
        ) : v.duration && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">{v.duration}</span>
        )}
      </span>
      <span className="line-clamp-2 text-sm font-medium leading-snug">{v.title || 'Video'}</span>
      {(v.channel || v.views != null) && (
        <span className="-mt-1 text-xs text-mute">{[v.channel, views(v.views), ago(v.published)].filter(Boolean).join(' · ')}</span>
      )}
    </button>
  );
}

// How to get a key, and the box to paste it in.
function KeySetup({ onSaved, onCancel }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { await api.put('/feeds/youtube/key', { key }); onSaved(); } catch (err) { alert(err.message); }
    setBusy(false);
  };
  return (
    <div className="space-y-3 rounded-2xl border border-stroke p-4">
      <p className="flex items-center gap-2 font-medium"><KeyRound size={16} className="text-red-500" /> Connect YouTube search</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-mute">
        <li>Open <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-txt underline">Google Cloud → YouTube Data API v3</a> (sign in with any Google account) and tap <b>Enable</b>.</li>
        <li>Go to <b>Credentials → Create credentials → API key</b> and copy it.</li>
        <li>Paste it here. It is free, and kept encrypted.</li>
      </ol>
      <form onSubmit={save} className="flex gap-2">
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" autoComplete="off" spellCheck={false}
          className="min-w-0 flex-1 rounded-full border border-stroke bg-white/5 px-4 py-2 font-mono text-sm outline-none" />
        <button disabled={busy || !key.trim()} className="rounded-full bg-red-600 px-4 text-sm font-medium text-white disabled:opacity-40">
          {busy ? <Loader2 size={16} className="animate-spin" /> : 'Save'}
        </button>
        {onCancel && <button type="button" onClick={onCancel} className="rounded-full px-3 text-sm text-mute hover:text-txt">Cancel</button>}
      </form>
    </div>
  );
}

export default function YouTubeBrowser({ connected, videos, onVideos, onConnected }) {
  const [tab, setTab] = useState(connected ? 'trending' : 'pinned'); // trending | pinned | search | channel
  const [q, setQ] = useState('');
  const [liveOnly, setLiveOnly] = useState(false);
  const [list, setList] = useState({ items: [], next: null, label: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(null);
  const [setup, setSetup] = useState(false);
  const top = useRef(null);

  const load = useCallback(async (fn) => {
    setLoading(true); setError('');
    try { await fn(); } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (tab === 'trending' && connected) load(async () => { const r = await api.get('/feeds/youtube/trending'); setList({ items: r.items, next: null, label: '' }); });
  }, [tab, connected, load]);

  const search = (e, more = false) => {
    e?.preventDefault();
    const text = q.trim();
    if (!text) return;
    // A pasted link just plays.
    const id = youTubeId(text);
    if (id) { play({ id, title: '', thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }); setQ(''); return; }
    if (!connected) { setSetup(true); return; }
    setTab('search');
    load(async () => {
      const r = await api.get(`/feeds/youtube/search?q=${encodeURIComponent(text)}${liveOnly ? '&live=1' : ''}${more && list.next ? `&page=${list.next}` : ''}`);
      setList((l) => ({ items: more ? [...l.items, ...r.items] : r.items, next: r.next, label: text }));
    });
  };

  const openChannel = (v) => {
    if (!connected || !v.channel_id) return;
    setTab('channel');
    load(async () => { const r = await api.get(`/feeds/youtube/channel/${v.channel_id}`); setList({ items: r.items, next: null, label: r.channel }); });
  };

  const play = (v) => {
    setPlaying(v);
    requestAnimationFrame(() => top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const pinned = videos.find((p) => p.video_id === playing?.id);
  const togglePin = async () => {
    try {
      if (pinned) { await api.del(`/feeds/videos/${pinned.id}`); onVideos(videos.filter((x) => x.id !== pinned.id)); }
      else { const v = await api.post('/feeds/videos', { url: `https://www.youtube.com/watch?v=${playing.id}` }); onVideos([v, ...videos.filter((x) => x.id !== v.id)]); }
    } catch (e) { alert(e.message); }
  };

  const shown = tab === 'pinned' ? videos.map(pinnedTile) : list.items;
  const Pill = ({ k, icon: I, children }) => (
    <button onClick={() => setTab(k)} className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${tab === k ? 'bg-txt text-bg' : 'bg-white/5 text-mute hover:bg-white/10 hover:text-txt'}`}>
      {I && <I size={14} />}{children}
    </button>
  );

  return (
    <section ref={top} className="flex scroll-mt-4 flex-col gap-4 rounded-3xl border border-stroke bg-transparent p-5 md:col-span-2 xl:col-span-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-9 place-items-center rounded-2xl bg-red-500/15 text-red-500"><MonitorPlay size={18} strokeWidth={1.75} /></span>
        <h2 className="font-medium">YouTube</h2>
        <form onSubmit={search} className="order-last flex w-full items-center gap-2 rounded-full border border-stroke bg-white/5 py-1 pl-4 pr-1 md:order-none md:ml-auto md:w-[28rem]">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={connected ? 'Search YouTube or paste a link' : 'Paste a YouTube link'}
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] outline-none placeholder:text-mute/70" />
          {connected && (
            <button type="button" onClick={() => setLiveOnly((l) => !l)} aria-pressed={liveOnly} title="Live streams only"
              className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold transition ${liveOnly ? 'bg-red-600 text-white' : 'text-mute hover:text-txt'}`}>
              <Radio size={12} /> LIVE
            </button>
          )}
          <button type="submit" aria-label="Search" className="grid size-9 shrink-0 place-items-center rounded-full bg-red-600 text-white"><Search size={16} /></button>
        </form>
      </div>

      {playing && (
        <div className="space-y-3">
          <YouTube key={playing.id} id={playing.id} title={playing.title} autoplay className="mx-auto max-w-5xl" />
          <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              {playing.title && <p className="font-medium leading-snug">{playing.title}</p>}
              <p className="text-sm text-mute">
                {playing.channel && (connected && playing.channel_id
                  ? <button onClick={() => openChannel(playing)} className="hover:text-txt hover:underline">{playing.channel}</button>
                  : playing.channel)}
                {[views(playing.views), ago(playing.published)].filter(Boolean).map((t) => ` · ${t}`)}
              </p>
            </div>
            <button onClick={togglePin} className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10">
              {pinned ? <><PinOff size={14} /> Unpin</> : <><Pin size={14} /> Pin</>}
            </button>
            <a href={`https://www.youtube.com/watch?v=${playing.id}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10">
              <ExternalLink size={14} /> YouTube
            </a>
            <button onClick={() => setPlaying(null)} aria-label="Close player" className="grid size-8 place-items-center rounded-full bg-white/5 hover:bg-white/10"><X size={16} /></button>
          </div>
        </div>
      )}

      {setup && <KeySetup onSaved={() => { setSetup(false); onConnected(); setTab('trending'); }} onCancel={() => setSetup(false)} />}

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {connected && <Pill k="trending" icon={Flame}>Trending in UAE</Pill>}
        <Pill k="pinned" icon={Pin}>Pinned{videos.length ? ` · ${videos.length}` : ''}</Pill>
        {list.label && tab === 'search' && <Pill k="search" icon={Search}>{list.label}</Pill>}
        {list.label && tab === 'channel' && <Pill k="channel">{list.label}</Pill>}
        {!connected && !setup && (
          <button onClick={() => setSetup(true)} className="flex shrink-0 items-center gap-1.5 rounded-full border border-dashed border-stroke px-3.5 py-1.5 text-sm text-mute hover:text-txt">
            <KeyRound size={14} /> Turn on YouTube search
          </button>
        )}
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}
      {loading && !shown.length ? (
        <p className="flex items-center gap-2 text-sm text-mute"><Loader2 size={16} className="animate-spin" /> Loading…</p>
      ) : shown.length ? (
        <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((v) => <Tile key={v.id} v={v} active={playing?.id === v.id} onPlay={play} />)}
        </div>
      ) : (
        tab === 'pinned' && <p className="text-sm text-mute">Nothing pinned yet. Play any video and tap Pin to keep it here, like a news channel's live stream.</p>
      )}
      {tab === 'search' && list.next && (
        <button onClick={() => search(null, true)} disabled={loading} className="mx-auto flex items-center gap-1.5 rounded-full bg-white/5 px-4 py-2 text-sm hover:bg-white/10">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <ChevronDown size={14} />} More
        </button>
      )}
    </section>
  );
}
