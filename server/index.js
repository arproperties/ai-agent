import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { ROOT, PORT, MODELS, VOICES, COLORS, AGENT_ICONS, FOLDERS } from './config.js';
import { db } from './db.js';
import { transcribe, speak, ask } from './ai.js';
import { authRoutes, requireUser } from './auth.js';
import { chat } from './chat.js';
import { addMemory } from './knowledge.js';
import { saveUpload, processDocument, deleteDocument, inlineType, docxPreview } from './files.js';
import { outlookRoutes, outlookCallback } from './outlook.js';

const app = express();
app.set('trust proxy', 1); // correct req.ip / req.secure behind a hosting proxy
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/outlook', outlookCallback); // Microsoft sign-in returns here; checked by its one-time state
app.use('/api', requireUser); // everything below needs a signed-in user
app.use('/api/outlook', outlookRoutes);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const own = (table, id, userId) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(Number(id), userId);
const notFound = (res) => res.status(404).json({ error: 'Not found' });

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

app.get('/api/agents', (req, res) => {
  res.json(db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY id').all(req.user.id).map(agentOut));
});
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

app.post('/api/agents', (req, res) => {
  const a = agentIn(req.body);
  const { lastInsertRowid } = db.prepare('INSERT INTO agents (user_id, name, icon, color, persona, model, voice, starters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, a.name, a.icon, a.color, a.persona, a.model, a.voice, a.starters);
  res.json(agentOut(own('agents', lastInsertRowid, req.user.id)));
});
app.put('/api/agents/:id', (req, res) => {
  if (!own('agents', req.params.id, req.user.id)) return notFound(res);
  const a = agentIn(req.body);
  db.prepare('UPDATE agents SET name = ?, icon = ?, color = ?, persona = ?, model = ?, voice = ?, starters = ? WHERE id = ?')
    .run(a.name, a.icon, a.color, a.persona, a.model, a.voice, a.starters, req.params.id);
  res.json(agentOut(own('agents', req.params.id, req.user.id)));
});
app.delete('/api/agents/:id', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) n FROM agents WHERE user_id = ?').get(req.user.id).n;
  if (count <= 1) return res.status(400).json({ error: 'You need at least one agent' });
  for (const d of db.prepare('SELECT id FROM documents WHERE agent_id = ? AND user_id = ?').all(req.params.id, req.user.id)) deleteDocument(req.user.id, d.id);
  db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- conversations ----------
app.get('/api/conversations', (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.title, c.updated_at,
      (SELECT agent_id FROM messages m WHERE m.conversation_id = c.id AND agent_id IS NOT NULL ORDER BY m.id DESC LIMIT 1) agent_id
    FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC LIMIT 200`).all(req.user.id));
});
// search chat titles and message text; returns a short snippet around the match
app.get('/api/conversations/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json([]);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db.prepare(`SELECT c.id, c.title, c.updated_at,
      (SELECT agent_id FROM messages m WHERE m.conversation_id = c.id AND agent_id IS NOT NULL ORDER BY m.id DESC LIMIT 1) agent_id,
      (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT 1) hit
    FROM conversations c
    WHERE c.user_id = ? AND (c.title LIKE ? ESCAPE '\\' OR EXISTS
      (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'))
    ORDER BY c.updated_at DESC LIMIT 50`).all(like, req.user.id, like, like);
  res.json(rows.map(({ hit, ...c }) => {
    if (!hit) return c;
    const flat = hit.replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ');
    const i = flat.toLowerCase().indexOf(q.toLowerCase());
    const start = Math.max(0, i - 50);
    return { ...c, snippet: `${start ? '…' : ''}${flat.slice(start, i + q.length + 70)}${i + q.length + 70 < flat.length ? '…' : ''}` };
  }));
});
app.get('/api/conversations/:id/messages', (req, res) => {
  if (!own('conversations', req.params.id, req.user.id)) return notFound(res);
  res.json(db.prepare('SELECT id, agent_id, role, content, files, sources FROM messages WHERE conversation_id = ? ORDER BY id').all(req.params.id)
    .map((m) => ({ ...m, files: JSON.parse(m.files), sources: JSON.parse(m.sources || '[]') })));
});
app.delete('/api/conversations/:id', (req, res) => {
  db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/chat', upload.array('files', 10), wrap(chat));

// ---------- files: ?agent=<id> for one agent's files, otherwise the shared library ----------
const docOut = ({ path, hash, user_id, ...d }) => ({ ...d, tags: JSON.parse(d.tags || '[]') });

const DOC_SELECT = `SELECT d.*, c.title conversation_title FROM documents d
  LEFT JOIN conversations c ON c.id = d.conversation_id AND c.user_id = d.user_id`;

// ?ids=1,2,3 for specific files (e.g. a chat's attachments), ?agent=<id> for an agent's files, otherwise the shared library
app.get('/api/documents', (req, res) => {
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map(Number).filter(Boolean).slice(0, 200);
    if (!ids.length) return res.json([]);
    return res.json(db.prepare(`${DOC_SELECT} WHERE d.user_id = ? AND d.id IN (${ids.map(() => '?').join(',')}) ORDER BY d.id DESC`)
      .all(req.user.id, ...ids).map(docOut));
  }
  const agentId = Number(req.query.agent) || null;
  res.json(db.prepare(`${DOC_SELECT} WHERE d.user_id = ? AND d.agent_id IS ? ORDER BY COALESCE(d.doc_date, date(d.created_at, 'unixepoch')) DESC, d.id DESC`)
    .all(req.user.id, agentId).map(docOut));
});
app.get('/api/documents/:id', (req, res) => {
  const doc = db.prepare(`${DOC_SELECT} WHERE d.id = ? AND d.user_id = ?`).get(Number(req.params.id), req.user.id);
  doc ? res.json(docOut(doc)) : notFound(res);
});
app.post('/api/documents', upload.array('files', 10), wrap(async (req, res) => {
  const agentId = Number(req.body.agent) || null;
  if (agentId && !own('agents', agentId, req.user.id)) return notFound(res);
  const results = await Promise.all((req.files || []).map(async (f) => {
    const { doc, duplicate } = saveUpload(req.user.id, agentId, f);
    if (!duplicate) await processDocument(doc, f);
    return { id: doc.id, name: doc.name, duplicate };
  }));
  res.json(results);
}));
// view (safe types only) or download the original file
app.get('/api/documents/:id/file', (req, res) => {
  const doc = own('documents', req.params.id, req.user.id);
  if (!doc?.path) return notFound(res);
  const inline = !req.query.download && inlineType(doc);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
  res.type(inline || 'application/octet-stream').sendFile(doc.path);
});
// Word documents rendered as HTML for the in-app viewer
app.get('/api/documents/:id/preview', wrap(async (req, res) => {
  const doc = own('documents', req.params.id, req.user.id);
  if (!doc?.path || !/\.docx$/i.test(doc.name)) return notFound(res);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(await docxPreview(doc));
}));
// move to another folder or rename
app.patch('/api/documents/:id', (req, res) => {
  const doc = own('documents', req.params.id, req.user.id);
  if (!doc) return notFound(res);
  const folder = FOLDERS.includes(req.body.folder) ? req.body.folder : doc.folder;
  const title = String(req.body.title || doc.title).slice(0, 120);
  db.prepare('UPDATE documents SET folder = ?, title = ? WHERE id = ?').run(folder, title, doc.id);
  res.json(docOut(db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(doc.id)));
});
app.delete('/api/documents/:id', (req, res) => {
  deleteDocument(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

// ---------- memory (shared by all of the user's agents) ----------
app.get('/api/memories', (req, res) => {
  res.json(db.prepare('SELECT id, text, created_at FROM memories WHERE user_id = ? ORDER BY id DESC').all(req.user.id));
});
app.post('/api/memories', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Empty memory' });
  res.json({ id: await addMemory(req.user.id, text) });
}));
app.delete('/api/memories/:id', (req, res) => {
  db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- voice (OpenAI) ----------
app.post('/api/voice/transcribe', upload.single('audio'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio' });
  res.json({ text: await transcribe(req.file.buffer, req.file.mimetype) });
}));
app.post('/api/voice/speak', wrap(async (req, res) => {
  const agent = own('agents', req.body.agentId, req.user.id);
  const text = String(req.body.text || '')
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/[*_#>`|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const audio = await speak(text, agent?.voice || 'alloy', agent?.persona);
  res.type('audio/mpeg').send(audio);
}));

app.use('/api', (req, res) => notFound(res));
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: err.message });
});

// ---------- production: serve the built PWA ----------
const dist = `${ROOT}client/dist`;
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, setHeaders: (res, p) => p.endsWith('sw.js') && res.setHeader('Cache-Control', 'no-cache') }));
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(`${dist}/index.html`) : next()));
}

app.listen(PORT, '0.0.0.0', () => console.log(`Jarvis server → http://localhost:${PORT}`));
