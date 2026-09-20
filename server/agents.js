import { MODELS, VOICES, COLORS } from './config.js';
import { isMaster } from './access.js';

/**
 * An agent as the API returns it. persona and model are master-authored configuration:
 * a normal user is shown the agent, not how it was built.
 */
export function agentOut(a, user) {
  if (!a) return a;
  const { persona, model, user_id, ...rest } = a;
  const base = { ...rest, starters: JSON.parse(a.starters || '[]') };
  return isMaster(user) ? { ...base, persona, model } : base;
}

export const agentIn = (b) => ({
  name: String(b.name || 'New agent').slice(0, 60),
  icon: /^[a-z-]{1,30}$/.test(b.icon) ? b.icon : 'bot',
  color: COLORS.includes(b.color) ? b.color : 'violet',
  persona: String(b.persona || '').slice(0, 8000),
  model: MODELS.some((m) => m.id === b.model) ? b.model : MODELS[0].id,
  voice: VOICES.includes(b.voice) ? b.voice : 'alloy',
  starters: JSON.stringify((Array.isArray(b.starters) ? b.starters : []).map(String).filter(Boolean).slice(0, 8)),
});
