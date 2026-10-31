import { Router } from 'express';
import { db, tx } from './db.js';
import { ask } from './ai.js';
import { CAREFUL_MODEL } from './config.js';
import { addMemory } from './knowledge.js';

// "Please check": Reem reads a person's memories and lists the ones that look wrong, out of
// date or repeated, with a short reason. Nothing is changed by the scan. The person decides
// each one: Keep (never flagged again), Fix (the corrected text replaces it, the old one stays
// under History) or Remove (it stops being used; kept in the database, out of every chat).

const MAX_FLAGS = 40;

/** What the model is asked; tests pass their own `check` so no model is called. */
async function checkMemories(memories, pinned) {
  const out = await ask(
    `Pinned facts (true; the person confirmed them):\n${pinned.map((m) => `- ${m.text}`).join('\n') || '(none)'}\n\n` +
    `Memories, oldest first:\n${memories.map((m) => `[${m.id}] (${new Date(m.created_at * 1000).toISOString().slice(0, 10)}) ${m.text}`).join('\n')}`,
    {
      maxTokens: 16000, // the careful model thinks first, and its thinking counts against this
      // Reading hundreds of memories at once, the fast model mixed up whose fact was whose and
      // flagged spellings; this is run by hand now and then, so the careful model is worth it.
      model: CAREFUL_MODEL,
      system: 'You check the long-term memory of an assistant for one person (the user). Flag ONLY memories that are clearly WRONG ' +
        'or OUT OF DATE, where you can name the pinned fact or the newer memory that shows it:\n' +
        '- the user given a wrong name or job (a building, a company or a colleague taken for the user);\n' +
        '- a person given a role that a pinned fact or a newer memory gives to someone else, or says they never had (e.g. only a candidate);\n' +
        '- a status a newer memory says has ended or changed;\n' +
        '- an exact repeat of another memory (flag the older copy and name the newer id).\n' +
        'Never flag: spellings or nicknames, a memory that is old, minor, vague or unfinished, a fact merely not confirmed elsewhere, ' +
        'or a fact about the past. The reason must be about THAT memory and name what contradicts it, e.g. "Pinned: Taj Khan is the Site Engineer" ' +
        'or "Newer memory [4424] says he was only a candidate". When in doubt, leave it out; flagging nothing is fine. ' +
        `At most ${MAX_FLAGS}. Reply with ONLY JSON: [{"id": 12, "reason": "one short plain sentence"}], or [] for none.`,
    }
  );
  const list = JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] || '[]');
  return Array.isArray(list) ? list : [];
}

/** Scan one person's memories and add what looks wrong to their list. Returns how many were added. */
export async function scanMemories(userId, { check = checkMemories } = {}) {
  const all = await db.prepare(`SELECT id, text, created_at, pinned FROM memories
    WHERE user_id = ? AND replaced_at IS NULL ORDER BY created_at, id`).all(userId);
  // Already on the list, or kept by the person: not asked about again.
  const settled = new Set((await db.prepare(`SELECT memory_id FROM memory_reviews
    WHERE user_id = ? AND (resolved_at IS NULL OR resolution = 'keep')`).all(userId)).map((r) => r.memory_id));
  const pinned = all.filter((m) => m.pinned);
  const open = all.filter((m) => !m.pinned && !settled.has(m.id));
  if (!open.length) return 0;

  const found = await check(open, pinned);
  const ok = new Set(open.map((m) => m.id));
  let added = 0;
  for (const f of found.slice(0, MAX_FLAGS)) {
    const id = Number(f?.id);
    const reason = String(f?.reason || '').trim().slice(0, 300);
    if (!ok.has(id) || !reason) continue; // only this person's own, current, unsettled memories
    ok.delete(id);
    await db.prepare('INSERT INTO memory_reviews (user_id, memory_id, reason) VALUES (?, ?, ?)').run(userId, id, reason);
    added++;
  }
  return added;
}

/** The open list: each flagged memory with why. */
export const reviewList = (userId) => db.prepare(`
  SELECT r.id, r.reason, m.id AS memory_id, m.text, m.created_at
  FROM memory_reviews r JOIN memories m ON m.id = r.memory_id
  WHERE r.user_id = ? AND r.resolved_at IS NULL AND m.replaced_at IS NULL
  ORDER BY m.created_at, m.id`).all(userId);

/** The person's answer to one item: keep, fix (with the corrected text) or remove. */
export async function resolveReview(userId, reviewId, { action, text } = {}) {
  const r = await db.prepare(`SELECT r.*, m.pinned FROM memory_reviews r JOIN memories m ON m.id = r.memory_id
    WHERE r.id = ? AND r.user_id = ? AND r.resolved_at IS NULL AND m.replaced_at IS NULL`).get(Number(reviewId) || 0, userId);
  if (!r) return null;
  const done = (resolution) => db.prepare(`UPDATE memory_reviews SET resolved_at = extract(epoch from now())::bigint, resolution = ?
    WHERE id = ?`).run(resolution, r.id);

  if (action === 'keep') { await done('keep'); return { ok: true }; }
  if (action === 'remove') {
    await tx(async () => {
      await db.prepare(`UPDATE memories SET replaced_at = extract(epoch from now())::bigint WHERE id = ? AND user_id = ?`).run(r.memory_id, userId);
      await done('remove');
    });
    return { ok: true };
  }
  if (action === 'fix') {
    const fixed = String(text || '').trim().slice(0, 500);
    if (!fixed) throw Object.assign(new Error('Write the corrected fact first.'), { status: 400 });
    // The corrected fact replaces this one only; nothing else is judged.
    const id = await addMemory(userId, fixed, { judge: async () => [] });
    await tx(async () => {
      await db.prepare(`UPDATE memories SET replaced_at = extract(epoch from now())::bigint, replaced_by = ? WHERE id = ? AND user_id = ?`)
        .run(id ?? null, r.memory_id, userId);
      if (id && r.pinned) await db.prepare('UPDATE memories SET pinned = true WHERE id = ?').run(id);
      await done('fix');
    });
    return { ok: true, id };
  }
  throw Object.assign(new Error('Unknown action'), { status: 400 });
}

const wrap = (fn) => (req, res, next) => fn(req, res).catch((e) => (e.status ? res.status(e.status).json({ error: e.message }) : next(e)));

// A scan reads every memory in one model call and can take a minute, longer than a request
// may wait, so it runs on after the reply and the screen asks again until it is done.
const scanning = new Map(); // userId -> promise

export const memoryReviewRoutes = Router();
memoryReviewRoutes.get('/', wrap(async (req, res) => res.json({ items: await reviewList(req.user.id), running: scanning.has(req.user.id) })));
memoryReviewRoutes.post('/scan', wrap(async (req, res) => {
  const me = req.user.id;
  if (!scanning.has(me)) {
    scanning.set(me, scanMemories(me)
      .catch((e) => console.error('[memory review]', e.message))
      .finally(() => scanning.delete(me)));
  }
  res.json({ items: await reviewList(me), running: true });
}));
memoryReviewRoutes.post('/:id', wrap(async (req, res) => {
  const out = await resolveReview(req.user.id, req.params.id, req.body || {});
  if (!out) return res.status(404).json({ error: 'Not found' });
  res.json(out);
}));
