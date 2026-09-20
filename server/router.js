import { db } from './db.js';
import { ask } from './ai.js';

const SYSTEM = `You route a user's message to the best agent on their personal AI team.
Reply with ONLY JSON: {"id": <agent id>, "why": "<topic label shown to the user, 2-4 words, e.g. \"Email drafting\" or \"Tenant rent issue\">"}
Rules:
- Pick the agent whose expertise, persona and files best match what the user needs right now.
- Judge attached files by their type and purpose, not by words that merely appear in them (an offer letter for an accountant job is an HR matter; a tenancy contract is a property matter).
- If the message continues the current topic (follow-ups like "make it shorter", "what about the second one?"), keep the current agent.
- If nothing specific fits, pick the general assistant.`;

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('router timeout')), ms))]);

/**
 * Filenames for the router prompt, so it can tell what each agent already holds.
 * Scoped to the calling user: an agent may be shared between users, but one user's
 * documents must never appear in another user's routing prompt.
 */
export async function teamDocuments(userId, agentIds) {
  if (!agentIds.length) return [];
  return db.prepare(`SELECT agent_id, name FROM documents
    WHERE user_id = ? AND agent_id IN (${agentIds.map(() => '?').join(',')})`)
    .all(userId, ...agentIds);
}

/**
 * Chooses which of the user's agents should answer.
 * Order: explicit "@Name" mention → only one agent → Claude Haiku router → fallback (current or first agent).
 */
export async function pickAgent({ agents, userId, text, attachments = [], recent, currentAgentId }) {
  const current = agents.find((a) => a.id === currentAgentId);
  const fallback = current || agents[0];

  const lower = text.toLowerCase();
  const mentioned = agents.find((a) => lower.startsWith(`@${a.name.toLowerCase()}`));
  if (mentioned) return { agent: mentioned, why: 'You asked for this agent' };
  if (agents.length === 1) return { agent: agents[0], why: null };

  const docs = await teamDocuments(userId, agents.map((a) => a.id));
  const team = agents.map((a) => {
    const files = docs.filter((d) => d.agent_id === a.id).slice(0, 8).map((d) => d.name);
    return `- id=${a.id} · ${a.name}: ${a.persona.slice(0, 350).replace(/\s+/g, ' ')}${files.length ? ` · files: ${files.join(', ')}` : ''}`;
  }).join('\n');
  const convo = recent.slice(-4).map((m) => `${m.role === 'user' ? 'USER' : m.agent_name || 'ASSISTANT'}: ${m.content.slice(0, 240).replace(/\s+/g, ' ')}`).join('\n');

  const prompt = `TEAM:\n${team}\n\nCURRENT AGENT: ${current ? `id=${current.id} · ${current.name}` : 'none (new conversation)'}\n\n` +
    `RECENT CONVERSATION:\n${convo || '(none)'}\n\nNEW MESSAGE: ${text.slice(0, 1500) || '(no text)'}` +
    (attachments.length ? `\nATTACHED FILES:\n${attachments.map((a) => `- ${a.name}${a.snippet ? `: ${a.snippet.slice(0, 500).replace(/\s+/g, ' ')}` : ' (image)'}`).join('\n')}` : '');

  try {
    const out = await withTimeout(ask(prompt, { system: SYSTEM, maxTokens: 80 }), 8000);
    const { id, why } = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    const agent = agents.find((a) => a.id === Number(id));
    if (agent) return { agent, why: why || null };
  } catch (e) {
    console.warn('[router]', e.message);
  }
  return { agent: fallback, why: null };
}
