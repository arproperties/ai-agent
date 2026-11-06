import { useRef, useState } from 'react';
import { Play, Radio, X, ExternalLink, History } from 'lucide-react';
import { api } from '../lib/api';
import YouTube from './YouTube';

// A row of YouTube videos in a chat reply (server/youtubeChat.js): the cards slide in one
// after another, and the one tapped opens above them in YouTube's own player, growing
// into place. Each video played is noted in the watch history; nothing here uses AI or
// any of the YouTube key's allowance.

/** The reply split into words and ```youtube rows, in order. */
export function splitYouTube(content) {
  const text = String(content || '');
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(/```youtube\n([\s\S]*?)\n```/g)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    try { parts.push({ youtube: JSON.parse(m[1]) }); } catch { /* a broken row is left out */ }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
export const withoutYouTube = (content) => String(content || '').replace(/```youtube\n[\s\S]*?\n```/g, '').trim();

const when = (secs) => new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function noteWatched(v) {
  api.post('/feeds/youtube/watched', { id: v.id, title: v.title, channel: v.channel, duration: v.duration }).catch(() => {});
}

export default function YouTubeRow({ data }) {
  const items = (data?.items || []).filter((v) => /^[\w-]{11}$/.test(v.id));
  const [playing, setPlaying] = useState(null);
  const box = useRef(null);
  if (!items.length) return null;

  const play = (v) => {
    setPlaying(v);
    noteWatched(v);
    requestAnimationFrame(() => box.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };

  return (
    <div ref={box} className="my-3 w-full max-w-3xl space-y-3">
      {/* The player grows open: its row goes from 0fr to 1fr, so the height follows the video. */}
      <div className={`grid transition-[grid-template-rows,opacity] duration-500 ease-out ${playing ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="min-h-0 overflow-hidden">
          {playing && (
            <div key={playing.id} className="rise space-y-2 pb-1">
              <YouTube id={playing.id} title={playing.title} autoplay />
              <div className="flex items-start gap-2 px-1">
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[15px] font-medium leading-snug">{playing.title}</p>
                  {playing.channel && <p className="text-xs text-mute">{playing.channel}</p>}
                </div>
                <a href={`https://www.youtube.com/watch?v=${playing.id}`} target="_blank" rel="noopener noreferrer" aria-label="Open on YouTube" title="Open on YouTube"
                  className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><ExternalLink size={15} /></a>
                <button onClick={() => setPlaying(null)} aria-label="Close player" title="Close"
                  className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={16} /></button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]">
        {items.map((v, i) => {
          const on = playing?.id === v.id;
          return (
            <button key={v.id} onClick={() => play(v)} style={{ animationDelay: `${Math.min(i, 10) * 60}ms` }}
              className={`rise group w-52 shrink-0 snap-start text-left transition ${playing && !on ? 'opacity-60 hover:opacity-100' : ''}`}>
              <span className={`relative block aspect-video overflow-hidden rounded-xl bg-white/5 ring-2 transition ${on ? 'ring-red-500' : 'ring-transparent'}`}>
                <img src={`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`} alt="" loading="lazy" className="size-full object-cover transition duration-300 group-hover:scale-105" />
                <span className="absolute inset-0 grid place-items-center bg-black/0 transition group-hover:bg-black/25">
                  <span className={`grid size-10 place-items-center rounded-full bg-red-600 text-white shadow-lg transition ${on ? 'scale-100 opacity-100' : 'scale-75 opacity-0 group-hover:scale-100 group-hover:opacity-100'}`}>
                    <Play size={16} fill="currentColor" className="ml-0.5" />
                  </span>
                </span>
                {v.live ? (
                  <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white"><Radio size={10} /> LIVE</span>
                ) : v.duration && (
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">{v.duration}</span>
                )}
              </span>
              <span className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-snug">{v.title || 'Video'}</span>
              <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-mute">
                {v.watched_at ? <><History size={11} className="shrink-0" /> {when(v.watched_at)}</> : v.channel}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
