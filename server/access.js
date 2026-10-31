import { db } from './db.js';

// Who may use which agent. Every cross-user boundary in the app is decided here, so
// the rules exist in one place and can be tested without an HTTP request.
//
// Master owns agents (agents.user_id); everyone else reaches them through
// agent_assignments. Those are two different questions, so they are two different
// statements rather than one query with an OR - a widening condition inside a shared
// query puts the bypass on the same line as the protection.

export const isMaster = (user) => user?.role === 'master';

/**
 * Someone from outside the company, ticked External on their People profile. They get an
 * empty book: their own files, chats, to-dos and memories, and only private agents -
 * nothing of the company's, no team, no staff list. It is a wall both ways: the master
 * does not see theirs either (masterReach). Each rule here narrows; none widens.
 */
export const isExternal = (user) => !!user?.external && !isMaster(user);

/**
 * What the master's "see everyone's" reads cover, as a condition on table alias `t`:
 * everybody's rows but an external person's.
 */
export const masterReach = (t = 't') => ({
  sql: `NOT EXISTS (SELECT 1 FROM users x WHERE x.id = ${t}.user_id AND x.external)`,
  params: [],
});

/** Is this account external? For the master's routes that name a person by id. */
export async function externalId(userId) {
  return !!(await db.prepare('SELECT 1 FROM users WHERE id = ? AND external').get(Number(userId) || 0));
}

// For an external person only private agents count, whatever else is still ticked.
const privateOnly = (user) => (isExternal(user) ? ' AND a.private' : '');

/**
 * The agents this user converses with: what the router may pick, and what a new file may
 * be filed against. The master's private agents are left out - they belong to the people
 * they are ticked for, so the master reaches one only by naming it (privateAgents).
 */
export async function chatAgents(user) {
  if (isMaster(user)) {
    return db.prepare('SELECT * FROM agents WHERE user_id = ? AND NOT private ORDER BY id').all(user.id);
  }
  return db.prepare(`SELECT a.* FROM agents a
    JOIN agent_assignments aa ON aa.agent_id = a.id
    WHERE aa.user_id = ? AND aa.mode = 'chat'${privateOnly(user)}
    ORDER BY aa.is_primary DESC, a.id`).all(user.id);
}

/** The master's private agents: in their list to manage, reached in chat only by @name. */
export async function privateAgents(user) {
  if (!isMaster(user)) return [];
  return db.prepare('SELECT * FROM agents WHERE user_id = ? AND private ORDER BY id').all(user.id);
}

/**
 * Someone whose agents are all private works apart from the team: their Shelf and their
 * agents hold only their own files, never what the master shared company-wide. Read once
 * per request and carried as user.ownFilesOnly, which agentScope() goes by.
 */
export async function onlyPrivateAgents(user) {
  if (isMaster(user)) return false;
  if (isExternal(user)) return true;
  const r = await db.prepare(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE NOT a.private)::int open
    FROM agent_assignments aa JOIN agents a ON a.id = aa.agent_id
    WHERE aa.user_id = ? AND aa.mode = 'chat'`).get(user.id);
  return r.n > 0 && r.open === 0;
}

/** Every agent this user's sidebar lists. */
export async function listedAgents(user) {
  return [...await chatAgents(user), ...await privateAgents(user)];
}

/**
 * Agent ids whose shelves this user may read. Includes 'knowledge' assignments, whose
 * agent is hidden from the sidebar but whose documents are still retrievable - that is
 * the whole point of the mode.
 */
export async function shelfIds(user) {
  const rows = isMaster(user)
    ? await db.prepare('SELECT id AS agent_id FROM agents WHERE user_id = ?').all(user.id)
    : await db.prepare(`SELECT aa.agent_id FROM agent_assignments aa JOIN agents a ON a.id = aa.agent_id
        WHERE aa.user_id = ?${privateOnly(user)}`).all(user.id);
  return rows.map((r) => r.agent_id);
}

/** May this user attach files to, speak as, or otherwise act on this agent? */
export async function canUseAgent(user, agentId) {
  const id = Number(agentId);
  if (!id) return false;
  if (isMaster(user)) {
    return !!(await db.prepare('SELECT 1 FROM agents WHERE id = ? AND user_id = ?').get(id, user.id));
  }
  return !!(await db.prepare(`SELECT 1 FROM agent_assignments aa JOIN agents a ON a.id = aa.agent_id
    WHERE aa.agent_id = ? AND aa.user_id = ?${privateOnly(user)}`).get(id, user.id));
}

/**
 * The parts of the app an external person may reach: their own chats, files and lists.
 * Anything else under /api - team chat, buildings, the shared inbox, saifsys, and any
 * company screen added later - is closed to them by default, so a new feature cannot
 * open the company to them by being forgotten here. Matched on the path's first part.
 */
const EXTERNAL_OPEN = new Set(['auth', 'config', 'agents', 'conversations', 'chat', 'messages', 'documents', 'imports',
  'memories', 'voice', 'access', 'modules', 'todos', 'routines', 'suggestions', 'push', 'meetings', 'transcripts',
  'translate', 'replies', 'pictures', 'email', 'outlook', 'imap', 'cases', 'case-focus']);

/** Mount after requireUser. Leaves everyone but an external person alone. */
export function externalFence(req, res, next) {
  if (!isExternal(req.user)) return next();
  const first = req.path.split('/')[1];
  if (EXTERNAL_OPEN.has(first)) return next();
  res.status(404).json({ error: 'Not found' });
}

/**
 * A person's place on a project (server/projects.js): 'master' for the master, who sees
 * every project; 'store' or 'manager' for a member; null for anyone else. Someone external
 * is never on one, whatever a row says: a project is the company's own work.
 */
export async function projectRole(user, projectId) {
  const id = Number(projectId) || 0;
  if (!id || isExternal(user)) return null;
  if (isMaster(user)) return (await db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) ? 'master' : null;
  return (await db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(id, user.id))?.role || null;
}

/** The projects this person is on, with their place on each - the same rule as projectRole. */
export async function projectsOf(user) {
  if (isExternal(user)) return [];
  if (isMaster(user)) return (await db.prepare('SELECT *, \'master\' AS role FROM projects ORDER BY name, id').all());
  return db.prepare(`SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id = p.id
    WHERE m.user_id = ? ORDER BY p.name, p.id`).all(user.id);
}
