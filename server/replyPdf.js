// A message's PDF - a reply, or text the person typed themselves: download it, or keep it
// on the Shelf. What goes in and how it is laid out is replyDoc.js; this is who may have
// it and where it goes.
import { Router } from 'express';
import { db } from './db.js';
import { canUseAgent, chatAgents } from './access.js';
import { saveUpload, processDocument } from './files.js';
import { documentPart, renderPdf, unsupportedScript, pdfName } from './replyDoc.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Message `messageId` - a reply, or the person's own text - with its PDF. For the owner only. */
async function build(userId, messageId) {
  const m = await db.prepare(`SELECT m.id, m.role, m.content, m.agent_id, m.conversation_id, m.created_at FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND c.user_id = ?`).get(Number(messageId) || 0, userId);
  if (!m) throw bad('That message was not found', 404);
  const part = documentPart(m.content, { own: m.role === 'user' });
  if (!part) throw bad('There is nothing in that message to put in a PDF');
  if (unsupportedScript(part.markdown)) throw bad('PDFs can only be made from English text for now');
  const bytes = await renderPdf({ ...part, date: new Date(Number(m.created_at) * 1000) });
  return { m, part, bytes: Buffer.from(bytes) };
}

export const replyPdfRoutes = Router();

// Download: the PDF itself, stored nowhere.
replyPdfRoutes.get('/:id/pdf', wrap(async (req, res) => {
  const { part, bytes } = await build(req.user.id, req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(pdfName(part.title))}`);
  res.type('application/pdf').send(bytes);
}));

// Keep it: saved to the Shelf and filed like any upload, on the shelf of the agent who
// wrote it when this person still has that agent. The same reply makes the same bytes,
// so a second tap finds the first copy instead of adding another.
replyPdfRoutes.post('/:id/pdf/shelf', wrap(async (req, res) => {
  const { m, part, bytes } = await build(req.user.id, req.params.id);
  const agentId = m.agent_id && await canUseAgent(req.user, m.agent_id) ? m.agent_id : null;
  const name = pdfName(part.title);
  // saveUpload reads names the way multer hands them over: as latin1.
  const f = { buffer: bytes, originalname: Buffer.from(name, 'utf8').toString('latin1'), mimetype: 'application/pdf', size: bytes.length };
  const { doc, duplicate } = await saveUpload(req.user.id, agentId, f, m.conversation_id);
  if (!duplicate) await processDocument(doc, f, part.markdown, agentId ? [] : await chatAgents(req.user));
  res.json({ id: doc.id, name: doc.name, duplicate });
}));
