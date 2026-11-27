import { Router } from 'express';
import { db, tx } from './db.js';
import { accountsSignedInHere } from './auth.js';

/**
 * Copying one chat into another account of the same person.
 *
 * Someone with a business and a private account, signed in side by side on one browser,
 * worked something out in the private one, then asked about it from the business one,
 * and Reem said it never happened, because each account sees only its own chats.
 * Copying the chat across puts it where they work, and Reem's chat search finds it there.
 *
 * A copy, not a shared chat: each account keeps its own chat and can carry on from it
 * without the other one changing. Who may receive it (an account signed in on this
 * browser) is decided by the route, which can see the browser's cookies.
 *
 * Attachments stay with the account that uploaded them, so in the copy they show by name
 * only. Returns the new chat's id, or null when the chat is not the sender's.
 */
export async function copyChat(fromUserId, conversationId, toUserId) {
  return tx(async () => {
    const c = await db.prepare('SELECT id, title FROM conversations WHERE id = ? AND user_id = ?').get(Number(conversationId), fromUserId);
    if (!c) return null;
    // Stamped now, so it is at the top of the other account's list under Today.
    const { id } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id')
      .run(toUserId, c.title || 'Untitled chat');
    // Each message keeps its own time, so the copy still shows the day it happened.
    await db.prepare(`INSERT INTO messages (conversation_id, agent_id, role, content, files, sources, cut_short, created_at)
      SELECT ?, agent_id, role, content, files, sources, cut_short, created_at FROM messages
      WHERE conversation_id = ? ORDER BY id`).run(id, c.id);
    return id;
  });
}

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

export const chatCopyRoutes = Router();
// Only an account signed in on this same browser may receive the copy, so nobody can drop
// a chat into someone else's list by guessing their id.
chatCopyRoutes.post('/:id/copy', wrap(async (req, res) => {
  const to = (await accountsSignedInHere(req, res, req.user.id)).find((u) => u.id === Number(req.body?.to));
  if (!to) return res.status(404).json({ error: 'That account is no longer signed in here. Sign in to it again, then copy.' });
  const id = await copyChat(req.user.id, req.params.id, to.id);
  if (!id) return res.status(404).json({ error: 'Chat not found' });
  res.json({ ok: true, id, to: to.name });
}));
