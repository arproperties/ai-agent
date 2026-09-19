import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { ROOT, PORT, MODELS, VOICES, COLORS, AGENT_ICONS, FOLDERS } from './config.js';
import { db } from './db.js';
import { transcribe, ask } from './ai.js';
import { spoken, prepare, cachedPath, claim, streamTo } from './tts.js';
import { authRoutes, requireUser } from './auth.js';
import { chat } from './chat.js';
import { addMemory } from './knowledge.js';
import { saveUpload, processDocument, deleteDocument, inlineType, docxPreview } from './files.js';
import { outlookRoutes, outlookCallback } from './outlook.js';
import { imapRoutes } from './imap.js';

const app = express();
app.set('trust proxy', 1); // correct req.ip / req.secure behind a hosting proxy
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/outlook', outlookCallback); // Microsoft sign-in returns here; checked by its one-time state
app.use('/api', requireUser); // everything below needs a signed-in user
app.use('/api/outlook', outlookRoutes);
app.use('/api/imap', imapRoutes);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const own = (table, id, userId) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(Number(id), userId);
const notFound = (res) => res.status(404).json({ error: 'Not found' });
const ilike = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

app.get('/api/config', (req, res) => res.json({ models: MODELS, voices: VOICES, folders: FOLDERS, voice: !!process.env.OPENAI_API_KEY }));

// ---------- agents ----------
const agentOut = (a) => a && { ...a, starters: JSON.parse(a.starters || '[]') };
const agentIn = (b) => ({
  name: String(b.name || 'New agent').slice(0, 60),
  icon: /^[a-z-]{1,30}$/.test(b.icon) ? b.icon : 'bot',
  color: COLORS.includes(b.color) ? b.color : 'violet',
  persona: String(b.persona || '').slice(0, 8000),
  model: MODELS.some((m) => m.id === b.model) ? b.model : MODELS[0].id,
  voice: VOICES.includes(b.voice) ? b.voice : 'alloy',
  starters: JSON.stringify((Array.isArray(b.starters) ? b.starters : []).map(String).filter(Boolean).slice(0, 8)),
});

app.get('/api/agents', wrap(async (req, res) => {
  res.json((await db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY id').all(req.user.id)).map(agentOut));
}));
// ✨ turn a name + one line into a full agent (persona, icon, colour, quick prompts)
app.post('/api/agents/draft', wrap(async (req, res) => {
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

app.post('/api/agents', wrap(async (req, res) => {
  const a = agentIn(req.body);
  const { id } = await db.prepare('INSERT INTO agents (user_id, name, icon, color, persona, model, voice, starters) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .run(req.user.id, a.name, a.icon, a.color, a.persona, a.model, a.voice, a.starters);
  res.json(agentOut(await own('agents', id, req.user.id)));
}));
app.put('/api/agents/:id', wrap(async (req, res) => {
  if (!await own('agents', req.params.id, req.user.id)) return notFound(res);
  const a = agentIn(req.body);
  await db.prepare('UPDATE agents SET name = ?, icon = ?, color = ?, persona = ?, model = ?, voice = ?, starters = ? WHERE id = ?')
    .run(a.name, a.icon, a.color, a.persona, a.model, a.voice, a.starters, Number(req.params.id));
  res.json(agentOut(await own('agents', req.params.id, req.user.id)));
}));
app.delete('/api/agents/:id', wrap(async (req, res) => {
  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM agents WHERE user_id = ?').get(req.user.id);
  if (n <= 1) return res.status(400).json({ error: 'You need at least one agent' });
  for (const d of await db.prepare('SELECT id FROM documents WHERE agent_id = ? AND user_id = ?').all(Number(req.params.id), req.user.id)) {
    await deleteDocument(req.user.id, d.id);
  }
  await db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
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
  const rows = await db.prepare('SELECT id, agent_id, role, content, files, sources FROM messages WHERE conversation_id = ? ORDER BY id').all(Number(req.params.id));
  res.json(rows.map((m) => ({ ...m, files: JSON.parse(m.files), sources: JSON.parse(m.sources || '[]') })));
}));
app.delete('/api/conversations/:id', wrap(async (req, res) => {
  await db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
}));

app.post('/api/chat', upload.array('files', 10), wrap(chat));

// ---------- files: ?agent=<id> for one agent's files, otherwise the shared library ----------
const docOut = ({ path, hash, user_id, ...d }) => ({ ...d, tags: JSON.parse(d.tags || '[]') });

const DOC_SELECT = `SELECT d.*, c.title conversation_title FROM documents d
  LEFT JOIN conversations c ON c.id = d.conversation_id AND c.user_id = d.user_id`;

// ?ids=1,2,3 for specific files (e.g. a chat's attachments), ?agent=<id> for an agent's files, otherwise the shared library
app.get('/api/documents', wrap(async (req, res) => {
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map(Number).filter(Boolean).slice(0, 200);
    if (!ids.length) return res.json([]);
    const rows = await db.prepare(`${DOC_SELECT} WHERE d.user_id = ? AND d.id IN (${ids.map(() => '?').join(',')}) ORDER BY d.id DESC`)
      .all(req.user.id, ...ids);
    return res.json(rows.map(docOut));
  }
  const agentId = Number(req.query.agent) || null;
  const rows = await db.prepare(`${DOC_SELECT} WHERE d.user_id = ? AND d.agent_id IS NOT DISTINCT FROM ?
    ORDER BY COALESCE(d.doc_date, to_char(to_timestamp(d.created_at), 'YYYY-MM-DD')) DESC, d.id DESC`).all(req.user.id, agentId);
  res.json(rows.map(docOut));
}));
app.get('/api/documents/:id', wrap(async (req, res) => {
  const doc = await db.prepare(`${DOC_SELECT} WHERE d.id = ? AND d.user_id = ?`).get(Number(req.params.id), req.user.id);
  doc ? res.json(docOut(doc)) : notFound(res);
}));
app.post('/api/documents', upload.array('files', 10), wrap(async (req, res) => {
  const agentId = Number(req.body.agent) || null;
  if (agentId && !await own('agents', agentId, req.user.id)) return notFound(res);
  const results = await Promise.all((req.files || []).map(async (f) => {
    const { doc, duplicate } = await saveUpload(req.user.id, agentId, f);
    if (!duplicate) await processDocument(doc, f);
    return { id: doc.id, name: doc.name, duplicate };
  }));
  res.json(results);
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
// move to another folder or rename
app.patch('/api/documents/:id', wrap(async (req, res) => {
  const doc = await own('documents', req.params.id, req.user.id);
  if (!doc) return notFound(res);
  const folder = FOLDERS.includes(req.body.folder) ? req.body.folder : doc.folder;
  const title = String(req.body.title || doc.title).slice(0, 120);
  await db.prepare('UPDATE documents SET folder = ?, title = ? WHERE id = ?').run(folder, title, doc.id);
  res.json(docOut(await db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(doc.id)));
}));
app.delete('/api/documents/:id', wrap(async (req, res) => {
  await deleteDocument(req.user.id, Number(req.params.id));
  res.json({ ok: true });
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
  const agent = await own('agents', req.body.agentId, req.user.id);
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
  console.error('[error]', err.message);
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

app.listen(PORT, '0.0.0.0', () => console.log(`Jarvis server → http://localhost:${PORT}`));
