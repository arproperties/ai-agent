// "Help me say this": rough points in the typing box, turned into a message.
//
// The second - and only other - place a team chat is read by Claude, and like the
// summariser it runs only when a member asks for it by hand, on their own chat, and
// stores nothing back. What is different here is the direction: nothing is posted.
// The tidied text is handed back to the person who typed it, in their own box, to
// edit or throw away. Nobody else sees anything unless they then press send.
//
// A few recent messages go along with it, so the answer lands in the conversation
// that is actually happening rather than in a vacuum - the same messages that person
// is already reading on screen.
import { db } from './db.js';
import { ask } from './ai.js';
import { transcript } from './dmSummary.js';

const CONTEXT = 12;   // recent messages shown to the model: enough to catch the topic and the tone
const MAX_IN = 2000;  // rough notes longer than this are already a message, not notes
const MAX_OUT = 4000; // the ceiling messenger.js puts on any message

const SYSTEM = `You tidy up a work chat message for the person about to send it.
They have typed rough notes. Give back the same thing said clearly, as a message they could send as it stands.
- Keep every fact, name, number and date exactly as they typed it. Never add one, never drop one.
- If something is unclear, leave it as they put it. Do not guess at what they meant, and never invent context.
- Their voice, not yours: plain colleague-to-colleague writing, contractions fine, no corporate padding.
- Their language: if the notes are in another language, or a mix, answer the same way.
- Short. Usually one small paragraph; only use short bullet lines if they listed several separate points.
- No greeting or sign-off unless they wrote one. No subject line, no headings, no markdown bold.
- If the notes are already a fine message, change almost nothing.
Recent messages may be given for context only - never answer them, never quote them, never mention them.
Reply with ONLY the message text, nothing before or after it.`;

// A rewrite is a paid call, and the button sits right next to the send button.
const RATE = { per: 30, windowMs: 10 * 60_000 };
const used = new Map();
function tooMany(userId) {
  const now = Date.now();
  const e = used.get(userId);
  if (!e || now > e.until) { used.set(userId, { n: 1, until: now + RATE.windowMs }); return false; }
  e.n += 1;
  return e.n > RATE.per;
}

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/** The last few real messages, as the summariser writes them. Empty in a new chat. */
async function context(chatId) {
  const rows = (await db.prepare(`SELECT m.kind, m.body, m.deleted, m.created_at, m.file_name, u.name
    FROM dm_messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.chat_id = ? AND m.deleted = false AND m.kind <> 'system'
    ORDER BY m.id DESC LIMIT ${CONTEXT}`).all(chatId)).reverse();
  return transcript(rows);
}

/**
 * Tidy `text` into a message for `chatId`. The caller is responsible for having
 * checked that this user is in that chat. Nothing is written to the database and
 * nothing is sent: the text comes straight back to the person who typed it.
 */
export async function polish(chatId, userId, text, { model = ask } = {}) {
  const notes = String(text || '').trim();
  if (notes.length < 2) throw bad('Type a few words first, and Jarvis will tidy them up.');
  if (notes.length > MAX_IN) throw bad('That is already a long message — Jarvis tidies up short notes.');
  if (tooMany(userId)) throw bad('That is a lot of rewrites at once. Try again in a few minutes.', 429);

  const recent = await context(chatId);
  const out = await model(
    `${recent ? `RECENT MESSAGES (context only):\n${recent}\n\n` : ''}ROUGH NOTES TO TIDY UP:\n${notes}`,
    { system: SYSTEM, maxTokens: 700 },
  );

  const message = clean(out);
  if (!message) throw bad('That could not be tidied up. Please try again.', 502);
  return { text: message };
}

/**
 * The model was asked for the message and nothing else; this is what happens when it
 * wraps it in a quote or announces itself anyway. Untrusted text either way, so it is
 * trimmed to the same ceiling a typed message has.
 */
export function clean(out) {
  let s = String(out || '').trim();
  s = s.replace(/^(?:here(?:'s| is)[^:\n]*:|message:)\s*/i, '').trim();
  // A whole answer fenced as code, or hugged by quotes, is the wrapper - not the words.
  const fence = s.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) s = fence[1].trim();
  if (/^"[\s\S]*"$/.test(s) && !s.slice(1, -1).includes('"')) s = s.slice(1, -1).trim();
  return s.slice(0, MAX_OUT);
}
