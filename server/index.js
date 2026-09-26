import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { ROOT, PORT, MODELS, VOICES, COLORS, AGENT_ICONS, FOLDERS } from './config.js';
import { db } from './db.js';
import { transcribe, ask } from './ai.js';
import { spoken, prepare, cachedPath, claim, streamTo } from './tts.js';
import { authRoutes, requireUser, requireMaster } from './auth.js';
import { agentOut, agentIn, agentLinks } from './agents.js';
import { chatAgents, canUseAgent, isMaster } from './access.js';
import { chat } from './chat.js';
import { addMemory } from './knowledge.js';
import { saveUpload, saveNote, processDocument, deleteDocument, inlineType, docxPreview, setShared, setSharedMany, pickCompany, userCompanies, expiringDocuments } from './files.js';
import { outlookRoutes, outlookCallback } from './outlook.js';
import { imapRoutes } from './imap.js';
import { adminRoutes, accessOfMe } from './admin.js';
import { emailRoutes } from './emailRoutes.js';
import { startOutbox } from './outbox.js';
import { importRoutes, startImportQueue } from './imports.js';
import { messengerRoutes } from './messenger.js';
import { todoRoutes } from './todos.js';
import { routineRoutes } from './routines.js';
import { pushRoutes } from './push.js';
import { startReminders } from './reminders.js';
import { saifsysRoutes } from './saifsys.js';
import { meetingRoutes, startMeetings } from './meetings.js';
import { errorRoutes, recordError } from './errors.js';

const app = express();
app.set('trust proxy', 1); // correct req.ip / req.secure behind a hosting proxy
export const MAX_UPLOAD_MB = 25;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10 } });
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/outlook', outlookCallback); // Microsoft sign-in returns here; checked by its one-time state
app.use('/api/errors', errorRoutes); // browsers report crashes here, signed in or not
app.use('/api', requireUser); // everything below needs a signed-in user
app.use('/api/outlook', outlookRoutes);
app.use('/api/imap', imapRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/messenger', messengerRoutes); // people-to-people chat, separate from the AI chats
app.use('/api/todos', todoRoutes);
app.use('/api/routines', routineRoutes); // things that come back, kept apart from the one-off todos
app.use('/api/push', pushRoutes); // the phone buzzing while the app is shut
app.use('/api/saifsys', saifsysRoutes); // live reads from the property system
app.use('/api/meetings', meetingRoutes); // recorded meetings: who said what, and a summary
app.use('/api/admin', adminRoutes); // master-only oversight; guarded inside the router

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const own = (table, id, userId) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(Number(id), userId);
const notFound = (res) => res.status(404).json({ error: 'Not found' });
const ilike = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

app.get('/api/config', (req, res) => res.json({ models: MODELS, voices: VOICES, folders: FOLDERS, voice: !!process.env.OPENAI_API_KEY }));

// ---------- agents ----------
app.get('/api/agents', wrap(async (req, res) => {
  res.json((await chatAgents(req.user)).map((a) => agentOut(a, req.user)));
}));
// ✨ turn a name + one line into a full agent (persona, icon, colour, quick prompts)
app.post('/api/agents/draft', requireMaster, wrap(async (req, res) => {
  const name = String(req.body.name || '').slice(0, 60);
  const idea = String(req.body.persona || '').slice(0, 2000);
  if (!name && !idea) return res.status(400).json({ error: 'Type a name or what the agent should do first' });
  const out = await ask(`Agent name: ${name || '(suggest one)'}\nWhat it should do: ${idea || '(infer from the name)'}`, {
    maxTokens: 900,
    system: `You design AI agents for a UAE-based user. Reply with ONLY JSON:
{"name": "<short name, max 3 words>", "icon": "<one of: ${AGENT_ICONS.join(', ')}>", "color": "<one of: ${COLORS.join(', ')}>",
 "persona": "<second-person system prompt, 60-120 words: who the agent is, its specific areas of expertise (listed explicitly, since a router uses them to pick this agent), UAE context where relevant, and its tone>",
 "starters": ["<3 short example questions a user might ask it>"]}
Keep the user's own wording and intent; expand it, do not change it.`,
  });
  const d = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
  res.json({
    name: String(d.name || name).slice(0, 60),
    icon: AGENT_ICONS.includes(d.icon) ? d.icon : 'sparkles',
    color: COLORS.includes(d.color) ? d.color : 'violet',
    persona: String(d.persona || idea),
    starters: (Array.isArray(d.starters) ? d.starters : []).map(String).slice(0, 4),
  });
}));

app.post('/api/agents', requireMaster, wrap(async (req, res) => {
  const a = agentIn(req.body);
  const { id } = await db.prepare('INSERT INTO agents (user_id, name, icon, color, persona, model, voice, starters) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .run(req.user.id, a.name, a.icon, a.color, a.persona, a.model, a.voice, a.starters);
  res.json(agentOut(await own('agents', id, req.user.id), req.user));
}));
app.put('/api/agents/:id', requireMaster, wrap(async (req, res) => {
  if (!await own('agents', req.params.id, req.user.id)) return notFound(res);
  const a = agentIn(req.body);
  await db.prepare('UPDATE agents SET name = ?, icon = ?, color = ?, persona = ?, model = ?, voice = ?, starters = ? WHERE id = ?')
    .run(a.name, a.icon, a.color, a.persona, a.model, a.voice, a.starters, Number(req.params.id));
  res.json(agentOut(await own('agents', req.params.id, req.user.id), req.user));
}));
app.delete('/api/agents/:id', requireMaster, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!await own('agents', id, req.user.id)) return notFound(res);

  // Agents are shared by reference, so other people's work is filed against this one.
  // Unassigning is reversible and this is not, so it goes first — and their files are
  // not the owner's to delete.
  const links = await agentLinks(req.user.id, id);
  if (links.users || links.documents) {
    const parts = [links.users && `${links.users} user(s) assigned`, links.documents && `${links.documents} file(s) filed by others`];
    return res.status(409).json({
      error: `This agent is still in use — ${parts.filter(Boolean).join(' and ')}. Unassign it first.`,
      ...links,
    });
  }

  for (const d of await db.prepare('SELECT id FROM documents WHERE agent_id = ? AND user_id = ?').all(id, req.user.id)) {
    await deleteDocument(req.user.id, d.id);
  }
  await db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(id, req.user.id);
  res.json({ ok: true });
}));

// ---------- conversations ----------
app.get('/api/conversations', wrap(async (req, res) => {
  res.json(await db.prepare(`SELECT c.id, c.title, c.updated_at,
      (SELECT agent_id FROM messages m WHERE m.conversation_id = c.id AND agent_id IS NOT NULL ORDER BY m.id DESC LIMIT 1) agent_id
    FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC LIMIT 200`).all(req.user.id));
}));
// search chat titles and message text; returns a short snippet around the match
app.get('/api/conversations/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json([]);
  const like = ilike(q); // ILIKE: SQLite's LIKE ignored case, Postgres' does not
  const rows = await db.prepare(`SELECT c.id, c.title, c.updated_at,
      (SELECT agent_id FROM messages m WHERE m.conversation_id = c.id AND agent_id IS NOT NULL ORDER BY m.id DESC LIMIT 1) agent_id,
      (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.content ILIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT 1) hit
    FROM conversations c
    WHERE c.user_id = ? AND (c.title ILIKE ? ESCAPE '\\' OR EXISTS
      (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content ILIKE ? ESCAPE '\\'))
    ORDER BY c.updated_at DESC LIMIT 50`).all(like, req.user.id, like, like);
  res.json(rows.map(({ hit, ...c }) => {
    if (!hit) return c;
    const flat = hit.replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ');
    const i = flat.toLowerCase().indexOf(q.toLowerCase());
    const start = Math.max(0, i - 50);
    return { ...c, snippet: `${start ? '…' : ''}${flat.slice(start, i + q.length + 70)}${i + q.length + 70 < flat.length ? '…' : ''}` };
  }));
}));
app.get('/api/conversations/:id/messages', wrap(async (req, res) => {
  if (!await own('conversations', req.params.id, req.user.id)) return notFound(res);
  // carried: earlier chats this message brought in, titled as they were at the time
  const rows = await db.prepare(`SELECT m.id, m.agent_id, m.role, m.content, m.files, m.sources,
      (SELECT json_agg(cc.title ORDER BY cc.id) FROM carried_chats cc WHERE cc.message_id = m.id) carried
    FROM messages m WHERE m.conversation_id = ? ORDER BY m.id`).all(Number(req.params.id));
  res.json(rows.map((m) => ({ ...m, files: JSON.parse(m.files), sources: JSON.parse(m.sources || '[]'), carried: m.carried || [] })));
}));
app.delete('/api/conversations/:id', wrap(async (req, res) => {
  await db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
}));

app.post('/api/chat', upload.array('files', 10), wrap(chat));

// ---------- files: ?agent=<id> for one agent's shelf, otherwise everything this user owns ----------
const docOut = ({ path, hash, user_id, ...d }) => ({ ...d, tags: JSON.parse(d.tags || '[]') });

const DOC_SELECT = `SELECT d.*, c.title conversation_title, a.name shelf_name FROM documents d
  LEFT JOIN conversations c ON c.id = d.conversation_id AND c.user_id = d.user_id
  LEFT JOIN agents a ON a.id = d.agent_id`;

// ?ids=1,2,3 for specific files (e.g. a chat's attachments), ?agent=<id> for one agent's shelf,
// otherwise all of this user's files. The Shelf screen lists the lot: the classifier files
// most uploads onto an agent, and listing only the unfiled ones made them vanish on arrival.
app.get('/api/documents', wrap(async (req, res) => {
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map(Number).filter(Boolean).slice(0, 200);
    if (!ids.length) return res.json([]);
    const rows = await db.prepare(`${DOC_SELECT} WHERE d.user_id = ? AND d.id IN (${ids.map(() => '?').join(',')}) ORDER BY d.id DESC`)
      .all(req.user.id, ...ids);
    return res.json(rows.map(docOut));
  }
  const agentId = Number(req.query.agent) || null;
  const rows = await db.prepare(`${DOC_SELECT} WHERE d.user_id = ? AND (?::int IS NULL OR d.agent_id = ?)
    ORDER BY COALESCE(d.doc_date, to_char(to_timestamp(d.created_at), 'YYYY-MM-DD')) DESC, d.id DESC`).all(req.user.id, agentId, agentId);
  res.json(rows.map(docOut));
}));
// Above /api/documents/:id, which would otherwise read "expiring" as an id.
// ?days=30 for the badge on the menu, the default 90 for the Shelf's own list.
app.get('/api/documents/expiring', wrap(async (req, res) => {
  const rows = await expiringDocuments(req.user.id, req.query.days);
  res.json(rows.map(docOut));
}));
app.get('/api/documents/:id', wrap(async (req, res) => {
  const doc = await db.prepare(`${DOC_SELECT} WHERE d.id = ? AND d.user_id = ?`).get(Number(req.params.id), req.user.id);
  doc ? res.json(docOut(doc)) : notFound(res);
}));
app.post('/api/documents', upload.array('files', 10), wrap(async (req, res) => {
  const agentId = Number(req.body.agent) || null;
  if (agentId && !await canUseAgent(req.user, agentId)) return notFound(res);
  // Only needed when no shelf was chosen, but reading it once beats once per file.
  const team = agentId ? [] : await chatAgents(req.user);
  const results = await Promise.all((req.files || []).map(async (f) => {
    const { doc, duplicate } = await saveUpload(req.user.id, agentId, f);
    if (!duplicate) await processDocument(doc, f, undefined, team);
    // Files dedup on their bytes alone, so the copy already held may be filed somewhere
    // other than where this one was headed. Naming the shelf turns "already in your
    // files" from an apparent no-op into an explanation.
    const shelf = duplicate && doc.agent_id
      ? (await db.prepare('SELECT name FROM agents WHERE id = ?').get(doc.agent_id))?.name ?? null
      : null;
    return { id: doc.id, name: doc.name, duplicate, shelf };
  }));
  res.json(results);
}));
// A typed note. Runs the identical path as an upload - classify, file to a shelf,
// index - so it is searchable and openable like any other file. Users get these too:
// their notes are their own, and like their uploads can never be shared.
app.post('/api/documents/note', wrap(async (req, res) => {
  const agentId = Number(req.body.agent) || null;
  if (agentId && !await canUseAgent(req.user, agentId)) return notFound(res);
  const { doc, duplicate } = await saveNote(req.user.id, agentId, req.body.text);
  if (!duplicate) await processDocument(doc, null, String(req.body.text).trim(), agentId ? [] : await chatAgents(req.user));
  const shelf = duplicate && doc.agent_id
    ? (await db.prepare('SELECT name FROM agents WHERE id = ?').get(doc.agent_id))?.name ?? null
    : null;
  res.json({ id: doc.id, name: doc.name, duplicate, shelf });
}));

// view (safe types only) or download the original file
app.get('/api/documents/:id/file', wrap(async (req, res) => {
  const doc = await own('documents', req.params.id, req.user.id);
  if (!doc?.path) return notFound(res);
  const inline = !req.query.download && inlineType(doc);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
  res.type(inline || 'application/octet-stream').sendFile(doc.path);
}));
// Word documents rendered as HTML for the in-app viewer
app.get('/api/documents/:id/preview', wrap(async (req, res) => {
  const doc = await own('documents', req.params.id, req.user.id);
  if (!doc?.path || !/\.docx$/i.test(doc.name)) return notFound(res);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(await docxPreview(doc));
}));
// master only: share or unshare a whole company or folder in one go
app.post('/api/documents/share', wrap(async (req, res) => {
  res.json({ changed: await setSharedMany(req.user, req.body.ids, req.body.shared) });
}));
// move to another folder or company, rename, or (master only) publish to the shelf
app.patch('/api/documents/:id', wrap(async (req, res) => {
  const doc = await own('documents', req.params.id, req.user.id);
  if (!doc) return notFound(res);
  const folder = FOLDERS.includes(req.body.folder) ? req.body.folder : doc.folder;
  const title = String(req.body.title || doc.title).slice(0, 120);
  // An empty company means "Other"; a typed one is matched to an existing spelling.
  const company = 'company' in req.body ? pickCompany(req.body.company, await userCompanies(req.user.id)) : doc.company;
  // A read expiry is a guess, and one nobody can correct is worse than none at all.
  // Anything that is not a date clears it, which is how the field is emptied.
  const expires = 'expires_on' in req.body
    ? (/^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_on) ? req.body.expires_on : null)
    : doc.expires_on;
  await db.prepare('UPDATE documents SET folder = ?, title = ?, company = ?, expires_on = ? WHERE id = ?').run(folder, title, company, expires, doc.id);
  // A field-level permission, not a route-level one: everyone renames and refiles here,
  // but only the master may publish. A user sending `shared` simply does not get it.
  if ('shared' in req.body && isMaster(req.user)) await setShared(req.user, doc.id, req.body.shared);
  res.json(docOut(await db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(doc.id)));
}));
app.delete('/api/documents/:id', wrap(async (req, res) => {
  await deleteDocument(req.user.id, Number(req.params.id));
  res.json({ ok: true });
}));

// Who has looked at this account. Anyone can read their own; it is the whole point of
// recording it that the person being looked at can see it, not only the one looking.
app.get('/api/access', wrap(async (req, res) => {
  res.json(await accessOfMe(req.user.id));
}));

// ---------- memory (shared by all of the user's agents) ----------
app.get('/api/memories', wrap(async (req, res) => {
  res.json(await db.prepare('SELECT id, text, created_at FROM memories WHERE user_id = ? ORDER BY id DESC').all(req.user.id));
}));
app.post('/api/memories', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Empty memory' });
  res.json({ id: await addMemory(req.user.id, text) });
}));
app.delete('/api/memories/:id', wrap(async (req, res) => {
  await db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
}));

// ---------- voice (OpenAI) ----------
app.post('/api/voice/transcribe', upload.single('audio'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio' });
  res.json({ text: await transcribe(req.file.buffer, req.file.mimetype) });
}));
// Reading a reply aloud is two calls: register the text, then stream the audio.
app.post('/api/voice/speak', wrap(async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'Voice is not configured (OPENAI_API_KEY missing)' });
  const agent = (await canUseAgent(req.user, req.body.agentId))
    ? await db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(req.body.agentId))
    : null;
  const text = spoken(req.body.text);
  if (!text) return res.status(400).json({ error: 'There is nothing to read out' });
  res.json(prepare({ userId: req.user.id, text, voice: agent?.voice || 'alloy', tone: agent?.persona }));
}));
app.get('/api/voice/speak/:key', wrap(async (req, res) => {
  const hit = cachedPath(req.params.key);
  if (hit) return res.sendFile(hit); // instant replay, and seekable
  const job = claim(req.params.key, req.user.id);
  if (!job) return notFound(res);
  await streamTo(req.params.key, job, res);
}));

app.use('/api', (req, res) => notFound(res));
app.use((err, req, res, next) => {
  // Multer says "File too large" and nothing else - not the limit, not which file. Videos
  // are the ones that reach it, so the message has to be one somebody can act on.
  if (err.code === 'LIMIT_FILE_SIZE') {
    err = Object.assign(new Error(`That file is too big — the limit is ${MAX_UPLOAD_MB} MB. A shorter clip, or send it another way.`), { status: 413 });
  }
  console.error('[error]', err.message);
  // Written down as well as printed: the console scrolls away and nobody reads it, which
  // is how a fault that hits one person every day stays invisible for weeks. Only faults,
  // though — a 4xx is the app telling someone "no" on purpose, and logging those as crashes
  // buries the real ones under typed-in dates and empty forms.
  if (!err.status || err.status >= 500) recordError({ userId: req.user?.id ?? null, source: 'server', message: err.message, stack: err.stack, url: req.originalUrl });
  if (res.headersSent) {
    // A chat stream is already open: say what went wrong rather than just
    // cutting the connection, which leaves the app waiting on a dead reply.
    if (!res.writableEnded && String(res.get('Content-Type')).includes('text/event-stream')) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    }
    return res.end();
  }
  res.status(err.status || 500).json({ error: err.message });
});

// ---------- production: serve the built PWA ----------
const dist = `${ROOT}client/dist`;
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, setHeaders: (res, p) => p.endsWith('sw.js') && res.setHeader('Cache-Control', 'no-cache') }));
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(`${dist}/index.html`) : next()));
}

app.listen(PORT, '0.0.0.0', () => {
  // drafts approved while the rate limit was full go out when it clears
  startOutbox().catch((e) => console.error('[outbox]', e.message));
  // files from a folder or ZIP import that were still waiting when the server stopped
  startImportQueue().catch((e) => console.error('[imports]', e.message));
  // The buzz when a to-do or a routine falls due. The badge and the first screen are
  // unchanged and keep working on their own if this timer ever stops.
  startReminders();
  // meeting recordings that were still waiting to be transcribed when the server stopped
  startMeetings().catch((e) => console.error('[meetings]', e.message));
  // The saifsys morning checkout reminder (startSaifsys in server/saifsys.js) is on hold
  // by the user's choice, 2026-09-25: they ask Jarvis instead. The tool still works.
  console.log(`Jarvis server → http://localhost:${PORT}`);
});
