// Primary case: the first case a chat names is what that chat is about, for good.
//
// Someone working on one case brings up others along the way ("how did 198822 end?"), and
// the agent mixed them: another case's dates turned up in this one. So the first case named
// is written on the conversation once and never changed, and every other case named after
// it is kept as a reference. chat.js tells the agent which is which.
//
// Only for those given the case_focus module. Without it nothing here runs.
import { Router } from 'express';
import { db } from './db.js';
import { needsModule } from './modules.js';
import { casesIn, allCases, sameCase } from './primaryCase.js';

/** The cases this person has of their own: their case folders, and legal cases if they have Legal. */
export async function knownCases(user, modules = []) {
  const folders = await db.prepare('SELECT id, case_number, party_a, party_b FROM case_folders WHERE user_id = ?').all(user.id);
  const legal = modules.includes('legal')
    ? await db.prepare('SELECT id, number, title, party_name FROM legal_cases').all() : [];
  const { pattern } = await db.prepare('SELECT pattern FROM case_settings WHERE user_id = ?').get(user.id) || {};
  return {
    known: [
      ...folders.map((f) => ({ number: f.case_number, partyA: f.party_a, partyB: f.party_b, folderId: f.id })),
      ...legal.map((c) => ({ number: c.number, title: c.title, partyB: c.party_name, legalCaseId: c.id })),
    ],
    patterns: pattern ? [pattern] : [],
  };
}

const said = (m) => ({ text: m.content || '', fileNames: JSON.parse(m.files || '[]').map((f) => f.name).filter(Boolean) });

const addRefs = (refs, found, primary) => {
  const out = [...refs];
  for (const c of found) {
    if (!sameCase(c.number, primary.number) && !out.some((r) => sameCase(r.number, c.number))) out.push(c);
  }
  return out;
};

/**
 * For one turn: sets the primary case if this chat has none yet and a case is now named,
 * and adds any other case named to the references. The earlier messages are looked at too,
 * oldest first, so "hi" before the case, or a chat from before this existed, still gets the
 * case it was started about. Returns { primary, references, changed } or null for a chat
 * that is not theirs.
 */
export async function focusTurn(user, conversationId, { text = '', fileNames = [], modules = [] } = {}) {
  const conv = await db.prepare('SELECT primary_case, reference_cases FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, user.id);
  if (!conv) return null;
  const { known, patterns } = await knownCases(user, modules);
  const now = { text, fileNames };
  let primary = conv.primary_case;
  let references = conv.reference_cases || [];

  if (!primary) {
    const earlier = (await db.prepare(`SELECT content, files FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id`)
      .all(conversationId)).map(said);
    const turns = [...earlier, now];
    // A message that names two cases settles nothing; the next one is looked at.
    const at = turns.findIndex((t) => casesIn({ ...t, known, patterns }).cases.length === 1);
    if (at < 0) return { primary: null, references: [], changed: false };
    const found = casesIn({ ...turns[at], known, patterns }).cases[0];
    const { source, ...rest } = found;
    const row = await db.prepare(`UPDATE conversations SET primary_case = ?::jsonb
      WHERE id = ? AND user_id = ? AND primary_case IS NULL RETURNING primary_case`)
      .get(JSON.stringify({ ...rest, source }), conversationId, user.id);
    // Two messages at once: the other one wrote it first, and that one stands.
    primary = row?.primary_case
      || (await db.prepare('SELECT primary_case FROM conversations WHERE id = ?').get(conversationId)).primary_case;
    const named = turns.flatMap((t) => allCases({ ...t, known, patterns }));
    references = addRefs(references, named, primary);
    await saveRefs(conversationId, references);
    return { primary, references, changed: true };
  }

  const more = addRefs(references, allCases({ ...now, known, patterns }), primary);
  if (more.length === references.length) return { primary, references, changed: false };
  await saveRefs(conversationId, more);
  return { primary, references: more, changed: true };
}

const saveRefs = (conversationId, refs) =>
  db.prepare('UPDATE conversations SET reference_cases = ?::jsonb WHERE id = ?').run(JSON.stringify(refs.map(({ number, key }) => ({ number, key }))), conversationId);

/** What the chat screen shows on the case chip. */
export async function focusOf(userId, conversationId) {
  const conv = await db.prepare('SELECT primary_case, reference_cases FROM conversations WHERE id = ? AND user_id = ?').get(Number(conversationId) || 0, userId);
  return conv && { primary: conv.primary_case, references: conv.reference_cases || [] };
}

// ---------- routes ----------

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
export const caseFocusRoutes = Router();
caseFocusRoutes.use(needsModule('case_focus'));

// Read only: there is no route that sets or changes a primary case. Only a chat message does.
caseFocusRoutes.get('/:conversationId', wrap(async (req, res) => {
  const focus = await focusOf(req.user.id, req.params.conversationId);
  if (!focus) return res.status(404).json({ error: 'Not found' });
  res.json(focus);
}));
