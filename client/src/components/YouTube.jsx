// YouTube's own player, the whole of it: quality, captions, speed, full screen, live chat
// replay. Used in chats (under a message with a YouTube link) and on the Feeds page.
// The no-cookie player, so YouTube does not set its tracking cookies until a video plays.

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
    const p = new URL(url).searchParams;
    const t = p.get('t') || p.get('start');
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

export default function YouTube({ id, start = 0, title, autoplay = false, className = '' }) {
  const params = new URLSearchParams({ rel: '0', playsinline: '1', modestbranding: '1', ...(autoplay ? { autoplay: '1' } : {}), ...(start ? { start: String(start) } : {}) });
  return (
    <div className={`relative aspect-video w-full overflow-hidden rounded-2xl border border-stroke bg-black shadow-lg shadow-black/20 ${className}`}>
      <iframe src={`https://www.youtube-nocookie.com/embed/${id}?${params}`} title={title || 'YouTube video'}
        className="absolute inset-0 size-full" loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
        allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
    </div>
  );
}

/** The players for the YouTube links in a message, under its text. */
export function YouTubeCards({ text, className = 'mt-2' }) {
  const links = youTubeLinks(text);
  if (!links.length) return null;
  return (
    <div className={`space-y-2 ${className}`}>
      {links.map((l) => <YouTube key={l.id} id={l.id} start={l.start} />)}
    </div>
  );
}
