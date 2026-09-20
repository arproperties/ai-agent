import { db } from './db.js';

// Who may use which agent. Every cross-user boundary in the app is decided here, so
// the rules exist in one place and can be tested without an HTTP request.
//
// Master owns agents (agents.user_id); everyone else reaches them through
// agent_assignments. Those are two different questions, so they are two different
// statements rather than one query with an OR - a widening condition inside a shared
// query puts the bypass on the same line as the protection.

export const isMaster = (user) => user?.role === 'master';

/** The agents this user converses with: their sidebar, and what the router may pick. */
export async function chatAgents(user) {
  if (isMaster(user)) {
    return db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY id').all(user.id);
  }
  return db.prepare(`SELECT a.* FROM agents a
    JOIN agent_assignments aa ON aa.agent_id = a.id
    WHERE aa.user_id = ? AND aa.mode = 'chat'
    ORDER BY aa.is_primary DESC, a.id`).all(user.id);
}

/**
 * Agent ids whose shelves this user may read. Includes 'knowledge' assignments, whose
 * agent is hidden from the sidebar but whose documents are still retrievable - that is
 * the whole point of the mode.
 */
export async function shelfIds(user) {
  const rows = isMaster(user)
    ? await db.prepare('SELECT id AS agent_id FROM agents WHERE user_id = ?').all(user.id)
    : await db.prepare('SELECT agent_id FROM agent_assignments WHERE user_id = ?').all(user.id);
  return rows.map((r) => r.agent_id);
}

/** May this user attach files to, speak as, or otherwise act on this agent? */
export async function canUseAgent(user, agentId) {
  const id = Number(agentId);
  if (!id) return false;
  if (isMaster(user)) {
    return !!(await db.prepare('SELECT 1 FROM agents WHERE id = ? AND user_id = ?').get(id, user.id));
  }
  return !!(await db.prepare('SELECT 1 FROM agent_assignments WHERE agent_id = ? AND user_id = ?').get(id, user.id));
}
