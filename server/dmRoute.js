// The master's one box on a group page: which topic does this message belong in?
//
// The third place a team chat is read by Claude, after the summary and the wand, and
// like them it runs only when somebody asks - here, the master pressing send in the
// group's common box. Nothing is posted from here. The answer is a suggestion: the app
// shows "→ Finance · Send / Change" and only the master's tap sends it, because a
// message in the wrong topic is read by the wrong people.
//
// Claude is shown each topic's name, who is in it and its last few messages - the
// same things the master can already see on that page - and picks one, or none.
import { db } from './db.js';
import { ask } from './ai.js';
import { transcript } from './dmSummary.js';

const CONTEXT = 8;   // recent messages per topic: enough to tell what each one is about
const MAX_IN = 2000;

const SYSTEM = `You sort a message into the right topic of a work group chat, before it is sent.
You are given the topics - each with its name, its members and its most recent messages - and the new message.
Pick the ONE topic it belongs in: the one whose subject or people it is about.
- A person named in the message ("Rona, ...") is a strong clue: prefer a topic they are in.
- If it continues a conversation in one topic, pick that topic.
- If no topic is a reasonable fit, or two fit equally well, answer 0. Do not guess.
Reply with ONLY the topic number, nothing else.`;

// A paid call behind the send button.
const RATE = { per: 60, windowMs: 10 * 60_000 };
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
 * The topic of group `groupId` that `text` belongs in, among the topics `userId` is in:
 * { chatId } - or { chatId: null } when none fits. With a single topic there is
 * nothing to decide and no call is made.
 */
export async function pickTopic(groupId, userId, text, { model = ask } = {}) {
  const words = String(text || '').trim().slice(0, MAX_IN);
  const topics = await db.prepare(`SELECT c.id, c.name FROM dm_chats c
    JOIN dm_members mb ON mb.chat_id = c.id AND mb.user_id = ?
    WHERE c.group_id = ? ORDER BY c.id`).all(userId, groupId);
  if (topics.length === 0) return { chatId: null };
  if (topics.length === 1) return { chatId: topics[0].id };
  if (!words) return { chatId: null }; // a photo with no words: only the sender knows where it goes
  if (tooMany(userId)) throw bad('That is a lot of messages at once. Pick the topic yourself for now.', 429);

  const blocks = [];
  for (const [i, t] of topics.entries()) {
    const people = (await db.prepare(`SELECT u.name FROM dm_members mb JOIN users u ON u.id = mb.user_id
      WHERE mb.chat_id = ? ORDER BY u.name`).all(t.id)).map((r) => r.name);
    const recent = (await db.prepare(`SELECT m.kind, m.body, m.deleted, m.created_at, m.file_name, u.name
      FROM dm_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = ? AND m.deleted = false AND m.kind <> 'system'
      ORDER BY m.id DESC LIMIT ${CONTEXT}`).all(t.id)).reverse();
    blocks.push(`TOPIC ${i + 1}: ${t.name}\nMembers: ${people.join(', ')}\n${transcript(recent) || '(no messages yet)'}`);
  }

  const out = await model(`${blocks.join('\n\n')}\n\nNEW MESSAGE:\n${words}\n\nWhich topic number?`, { system: SYSTEM, maxTokens: 10 });
  const n = Number(String(out || '').match(/\d+/)?.[0]);
  return { chatId: topics[n - 1]?.id ?? null };
}
