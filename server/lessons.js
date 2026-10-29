import { Router } from 'express';
import { db, tx } from './db.js';
import { requireMaster } from './auth.js';
import { isMaster } from './access.js';
import { tooSpecificToShare } from './knowledge.js';

// Rules the master teaches an agent by correcting it in a chat ("no, always show rent
// including VAT"). The screens call them Rules; the code says lesson so it never clashes
// with the rule text itself.
//
// Reem never learns one by itself. It writes the correction as one plain sentence and a
// "Learn this?" card appears under the reply: Approve, Edit or No. Only the master's own
// chats make them - a staff or external chat never does. Once approved, the agent follows
// the rule in every chat with anyone, so a rule is about how the agent works, never about a
// person: names, sums and ID numbers are refused before they can reach every chat.
//
// A No is kept, and so is a removed rule, so the same thing is never offered twice.

const NOW = 'extract(epoch from now())::bigint';
const MAX_RULE = 300;
const IN_PROMPT = 50; // the newest ones; a long list would drown the persona
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// "Always show rent including VAT." and "  always show RENT including vat. " are one rule.
const SAME = (col) => `lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g'))`;
const scopeIs = (col) => `${col} IS NOT DISTINCT FROM ?`;

const PCOLS = `p.id, p.conversation_id, p.agent_id, a.name AS agent_name, p.rule, p.replaces_lesson_id,
  r.rule AS replaces_rule, p.status, p.decided_at, p.created_at`;
const PFROM = `lesson_proposals p LEFT JOIN agents a ON a.id = p.agent_id LEFT JOIN agent_lessons r ON r.id = p.replaces_lesson_id`;
const LCOLS = 'id, agent_id, rule, created_at';

const getProposal = (masterId, id) =>
  db.prepare(`SELECT ${PCOLS} FROM ${PFROM} WHERE p.id = ? AND p.master_id = ?`).get(Number(id), masterId);

function cleanRule(raw) {
  const rule = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!rule) throw bad('The rule is empty.');
  if (rule.length > MAX_RULE) throw bad(`Keep the rule under ${MAX_RULE} characters.`);
  if (tooSpecificToShare(rule)) {
    throw bad('That reads as being about a particular person, sum or document. Restate it as a general rule, without names, sums or ID numbers.');
  }
  return rule;
}

async function ownAgent(master, agentId) {
  const a = await db.prepare('SELECT id, user_id FROM agents WHERE id = ?').get(Number(agentId));
  if (!a || a.user_id !== master.id) throw bad('That agent is not one of yours.', 403);
  return a.id;
}

/** Refuses a rule already in force, waiting on a card, turned down or removed, for that scope. */
async function notSeenBefore(masterId, agentId, rule, { skipProposal = null } = {}) {
  const hit = await db.prepare(`
    SELECT 1 FROM agent_lessons WHERE owner_id = ? AND ${scopeIs('agent_id')} AND ${SAME('rule')} = ${SAME('?')}
    UNION ALL
    SELECT 1 FROM lesson_proposals WHERE master_id = ? AND ${scopeIs('agent_id')} AND ${SAME('rule')} = ${SAME('?')}
      AND status IN ('pending', 'declined') AND id IS DISTINCT FROM ?
    LIMIT 1`).get(masterId, agentId, rule, masterId, agentId, rule, skipProposal);
  if (hit) throw bad('That rule has already been offered, taught or turned down - it will not be asked again.', 409);
}

/** A current lesson of this owner, or null: a stale or foreign id is dropped, never trusted. */
async function currentLesson(ownerId, id) {
  if (!Number.isInteger(Number(id)) || id === null) return null;
  return (await db.prepare('SELECT id FROM agent_lessons WHERE id = ? AND owner_id = ? AND removed_at IS NULL')
    .get(Number(id), ownerId))?.id ?? null;
}

export async function proposeLesson(master, { agentId, rule, allAgents = false, replaces = null, conversationId = null }) {
  if (!isMaster(master)) throw bad('Only the master teaches agents.', 403);
  const own = await ownAgent(master, agentId);
  const text = cleanRule(rule);
  const scope = allAgents ? null : own;
  await notSeenBefore(master.id, scope, text);
  const { id } = await db.prepare(`INSERT INTO lesson_proposals (master_id, conversation_id, agent_id, rule, replaces_lesson_id)
    VALUES (?, ?, ?, ?, ?) RETURNING id`).run(master.id, conversationId, scope, text, await currentLesson(master.id, replaces));
  return getProposal(master.id, id);
}

/**
 * Approve or No on the card. The status change is the lock, so a double tap applies it
 * once. Approve may carry an edited rule and another scope (agentId null = All agents);
 * replace (on by default) retires the lesson the card said it replaces, in the same step.
 */
export async function decideLesson(master, id, { approve, rule, agentId, replace = true } = {}) {
  const p = await getProposal(master.id, id);
  if (!p) return null;
  if (p.status !== 'pending') throw bad(`This was already ${p.status}.`, 409);
  if (!approve) {
    const { changes } = await db.prepare(`UPDATE lesson_proposals SET status = 'declined', decided_at = ${NOW} WHERE id = ? AND status = 'pending'`).run(p.id);
    if (!changes) throw bad('This was already decided.', 409);
    return getProposal(master.id, p.id);
  }
  const text = rule === undefined ? p.rule : cleanRule(rule);
  const scope = agentId === undefined ? p.agent_id : agentId === null ? null : await ownAgent(master, agentId);
  await notSeenBefore(master.id, scope, text, { skipProposal: p.id });
  await tx(async () => {
    const { changes } = await db.prepare(`UPDATE lesson_proposals SET status = 'approved', decided_at = ${NOW}, rule = ?, agent_id = ?
      WHERE id = ? AND status = 'pending'`).run(text, scope, p.id);
    if (!changes) throw bad('This was already decided.', 409);
    const old = replace ? await currentLesson(master.id, p.replaces_lesson_id) : null;
    if (old) await db.prepare(`UPDATE agent_lessons SET removed_at = ${NOW} WHERE id = ?`).run(old);
    await db.prepare('INSERT INTO agent_lessons (owner_id, agent_id, rule, from_proposal_id) VALUES (?, ?, ?, ?)')
      .run(master.id, scope, text, p.id);
  });
  return getProposal(master.id, p.id);
}

export async function removeLesson(master, lessonId) {
  const { changes } = await db.prepare(`UPDATE agent_lessons SET removed_at = ${NOW} WHERE id = ? AND owner_id = ? AND removed_at IS NULL`)
    .run(Number(lessonId), master.id);
  return changes > 0;
}

/**
 * The rules an agent follows: its own and its owner's All-agents ones. Read off the agent's
 * owner, not the person chatting, so a staff member or an external user talking to the agent
 * gets the very same rules - that is the point of teaching it.
 */
export async function lessonsFor(agent) {
  const owner = (await db.prepare('SELECT name FROM users WHERE id = ?').get(agent.user_id))?.name || 'the owner';
  const rows = await db.prepare(`SELECT ${LCOLS} FROM agent_lessons
    WHERE owner_id = ? AND (agent_id = ? OR agent_id IS NULL) AND removed_at IS NULL
    ORDER BY created_at DESC, id DESC LIMIT ${IN_PROMPT}`).all(agent.user_id, agent.id);
  return { owner, lessons: rows.reverse() };
}

export function lessonsBlock(ownerName, lessons) {
  if (!lessons?.length) return '';
  return `<lessons>\nStanding rules ${ownerName} has taught you about how to do your work. Follow them in every chat; ` +
    'where one clashes with a request in this chat, follow the request and mention the rule.\n' +
    `${lessons.map((l) => `- ${l.rule}`).join('\n')}\n</lessons>`;
}

export async function listLessons(master, agentId) {
  const rows = await db.prepare(`SELECT ${LCOLS} FROM agent_lessons
    WHERE owner_id = ? AND (agent_id = ? OR agent_id IS NULL) AND removed_at IS NULL ORDER BY created_at, id`)
    .all(master.id, Number(agentId));
  return { own: rows.filter((l) => l.agent_id !== null), all: rows.filter((l) => l.agent_id === null) };
}

export const proposalsFor = (master, conversationId) =>
  db.prepare(`SELECT ${PCOLS} FROM ${PFROM} WHERE p.master_id = ? AND ${scopeIs('p.conversation_id')} ORDER BY p.id`)
    .all(master.id, conversationId ?? null);
