import { db } from './db.js';
import { sendPush } from './push.js';
import { saveUpload } from './files.js';
import { getCase, event } from './renewalCases.js';
import { dubaiDate } from './saifsys/client.js';

// The PRO's part of a renewal case: after approval, a task with instructions and a due date.
// The PRO is any of our own staff (never an external user), picked on the case. While their task is open they see
// that case's papers and nothing else - not the case page, not the employee's other files -
// and the access ends with the task. Their notification is a link, never a document. What
// they bring back is uploaded onto the Shelf, linked to the case, and checked by HR.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400000;
const pretty = (s) => new Date(Date.parse(`${s}T00:00:00Z`)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
const OWNER_AFTER_DAYS = 3; // this many days late, the case's owner hears too

export async function createTask(user, caseId, { assignee_id, kind, instructions, due_date } = {}, { push = sendPush } = {}) {
  const c = await getCase(user, caseId);
  if (!['approved', 'with_pro'].includes(c.status)) throw bad('A PRO task comes after the proposal is saved');
  const pro = Number(assignee_id);
  if (!Number.isInteger(pro) || !await db.prepare('SELECT 1 FROM users WHERE id = ? AND NOT external').get(pro)) {
    throw bad('Give the task to one of the staff');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due_date || ''))) throw bad('Give a due date');
  const what = String(kind || '').trim().slice(0, 60) || 'task';
  const { id } = await db.prepare(`INSERT INTO doc_renewal_case_tasks (case_id, assignee_id, kind, instructions, due_date)
    VALUES (?, ?, ?, ?, ?) RETURNING id`).run(c.id, pro, what, String(instructions || '').trim().slice(0, 2000) || null, due_date);
  await db.prepare("UPDATE doc_renewal_cases SET status = 'with_pro', updated_at = ? WHERE id = ?").run(now(), c.id);
  await event(c.id, user.id, 'task', { task_id: id, assignee_id: pro, kind: what, due_date });
  await push([pro], {
    title: 'A task is waiting for you',
    body: `Document Renewals: due ${pretty(due_date)}. Open it for the instructions.`,
    url: `/?protask=${id}`,
    tag: `pro-task-${id}`,
  });
  return db.prepare('SELECT * FROM doc_renewal_case_tasks WHERE id = ?').get(id);
}

export const myTasks = (user) => db.prepare(`SELECT t.*, c.employee_name, c.subject, c.kind AS case_kind FROM doc_renewal_case_tasks t
  JOIN doc_renewal_cases c ON c.id = t.case_id WHERE t.assignee_id = ? AND t.status = 'open' ORDER BY t.due_date, t.id`).all(user.id);

async function ownTask(user, taskId) {
  const t = await db.prepare('SELECT * FROM doc_renewal_case_tasks WHERE id = ? AND assignee_id = ?').get(Number(taskId) || 0, user.id);
  if (!t) throw bad('Not found', 404);
  return t;
}

// The papers a PRO's task reaches: the case's document and what they uploaded for it.
const taskDocIds = (t, c) => [c.document_id, ...(t.evidence?.files || [])];

/** What the PRO sees of their task: the instructions, who it is for, and its papers while open. */
export async function taskView(user, taskId) {
  const t = await ownTask(user, taskId);
  const c = await db.prepare('SELECT * FROM doc_renewal_cases WHERE id = ?').get(t.case_id);
  const documents = t.status === 'open'
    ? await db.prepare(`SELECT d.id, d.title, d.name, d.expires_on, d.mime, ty.label AS type FROM documents d
        LEFT JOIN document_types ty ON ty.id = d.type_id WHERE d.id = ANY(?::int[]) ORDER BY d.id`).all(taskDocIds(t, c))
    : [];
  return {
    task: t,
    case: { id: c.id, kind: c.kind, employee_name: c.employee_name, subject: c.subject, ends_on: c.ends_on, terms: c.proposal?.terms || {} },
    documents,
  };
}

/** One of the task's papers, to open - only while the task is open. */
export async function taskFile(user, taskId, docId) {
  const t = await ownTask(user, taskId);
  const c = await db.prepare('SELECT * FROM doc_renewal_cases WHERE id = ?').get(t.case_id);
  if (t.status !== 'open' || !taskDocIds(t, c).includes(Number(docId))) throw bad('Not found', 404);
  const d = await db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(docId));
  if (!d) throw bad('Not found', 404);
  return d; // the route says when there is no file yet
}

/** The issued papers, onto the Shelf: the case's kind and employee, the date unconfirmed until HR checks it. */
export async function taskUpload(user, taskId, f) {
  const t = await ownTask(user, taskId);
  if (t.status !== 'open') throw bad('This task is finished');
  const c = await db.prepare('SELECT * FROM doc_renewal_cases WHERE id = ?').get(t.case_id);
  const base = await db.prepare('SELECT type_id, category_id FROM documents WHERE id = ?').get(c.document_id);
  const { doc } = await saveUpload(user.id, null, f);
  await db.prepare(`UPDATE documents SET type_id = ?, category_id = ?, employee_code = ?, employee_name = ?, subject = ?,
      expiry_confirmed_at = NULL, expiry_confirmed_by = NULL, link_confirmed_at = NULL, link_confirmed_by = NULL,
      status = CASE WHEN status = 'processing' THEN 'queued' ELSE status END
    WHERE id = ?`).run(base.type_id, base.category_id, c.employee_code, c.employee_name, c.subject, doc.id);
  const files = [...new Set([...(t.evidence?.files || []), doc.id])];
  await db.prepare('UPDATE doc_renewal_case_tasks SET evidence = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...t.evidence, files }), now(), t.id);
  await event(c.id, user.id, 'task_file', { task_id: t.id, document_id: doc.id });
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
}

async function tellOwner(c, msg, push) {
  if (c.owner_id) await push([c.owner_id], { ...msg, url: `/?docrenewals=case-${c.id}`, tag: `renewal-case-${c.id}` });
}

export async function finishTask(user, taskId, { note } = {}, { push = sendPush } = {}) {
  const t = await ownTask(user, taskId);
  if (t.status !== 'open') throw bad('This task is already finished');
  const why = String(note || '').trim().slice(0, 1000) || null;
  await db.prepare("UPDATE doc_renewal_case_tasks SET status = 'done', evidence = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify({ ...t.evidence, note: why, done_at: now() }), now(), t.id);
  await event(t.case_id, user.id, 'task_done', { task_id: t.id, note: why });
  const left = await db.prepare("SELECT 1 FROM doc_renewal_case_tasks WHERE case_id = ? AND status = 'open'").get(t.case_id);
  if (!left) {
    await db.prepare("UPDATE doc_renewal_cases SET status = 'checking_documents', updated_at = ? WHERE id = ? AND status = 'with_pro'").run(now(), t.case_id);
    const c = await db.prepare('SELECT * FROM doc_renewal_cases WHERE id = ?').get(t.case_id);
    await tellOwner(c, { title: 'The PRO has finished', body: 'Check the papers that came back and verify them' }, push);
  }
}

export async function blockTask(user, taskId, { reason } = {}, { push = sendPush } = {}) {
  const t = await ownTask(user, taskId);
  if (t.status !== 'open') throw bad('This task is finished');
  const why = String(reason || '').trim().slice(0, 500);
  if (!why) throw bad('Say what is stopping it');
  await db.prepare("UPDATE doc_renewal_case_tasks SET status = 'blocked', evidence = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify({ ...t.evidence, blocked: why }), now(), t.id);
  const c = await db.prepare('SELECT * FROM doc_renewal_cases WHERE id = ?').get(t.case_id);
  await db.prepare("UPDATE doc_renewal_cases SET status = 'paused', paused_from = ?, paused_reason = ?, updated_at = ? WHERE id = ? AND status <> 'paused'")
    .run(c.status, `PRO: ${why}`, now(), c.id);
  await event(c.id, user.id, 'task_blocked', { task_id: t.id, reason: why });
  await tellOwner(c, { title: 'The PRO is stuck', body: 'Open the case to see what is needed' }, push);
}

/** Daily: an open task past its date reminds the PRO; after a few days, the case's owner too. Once a day. */
export async function remindOverdue({ today = dubaiDate(), push = sendPush } = {}) {
  const late = await db.prepare(`SELECT t.*, c.owner_id FROM doc_renewal_case_tasks t JOIN doc_renewal_cases c ON c.id = t.case_id
    WHERE t.status = 'open' AND t.due_date < ?`).all(today);
  for (const t of late) {
    if (t.evidence?.reminded_on === today) continue;
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${t.due_date}T00:00:00Z`)) / DAY);
    await db.prepare('UPDATE doc_renewal_case_tasks SET evidence = ? WHERE id = ?').run(JSON.stringify({ ...t.evidence, reminded_on: today }), t.id);
    await push([t.assignee_id], { title: 'A task is overdue', body: `Due ${pretty(t.due_date)}, ${days} day${days === 1 ? '' : 's'} ago`, url: `/?protask=${t.id}`, tag: `pro-task-${t.id}` });
    if (days > OWNER_AFTER_DAYS && t.owner_id) {
      await push([t.owner_id], { title: 'A PRO task is overdue', body: `${days} days late`, url: `/?docrenewals=case-${t.case_id}`, tag: `renewal-case-${t.case_id}` });
    }
  }
}
