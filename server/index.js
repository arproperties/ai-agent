import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { ROOT, PORT, MODELS, VOICES, COLORS, AGENT_ICONS, FOLDERS } from './config.js';
import { db, tx } from './db.js';
import { transcribe, ask } from './ai.js';
import { spoken, prepare, cachedPath, claim, streamTo, timingsFor } from './tts.js';
import { authRoutes, requireUser, requireMaster } from './auth.js';
import { agentOut, agentIn, agentLinks, setAgentCase } from './agents.js';
import { chatAgents, listedAgents, canUseAgent, isMaster, externalFence } from './access.js';
import { deleteMessage, editReply, chat } from './chat.js';
import { addMemory, memoryChain, MAX_PINNED } from './knowledge.js';
import { saveUpload, saveNote, processDocument, deleteDocument, inlineType, docxPreview, setShared, setSharedMany, pickCompany, userCompanies, expiringDocuments, DOC_SELECT, docOut, readableDocuments, readableDocument, editDocumentKind, kindFieldsIn } from './files.js';
import { outlookRoutes, outlookCallback } from './outlook.js';
import { imapRoutes } from './imap.js';
import { adminRoutes, accessOfMe } from './admin.js';
import { emailRoutes } from './emailRoutes.js';
import { startOutbox } from './outbox.js';
import { importRoutes, startImportQueue, kickImports } from './imports.js';
import { messengerRoutes } from './messenger.js';
import { todoRoutes } from './todos.js';
import { routineRoutes } from './routines.js';
import { teamReminderRoutes, bringOldRemindersIntoTodos } from './teamReminders.js';
import { responsibilityRoutes } from './responsibilities.js';
import { addressRoutes } from './addressBook.js';
import { lessonRoutes } from './lessons.js';
import { checklistRoutes } from './checklists.js';
import { hrLinkRoutes } from './hrLinks.js';
import { fileAccessRoutes } from './fileAccess.js';
import { aiKeyRoutes, hasKey } from './aiKeys.js';
import { appRoutes, connectorRoutes } from './apps.js';
import { docCategoryRoutes, seedCategories } from './docCategories.js';
import { documentRenewalRoutes, proTaskRoutes } from './documentRenewals.js';
import { startSaifsysDocSync } from './saifsysDocSync.js';
import { startDocumentAlerts } from './documentAlerts.js';
import { sendingOn } from './renewalCases.js';
import { buildingRoutes, startBuildings } from './buildings.js';
import { inventoryRoutes } from './inventory.js';
import { projectRoutes, startProjects } from './projects.js';
import { caseRoutes } from './caseRoutes.js';
import { startCaseFolders } from './caseWatch.js';
import { caseShareRoutes, publicCaseRoutes } from './caseShare.js';
import { caseFocusRoutes } from './caseFocus.js';
import { serverHealthRoutes, startServerHealth } from './serverHealth.js';
import { startCaseBriefs } from './caseBrief.js';
import { recurringPaymentRoutes, startRecurringPayments } from './recurringPayments.js';
import { fromSaifsys } from './fromSaifsys.js';
import { suggestionRoutes } from './suggestions.js';
import { pushRoutes } from './push.js';
import { startReminders } from './reminders.js';
import { saifsysRoutes } from './saifsys/index.js';
import { meetingRoutes, startMeetings } from './meetings.js';
import { transcriptRoutes, startTranscripts } from './transcripts.js';
import { translateRoutes } from './translate.js';
import { errorRoutes, recordError } from './errors.js';
import { replyPdfRoutes } from './replyPdf.js';
import { meetingShareRoutes } from './meetingShare.js';
import { drawingRoutes } from './drawing.js';
import { tenantCareRoutes, startTenantCare } from './tenantCare.js';
import { mailRoutingRoutes, startMailRouting } from './mailRouting.js';
import { sharedInboxRoutes } from './sharedInbox.js';
import { moduleRoutes, needsModule, needsModuleUnless, userModules, giveToEveryoneOnce } from './modules.js';
import { noticeRoutes } from './notices.js';
import { pictureRoutes } from './pictures.js';
import { leaseRenewalRoutes, startLeaseRenewals } from './leaseRenewals.js';
import { billingContext, billingRoutes, billAs } from './billing.js';
import { legalCaseRoutes, startLegalCases } from './legalCases.js';
import { legalLeaseRoutes } from './legalLease.js';

const app = express();
app.set('trust proxy', 1); // correct req.ip / req.secure behind a hosting proxy
export const MAX_UPLOAD_MB = 25;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10 } });
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/outlook', outlookCallback); // Microsoft sign-in returns here; checked by its one-time state
app.use('/api/errors', errorRoutes); // browsers report crashes here, signed in or not
app.use('/api/from-saifsys/inventory', fromSaifsys, inventoryRoutes); // the saifsys Building Inventory screens; own key, see fromSaifsys.js
app.use('/api/from-saifsys/recurring-payments', fromSaifsys, recurringPaymentRoutes); // the saifsys Recurring Payments screens, by the same door
app.use('/api/connector', connectorRoutes); // the AOL connector server asks which mailbox a link opens; this machine only (apps.js)
app.use('/api/case-share', publicCaseRoutes); // a case folder shared by link: anyone with it, while it is on (caseShare.js)
app.use('/api', requireUser); // everything below needs a signed-in user
app.use('/api', externalFence); // someone from outside the company reaches only their own things (access.js)
app.use('/api', billingContext); // every AI call made for this request is priced to this person (billing.js)
// Reem's own modules (server/modules.js) stand in front of each screen's routes. Where a
// chat reads the same data, only what the screen alone does is closed.
const glance = (req) => req.method === 'GET' && req.path === '/'; // which mailbox is connected: a chat asks too
app.use('/api/outlook', needsModuleUnless('email', glance), outlookRoutes);
app.use('/api/imap', needsModuleUnless('email', glance), imapRoutes);
app.use('/api/email/activity', needsModule('email')); // the drafts beside it are approved from a chat
app.use('/api/email', emailRoutes);
app.use('/api/imports', needsModule('shelf'), importRoutes);
app.use('/api/messenger', messengerRoutes); // people-to-people chat, separate from the AI chats
app.use('/api/todos', needsModule('todos'), todoRoutes);
app.use('/api/team-reminders', teamReminderRoutes); // reminders sent to other people, proposed in chat
app.use('/api/suggestions', suggestionRoutes); // reminders Reem spots in new email and chat, one tap to keep
app.use('/api/routines', needsModule('todos'), routineRoutes); // things that come back, kept apart from the one-off todos
app.use('/api/push', pushRoutes); // the phone buzzing while the app is shut
app.use('/api/saifsys', saifsysRoutes); // live reads from the property system
app.use('/api/meetings', needsModule('meetings'), meetingShareRoutes); // a meeting as a PDF, on the Shelf, or emailed
app.use('/api/meetings', meetingRoutes); // recorded meetings: who said what, and a summary
app.use('/api/transcripts', needsModule('transcribe'), transcriptRoutes); // any audio file or recording, as plain text
app.use('/api/translate', needsModule('translate'), translateRoutes); // two people, two languages, one phone
app.use('/api/replies', replyPdfRoutes); // a reply's document part as a PDF, to download or keep
app.use('/api/replies', drawingRoutes); // a reply's drawing as a PDF or an AutoCAD file
app.use('/api/tenant-care', tenantCareRoutes); // the shared tenant inbox: asks for building and unit when an email leaves them out
app.use('/api/mail-routing', requireMaster, mailRoutingRoutes); // the shared mailbox: who each email is passed on to, and who sent what (master only)
app.use('/api/shared-inbox', sharedInboxRoutes); // the emails Mail routing passed on to someone, read and answered from the shared address
app.use('/api/modules', moduleRoutes); // which of Reem's own modules this person has been given
app.use('/api/notices', noticeRoutes); // a watchman's report on a unit, emailed to its tenant
app.use('/api/lease-renewals', leaseRenewalRoutes); // leases ending within 120 days, renewed with the tenant by email step by step (module renewals)
app.use('/api/legal-cases', legalLeaseRoutes); // each case's lease from saifsys, its checks and Reem's advice (module legal)
app.use('/api/legal-cases', legalCaseRoutes); // legal cases step by step, cooling periods to closure (module legal)
app.use('/api/pictures', pictureRoutes); // the pictures a chat drew for /explain, /breakdown and /explore
app.use('/api/responsibilities/mine', needsModule('duties')); // their own page; the rest is the master's, and a chat's
app.use('/api/address-book', addressRoutes); // company mailboxes the master added, next to the built-in ones (master only)
app.use('/api/lessons', lessonRoutes); // rules the master taught agents from chat, shown as Rules (master only)
app.use('/api/responsibilities', responsibilityRoutes); // who looks after what; written by the master, read by each person
app.use('/api/checklists', needsModule('checklists'), checklistRoutes); // the points of a job, ticked each time; the master sees everyone's progress
app.use('/api/buildings', buildingRoutes); // who runs each building, and the staff jobs in it
app.use('/api/inventory', inventoryRoutes); // the things kept in each unit and area of a building
// A building job's stock, deliveries and manpower (module projects); the cards a chat makes stay open to whoever is on the project.
app.use('/api/projects', needsModuleUnless('projects', (req) => req.path.startsWith('/proposals')), projectRoutes);
app.use('/api/cases', caseShareRoutes); // a case folder emailed, or its link turned on and off (external only)
app.use('/api/cases', caseRoutes); // an external person's case folders, got ready from their inbox in chat (external only)
app.use('/api/case-focus', caseFocusRoutes); // the case a chat is about, its references (module case_focus)
app.use('/api/recurring-payments', recurringPaymentRoutes); // what should come in each month from a building, pending until paid
app.use('/api/hr-link', hrLinkRoutes); // which HR employee each account is, by employee code (master only)
app.use('/api/file-access', fileAccessRoutes); // whose files a person may read besides their own (master only)
app.use('/api/ai-keys', aiKeyRoutes); // the company's AI keys and anyone's own (master only)
app.use('/api/apps', appRoutes); // mailboxes connected to Claude.ai as custom connectors (master only)
app.use('/api', docCategoryRoutes); // Document Renewals: the categories and types a Shelf file can be filed as
app.use('/api/document-renewals', documentRenewalRoutes); // the Document Renewals screen (module holders and the master)
app.use('/api/pro-tasks', proTaskRoutes); // a PRO's own renewal tasks (no module needed: only their own)
app.use('/api/billing', requireMaster, billingRoutes); // what the AI cost: by person, job and model (master only)
app.use('/api/server-health', requireMaster, serverHealthRoutes); // disk, memory, database, backups and their growth (master only)
app.use('/api/admin', adminRoutes); // master-only oversight; guarded inside the router

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const own = (table, id, userId) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(Number(id), userId);
const notFound = (res) => res.status(404).json({ error: 'Not found' });
const ilike = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

app.get('/api/config', (req, res) => res.json({ models: MODELS, voices: VOICES, folders: FOLDERS, voice: hasKey('openai', req.user?.id) }));

// ---------- agents ----------
app.get('/api/agents', wrap(async (req, res) => {
  res.json((await listedAgents(req.user)).map((a) => agentOut(a, req.user)));
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
  const { id } = await tx(async () => {
    // One case agent per owner: ticking it on another agent takes it off the old one.
    if (a.handles_cases) await db.prepare('UPDATE agents SET handles_cases = false WHERE user_id = ?').run(req.user.id);
    return db.prepare(`INSERT INTO agents (user_id, name, icon, color, persona, model, voice, starters, private, handles_cases, case_number, case_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .run(req.user.id, a.name, a.icon, a.color, a.persona, a.model, a.voice, a.starters, a.private, a.handles_cases, a.case_number, a.case_key);
  });
  res.json(agentOut(await own('agents', id, req.user.id), req.user));
}));
app.put('/api/agents/:id', requireMaster, wrap(async (req, res) => {
  if (!await own('agents', req.params.id, req.user.id)) return notFound(res);
  const a = agentIn(req.body);
  await tx(async () => {
    if (a.handles_cases) await db.prepare('UPDATE agents SET handles_cases = false WHERE user_id = ? AND id <> ?').run(req.user.id, Number(req.params.id));
    await db.prepare(`UPDATE agents SET name = ?, icon = ?, color = ?, persona = ?, model = ?, voice = ?, starters = ?, private = ?, handles_cases = ?,
      case_number = ?, case_key = ? WHERE id = ?`)
      .run(a.name, a.icon, a.color, a.persona, a.model, a.voice, a.starters, a.private, a.handles_cases, a.case_number, a.case_key, Number(req.params.id));
    // Made private: it stops being lent out as a hidden shelf. The people it is ticked for keep it.
    if (a.private) await db.prepare("DELETE FROM agent_assignments WHERE agent_id = ? AND mode = 'knowledge'").run(Number(req.params.id));
  });
  res.json(agentOut(await own('agents', req.params.id, req.user.id), req.user));
}));
// The case an agent works on: also for the person it was given to, when it is theirs alone.
app.put('/api/agents/:id/case', wrap(async (req, res) => {
  try {
    res.json(agentOut(await setAgentCase(req.user, req.params.id, req.body?.case_number), req.user));
  } catch (e) {
    if (!e.status) throw e;
    res.status(e.status).json({ error: e.message });
  }
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
  const rows = await db.prepare(`SELECT m.id, m.agent_id, m.role, m.content, m.files, m.sources, m.created_at,
      (SELECT json_agg(cc.title ORDER BY cc.id) FROM carried_chats cc WHERE cc.message_id = m.id) carried
    FROM messages m WHERE m.conversation_id = ? ORDER BY m.id`).all(Number(req.params.id));
  res.json(rows.map((m) => ({ ...m, files: JSON.parse(m.files), sources: JSON.parse(m.sources || '[]'), carried: m.carried || [] })));
}));
// Renamed from the chat list. The title is only ever set when a chat starts, so a new
// name is kept from then on.
app.patch('/api/conversations/:id', wrap(async (req, res) => {
  const title = String(req.body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'Give the chat a name' });
  const r = await db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?').run(title, Number(req.params.id), req.user.id);
  if (!r.changes) return notFound(res);
  res.json({ ok: true, title });
}));
app.delete('/api/conversations/:id', wrap(async (req, res) => {
  await db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
}));

app.post('/api/chat', upload.array('files', 10), wrap(chat));
// One message taken out of a Reem chat, as in WhatsApp: a voice note said wrong, or a reply not worth keeping.
// Part of a reply taken out (select → Remove): the reply is saved without it.
app.patch('/api/messages/:id', wrap(async (req, res) => {
  if (!await editReply(req.user.id, req.params.id, req.body.content)) return notFound(res);
  res.json({ ok: true });
}));
app.delete('/api/messages/:id', wrap(async (req, res) => {
  if (!await deleteMessage(req.user.id, req.params.id)) return notFound(res);
  res.json({ ok: true });
}));

// ---------- files: ?agent=<id> for one agent's shelf, otherwise everything this user can read ----------
// ?ids=1,2,3 for specific files (e.g. a chat's attachments), ?agent=<id> for one agent's shelf,
// otherwise all of this user's files and the ones shared with them. The Shelf screen lists the
// lot: the classifier files most uploads onto an agent, and listing only the unfiled ones made
// them vanish on arrival.
app.get('/api/documents', wrap(async (req, res) => {
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map(Number).filter(Boolean).slice(0, 200);
    if (!ids.length) return res.json([]);
    // The master's chats can hold files Reem showed from someone else's Shelf.
    const rows = await db.prepare(`${DOC_SELECT} WHERE (d.user_id = ? OR ?) AND d.id IN (${ids.map(() => '?').join(',')}) ORDER BY d.id DESC`)
      .all(req.user.id, isMaster(req.user), ...ids);
    return res.json(rows.map((d) => docOut(d, req.user.id)));
  }
  // The list itself is the Shelf screen's. A chat's own files, above, are anybody's to see.
  if (!(await userModules(req.user)).includes('shelf')) return res.status(403).json({ error: 'You do not have this module' });
  const rows = await readableDocuments(req.user, req.query.agent);
  res.json(rows.map((d) => docOut(d, req.user.id)));
}));
// Above /api/documents/:id, which would otherwise read "expiring" as an id.
// ?days=30 for the badge on the menu, the default 90 for the Shelf's own list.
app.get('/api/documents/expiring', needsModule('shelf'), wrap(async (req, res) => {
  const rows = await expiringDocuments(req.user, req.query.days);
  res.json(rows.map((d) => docOut(d, req.user.id)));
}));
app.get('/api/documents/:id', wrap(async (req, res) => {
  const doc = await readableDocument(req.user, req.params.id);
  doc ? res.json(docOut(doc, req.user.id)) : notFound(res);
}));
app.post('/api/documents', needsModule('shelf'), upload.array('files', 10), wrap(async (req, res) => {
  const agentId = Number(req.body.agent) || null;
  if (agentId && !await canUseAgent(req.user, agentId)) return notFound(res);
  // Stored now and filed by the queue, a couple at a time: a court PDF is read page by page
  // and can take minutes, and filing ten of them inside this request kept the upload waiting
  // that long. The Shelf shows them as waiting and refreshes until they are done.
  // One at a time here: two copies of the same file in one batch must meet the dedup check in turn.
  const results = [];
  for (const f of req.files || []) {
    const { doc, duplicate } = await saveUpload(req.user.id, agentId, f);
    if (!duplicate) await db.prepare("UPDATE documents SET status = 'queued' WHERE id = ?").run(doc.id);
    // Files dedup on their bytes alone, so the copy already held may be filed somewhere
    // other than where this one was headed. Naming the shelf turns "already in your
    // files" from an apparent no-op into an explanation.
    const shelf = duplicate && doc.agent_id
      ? (await db.prepare('SELECT name FROM agents WHERE id = ?').get(doc.agent_id))?.name ?? null
      : null;
    results.push({ id: doc.id, name: doc.name, duplicate, shelf });
  }
  kickImports();
  res.json(results);
}));
// A typed note. Runs the identical path as an upload - classify, file to a shelf,
// index - so it is searchable and openable like any other file. Users get these too:
// their notes are their own, and like their uploads can never be shared.
app.post('/api/documents/note', needsModule('shelf'), wrap(async (req, res) => {
  const agentId = Number(req.body.agent) || null;
  if (agentId && !await canUseAgent(req.user, agentId)) return notFound(res);
  const { doc, duplicate } = await saveNote(req.user.id, agentId, req.body.text);
  if (!duplicate) await processDocument(doc, null, String(req.body.text).trim(), agentId ? [] : await chatAgents(req.user));
  const shelf = duplicate && doc.agent_id
    ? (await db.prepare('SELECT name FROM agents WHERE id = ?').get(doc.agent_id))?.name ?? null
    : null;
  res.json({ id: doc.id, name: doc.name, duplicate, shelf });
}));

// view (safe types only) or download the original file. Reading reaches as far as the
// Shelf lists; everything below that changes a file stays with its owner.
app.get('/api/documents/:id/file', wrap(async (req, res) => {
  const doc = await readableDocument(req.user, req.params.id);
  if (!doc?.path) return notFound(res);
  const inline = !req.query.download && inlineType(doc);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
  // dotfiles: the path is the one stored for this file, never the visitor's; a data folder
  // under a dot-named folder (a git worktree under .claude) must not turn every file into a 404.
  res.type(inline || 'application/octet-stream').sendFile(doc.path, { dotfiles: 'allow' });
}));
// Word documents rendered as HTML for the in-app viewer
app.get('/api/documents/:id/preview', wrap(async (req, res) => {
  const doc = await readableDocument(req.user, req.params.id);
  if (!doc?.path || !/\.docx$/i.test(doc.name)) return notFound(res);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(await docxPreview(doc));
}));
// master only: share or unshare a whole company or folder in one go
app.post('/api/documents/share', needsModule('shelf'), wrap(async (req, res) => {
  res.json({ changed: await setSharedMany(req.user, req.body.ids, req.body.shared) });
}));
// move to another folder or company, rename, or (master only) publish to the shelf
app.patch('/api/documents/:id', needsModule('shelf'), wrap(async (req, res) => {
  const doc = await own('documents', req.params.id, req.user.id);
  // Not theirs: only what a file is, who it is for and its dates, and only for the master
  // or a Document Renewals holder (editDocumentKind decides; anyone else gets its 404).
  if (!doc) {
    if (!kindFieldsIn(req.body) && !('expires_on' in req.body)) return notFound(res);
    const { type_id, employee_code, subject, expires_on, confirm_expiry, confirm_link, not_renewing } = req.body;
    const kind = Object.fromEntries(Object.entries({ type_id, employee_code, subject, expires_on, confirm_expiry, confirm_link, not_renewing })
      .filter(([k]) => k in req.body));
    const edited = await editDocumentKind(req.user, req.params.id, kind);
    return res.json(docOut(await db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(edited.id), req.user.id));
  }
  const folder = FOLDERS.includes(req.body.folder) ? req.body.folder : doc.folder;
  const title = String(req.body.title || doc.title).slice(0, 120);
  // An empty company means "Other"; a typed one is matched to an existing spelling.
  const company = 'company' in req.body ? pickCompany(req.body.company, await userCompanies(req.user.id)) : doc.company;
  await db.prepare('UPDATE documents SET folder = ?, title = ?, company = ? WHERE id = ?').run(folder, title, company, doc.id);
  // A read expiry is a guess, and one nobody can correct is worse than none at all.
  // Anything that is not a date clears it, which is how the field is emptied. A changed
  // date is no longer the one somebody confirmed: editDocumentKind clears that.
  if (kindFieldsIn(req.body) || 'expires_on' in req.body) {
    const { title: _t, folder: _f, company: _c, shared: _s, ...kind } = req.body;
    await editDocumentKind(req.user, doc.id, kind);
  }
  // A field-level permission, not a route-level one: everyone renames and refiles here,
  // but only the master may publish. A user sending `shared` simply does not get it.
  if ('shared' in req.body && isMaster(req.user)) await setShared(req.user, doc.id, req.body.shared);
  res.json(docOut(await db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(doc.id), req.user.id));
}));
app.delete('/api/documents/:id', needsModule('shelf'), wrap(async (req, res) => {
  await deleteDocument(req.user.id, Number(req.params.id));
  res.json({ ok: true });
}));

// Who has looked at this account. Anyone can read their own; it is the whole point of
// recording it that the person being looked at can see it, not only the one looking.
app.get('/api/access', wrap(async (req, res) => {
  res.json(await accessOfMe(req.user.id));
}));

// ---------- memory (shared by all of the user's agents) ----------
app.use('/api/memories', needsModule('memory'));
// Current memories only, newest first, one page at a time; `versions` counts the earlier
// ones a memory replaced, for its History link. `q` keeps memories holding every word of it,
// searched here rather than in the page so it reaches memories on other pages.
const MEMORY_PAGE = 20;
app.get('/api/memories', wrap(async (req, res) => {
  const words = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const where = ['m.user_id = ?', 'm.replaced_at IS NULL', ...words.map(() => "m.text ILIKE ? ESCAPE '\\'")].join(' AND ');
  const params = [req.user.id, ...words.map((w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`)];
  const { total } = await db.prepare(`SELECT COUNT(*)::int total FROM memories m WHERE ${where}`).get(...params);
  const page = Math.max(1, Math.min(Number(req.query.page) || 1, Math.ceil(total / MEMORY_PAGE) || 1));
  const items = await db.prepare(`
    SELECT m.id, m.text, m.created_at, m.pinned, (
      WITH RECURSIVE older AS (
        SELECT m.id AS id UNION SELECT o2.id FROM memories o2 JOIN older o ON o2.replaced_by = o.id
      ) SELECT COUNT(*)::int - 1 FROM older) AS versions
    FROM memories m WHERE ${where} ORDER BY m.pinned DESC, m.id DESC LIMIT ${MEMORY_PAGE} OFFSET ${(page - 1) * MEMORY_PAGE}`).all(...params);
  res.json({ items, total, page, pages: Math.ceil(total / MEMORY_PAGE) });
}));
app.get('/api/memories/:id/history', wrap(async (req, res) => {
  res.json(await memoryChain(req.user.id, Number(req.params.id)));
}));
app.post('/api/memories', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Empty memory' });
  res.json({ id: await addMemory(req.user.id, text) });
}));
// Pinned memories go into every chat (pinnedMemories), so there is a ceiling on how many.
app.patch('/api/memories/:id', wrap(async (req, res) => {
  const pinned = req.body.pinned === true;
  if (pinned) {
    const { n } = await db.prepare('SELECT COUNT(*)::int n FROM memories WHERE user_id = ? AND replaced_at IS NULL AND pinned').get(req.user.id);
    if (n >= MAX_PINNED) return res.status(400).json({ error: `You can pin up to ${MAX_PINNED}. Unpin one first.` });
  }
  const { changes } = await db.prepare('UPDATE memories SET pinned = ? WHERE id = ? AND user_id = ? AND replaced_at IS NULL')
    .run(pinned, Number(req.params.id) || 0, req.user.id);
  if (!changes) return notFound(res);
  res.json({ ok: true, pinned });
}));
// Forgetting a memory forgets its earlier versions too, or they would linger out of sight.
app.delete('/api/memories/:id', wrap(async (req, res) => {
  const ids = (await memoryChain(req.user.id, Number(req.params.id))).map((m) => m.id);
  if (ids.length) await db.prepare('DELETE FROM memories WHERE user_id = ? AND id = ANY(?::int[])').run(req.user.id, ids);
  res.json({ ok: true });
}));

// ---------- voice (OpenAI) ----------
app.post('/api/voice/transcribe', upload.single('audio'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio' });
  res.json({ text: await transcribe(req.file.buffer, req.file.mimetype) });
}));
// Reading a reply aloud is two calls: register the text, then stream the audio.
app.post('/api/voice/speak', wrap(async (req, res) => {
  if (!hasKey('openai', req.user.id)) return res.status(400).json({ error: 'Voice is not configured (no OpenAI key in Settings → AI keys)' });
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

// When each word of a spoken reply is said, so the reply can be highlighted as it is read.
app.get('/api/voice/words/:key', wrap(async (req, res) => {
  const list = await timingsFor(req.params.key, req.user.id);
  if (!list) return notFound(res);
  res.json({ words: list });
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

// Before anyone is let in: the screens that have just become modules go to the people
// who already had them, so nobody opens Reem to find a screen gone.
await giveToEveryoneOnce()
  .then((given) => given.length && console.log('[modules] given to everyone already here:', given.join(', ')))
  .catch((e) => console.error('[modules] could not give the new modules to everyone:', e.message));
// The first two document categories (Employee / Company Documents), into an empty list only.
await seedCategories().catch((e) => console.error('[doc-categories] could not seed the categories:', e.message));
// Reminders sent before they landed as to-dos are put on each person's list. Once only.
await bringOldRemindersIntoTodos()
  .then((n) => n && console.log(`[team-reminders] ${n} sent reminders put on people's to-do lists`))
  .catch((e) => console.error('[team-reminders] could not bring old reminders into to-dos:', e.message));

app.listen(PORT, '0.0.0.0', () => {
  // saifsys's employee documents onto the Shelf, for Document Renewals: nightly, and once now
  startSaifsysDocSync();
  // Expiry alerts (pushes and to-dos) on the live server only, unless asked for: a local copy of
  // the live database holds real people's phones, which a test run must not wake. And on live
  // only while Document Renewals sending is switched on (the master's switch, or DOC_RENEWALS_SEND).
  if (process.env.DOCUMENT_ALERTS === 'on') startDocumentAlerts();
  else if (process.env.NODE_ENV === 'production') startDocumentAlerts({ gate: () => sendingOn() });
  // drafts approved while the rate limit was full go out when it clears
  startOutbox().catch((e) => console.error('[outbox]', e.message));
  // files from a folder or ZIP import that were still waiting when the server stopped
  startImportQueue().catch((e) => console.error('[imports]', e.message));
  // The buzz when a to-do or a routine falls due. The badge and the first screen are
  // unchanged and keep working on their own if this timer ever stops.
  startReminders();
  // Each timer keeps the job it was started as, so what it costs shows under that job in Billing.
  billAs({ userId: null, job: 'tenantcare' }, startTenantCare); // does nothing until the Tenant care inbox is connected
  billAs({ userId: null, job: 'renewals' }, startLeaseRenewals); // reads tenants' replies to renewals and sends the reminders
  billAs({ userId: null, job: 'other' }, startLegalCases); // tells people when a cooling period is about to end, or has run over
  billAs({ userId: null, job: 'mail' }, startMailRouting); // does nothing until the shared mailbox is connected
  startCaseFolders(); // external users' case folders take in new case mail; each folder is billed to its owner
  // Case brief suggestions from quiet case chats, billed to each chat's owner. Live only unless
  // asked for: a local copy of the live database would pay to read every real case chat.
  if (process.env.NODE_ENV === 'production' || process.env.CASE_BRIEFS === 'on') startCaseBriefs();
  billAs({ userId: null, job: 'buildings' }, startBuildings); // buzzes a building's administrator when a staff job needs them
  billAs({ userId: null, job: 'other' }, startRecurringPayments); // creates each recurring payment's line on its day of the month
  // meeting recordings that were still waiting to be transcribed when the server stopped
  startMeetings().catch((e) => console.error('[meetings]', e.message));
  startTranscripts().catch((e) => console.error('[transcripts]', e.message));
  startServerHealth(); // an hourly reading of disk, memory and database, for the master's Server health screen
  // The 5 pm "today's manpower not sent" push to a project's store keeper. Live only unless asked
  // for, like the document alerts: a local copy of the live database holds real people's phones.
  if (process.env.NODE_ENV === 'production' || process.env.PROJECTS_PUSH === 'on') startProjects();
  // The saifsys morning checkout reminder (startArs in server/saifsys/ars.js) is on hold
  // by the user's choice, 2026-09-25: they ask Reem instead. The tool still works.
  console.log(`Reem server → http://localhost:${PORT}`);
});
