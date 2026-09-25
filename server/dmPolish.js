// "Help me say this": the wand in the typing box, in its two moods.
//
// With rough notes in the box it tidies them up. With the box empty it writes a first
// draft of a reply to what has just been said - for the person who has read the chat
// and does not want to start from a blank line.
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

const CONTEXT = 12;   // recent messages shown when tidying: enough to catch the topic and the tone
const DRAFT_CONTEXT = 25; // writing a reply from scratch needs more of the thread than tidying does
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

const DRAFT_SYSTEM = `You write a first draft of a reply in a work chat, for one of the people in it.
You are not that person and you do not know anything they have not said. The draft is a starting point they will read, edit and send themselves.
- Answer what was actually said, especially the most recent message.
- Never decide anything on their behalf. If the last message asks something only they can answer - which option, which date, which number, yes or no - do NOT pick one. Ask it back plainly, or say they will confirm.
- Never invent a fact, a name, a number, a date or a promise. Only what is in the conversation.
- Their voice: plain colleague-to-colleague writing, first person, contractions fine, no corporate padding.
- The language the conversation is written in.
- Short. A couple of sentences is usually right; short bullet lines only if there are several separate points to answer.
- No greeting or sign-off, no subject line, no headings, no markdown bold.
Photos and files appear as [photo] or [file: name]: you cannot see inside them, so never guess at their contents.
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
async function context(chatId, limit) {
  const rows = (await db.prepare(`SELECT m.kind, m.body, m.deleted, m.created_at, m.file_name, u.name
    FROM dm_messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.chat_id = ? AND m.deleted = false AND m.kind <> 'system'
    ORDER BY m.id DESC LIMIT ${Number(limit)}`).all(chatId)).reverse();
  return transcript(rows);
}

/**
 * The wand. With `text`, those rough notes come back tidied up. Without it, a first
 * draft of a reply to the conversation comes back instead. The caller is responsible
 * for having checked that this user is in that chat.
 *
 * Nothing is written to the database and nothing is sent either way: the text goes
 * straight back to the person who asked, into their own typing box.
 */
export async function polish(chatId, userId, text, { model = ask, name = '' } = {}) {
  const notes = String(text || '').trim();
  if (notes.length === 1) throw bad('Type a few more words, and Jarvis will tidy them up.');
  if (notes.length > MAX_IN) throw bad('That is already a long message — Jarvis tidies up short notes.');
  if (tooMany(userId)) throw bad('That is a lot of rewrites at once. Try again in a few minutes.', 429);

  const drafting = !notes;
  const recent = await context(chatId, drafting ? DRAFT_CONTEXT : CONTEXT);
  if (drafting && !recent) throw bad('There is nothing here to reply to yet. Type a few words and Jarvis will tidy them up.');

  const out = drafting
    ? await model(
      `CONVERSATION SO FAR:\n${recent}\n\nWrite the next message in this conversation, as ${name || 'the reader'}.`,
      { system: DRAFT_SYSTEM, maxTokens: 700 },
    )
    : await model(
      `${recent ? `RECENT MESSAGES (context only):\n${recent}\n\n` : ''}ROUGH NOTES TO TIDY UP:\n${notes}`,
      { system: SYSTEM, maxTokens: 700 },
    );

  const message = clean(out);
  if (!message) throw bad(drafting ? 'A reply could not be written. Please try again.' : 'That could not be tidied up. Please try again.', 502);
  return { text: message, drafted: drafting };
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
