import { useState } from 'react';
import { Play, X } from 'lucide-react';

// A YouTube video, shown the light way: its picture and a play button, and YouTube's own
// player only once someone taps. Until then nothing is loaded from YouTube but the picture,
// so a chat with ten links stays quick on a phone. The player is the no-cookie one.

const ID = /^[\w-]{11}$/;

/** The video id in a YouTube link (watch, youtu.be, shorts, live, embed), or null. */
export function youTubeId(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/)?.[1] || null;
  }
  return id && ID.test(id) ? id : null;
}

// Where a link asks to start ("?t=90", "t=1m30s"), in seconds.
function startAt(url) {
  try {
    const t = new URL(url).searchParams.get('t') || new URL(url).searchParams.get('start');
    if (!t) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    return (Number(m?.[1] || 0) * 3600) + (Number(m?.[2] || 0) * 60) + Number(m?.[3] || 0);
  } catch { return 0; }
}

/** Every distinct YouTube video linked in a piece of text, in order. At most `max`. */
export function youTubeLinks(text, max = 3) {
  const seen = new Set();
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s)<>\]"']+/g)) {
    const id = youTubeId(m[0]);
    if (id && !seen.has(id)) { seen.add(id); out.push({ id, url: m[0], start: startAt(m[0]) }); }
    if (out.length >= max) break;
  }
  return out;
}

export default function YouTube({ id, start = 0, title, onRemove, className = '' }) {
  const [playing, setPlaying] = useState(false);
  // maxres is missing for some videos; hq is always there.
  const [thumb, setThumb] = useState(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`);
  return (
    <div className={`group relative aspect-video w-full overflow-hidden rounded-2xl border border-stroke bg-black shadow-lg shadow-black/20 ${className}`}>
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1${start ? `&start=${start}` : ''}`}
          title={title || 'YouTube video'} className="absolute inset-0 size-full" loading="lazy"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      ) : (
        <button onClick={() => setPlaying(true)} aria-label={title ? `Play ${title}` : 'Play video'} className="absolute inset-0 size-full">
          <img src={thumb} alt="" loading="lazy" className="size-full object-cover transition duration-300 group-hover:scale-[1.03]"
            onLoad={(e) => { if (e.currentTarget.naturalWidth <= 120) setThumb(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`); }}
            onError={() => setThumb(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`)} />
          <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
          <span className="absolute left-1/2 top-1/2 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/20 text-white ring-1 ring-white/40 backdrop-blur-md transition group-hover:scale-110 group-hover:bg-red-600 group-hover:ring-red-500">
            <Play size={26} fill="currentColor" className="ml-1" />
          </span>
          {title && <span className="absolute inset-x-0 bottom-0 line-clamp-2 px-4 pb-3 text-left text-sm font-medium text-white drop-shadow">{title}</span>}
        </button>
      )}
      {onRemove && (
        <button onClick={onRemove} aria-label="Remove video" title="Remove"
          className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-black/50 text-white opacity-0 backdrop-blur transition hover:bg-black/70 group-hover:opacity-100 max-md:opacity-100">
          <X size={16} />
        </button>
      )}
    </div>
  );
}

/** The cards for the YouTube links in a message, under its text. */
export function YouTubeCards({ text, className = 'mt-2' }) {
  const links = youTubeLinks(text);
  if (!links.length) return null;
  return (
    <div className={`space-y-2 ${className}`}>
      {links.map((l) => <YouTube key={l.id} id={l.id} start={l.start} />)}
    </div>
  );
}
