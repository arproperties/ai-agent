import { streamChat } from './api';

// Asking Reem through the pet. It is an ordinary chat turn, so it is saved in the chat list with
// the rest, goes to the same agents and tools, and is billed the same way. Asking again within
// ten minutes carries on the same chat, so "and the one after that?" still makes sense.

const KEY = 'jarvis:pet-chat';
const CARRY_ON_MS = 10 * 60 * 1000;
// What a turn can put on screen for the person to confirm. The pet does not rebuild these cards;
// it says one is waiting and opens the chat, where they live.
const CARDS = new Set(['teamReminder', 'responsibility', 'companyAddress', 'lesson','inventoryAdd', 'caseFolder', 'tenantNotice', 'arsBooking', 'draft']);

const lastChat = () => {
  try {
    const c = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return c && Date.now() - c.at < CARRY_ON_MS ? c.id : null;
  } catch { return null; }
};
const remember = (id) => { try { sessionStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* private mode */ } };

/** Resolves with { reply, conversationId, agentId, needsYou } once the reply is complete. */
export async function askReem(text, { signal, onStatus, onAgent, onText } = {}) {
  const form = new FormData();
  const carryOn = lastChat();
  if (carryOn) form.append('conversationId', carryOn);
  form.append('text', text);
  let reply = '', conversationId = null, agentId = null, needsYou = false, error = null;
  await streamChat(form, {
    signal,
    onEvent: (event, d) => {
      if (event === 'meta') { conversationId = d.conversationId; remember(conversationId); }
      else if (event === 'agent') { agentId = d.id; onAgent?.(d.id); }
      else if (event === 'status') onStatus?.(d.label);
      else if (event === 'delta') { reply += d.text; onText?.(reply); }
      else if (event === 'error') error = d.message;
      else if (CARDS.has(event)) needsYou = true;
    },
  });
  if (conversationId) remember(conversationId); // the ten minutes run from the last answer
  if (error && !reply) throw new Error(error);
  return { reply, conversationId, agentId, needsYou };
}

// The bubble is plain text: markdown marks and the hidden <!-- doc --> tags read as noise there.
export const plainText = (md) => md
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/```[\s\S]*?```/g, '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
  .replace(/[*_`~]/g, '')
  .replace(/\|/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
