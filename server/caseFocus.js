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
import { casesIn, allCases, sameCase, names } from './primaryCase.js';
import { caseKey, searchTerm } from './caseMatch.js';
import { dubaiDate } from './saifsys/client.js';
import { deadlinesFor } from './caseDeadlines.js';
import { briefOf, saveBrief, approve, dismiss } from './caseBrief.js';

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

/**
 * A chat with no case yet, started by tagging an agent bound to one: that case is the chat's.
 * Never changes a case already set. Returns true when it set it.
 */
export async function claimCase(userId, conversationId, agent) {
  const row = await db.prepare(`UPDATE conversations SET primary_case = ?::jsonb
    WHERE id = ? AND user_id = ? AND primary_case IS NULL RETURNING id`)
    .get(JSON.stringify({ number: agent.case_number, key: agent.case_key, source: 'agent' }), conversationId, userId);
  return Boolean(row);
}

const saveRefs = (conversationId, refs) =>
  db.prepare('UPDATE conversations SET reference_cases = ?::jsonb WHERE id = ?').run(JSON.stringify(refs.map(({ number, key }) => ({ number, key }))), conversationId);

/** What the chat screen shows on the case chip. */
export async function focusOf(userId, conversationId) {
  const conv = await db.prepare('SELECT primary_case, reference_cases FROM conversations WHERE id = ? AND user_id = ?').get(Number(conversationId) || 0, userId);
  return conv && { primary: conv.primary_case, references: conv.reference_cases || [] };
}

// ---------- the case's files, for the panel beside the chat ----------

const FILE_COLS = 'id, title, name, created_at, case_folder_id';

/**
 * The person's own Shelf files that belong to the chat's primary case: what its case folder
 * made (the summary first), anything attached in any of their chats about the case (a
 * "scan_001.pdf" has no number in its name, but was sent to the case), and any file whose
 * title or name has the case number. Never a reference case's files: the panel is the one
 * case the chat is about.
 */
export async function caseFiles(userId, conversationId) {
  const focus = await focusOf(userId, conversationId);
  if (!focus?.primary) return null;
  const p = focus.primary;
  const folders = (await db.prepare('SELECT id, case_number, summary_doc_id FROM case_folders WHERE user_id = ?').all(userId))
    .filter((f) => f.id === p.folderId || sameCase(f.case_number, p.number));
  const inFolders = folders.length
    ? await db.prepare(`SELECT ${FILE_COLS} FROM documents WHERE user_id = ? AND case_folder_id = ANY(?::int[])`).all(userId, folders.map((f) => f.id))
    : [];
  const chats = (await db.prepare('SELECT id, primary_case FROM conversations WHERE user_id = ? AND primary_case IS NOT NULL').all(userId))
    .filter((c) => keyOf(c.primary_case) === keyOf(p)).map((c) => c.id);
  const inChats = chats.length
    ? await db.prepare(`SELECT ${FILE_COLS} FROM documents WHERE user_id = ? AND conversation_id = ANY(?::int[])`).all(userId, chats)
    : [];
  // The database narrows by the number's digits; names() then checks it is this case and not a longer number.
  const digits = searchTerm(p.number);
  const byName = digits.length >= 4
    ? (await db.prepare(`SELECT ${FILE_COLS} FROM documents WHERE user_id = ? AND (title ILIKE ? OR name ILIKE ?)`).all(userId, `%${digits}%`, `%${digits}%`))
      .filter((d) => names(d.title || '', p.number) || names(d.name || '', p.number))
    : [];
  const summaries = new Set(folders.map((f) => f.summary_doc_id).filter(Boolean));
  const files = [...new Map([...inFolders, ...inChats, ...byName].map((d) => [d.id, d])).values()]
    .map((d) => ({ ...d, summary: summaries.has(d.id) }))
    .sort((a, b) => (b.summary - a.summary) || (b.created_at - a.created_at) || (b.id - a.id));
  return { number: p.number, files };
}

// ---------- the case timer ----------

// The most one beat can add. The page beats every 30 seconds while the timer runs, and a
// background tab is slowed to about once a minute, which must still count; a laptop that
// slept for an hour must not.
export const BEAT_CAP = 120;

const keyOf = (primary) => primary.key || caseKey(primary.number);

// The seven Dubai days ending today, oldest first, as YYYY-MM-DD.
const lastDays = (today, n = 7) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (n - 1 - i));
  return d.toISOString().slice(0, 10);
});

/** This person's time on one case: today, the last 7 days, all of it, and each of the 7 days. */
export async function timeOn(userId, primary, today = dubaiDate()) {
  const key = keyOf(primary);
  const days = lastDays(today);
  const t = await db.prepare(`SELECT coalesce(sum(seconds) FILTER (WHERE day = ?::date), 0)::int today,
      coalesce(sum(seconds) FILTER (WHERE day >= ?::date), 0)::int week,
      coalesce(sum(seconds), 0)::int total, count(DISTINCT conversation_id)::int chats
    FROM case_time WHERE user_id = ? AND case_key = ?`).get(today, days[0], userId, key);
  const rows = await db.prepare(`SELECT day::text d, sum(seconds)::int s FROM case_time
    WHERE user_id = ? AND case_key = ? AND day >= ?::date GROUP BY day`).all(userId, key, days[0]);
  return { ...t, days: days.map((d) => ({ day: d, seconds: rows.find((r) => r.d === d)?.s || 0 })) };
}

/**
 * One beat of a running timer. start: the timer has just been started or resumed, so the
 * time since the last beat was a pause and is not counted. The case is the chat's own, read
 * here, never one the page names. Returns the totals, or null for a chat with no case.
 */
export async function beat(userId, conversationId, { start = false, now = Math.floor(Date.now() / 1000) } = {}) {
  const focus = await focusOf(userId, conversationId);
  if (!focus?.primary) return null;
  const p = focus.primary;
  const { last } = await db.prepare('SELECT max(last_beat_at) AS last FROM case_time WHERE user_id = ? AND conversation_id = ?')
    .get(userId, Number(conversationId));
  const add = start || !last ? 0 : Math.max(0, Math.min(BEAT_CAP, now - last));
  const today = dubaiDate(now * 1000);
  await db.prepare(`INSERT INTO case_time (user_id, case_key, case_number, conversation_id, day, seconds, last_beat_at)
    VALUES (?, ?, ?, ?, ?::date, ?, ?)
    ON CONFLICT (user_id, case_key, conversation_id, day)
    DO UPDATE SET seconds = case_time.seconds + EXCLUDED.seconds, last_beat_at = EXCLUDED.last_beat_at`)
    .run(userId, keyOf(p), p.number, Number(conversationId), today, add, now);
  return { added: add, ...(await timeOn(userId, p, today)) };
}

/** Every case this person has timed, for Time on cases: in the range asked, and all time. */
export async function timeByCase(userId, from, to) {
  const rows = await db.prepare(`SELECT case_key, max(case_number) case_number,
      coalesce(sum(seconds) FILTER (WHERE day BETWEEN ?::date AND ?::date), 0)::int seconds,
      sum(seconds)::int total, count(DISTINCT conversation_id)::int chats, max(day)::text last_day
    FROM case_time WHERE user_id = ? GROUP BY case_key ORDER BY max(last_beat_at) DESC`).all(from, to, userId);
  return rows;
}

// ---------- the cases worked on with one agent ----------

/**
 * For the Cases tab on an agent: every case this person has discussed with this agent, newest
 * first, with its chats, how many files it has, its next legal date and the time spent on it.
 * Only their own chats: an agent shared by many people shows each of them only their cases.
 */
export async function agentCases(userId, agentId, today = dubaiDate()) {
  const convs = await db.prepare(`SELECT c.id, c.title, c.updated_at, c.primary_case FROM conversations c
    WHERE c.user_id = ? AND c.primary_case IS NOT NULL
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.agent_id = ?)
    ORDER BY c.updated_at DESC NULLS LAST, c.id DESC`).all(userId, Number(agentId) || 0);
  const byKey = new Map();
  for (const c of convs) {
    const key = keyOf(c.primary_case);
    if (!byKey.has(key)) byKey.set(key, { key, ...c.primary_case, chats: [] });
    byKey.get(key).chats.push({ id: c.id, title: c.title, updated_at: c.updated_at });
  }
  return Promise.all([...byKey.values()].map(async (k) => {
    const [{ files }, next, { seconds }, { brief, suggestion }] = await Promise.all([
      caseFiles(userId, k.chats[0].id),
      db.prepare(`SELECT due::text due, what FROM case_deadlines WHERE user_id = ? AND case_key = ? AND due >= ?::date
        ORDER BY due LIMIT 1`).get(userId, k.key, today),
      db.prepare('SELECT coalesce(sum(seconds), 0)::int seconds FROM case_time WHERE user_id = ? AND case_key = ?').get(userId, k.key),
      briefOf(userId, k.key),
    ]);
    return { key: k.key, number: k.number, partyA: k.partyA || null, partyB: k.partyB || null, title: k.title || null,
      chats: k.chats, files: files.length, next: next || null, seconds, brief, suggestion };
  }));
}

/**
 * Case Home: one case of this person's, by its key, with every chat about it whichever agent
 * answered, and its brief. Its files, dates and time come from the chat routes above, asked
 * with the newest chat's id. Null when they have no chat about the case.
 */
export async function caseHome(userId, key, number = '') {
  const chats = (await db.prepare(`SELECT c.id, c.title, c.updated_at, c.primary_case,
      (SELECT a.name FROM messages m JOIN agents a ON a.id = m.agent_id WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) agent_name
    FROM conversations c WHERE c.user_id = ? AND c.primary_case IS NOT NULL
    ORDER BY c.updated_at DESC NULLS LAST, c.id DESC`).all(userId))
    .filter((c) => keyOf(c.primary_case) === key);
  // A case an agent is bound to has a home before its first chat.
  if (!chats.length && !(number && caseKey(number) === key)) return null;
  const p = chats[0]?.primary_case || { number };
  return {
    key, number: p.number, partyA: p.partyA || null, partyB: p.partyB || null, title: p.title || null,
    chats: chats.map(({ id, title, updated_at, agent_name }) => ({ id, title, updated_at, agent: agent_name })),
    ...(await briefOf(userId, key)),
  };
}

// ---------- routes ----------

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const caseFocusRoutes = Router();
caseFocusRoutes.use(needsModule('case_focus'));

// Time on cases: their own only. There is no route that takes another person's id.
caseFocusRoutes.get('/time', wrap(async (req, res) => {
  const to = DAY.test(req.query.to) ? req.query.to : dubaiDate();
  const from = DAY.test(req.query.from) ? req.query.from : lastDays(to, 30)[0];
  res.json({ from, to, cases: await timeByCase(req.user.id, from, to) });
}));

caseFocusRoutes.get('/agent/:agentId/cases', wrap(async (req, res) => {
  res.json(await agentCases(req.user.id, req.params.agentId));
}));

caseFocusRoutes.get('/case/:key', wrap(async (req, res) => {
  const out = await caseHome(req.user.id, req.params.key, String(req.query.number || ''));
  if (!out) return res.status(404).json({ error: 'Not found' });
  res.json(out);
}));

// The case brief (caseBrief.js): always the person's own, by the case's key.
caseFocusRoutes.get('/brief/:key', wrap(async (req, res) => res.json(await briefOf(req.user.id, req.params.key))));
caseFocusRoutes.put('/brief/:key', wrap(async (req, res) => {
  const body = String(req.body?.body || '').trim();
  const number = String(req.body?.number || '').trim();
  if (!number) return res.status(400).json({ error: 'Which case?' });
  if (!caseKey(number) || caseKey(number) !== req.params.key) return res.status(400).json({ error: 'That is not this case' });
  if (!body) {
    await db.prepare('DELETE FROM case_briefs WHERE user_id = ? AND case_key = ?').run(req.user.id, req.params.key);
  } else await saveBrief(req.user.id, req.params.key, number, body);
  res.json(await briefOf(req.user.id, req.params.key));
}));
caseFocusRoutes.post('/brief/:key/suggestions/:id/approve', wrap(async (req, res) => {
  const out = await approve(req.user.id, req.params.key, req.params.id, typeof req.body?.body === 'string' ? req.body.body : undefined);
  if (!out) return res.status(404).json({ error: 'That suggestion is no longer waiting' });
  res.json(out);
}));
caseFocusRoutes.post('/brief/:key/suggestions/:id/dismiss', wrap(async (req, res) => {
  const out = await dismiss(req.user.id, req.params.key, req.params.id);
  if (!out) return res.status(404).json({ error: 'That suggestion is no longer waiting' });
  res.json(out);
}));

caseFocusRoutes.get('/:conversationId/files',wrap(async (req, res) => {
  const out = await caseFiles(req.user.id, req.params.conversationId);
  if (!out) return res.status(404).json({ error: 'Not found' });
  res.json(out);
}));

// The case's legal dates, read from its files and emails (caseDeadlines.js). force: Check again.
const deadlines = (force) => wrap(async (req, res) => {
  const focus = await focusOf(req.user.id, req.params.conversationId);
  if (!focus?.primary) return res.status(404).json({ error: 'Not found' });
  const { files } = await caseFiles(req.user.id, req.params.conversationId);
  res.json(await deadlinesFor(req.user.id, focus.primary, files, { force }));
});
caseFocusRoutes.get('/:conversationId/deadlines', deadlines(false));
caseFocusRoutes.post('/:conversationId/deadlines/scan', deadlines(true));

caseFocusRoutes.get('/:conversationId/time', wrap(async (req, res) => {
  const focus = await focusOf(req.user.id, req.params.conversationId);
  if (!focus?.primary) return res.status(404).json({ error: 'Not found' });
  res.json(await timeOn(req.user.id, focus.primary));
}));

caseFocusRoutes.post('/:conversationId/beat', wrap(async (req, res) => {
  const out = await beat(req.user.id, req.params.conversationId, { start: req.body?.start === true });
  if (!out) return res.status(404).json({ error: 'Not found' });
  res.json(out);
}));

// Read only: there is no route that sets or changes a primary case. Only a chat message does.
caseFocusRoutes.get('/:conversationId', wrap(async (req, res) => {
  const focus = await focusOf(req.user.id, req.params.conversationId);
  if (!focus) return res.status(404).json({ error: 'Not found' });
  res.json(focus);
}));
