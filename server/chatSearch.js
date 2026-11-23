import { db } from './db.js';
import { splitParts } from './shelf.js';

/**
 * Finding something in the person's own earlier chats.
 *
 * Plenty of real work is written in a chat and never saved to the Shelf: the boss's AC
 * technician interview packet was a long reply in a chat from September, and when he
 * asked for it two months later Reem looked only at the Shelf, memory and the mailbox,
 * then said it did not exist and asked him for its exact name. These tools let her look
 * through his old chats by the words he does remember.
 *
 * Only the person's own chats (conversations.user_id), the same rule as the chat list and
 * its search box. Read-only.
 */

const HITS = 40; // messages ranked, before grouping by chat
const CHATS = 8; // chats listed back
const PER_CHAT = 2; // best messages shown per chat

const fmtDay = (secs) => new Date(secs * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' });

/**
 * Any of the words, so a half-remembered name still finds it ("AC interview pack" finds
 * "HVAC Technician Interview Pack"). Two letters count here: AC, HR and MEP-style words are
 * how people name things. The words are stripped to letters and digits, so to_tsquery has
 * nothing to misread.
 */
export function chatQuery(q) {
  const words = [...new Set((String(q || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []))];
  return words.slice(0, 12).join(' | ');
}

function snippet(text, words) {
  const flat = String(text || '').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  const at = words.map((w) => low.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 60);
  return `${start ? '…' : ''}${flat.slice(start, start + 220)}${start + 220 < flat.length ? '…' : ''}`;
}

/** The chats that best match, each with its best messages: [{ conversationId, title, hits: [{ id, role, at, length, snippet }] }]. */
export async function searchChats(userId, query, { exceptConversation = null } = {}) {
  const tsq = chatQuery(query);
  if (!tsq) throw new Error('Give a few words to look for');
  // The chat's title counts double: it is usually the best name the person gave the work.
  const rows = await db.prepare(`SELECT m.id, m.conversation_id, c.title, m.role, m.created_at, length(m.content) AS length, m.content,
      ts_rank(setweight(to_tsvector('english', coalesce(c.title, '')), 'A') || setweight(to_tsvector('english', m.content), 'B'), q) AS rank
    FROM messages m JOIN conversations c ON c.id = m.conversation_id, to_tsquery('english', ?) q
    WHERE c.user_id = ? AND c.id IS DISTINCT FROM ?
      AND (to_tsvector('english', coalesce(c.title, '')) || to_tsvector('english', m.content)) @@ q
    ORDER BY rank DESC, m.id DESC LIMIT ${HITS}`).all(tsq, userId, exceptConversation);

  const words = tsq.split(' | ');
  const chats = new Map();
  for (const r of rows) {
    const c = chats.get(r.conversation_id) ?? { conversationId: r.conversation_id, title: r.title || 'Untitled chat', hits: [] };
    if (c.hits.length < PER_CHAT) c.hits.push({ id: r.id, role: r.role, at: r.created_at, length: r.length, snippet: snippet(r.content, words) });
    chats.set(r.conversation_id, c);
  }
  return [...chats.values()].slice(0, CHATS);
}

/** One message from their own chats, in parts when long, with the question it answered. */
export async function readChatMessage(userId, { id, part } = {}) {
  const m = await db.prepare(`SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title
    FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.user_id = ?`).get(Number(id), userId);
  if (!m) throw new Error(`No message #${id} in your chats`);
  const parts = splitParts(m.content);
  const total = Math.max(1, parts.length);
  const n = Math.min(Math.max(1, Math.floor(Number(part)) || 1), total);
  const asked = m.role === 'assistant' && n === 1 ? await db.prepare(`SELECT content FROM messages
    WHERE conversation_id = ? AND id < ? AND role = 'user' ORDER BY id DESC LIMIT 1`).get(m.conversation_id, m.id) : null;
  const head = `From the chat "${m.title || 'Untitled chat'}" (${fmtDay(m.created_at)}), ${m.role === 'user' ? 'what they wrote' : 'Reem\'s reply'}. ` +
    (total === 1 ? 'The whole message.' : `Part ${n} of ${total}.${n < total ? ` Read part ${n + 1} next (read_chat id ${m.id}, part ${n + 1}).` : ' This is the last part.'}`);
  return [head, asked ? `They had asked: ${asked.content.slice(0, 600)}` : '', '---', parts[n - 1] || ''].filter(Boolean).join('\n');
}

export const CHAT_SEARCH_TOOLS = [
  {
    name: 'search_chats',
    description: "Look through the user's own earlier chats with Reem, by the words in them. Much of their work (packets, letters, plans, checklists, answers) was written in a chat and never saved to the Shelf. " +
      'Use it when they ask for something "we made", "you wrote", "we did before", or that search_files does not find - always before saying something does not exist. ' +
      'Never ask them for the exact name: search by what it is about, and if nothing comes back try other words (AC and HVAC, packet and pack, interview and hiring). ' +
      'Long messages are usually the finished piece of work. Then read it with read_chat.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A few words about it, any order. E.g. "AC technician interview packet".' } },
      required: ['query'],
    },
  },
  {
    name: 'read_chat',
    description: 'Read one message from their earlier chats in full, by the number search_chats gave. A long one comes in parts and says which to read next; read every part before handing it over or working from it.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The message number from search_chats, without the #.' },
        part: { type: 'integer', description: 'Which part of a long message, from 1. Leave out for the first.' },
      },
      required: ['id'],
    },
  },
];

/** Same shape as the other kits. conversationId: this chat, left out of the search. */
export function chatSearchKit(user, { conversationId = null } = {}) {
  return {
    definitions: CHAT_SEARCH_TOOLS,
    status: (name, input) => (name === 'search_chats' ? `Looking through your earlier chats: “${String(input?.query || '').slice(0, 60)}”`
      : name === 'read_chat' ? 'Reading the earlier chat…' : null),
    run: async (block) => {
      try {
        const input = block.input || {};
        let content;
        if (block.name === 'search_chats') {
          const chats = await searchChats(user.id, input.query, { exceptConversation: conversationId });
          content = chats.length
            ? chats.map((c) => `Chat "${c.title}":\n${c.hits.map((h) => `- #${h.id} ${h.role === 'user' ? 'they wrote' : 'Reem replied'}, ${fmtDay(h.at)}, ${h.length} characters: ${h.snippet}`).join('\n')}`).join('\n\n')
            : 'No earlier chat mentions that. Try other words before saying it is not there.';
        } else if (block.name === 'read_chat') content = await readChatMessage(user.id, input);
        else throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}
