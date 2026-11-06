import { Router } from 'express';
import { db } from './db.js';
import { encrypt, decrypt } from './secrets.js';

// YouTube inside Reem, on the master's Feeds page: search, what is trending in the UAE, and
// a channel's latest videos, through Google's YouTube Data API with the master's own key
// (typed on the page, kept encrypted). The videos themselves play in YouTube's own player
// on the page. Google gives a key 10,000 units a day: a search costs 100, a trending list 1,
// so about 90 searches a day; trending is kept for an hour so opening the page costs nothing.

const API = 'https://www.googleapis.com/youtube/v3';
const bad = (message, status) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// The key typed on the page first, else YOUTUBE_API_KEY from .env.
const envKey = () => String(process.env.YOUTUBE_API_KEY || '').trim();
async function storedKey() {
  const row = await db.prepare('SELECT youtube_key FROM feed_settings WHERE id = 1').get();
  return row?.youtube_key ? decrypt(row.youtube_key) : envKey();
}

export const hasYouTubeKey = async () => !!envKey() || !!(await db.prepare("SELECT 1 FROM feed_settings WHERE id = 1 AND youtube_key <> ''").get());

// Google's own words for what went wrong, in plain terms where we know them.
function googleError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason || '';
  if (reason === 'quotaExceeded') return bad('YouTube\'s daily limit for this key is used up. It resets at 11 am Dubai time.', 429);
  if (reason === 'keyInvalid' || status === 400 && /API key/i.test(body?.error?.message || '')) return bad('Google says this YouTube key is not valid', 400);
  if (reason === 'accessNotConfigured' || /has not been used|disabled/i.test(body?.error?.message || '')) return bad('Turn on "YouTube Data API v3" for this key in Google Cloud, then try again', 400);
  return bad(`YouTube: ${body?.error?.message || `error ${status}`}`, 502);
}

async function call(path, params, key) {
  const k = key ?? await storedKey();
  if (!k) throw bad('Add your YouTube key first', 400);
  const url = new URL(`${API}/${path}`);
  for (const [n, v] of Object.entries({ ...params, key: k })) if (v != null && v !== '') url.searchParams.set(n, v);
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw googleError(r.status, body);
  return body;
}

// The API sends titles with HTML entities (&#39; &amp; …).
const unescape = (s = '') => String(s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// PT1H2M3S -> 1:02:03
export function duration(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return '';
  const h = Number(m[1] || 0) * 24 + Number(m[2] || 0), min = Number(m[3] || 0), s = Number(m[4] || 0);
  if (!h && !min && !s) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

const tile = (v) => ({
  id: v.id,
  title: unescape(v.snippet?.title),
  channel: unescape(v.snippet?.channelTitle),
  channel_id: v.snippet?.channelId || '',
  published: v.snippet?.publishedAt || '',
  thumb: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
  duration: duration(v.contentDetails?.duration),
  live: v.snippet?.liveBroadcastContent === 'live',
  views: Number(v.statistics?.viewCount) || null,
});

// Search gives ids only; one more call (1 unit) brings lengths, views and live.
async function details(ids) {
  if (!ids.length) return [];
  const { items = [] } = await call('videos', { part: 'snippet,contentDetails,statistics', id: ids.join(','), maxResults: 50 });
  const byId = new Map(items.map((v) => [v.id, tile(v)]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export async function searchYouTube(q, { pageToken, live } = {}) {
  const r = await call('search', {
    part: 'id', type: 'video', q: String(q).slice(0, 200), maxResults: 24, regionCode: 'AE', safeSearch: 'moderate',
    pageToken, ...(live ? { eventType: 'live' } : {}),
  });
  return { items: await details((r.items || []).map((i) => i.id?.videoId).filter(Boolean)), next: r.nextPageToken || null };
}

let trendingCache = null; // { at, items }
export async function trending() {
  if (trendingCache && Date.now() - trendingCache.at < 3600_000) return trendingCache.items;
  const { items = [] } = await call('videos', { part: 'snippet,contentDetails,statistics', chart: 'mostPopular', regionCode: 'AE', maxResults: 24 });
  trendingCache = { at: Date.now(), items: items.map(tile) };
  return trendingCache.items;
}

// A channel's newest uploads, from its uploads playlist (2 units, not a 100-unit search).
export async function channelVideos(channelId) {
  const { items = [] } = await call('channels', { part: 'contentDetails,snippet', id: channelId });
  const uploads = items[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw bad('Channel not found', 404);
  const list = await call('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: 24 });
  return { channel: unescape(items[0].snippet?.title), items: await details((list.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean)) };
}

// ---------- routes (master only, mounted under /api/feeds/youtube) ----------

export const youtubeRoutes = Router();

// Saved only once Google accepts it, so a typo is caught here rather than on the first search.
youtubeRoutes.put('/key', wrap(async (req, res) => {
  const key = String(req.body?.key || '').trim();
  await db.prepare('INSERT INTO feed_settings (id) VALUES (1) ON CONFLICT DO NOTHING').run();
  if (!key) {
    await db.prepare("UPDATE feed_settings SET youtube_key = '' WHERE id = 1").run();
    trendingCache = null;
    return res.json({ ok: true, youtube: false });
  }
  if (!/^[\w-]{30,60}$/.test(key)) throw bad('That does not look like a Google API key (it starts with AIza)', 400);
  await call('videos', { part: 'id', chart: 'mostPopular', regionCode: 'AE', maxResults: 1 }, key);
  await db.prepare('UPDATE feed_settings SET youtube_key = ? WHERE id = 1').run(encrypt(key));
  trendingCache = null;
  res.json({ ok: true, youtube: true });
}));

youtubeRoutes.get('/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) throw bad('Type something to search for', 400);
  res.json(await searchYouTube(q, { pageToken: req.query.page || undefined, live: req.query.live === '1' }));
}));

youtubeRoutes.get('/trending', wrap(async (req, res) => {
  res.json({ items: await trending() });
}));

youtubeRoutes.get('/channel/:id', wrap(async (req, res) => {
  if (!/^UC[\w-]{22}$/.test(req.params.id)) throw bad('Channel not found', 404);
  res.json(await channelVideos(req.params.id));
}));
