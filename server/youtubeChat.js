import { db } from './db.js';
import { saveQuestion } from './chat.js';
import { searchYouTube, trending, watchHistory, hasYouTubeKey } from './youtube.js';

// YouTube in a chat, for the master, with no AI at all: "open cyber security videos on
// youtube" is a YouTube search, "what did I watch about phishing last week" a look in the
// watch history. Both are read from the words here and answered with a row of videos that
// play in the chat. The reply carries the list in a ```youtube block the app draws; the
// agents see it as a short list on later turns, so "the second one" still makes sense.

const STOP = new Set(('youtube you tube yt open show find search play watch get look suggest recommend me some any the a an of on in at ' +
  'for to about related relating regarding video videos clip clips please pls can could would you reem i want need like see give list with ' +
  'good best latest new top channel channels').split(' '));
const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
const topic = (s) => words(s).filter((w) => !STOP.has(w)).join(' ').trim();

// Periods people say, as a start time (unix seconds, Dubai days).
const HISTORY_STOP = new Set(['what', 'which', 'did', 'have', 'watch', 'watched', 'watching', 'history', 'my', 'saw', 'seen', 'today', 'yesterday',
  'last', 'this', 'week', 'month', 'ago', 'days', 'day', 'was', 'were', 'that', 'those', 'videos', 'video', 'show', 'me', 'all', 'i', 'the',
  'about', 'on', 'in', 'youtube', 'list', 'give', 'tell', 'when', 'it', 'is', 'are', 'from', 'of', 'a',
  'app', 'reem', 'yt', 'you', 'tube', 'open', 'see', 'can', 'please', 'pls', 'recent', 'recently', 'everything', 'so', 'far', 'till', 'now',
  'any', 'some', 'for', 'to', 'related', 'viewed', 'view', 'viewing', 'played', 'opened']);
function sinceOf(text) {
  const t = text.toLowerCase();
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  const dubaiMidnight = now - ((now + 4 * 3600) % day);
  if (/\btoday\b/.test(t)) return dubaiMidnight;
  if (/\byesterday\b/.test(t)) return dubaiMidnight - day;
  if (/\b(this|last|past) week\b/.test(t)) return now - 7 * day;
  if (/\b(this|last|past) month\b/.test(t)) return now - 31 * day;
  const n = t.match(/\b(\d{1,3}) days?\b/);
  if (n) return now - Number(n[1]) * day;
  return 0;
}

/** What the message asks of YouTube: { kind: 'history' | 'search' | 'trending', ... } or null for an ordinary message. */
export function youtubeAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200 || t.includes('\n')) return null;
  const low = t.toLowerCase();
  // "what did I watch…", "videos I watched…", "my watch history", "show me youtube history". Not
  // "history videos on youtube": there history is what to search for, so it must sit right
  // after youtube, watch, viewing or my, or come before "of my videos".
  if (/\b(what|which)\b.*\b(did i|have i|i)\b.*\bwatch(ed)?\b|\bvideos? i (watched|saw|played|opened)\b|\bi watched\b/.test(low)
    || /\b(you ?tube|yt|watch(ing)?|viewing|my|video)\s+history\b|\bhistory of (my )?(you ?tube|videos?|watch)/.test(low)) {
    return { kind: 'history', words: words(t).filter((w) => !HISTORY_STOP.has(w)).slice(0, 4), since: sinceOf(t) };
  }
  if (!/\b(you ?tube|yt)\b/.test(low)) return null;
  if (!/\b(open|show|find|search|play|watch|get|look|suggest|recommend|videos?|clips?)\b/.test(low)) return null;
  const q = topic(t);
  if (!q) return { kind: 'trending' };
  return { kind: 'search', q, live: /\blive\b/.test(low) };
}

// The list as the reply keeps it: what the app needs to draw the cards, nothing more.
const slim = (v) => ({ id: v.id, title: v.title, channel: v.channel, duration: v.duration, ...(v.live && { live: true }), ...(v.watched_at && { watched_at: v.watched_at }) });
const block = (data) => `\n\n\`\`\`youtube\n${JSON.stringify(data)}\n\`\`\``;

const when = (secs) => new Date(secs * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export async function youtubeReply(user, ask) {
  if (ask.kind === 'history') {
    const items = await watchHistory(user.id, { words: ask.words, since: ask.since, limit: 24 });
    const about = ask.words.length ? ` about **${ask.words.join(' ')}**` : '';
    if (!items.length) return `I found no videos you watched${about}${ask.since ? ' in that time' : ''}. Videos count once you play them in Reem.`;
    const lines = items.slice(0, 8).map((v) => `- ${when(v.watched_at)}: ${v.title || 'a video'}${v.channel ? ` (${v.channel})` : ''}`).join('\n');
    return `You watched ${items.length} video${items.length === 1 ? '' : 's'}${about}:\n\n${lines}${items.length > 8 ? '\n- …' : ''}` +
      block({ kind: 'history', items: items.map(slim) });
  }
  if (!await hasYouTubeKey()) return 'YouTube search is not connected yet: add the YouTube key on Feeds → YouTube.';
  if (ask.kind === 'trending') {
    const items = (await trending()).slice(0, 12);
    return `What's trending on YouTube in the UAE right now:${block({ kind: 'trending', items: items.map(slim) })}`;
  }
  const { items } = await searchYouTube(ask.q, { live: ask.live });
  if (!items.length) return `YouTube found nothing for **${ask.q}**.`;
  return `YouTube${ask.live ? ' live streams' : ''} for **${ask.q}**, tap one to play it here:${block({ kind: 'search', q: ask.q, items: items.slice(0, 12).map(slim) })}`;
}

/** The chat turn for a YouTube ask: like a picture turn, answered by whoever was talking, no model called. */
export async function youtubeTurn({ user, team, convId, text, ask, send, res }) {
  const prior = await db.prepare('SELECT agent_id FROM messages WHERE conversation_id = ? AND agent_id IS NOT NULL ORDER BY id DESC LIMIT 1').get(convId);
  const agent = team.find((a) => a.id === prior?.agent_id) ?? team.find((a) => !a.case_key) ?? team[0];
  send('agent', { id: agent.id, why: 'YouTube' });
  const { id: userMessageId, repeat } = await saveQuestion(convId, text, []);
  if (repeat) send('repeat', { userMessageId });
  let messageId = null;
  try {
    send('status', { label: ask.kind === 'history' ? 'Looking at what you watched…' : 'Searching YouTube…' });
    const content = await youtubeReply(user, ask);
    ({ id: messageId } = await db.prepare('INSERT INTO messages (conversation_id, agent_id, role, content, files) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .run(convId, agent.id, 'assistant', content, '[]'));
    send('delta', { text: content });
  } catch (e) {
    console.error('[youtube chat]', e.message);
    send('error', { message: e.status && e.status < 500 ? e.message : 'YouTube could not be reached. Please try again.' });
  }
  await db.prepare('UPDATE conversations SET updated_at = extract(epoch from now()) WHERE id = ?').run(convId);
  if (!res.writableEnded) { send('done', { messageId, userMessageId }); res.end(); }
}
