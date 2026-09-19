import { db } from './db.js';
import { claude } from './ai.js';
import { pickAgent } from './router.js';
import { extractText, recall, learn } from './knowledge.js';
import { saveUpload, processDocument, isImage, fileName, libraryCatalog } from './files.js';

const MAX_INLINE = 60000; // chars of a document sent in full on the turn it is attached

// Server-side web search, run by Anthropic. Sonnet 5 / Opus 5 take the newer tool version; Haiku 4.5 the basic one.
const webSearch = (model) => ({
  type: model.startsWith('claude-haiku') ? 'web_search_20250305' : 'web_search_20260209',
  name: 'web_search',
  max_uses: 5, // location hint isn't used: the API doesn't accept country AE; the system prompt keeps searches UAE-focused
});

function systemPrompt(user, agent, team, memories, knowledge, library) {
  const others = team.filter((a) => a.id !== agent.id).map((a) => a.name);
  const parts = [
    agent.persona || `You are ${agent.name}, a helpful assistant.`,
    `Your name is ${agent.name}. You are talking with ${user.name}. Current date and time: ${new Date().toString()}. Dates in UAE documents are usually written DD/MM/YYYY.`,
    'You live inside a personal AI app with long-term memory and a knowledge base made from files the user shared. ' +
      'Use them naturally — do not explain these mechanics unless asked. When you use the knowledge base, mention the file name. ' +
      'If the answer is not in the knowledge base or memory, say so instead of guessing. Format replies in Markdown; keep them concise and mobile-friendly.',
    'You can search the web. Before stating any specific UAE legal rule, article, government fee, tax rate or threshold, labour or visa rule, deadline or penalty, verify it with a quick search, even if you think you know it (laws and fees change). Also search for prices, exchange rates and news. ' +
      'Prefer official sources (u.ae, mohre.gov.ae, tax.gov.ae, dubailand.gov.ae, rera and other .gov.ae sites, DIFC/ADGM) and say when the official source differs from what you expected. ' +
      "Don't search for things answered by the user's files, memory, or stable general knowledge.",
  ];
  if (others.length) {
    parts.push(`You are one of several specialist agents on ${user.name}'s team (teammates: ${others.join(', ')}). ` +
      'The app automatically routes each message to the best agent, so earlier assistant turns in this conversation may have been written by a teammate. Continue seamlessly.');
  }
  if (memories.length) parts.push(`<memory>\nThings you remember about the user from earlier conversations:\n${memories.map((m) => `- ${m}`).join('\n')}\n</memory>`);
  if (library.length) parts.push(`<file_library>\nThe user's saved files (newest first). Their content is searchable; relevant excerpts appear in <knowledge>. Files can be opened from the Files screen in the app.\n${library.join('\n')}\n</file_library>`);
  if (knowledge.length) parts.push(`<knowledge>\nExcerpts from the user's files that may be relevant:\n${knowledge.join('\n---\n')}\n</knowledge>`);
  return parts.join('\n\n');
}

async function recentMessages(conversationId) {
  const rows = (await db.prepare(`SELECT m.role, m.content, m.files, m.agent_id, a.name agent_name FROM messages m
    LEFT JOIN agents a ON a.id = m.agent_id WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 20`).all(conversationId)).reverse();
  while (rows[0]?.role === 'assistant') rows.shift(); // must start with a user turn
  return rows;
}

const toClaude = (rows) => rows.map((r) => {
  const names = JSON.parse(r.files).map((f) => f.name);
  return { role: r.role, content: names.length ? `${r.content}\n\n[Attached: ${names.join(', ')}]` : r.content };
});

// Attachments are read in full for this turn, stored in the user's library, and organised in the background
async function readAttachments(user, convId, files, send) {
  const blocks = [];
  const meta = [];
  for (const f of files) {
    const name = fileName(f);
    try {
      if (isImage(f)) {
        const { doc, duplicate } = await saveUpload(user.id, null, f, convId);
        blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mimetype, data: f.buffer.toString('base64') } });
        if (!duplicate) processDocument(doc, f);
        meta.push({ name, kind: 'image', docId: doc.id });
      } else {
        send('status', { label: `Reading ${name}…` });
        const content = await extractText({ ...f, originalname: name }); // read first, so unreadable files are never stored
        if (!content.trim()) throw new Error(`No readable text found in ${name}`);
        const { doc, duplicate } = await saveUpload(user.id, null, f, convId);
        if (!duplicate) processDocument(doc, f, content);
        meta.push({ name, kind: 'doc', docId: doc.id, snippet: content.slice(0, 600) });
        const inline = content.length > MAX_INLINE ? `${content.slice(0, MAX_INLINE)}\n…(truncated — the rest is in your knowledge base)` : content;
        blocks.push({ type: 'text', text: `<file name="${name}">\n${inline}\n</file>` });
      }
    } catch (e) {
      send('notice', { message: e.message });
    }
  }
  return { blocks, meta };
}

export async function chat(req, res) {
  const user = req.user;
  const team = await db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY id').all(user.id);
  if (!team.length) return res.status(400).json({ error: 'Create an agent first' });
  const text = (req.body.text || '').trim();
  const files = req.files || [];
  if (!text && !files.length) return res.status(400).json({ error: 'Empty message' });

  let convId = Number(req.body.conversationId) || null;
  if (convId && !await db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(convId, user.id)) convId = null;
  if (!convId) {
    const title = (text || files[0].originalname).slice(0, 60);
    ({ id: convId } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(user.id, title));
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('meta', { conversationId: convId });

  // 1. Read attachments, then pick the agent (the router sees what the files are about)
  const prior = await recentMessages(convId);
  const currentAgentId = [...prior].reverse().find((m) => m.agent_id)?.agent_id;
  const { blocks, meta } = await readAttachments(user, convId, files, send);
  const savedFiles = meta.map(({ snippet, ...m }) => m);
  if (savedFiles.length) send('files', savedFiles); // lets the app link the just-sent attachments
  send('status', { label: 'Choosing the best agent…' });
  const { agent, why } = await pickAgent({ agents: team, text, attachments: meta, recent: prior, currentAgentId });
  send('agent', { id: agent.id, why });

  // 2. Context: recalled memories + relevant file excerpts
  send('status', { label: `${agent.name} is thinking…` });
  const { memories, knowledge } = await recall(user.id, agent.id, text || meta.map((f) => f.name).join(' '));
  const library = await libraryCatalog(user.id, agent.id); // same every turn, so read it once
  await db.prepare('INSERT INTO messages (conversation_id, role, content, files) VALUES (?, ?, ?, ?)').run(convId, 'user', text, JSON.stringify(savedFiles));

  // 3. Stream the reply (with web search). A long search can pause the turn; resume it a few times.
  let reply = '';
  let finished = false;
  let stream;
  const cited = new Map(); // pages the reply explicitly cites
  const searched = new Map(); // pages returned by searches (fallback: the newer search tool often returns no citations)
  const convo = [...toClaude(prior), { role: 'user', content: [...blocks, { type: 'text', text: text || 'Please review the attached file(s).' }] }];
  const emit = (t) => { reply += t; send('delta', { text: t }); };
  res.on('close', () => { if (!finished) stream?.abort(); });

  try {
    for (let turn = 0; turn < 4; turn++) {
      stream = claude.messages.stream({
        model: agent.model,
        max_tokens: 16000,
        system: systemPrompt(user, agent, team, memories, knowledge, library),
        tools: [webSearch(agent.model)],
        messages: convo,
      });
      let prevType = null;
      stream.on('streamEvent', (ev) => {
        if (ev.type !== 'content_block_start') return;
        // text resuming after a search starts a new paragraph (citations also split text into blocks: leave those joined)
        if (ev.content_block.type === 'text' && prevType && prevType !== 'text' && reply && !reply.endsWith('\n')) emit('\n\n');
        prevType = ev.content_block.type;
      });
      stream.on('text', emit);
      stream.on('contentBlock', (block) => {
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          send('status', { label: `Searching the web: “${String(block.input?.query || '').slice(0, 60)}”` });
        }
        for (const c of block.citations || []) if (c.url && !cited.has(c.url)) cited.set(c.url, { url: c.url, title: c.title });
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) if (r.url && !searched.has(r.url)) searched.set(r.url, { url: r.url, title: r.title });
        }
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal' && !reply) send('error', { message: "I can't help with that request." });
      if (msg.stop_reason !== 'pause_turn') break;
      convo.push({ role: 'assistant', content: msg.content });
    }
  } catch (e) {
    if (!stream?.aborted) {
      console.error('[chat]', e.message);
      send('error', { message: e.status === 401 ? 'Claude API key is invalid' : e.message });
    }
  }
  finished = true;

  let messageId = null;
  const official = (u) => /\.gov\.ae|difc|adgm|u\.ae/i.test(new URL(u.url).hostname) ? 0 : 1;
  const sources = (cited.size ? [...cited.values()] : [...searched.values()].sort((a, b) => official(a) - official(b))).slice(0, 6);
  if (sources.length) send('sources', sources);
  if (reply) {
    ({ id: messageId } = await db.prepare('INSERT INTO messages (conversation_id, agent_id, role, content, sources) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .run(convId, agent.id, 'assistant', reply.trim(), JSON.stringify(sources)));
  }
  await db.prepare('UPDATE conversations SET updated_at = extract(epoch from now()) WHERE id = ?').run(convId);
  if (!res.writableEnded) { send('done', { messageId }); res.end(); }

  // 4. Learn from this turn (background, never blocks the reply)
  if (reply && text) learn(user.id, text, reply).catch((e) => console.error('[learn]', e.message));
}
