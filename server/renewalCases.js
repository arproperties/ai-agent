import { db } from './db.js';
import { isMaster, isExternal } from './access.js';
import { userModules } from './modules.js';
import { readableDocument } from './files.js';
import { askSaifsys, dubaiDate } from './saifsys/client.js';
import { DOC_RENEWALS_SEND } from './config.js';

// Renewal cases (Document Renewals): one document being renewed or cancelled, from the
// decision to the papers coming back. A contract (a type the master ticked "opens a case")
// opens one by itself 60 days before it ends; any other document when the admin taps Renew
// or Cancel. People decide: nothing here renews, terminates or cancels anything by itself.
// Every step is an event with who took it. The master and Document Renewals holders work
// the cases, on documents they can read. There is no approval step: the saved proposal is
// what goes to the PRO, and it can be corrected until the PRO has a task.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const DAY = 86400000;
const shift = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const now = () => Math.floor(Date.now() / 1000);

// 'approved' is the saved proposal, ready for the PRO (the name is kept for the cases already in it).
export const STATUSES = ['open', 'renew_review', 'cancel_review', 'needs_review', 'with_pro',
  'approved', 'checking_documents', 'writing_back', 'paused', 'closed'];
const DECIDING = ['open', 'renew_review', 'cancel_review', 'needs_review'];
const PROPOSING = ['renew_review', 'cancel_review', 'needs_review'];
const AFTER = { renew: 'renew_review', cancel: 'cancel_review', needs_review: 'needs_review' };

export async function caseSettings() {
  const s = await db.prepare(`SELECT s.open_days, s.pro_ids, s.send_on, s.send_changed_at, u.name AS send_changed_by
    FROM doc_renewal_case_settings s LEFT JOIN users u ON u.id = s.send_changed_by WHERE s.id = 1`).get();
  return s || { open_days: 60, pro_ids: [], send_on: false, send_changed_at: null, send_changed_by: null };
}

/**
 * Do Document Renewals' emails and expiry alerts go out? The master's switch on the settings
 * screen, read each time so flipping it needs no restart; DOC_RENEWALS_SEND=on in .env also turns it on.
 */
export async function sendingOn({ env = DOC_RENEWALS_SEND } = {}) {
  return env || !!(await caseSettings()).send_on;
}

/** Has a PRO been given this case yet? Until then its proposal and decision can still change. */
const withPro = async (caseId) => !!(await db.prepare('SELECT 1 FROM doc_renewal_case_tasks WHERE case_id = ? LIMIT 1').get(caseId));
const stillOpenToChange = async (c) => PROPOSING.includes(c.status) || (c.status === 'approved' && !(await withPro(c.id)));

export const event = (caseId, userId, kind, detail = {}) =>
  db.prepare('INSERT INTO doc_renewal_case_events (case_id, user_id, kind, detail) VALUES (?, ?, ?, ?)').run(caseId, userId, kind, JSON.stringify(detail));

/** May this person work cases at all? The master, and Document Renewals holders who are not external. */
export async function worker(user) {
  if (isMaster(user)) return true;
  return !isExternal(user) && (await userModules(user)).includes('document_renewals');
}

/** A case this person may see: they work cases and can read its document. */
export async function getCase(user, id) {
  const c = await db.prepare('SELECT * FROM doc_renewal_cases WHERE id = ?').get(Number(id) || 0);
  if (!c || !(await worker(user)) || !(await readableDocument(user, c.document_id))) throw bad('Not found', 404);
  return c;
}

export async function listCases(user, { closed = false } = {}) {
  if (!(await worker(user))) return [];
  const rows = await db.prepare(`SELECT c.*, t.label AS type FROM doc_renewal_cases c
    JOIN documents d ON d.id = c.document_id LEFT JOIN document_types t ON t.id = d.type_id
    WHERE (c.closed_at IS NULL) <> ? ORDER BY c.ends_on ASC NULLS LAST, c.id`).all(closed);
  const out = [];
  for (const c of rows) if (await readableDocument(user, c.document_id)) out.push(c);
  return out;
}

async function openCase(doc, { userId = null, status = 'open', kind = null } = {}) {
  const { id } = await db.prepare(`INSERT INTO doc_renewal_cases (document_id, employee_code, employee_name, subject, ends_on, kind, status, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .run(doc.id, doc.employee_code, doc.employee_name, doc.subject, doc.expires_on, kind, status, userId);
  await event(id, userId, 'opened', userId ? {} : { by: 'the daily check', ends_on: doc.expires_on });
  return id;
}

/** The admin's Renew or Cancel on a document. */
export async function startCase(user, docId, kind) {
  if (!(await worker(user))) throw bad('You do not have Document Renewals', 403);
  if (!['renew', 'cancel'].includes(kind)) throw bad('Renew or cancel?');
  const doc = await readableDocument(user, docId);
  if (!doc) throw bad('Not found', 404);
  if (!doc.category_id) throw bad('Give this file its kind of document first (passport, visa, licence...)');
  let id;
  try {
    id = await openCase(doc, { userId: user.id, status: AFTER[kind], kind });
  } catch (e) {
    if (e.code === '23505') throw bad('This document already has an open case', 409);
    throw e;
  }
  await event(id, user.id, 'decision', { choice: kind });
  return getCase(user, id);
}

/**
 * Renew, cancel (for a contract: start a termination review) or needs review. Before the
 * proposal, or after it until the PRO has a task when the mind changes the other way (a
 * saved renewal becomes a termination): the old proposal goes with it, a new one is written.
 */
export async function decide(user, id, { choice, note } = {}) {
  const c = await getCase(user, id);
  if (!AFTER[choice]) throw bad('Choose renew, cancel or needs review');
  const turned = choice !== 'needs_review' && c.kind && choice !== c.kind;
  if (!DECIDING.includes(c.status) && !(turned && (await stillOpenToChange(c)))) throw bad('This case is past its decision');
  const kind = choice === 'needs_review' ? c.kind : choice;
  await db.prepare(`UPDATE doc_renewal_cases SET status = ?, kind = ?, owner_id = COALESCE(owner_id, ?),
      proposal = CASE WHEN ? THEN NULL ELSE proposal END, updated_at = ${'extract(epoch from now())::bigint'} WHERE id = ?`)
    .run(AFTER[choice], kind, user.id, !!turned, c.id);
  await event(c.id, user.id, 'decision', { choice, note: String(note || '').trim().slice(0, 500) || null });
  return getCase(user, c.id);
}

export async function pause(user, id, { reason } = {}) {
  const c = await getCase(user, id);
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw bad('Say why it is paused');
  if (c.closed_at || c.status === 'paused') throw bad('This case cannot be paused now');
  await db.prepare('UPDATE doc_renewal_cases SET status = ?, paused_from = ?, paused_reason = ?, updated_at = ? WHERE id = ?').run('paused', c.status, why, now(), c.id);
  await event(c.id, user.id, 'paused', { reason: why });
}

export async function resume(user, id) {
  const c = await getCase(user, id);
  if (c.status !== 'paused') throw bad('This case is not paused');
  await db.prepare('UPDATE doc_renewal_cases SET status = ?, paused_from = NULL, paused_reason = NULL, updated_at = ? WHERE id = ?').run(c.paused_from || 'open', now(), c.id);
  await event(c.id, user.id, 'resumed');
}

export async function closeCase(caseId, userId, note) {
  await db.prepare("UPDATE doc_renewal_cases SET status = 'closed', closed_at = ?, closed_note = ?, updated_at = ? WHERE id = ?").run(now(), note, now(), caseId);
  await event(caseId, userId, 'closed', { note });
}

/** Not a case for us (a contractor, a mistake): closed with the reason, and not reopened. */
export async function outOfScope(user, id, { reason } = {}) {
  const c = await getCase(user, id);
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw bad('Say why it is out of scope');
  if (c.closed_at) throw bad('This case is already closed');
  await closeCase(c.id, user.id, `Out of scope: ${why}`);
}

/**
 * The daily check: a confirmed contract within open_days of its end opens a case; an open
 * case follows its contract to the newer one that replaced it; one whose employee has left
 * in saifsys closes. Nothing is opened or closed when saifsys cannot say who is still here.
 */
export async function scanCases({ today = dubaiDate(), ask = askSaifsys } = {}) {
  const out = { opened: 0, moved: 0, closed: 0 };
  const { open_days } = await caseSettings();
  const staff = new Map(); // code -> saifsys employee, or an Error
  const employee = async (code) => {
    if (!staff.has(code)) {
      staff.set(code, await ask('hr', 'employee', { q: code }).then((r) => (r.employee && String(r.employee.code) === code ? r.employee : null), (e) => e));
    }
    return staff.get(code);
  };

  // An open case whose document was replaced follows it to the newest one.
  for (const c of await db.prepare(`SELECT c.id, c.document_id FROM doc_renewal_cases c JOIN documents d ON d.id = c.document_id
      WHERE c.closed_at IS NULL AND d.superseded_by IS NOT NULL`).all()) {
    let to = c.document_id;
    for (let i = 0; i < 20; i++) {
      const next = (await db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(to))?.superseded_by;
      if (!next) break;
      to = next;
    }
    const d = await db.prepare('SELECT * FROM documents WHERE id = ?').get(to);
    await db.prepare('UPDATE doc_renewal_cases SET document_id = ?, ends_on = ?, updated_at = ? WHERE id = ?').run(d.id, d.expires_on, now(), c.id);
    await event(c.id, null, 'moved', { from: c.document_id, to: d.id, ends_on: d.expires_on });
    out.moved++;
  }

  // An open case for someone who has left closes.
  for (const c of await db.prepare('SELECT id, employee_code FROM doc_renewal_cases WHERE closed_at IS NULL AND employee_code IS NOT NULL').all()) {
    const e = await employee(c.employee_code);
    if (e && !(e instanceof Error) && e.left) {
      await closeCase(c.id, null, `Left in saifsys on ${e.exit_date || 'an unknown date'}`);
      out.closed++;
    }
  }

  // A confirmed contract near its end, for someone still here, opens a case once.
  const due = await db.prepare(`SELECT d.* FROM documents d
      JOIN document_types t ON t.id = d.type_id AND t.opens_case
      JOIN document_categories c ON c.id = d.category_id AND c.links_to = 'employee'
    WHERE d.employee_code IS NOT NULL AND d.expires_on IS NOT NULL AND d.expires_on <= ?
      AND d.expiry_confirmed_at IS NOT NULL AND d.link_confirmed_at IS NOT NULL
      AND d.superseded_by IS NULL AND d.not_renewing_at IS NULL AND d.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM doc_renewal_cases r WHERE r.document_id = d.id)
    ORDER BY d.expires_on, d.id`).all(shift(today, open_days));
  for (const d of due) {
    const e = await employee(d.employee_code);
    if (!e || e instanceof Error || e.left) continue;
    try {
      await openCase(d);
      out.opened++;
    } catch (err) {
      if (err.code !== '23505') throw err; // another run opened it a moment ago
    }
  }
  return out;
}

// ---------- the proposal ----------

const MONEY = ['basic', 'allowance', 'bonus', 'total'];
const TEXT = ['position', 'location', 'hours', 'benefits'];
const DATES = ['new_start', 'new_end', 'effective_date', 'expected_expiry', 'last_working_day', 'notice_given_on'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Is this case's document a contract (its type opens cases)? */
async function isContract(c) {
  return !!(await db.prepare(`SELECT t.opens_case FROM documents d JOIN document_types t ON t.id = d.type_id WHERE d.id = ?`).get(c.document_id))?.opens_case;
}

// Only the fields a proposal has, cleaned: numbers as numbers, dates as dates, short texts.
function cleanTerms(t = {}) {
  const out = {};
  for (const k of MONEY) if (t[k] !== undefined && t[k] !== '' && t[k] !== null) {
    const n = Number(t[k]);
    if (!Number.isFinite(n) || n < 0) throw bad(`${k} must be an amount`);
    out[k] = n;
  }
  for (const k of TEXT) if (t[k]) out[k] = String(t[k]).trim().slice(0, 300);
  for (const k of DATES) if (t[k]) {
    if (!isDate(t[k])) throw bad(`${k.replace(/_/g, ' ')} must be a date`);
    out[k] = t[k];
  }
  for (const k of ['reason', 'notice_days']) if (t[k]) out[k] = k === 'notice_days' ? Number(t[k]) || 0 : String(t[k]).trim().slice(0, 500);
  return out;
}

// What Reem last read off the case's contract, as kept on the document. The route passes a reader
// that also reads it when it is not read yet (documentRenewals.js contractTerms).
const keptReading = async (c) => (await db.prepare('SELECT terms_read FROM documents WHERE id = ?').get(c.document_id))?.terms_read || null;

/**
 * HR's proposal, and saving it is final: the case is then ready for the PRO (it can be saved
 * again until the PRO has a task). A contract renewal keeps the terms, which come from the
 * current contract itself, the source of truth the PRO works from; or updates them (a new end
 * and effective date required); or resolves a discrepancy first (the case pauses). Any other
 * document proposes its expected new expiry; a cancellation its reason.
 */
export async function propose(user, id, { mode, terms, note } = {}, { contract: readContract = keptReading } = {}) {
  const c = await getCase(user, id);
  if (!(await stillOpenToChange(c))) throw bad(c.status === 'approved' ? 'The PRO has the case already: the proposal cannot change now' : 'Decide renew or cancel first, before the proposal');
  const contract = await isContract(c);
  const why = String(note || '').trim().slice(0, 1000) || null;
  let t;
  let from;
  if (c.kind === 'cancel') {
    if (mode !== 'cancel') throw bad('This case is a cancellation');
    t = cleanTerms(terms);
    if (!t.reason) throw bad('Say why it is being cancelled');
    if (contract && !t.last_working_day) throw bad('Give the last working day');
  } else if (!contract) {
    if (mode !== 'renew_document') throw bad('Keep and update terms are for contracts; give the expected new expiry');
    t = cleanTerms(terms);
    if (!t.expected_expiry) throw bad('Give the expected new expiry date');
  } else if (mode === 'resolve_first') {
    await pause(user, c.id, { reason: `Resolve before proceeding${why ? `: ${why}` : ''}` });
    return getCase(user, c.id);
  } else if (mode === 'keep') {
    // Only what the contract says: nothing it leaves out is filled from HR.
    const paper = await readContract(c);
    if (paper?.basic == null) throw bad('Reem could not read the salary on the contract: choose Update the terms and type it in');
    const said = Object.fromEntries(['basic', 'allowance', 'total', 'position', 'location', 'hours', 'benefits'].filter((k) => paper[k] != null).map((k) => [k, paper[k]]));
    const dates = Object.fromEntries(Object.entries(terms || {}).filter(([k]) => DATES.includes(k)));
    t = cleanTerms({ ...said, ...dates });
    from = { contract: c.document_id, confidence: paper.confidence === 'high' ? 'high' : 'low' };
  } else if (mode === 'update') {
    t = cleanTerms(terms);
    if (!t.new_end) throw bad('Give the new end date');
    if (!t.effective_date) throw bad('Give the date the new terms start');
  } else {
    throw bad('Choose keep terms, update terms or resolve first');
  }
  const proposal = { mode, terms: t, ...(from ? { from } : {}), note: why, by: user.id, at: now() };
  await db.prepare("UPDATE doc_renewal_cases SET proposal = ?, status = 'approved', updated_at = ? WHERE id = ?").run(JSON.stringify(proposal), now(), c.id);
  await event(c.id, user.id, 'proposal', proposal);
  return getCase(user, c.id);
}

// ---------- the papers that come back ----------

/** The papers the PRO brought for this case. */
async function caseFiles(caseId) {
  const rows = await db.prepare('SELECT evidence FROM doc_renewal_case_tasks WHERE case_id = ?').all(caseId);
  return rows.flatMap((r) => r.evidence?.files || []);
}

/**
 * Reem reads one returned paper and checks it against what was approved; the result goes on
 * the case's timeline for HR. `read` is the reader (renewalAi.js readReturnedDoc on the file).
 */
export async function checkPapers(user, id, docId, { read } = {}) {
  const c = await getCase(user, id);
  if (!(await caseFiles(c.id)).includes(Number(docId))) throw bad('That paper was not brought for this case');
  const { readReturnedDoc, checkAgainstCase } = await import('./renewalAi.js');
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(docId));
  const got = read ? await read(doc) : await readReturnedDoc(await fileBytes(doc));
  const result = checkAgainstCase(got, c, { contract: await isContract(c) });
  await event(c.id, user.id, 'papers', { document_id: doc.id, read: got, ...result });
  return result;
}

async function fileBytes(doc) {
  const { readFileSync } = await import('node:fs');
  if (!doc.path) throw bad('That paper has no file yet');
  return { mime: doc.mime || 'application/pdf', data: readFileSync(doc.path).toString('base64') };
}

/**
 * HR's Verified on a returned paper: its date and person are confirmed, it replaces the case's
 * document, and the case closes - or, for a contract whose terms changed, goes on to be written
 * back to saifsys. A verified cancellation marks the document not renewing.
 */
export async function verify(user, id, { document_id } = {}) {
  const c = await getCase(user, id);
  if (c.status !== 'checking_documents') throw bad('The papers are checked once the PRO has finished');
  const docId = Number(document_id);
  if (!(await caseFiles(c.id)).includes(docId)) throw bad('Verify a paper that was brought for this case');
  const d = await db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  const t = now();
  if (c.kind === 'renew') {
    if (!d.expires_on) throw bad('Put the new expiry date on the paper first');
    await db.prepare(`UPDATE documents SET expiry_confirmed_by = ?, expiry_confirmed_at = ?, link_confirmed_by = ?, link_confirmed_at = ? WHERE id = ?`)
      .run(user.id, t, user.id, t, d.id);
    await db.prepare('UPDATE documents SET superseded_by = ? WHERE id = ?').run(d.id, c.document_id);
  } else {
    await db.prepare('UPDATE documents SET not_renewing_at = ?, not_renewing_note = ? WHERE id = ?')
      .run(t, `Cancelled (case #${c.id})`, c.document_id);
  }
  await event(c.id, user.id, 'verified', { document_id: d.id });
  if (c.kind === 'renew' && (await isContract(c)) && c.proposal?.mode === 'update') {
    await db.prepare("UPDATE doc_renewal_cases SET status = 'writing_back', updated_at = ? WHERE id = ?").run(t, c.id);
    return;
  }
  if (c.kind === 'cancel' && (await isContract(c))) {
    await db.prepare("UPDATE doc_renewal_cases SET status = 'writing_back', updated_at = ? WHERE id = ?").run(t, c.id);
    return;
  }
  await closeCase(c.id, user.id, c.kind === 'renew' ? `Renewed: runs to ${d.expires_on}` : 'Cancelled');
}

/** The master's settings: when a contract opens a case, who the PROs are, and whether sending is on. */
export async function saveCaseSettings(user, { open_days, pro_ids, send_on } = {}) {
  if (!isMaster(user)) throw bad('Only the master changes these settings', 403);
  const cur = await caseSettings();
  const days = open_days === undefined ? cur.open_days : Number(open_days);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw bad('Days before the end must be between 1 and 365');
  const known = async (ids, keep) => {
    if (ids === undefined) return keep;
    const want = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
    if (!want.length) return [];
    const rows = await db.prepare('SELECT id FROM users WHERE id = ANY(?::int[]) AND NOT external').all(want);
    return want.filter((id) => rows.some((r) => r.id === id));
  };
  const p = await known(pro_ids, cur.pro_ids);
  await db.prepare(`INSERT INTO doc_renewal_case_settings (id, open_days, pro_ids) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET open_days = EXCLUDED.open_days, pro_ids = EXCLUDED.pro_ids`).run(days, p);
  // Only a real change of the switch is written down with who and when.
  if (send_on !== undefined && !!send_on !== !!cur.send_on) {
    await db.prepare('UPDATE doc_renewal_case_settings SET send_on = ?, send_changed_by = ?, send_changed_at = ? WHERE id = 1').run(!!send_on, user.id, now());
    console.log(`[document-renewals] sending turned ${send_on ? 'on' : 'off'} by user ${user.id}`);
  }
  return caseSettings();
}
