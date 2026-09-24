// A Jarvis reply, passed on to the team.
//
// Someone asks an agent for the points, then taps Share on that reply and picks a chat.
// What arrives there is an ordinary message - repliable, quotable, deletable like any
// other - carrying one label: which agent wrote the words.
//
// Only the one reply travels, never the conversation around it. The rest of that thread
// is the asker's own and nothing here reads it, which is also why this is not a
// widening of the rule at the top of messenger.js: no chat is sent to the model, a
// finished answer is being copied out of one.
//
// The text is read from the database by id, never taken from the browser. That is the
// difference between "Jarvis said this" and "somebody typed this and signed it Jarvis".
import { db, tx } from './db.js';

const MAX = 4000; // the same ceiling messenger.js puts on a typed message

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Copy assistant reply `messageId` into `chatId` as a message from `userId`, who must
 * own the conversation it came from. Membership of the chat is the caller's to check.
 * Returns the new dm_messages id.
 */
export async function shareReply({ chatId, userId, messageId }) {
  const m = await db.prepare(`SELECT m.id, m.content, m.agent_id, a.name agent_name
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN agents a ON a.id = m.agent_id
    WHERE m.id = ? AND c.user_id = ? AND m.role = 'assistant'`).get(Number(messageId) || 0, userId);
  if (!m) throw bad('That reply was not found', 404);

  const body = (m.content || '').trim().slice(0, MAX);
  if (!body) throw bad('There is nothing in that reply to share');

  return tx(async () => {
    const { id } = await db.prepare(`INSERT INTO dm_messages (chat_id, user_id, kind, body)
      VALUES (?, ?, 'text', ?) RETURNING id`).run(chatId, userId, body);
    await db.prepare(`INSERT INTO dm_shared_replies (message_id, source_message_id, agent_id, agent_name)
      VALUES (?, ?, ?, ?)`).run(id, m.id, m.agent_id, m.agent_name || 'Jarvis');
    return id;
  });
}
