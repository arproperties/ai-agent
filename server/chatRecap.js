// Bringing earlier chats into the one that is open now.
//
// A chat is given only its own last 20 messages, so what was said in chat A and chat B
// cannot reach chat C — and pulling two conversations together is exactly what preparing
// for a meeting is. So the person picks the chats to bring in, and this file turns each
// one into a short recap that the agent is handed as context.
//
// A recap, not the transcript: two long chats would swamp the turn, and what is brought
// in stays in for the rest of the conversation, so the whole thing would be paid for
// again on every message. Short chats are passed through as they stand — summarising
// them would cost a call and lose detail for nothing.
//
// Nothing is stripped out of a recap: it keeps the names, dates and amounts that a saved
// memory deliberately drops (knowledge.js `tooSpecificToShare`). That guard is about a
// fact escaping to the rest of the team; this is the person's own chat going into the
// person's own chat, and the numbers are the reason they brought it.
import { db } from './db.js';
import { ask } from './ai.js';

const WINDOW = 200;      // messages read from one chat: a long conversation, well inside the model's limits
const PER_MESSAGE = 1500; // chars kept per message in the transcript
const VERBATIM = 4000;   // a transcript this short is used as it is, unsummarised
const MAX_CARRIED = 6;   // chats one conversation can carry, however many times they are picked

const SYSTEM = `You are shown one conversation between a person and their AI assistants. Write the notes somebody would need to pick that conversation up cold — for example to prepare for a meeting.
Report only what the conversation actually says. Never invent a decision, a name, a number, a date or an amount. Keep every name, number, date and amount that IS there: they are the point of these notes.
Reply with plain Markdown and no preamble, in this shape:
- One sentence saying what the conversation was about.
- **Points** — short bullets of what was discussed, decided or agreed, in the order it happened.
- **Open** — what was asked and never answered, or left hanging. Leave this heading out entirely if there is nothing.
Write in the language the conversation is written in. Aim for 150 words and never exceed 300.
Attached files appear as [Attached: name]. You cannot see inside them, so never guess at their contents.`;

/** The paid call. Taken as an argument below so a test can watch when it is and is not made. */
const askSummary = (title, text) => ask(`CONVERSATION TITLE: ${title}\n\n${text}`, { system: SYSTEM, maxTokens: 700 });

/** The conversation as the summariser sees it: who said what, agent names and all. */
export function transcript(rows, userName) {
  return rows.map((m) => {
    const who = m.role === 'user' ? userName : m.agent_name || 'Assistant';
    const names = JSON.parse(m.files || '[]').map((f) => f.name);
    const body = [m.content, names.length ? `[Attached: ${names.join(', ')}]` : ''].filter(Boolean).join(' ');
    return `${who}: ${body.slice(0, PER_MESSAGE)}`;
  }).join('\n\n');
}

/**
 * One chat, ready to be handed to an agent. Returns null for a chat that is not this
 * user's or has nothing in it — a conversation deleted after it was brought in simply
 * stops arriving, it does not break the turn.
 */
export async function recapOf(user, conversationId, { summarise = askSummary } = {}) {
  const conv = await db.prepare('SELECT id, title FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, user.id);
  if (!conv) return null;
  const rows = (await db.prepare(`SELECT m.id, m.role, m.content, m.files, a.name agent_name
    FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
    WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT ${WINDOW}`).all(conv.id)).reverse();
  if (!rows.length) return null;

  const title = conv.title || 'Untitled chat';
  const text = transcript(rows, user.name);
  if (text.length <= VERBATIM) return { id: conv.id, title, body: text, verbatim: true };

  const through = rows.at(-1).id;
  const hit = await db.prepare('SELECT summary FROM chat_recaps WHERE conversation_id = ? AND through_id = ?').get(conv.id, through);
  if (hit) return { id: conv.id, title, body: hit.summary };

  // A summary that does not come back is not worth failing the turn for: the opening of
  // the chat is still better context than nothing.
  let summary = '';
  try {
    summary = (await summarise(title, text)).trim();
  } catch (e) {
    console.error('[recap]', e.message);
  }
  if (!summary) return { id: conv.id, title, body: `${text.slice(0, VERBATIM)}\n…(beginning of the chat only)`, verbatim: true };

  await db.prepare(`INSERT INTO chat_recaps (conversation_id, through_id, summary) VALUES (?, ?, ?)
    ON CONFLICT (conversation_id) DO UPDATE SET through_id = EXCLUDED.through_id, summary = EXCLUDED.summary,
      created_at = extract(epoch from now())`).run(conv.id, through, summary);
  return { id: conv.id, title, body: summary };
}

/** Chats already brought into this conversation by an earlier message. */
export async function carriedIds(conversationId) {
  const rows = await db.prepare(`SELECT DISTINCT cc.source_id id FROM carried_chats cc
    JOIN messages m ON m.id = cc.message_id
    WHERE m.conversation_id = ? AND cc.source_id IS NOT NULL ORDER BY cc.source_id`).all(conversationId);
  return rows.map((r) => r.id);
}

/**
 * Everything this turn should see: the chats carried in earlier, plus the ones picked on
 * this message. `added` is the newly picked ones, which the caller writes against the
 * message so that they keep counting for the rest of the conversation.
 */
export async function carry(user, conversationId, picked = [], opts = {}) {
  const already = await carriedIds(conversationId);
  const fresh = picked.filter((id) => id !== conversationId && !already.includes(id));
  const ids = [...already, ...new Set(fresh)].slice(0, MAX_CARRIED);
  const chats = (await Promise.all(ids.map((id) => recapOf(user, id, opts)))).filter(Boolean);
  const added = chats.filter((c) => fresh.includes(c.id)).map(({ id, title }) => ({ id, title }));
  return { chats, added };
}

/** The list the API is given: ids only, and never more than a turn can use. */
export const pickedIds = (raw) => {
  const list = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
  return [...new Set((Array.isArray(list) ? list : []).map(Number).filter(Boolean))].slice(0, MAX_CARRIED);
};

/** Written once, against the message that brought them in. */
export async function noteCarried(messageId, added) {
  for (const { id, title } of added) {
    await db.prepare('INSERT INTO carried_chats (message_id, source_id, title) VALUES (?, ?, ?)').run(messageId, id, title);
  }
}
