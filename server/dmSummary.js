// The one place a team chat is read by Claude.
//
// Everything else about the Messages screen is deliberately kept away from the AI
// (see the top of messenger.js). This is the single exception, and it is kept in its
// own file so that "what can reach the model" stays one short thing to audit: it runs
// only when a member of a chat asks for a summary, it reads nothing but that chat's
// own messages, and it stores nothing back.
import { db } from './db.js';
import { ask } from './ai.js';

const WINDOW = 400; // messages read for one summary: a long day of chat, well inside the model's limits
const MIN = 2;      // below this there is nothing to conclude

const SYSTEM = `You summarise a work conversation between colleagues, for one of the people in it.
Report only what the messages actually say. Never invent a decision, a name, a number or a date.
Reply with ONLY JSON: {"headline": "…", "points": ["…"], "conclusion": "…", "actions": [{"who": "…", "what": "…"}], "open": ["…"]}
- headline: one plain sentence saying what this conversation is about.
- points: 2-6 short bullets of what was actually discussed, in the order it happened.
- conclusion: what the conversation came to - what was agreed, decided or settled, and by whom. If nothing was settled, say so plainly and say what is holding it up. This is the part the reader cares about most.
- actions: what somebody agreed to do, naming the person exactly as the transcript names them. [] if nobody agreed to anything.
- open: questions that were asked and never answered, or points left hanging. [] if none.
Write in the language the conversation is written in. Keep every line short and concrete, so the whole thing reads in under a minute.
Photos and files appear as [photo] or [file: name]: you cannot see inside them, so never guess at their contents.`;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/**
 * The transcript the model is shown. Names, not ids - the summary has to be able to say
 * "Sara agreed to send it". A deleted message is left out entirely: deleting it for
 * everyone has to mean everyone, the summary included.
 */
export function transcript(rows) {
  return rows.filter((m) => !m.deleted).map((m) => {
    const when = stamp(m.created_at);
    if (m.kind === 'system') return `[${when}] * ${m.body}`;
    const who = m.name || 'Former member';
    const file = m.kind === 'image' ? '[photo]' : m.kind === 'file' ? `[file: ${m.file_name || 'attachment'}]` : '';
    return `[${when}] ${who}: ${[file, m.body].filter(Boolean).join(' ').slice(0, 1500)}`;
  }).join('\n');
}

// Summarising the same unchanged chat twice costs a second API call for an identical
// answer, and people do re-open the panel. Keyed by the last message id, so one new
// message is enough to make it stale.
const cache = new Map();
const CACHE_MAX = 200;

// A summary is a paid call, so one person cannot sit on the button.
const RATE = { per: 12, windowMs: 10 * 60_000 };
const used = new Map();
function tooMany(userId) {
  const now = Date.now();
  const e = used.get(userId);
  if (!e || now > e.until) { used.set(userId, { n: 1, until: now + RATE.windowMs }); return false; }
  e.n += 1;
  return e.n > RATE.per;
}

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Summarise one chat. The caller is responsible for having checked that this user is
 * in it: this function does no membership check of its own and must never be reached
 * from anywhere that has not done one.
 */
export async function summarise(chatId, userId, { fresh = false } = {}) {
  const rows = (await db.prepare(`SELECT m.kind, m.body, m.deleted, m.created_at, m.file_name, u.name
    FROM dm_messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT ${WINDOW}`).all(chatId)).reverse();

  const real = rows.filter((m) => !m.deleted && m.kind !== 'system');
  if (real.length < MIN) throw bad('There is not enough here to summarise yet.');

  const lastId = (await db.prepare('SELECT COALESCE(MAX(id), 0) id FROM dm_messages WHERE chat_id = ?').get(chatId)).id;
  const hit = cache.get(chatId);
  if (!fresh && hit && hit.lastId === lastId) return { ...hit.out, cached: true };

  if (tooMany(userId)) throw bad('That is a lot of summaries at once. Try again in a few minutes.', 429);

  const out = await ask(`CONVERSATION:\n${transcript(rows)}`, { system: SYSTEM, maxTokens: 900 });
  const summary = parse(out);
  if (!summary) throw bad('The summary could not be read. Please try again.', 502);

  const result = {
    ...summary,
    messages: real.length,
    from: real[0].created_at,
    to: real[real.length - 1].created_at,
    partial: rows.length === WINDOW, // older messages exist above the window
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(chatId, { lastId, out: result });
  return { ...result, cached: false };
}

/** The model is asked for JSON; this is what happens when it wraps it in prose anyway. */
export function parse(out) {
  let d;
  try { d = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return null; }
  const lines = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 400)).slice(0, 8);
  const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 800) : '');
  const conclusion = text(d.conclusion);
  const headline = text(d.headline);
  if (!conclusion && !headline) return null;
  return {
    headline,
    points: lines(d.points),
    conclusion,
    actions: (Array.isArray(d.actions) ? d.actions : [])
      .map((a) => ({ who: text(a?.who).slice(0, 80), what: text(a?.what) }))
      .filter((a) => a.what).slice(0, 8),
    open: lines(d.open),
  };
}

/** A chat that changed while a summary was cached must not serve the old one. */
export const forget = (chatId) => cache.delete(chatId);
