import { MODELS, VOICES, COLORS } from './config.js';
import { db } from './db.js';
import { isMaster } from './access.js';
import { caseKey } from './caseMatch.js';

/**
 * What still points at this agent from someone other than its owner.
 *
 * An agent is shared by reference, so other people's material is filed against it.
 * Removing it under them is not the owner's call to make silently: unassigning is a
 * separate, reversible operation, and deletion waits until nobody else is attached.
 */
export async function agentLinks(ownerId, agentId) {
  const id = Number(agentId);
  const [{ n: users }, { n: documents }] = await Promise.all([
    db.prepare('SELECT COUNT(*)::int n FROM agent_assignments WHERE agent_id = ? AND user_id <> ?').get(id, ownerId),
    db.prepare('SELECT COUNT(*)::int n FROM documents WHERE agent_id = ? AND user_id <> ?').get(id, ownerId),
  ]);
  return { users, documents };
}

/**
 * An agent as the API returns it. Anyone given the agent may read its persona, so they know
 * what it does and how it was told to work (Francis, 2026-10-28); only the master edits it.
 * The model stays the master's choice and is not shown.
 */
export function agentOut(a, user) {
  if (!a) return a;
  const { model, user_id, ...rest } = a;
  const base = { ...rest, starters: JSON.parse(a.starters || '[]') };
  return isMaster(user) ? { ...base, model } : base;
}

export const agentIn = (b) => ({
  name: String(b.name || 'New agent').slice(0, 60),
  icon: /^[a-z-]{1,30}$/.test(b.icon) ? b.icon : 'bot',
  color: COLORS.includes(b.color) ? b.color : 'violet',
  persona: String(b.persona || '').slice(0, 8000),
  model: MODELS.some((m) => m.id === b.model) ? b.model : MODELS[0].id,
  voice: VOICES.includes(b.voice) ? b.voice : 'alloy',
  starters: JSON.stringify((Array.isArray(b.starters) ? b.starters : []).map(String).filter(Boolean).slice(0, 8)),
  private: b.private === true,
  handles_cases: b.handles_cases === true,
  ...boundCase(b.case_number),
});

/**
 * Sets the one case an agent works on. Its owner (the master) may always; anyone else only
 * for an agent given to them alone, since the binding moves every chat of everyone who has
 * it. Returns the agent row, or throws with a status the route passes on.
 */
export async function setAgentCase(user, agentId, number) {
  const id = Number(agentId) || 0;
  const agent = await db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  if (!agent) throw Object.assign(new Error('Not found'), { status: 404 });
  if (!(isMaster(user) && agent.user_id === user.id)) {
    const { mine, others } = await db.prepare(`SELECT count(*) FILTER (WHERE user_id = ?)::int mine,
      count(*) FILTER (WHERE user_id <> ?)::int others FROM agent_assignments WHERE agent_id = ? AND mode = 'chat'`).get(user.id, user.id, id);
    if (!mine) throw Object.assign(new Error('Not found'), { status: 404 });
    if (others) throw Object.assign(new Error('Other people use this agent too, so only the administrator can change its case'), { status: 403 });
  }
  const b = boundCase(number);
  return db.prepare('UPDATE agents SET case_number = ?, case_key = ? WHERE id = ? RETURNING *').get(b.case_number, b.case_key, id);
}

/** The one case an agent works on, or none: { case_number, case_key }. */
export function boundCase(number) {
  const n = String(number || '').trim().slice(0, 100);
  const key = n && caseKey(n);
  return key ? { case_number: n, case_key: key } : { case_number: null, case_key: null };
}
