import { db, tx } from './db.js';
import { projectRole } from './access.js';
import { sendPush } from './push.js';
import { dubaiDate } from './saifsys/client.js';
import { bad, line, has, canRecord, canDecide, pickProject, saveCard, managersOf } from './projects.js';
import { ensureSteps } from './projectProgress.js';

// Issues and wall checks on a project.
//
// Issues: questions for the consultant and problems that hold work up - what, which floor
// and step it holds, who was asked, and the answer once there is one. Anyone on the project
// can raise one; a manager closes it with the answer. The JVC School starts with the basement
// questions found in the Arch-TRK drawing check (2026-11-02).
//
// Wall checks: the daily walk along new blockwork, nine checks Pass or Fail for a room. A
// Fail sends the managers a push. Both come from chat on a card, like the rest of a project.

export const WALL_CHECKS = [
  'Mortar mixed 1:4, measured with a box or bucket',
  'Mortar used within about 2 hours, no water added to old mortar',
  'Joints full, about 10 mm',
  'Courses level and walls plumb',
  'Joints staggered (half-block overlap)',
  'Tied to columns every 2-3 courses',
  'Lintel over every door and opening',
  'Not more than about 1.5 m of wall a day',
  'Walls cured: sprayed 2-3 times a day for 7 days',
];

// From the drawing check of the Arch-TRK set: the basement questions to settle with the
// consultant before the walls they touch are built. [text, step it holds, asked]
const JVC_BASEMENT = [
  ['Pool deck level: −2.50 or −3.00? Sheet 22 also shows the basement at −4.50 against −4.10 elsewhere.', 'Blockwork'],
  ['Fire rating of the garbage room and generator room doors: the door schedule says N/A.', 'Blockwork'],
  ['Car ramp: the real slope is 12.6% (4.10 over 32.50), not 12%, with no transition slopes.', 'Blockwork'],
  ['No accessible WC by the pool and changing rooms.', 'Blockwork'],
];

/** A JVC project's first floor gets the drawing-check questions, once. Other projects start empty. */
export async function ensureIssues(projectId) {
  const p = await db.prepare('SELECT name, floors, issues_seeded FROM projects WHERE id = ?').get(projectId);
  if (!p || p.issues_seeded) return;
  await ensureSteps(projectId); // the questions point at the step they hold up
  await tx(async () => {
    const { changes } = await db.prepare('UPDATE projects SET issues_seeded = true WHERE id = ? AND NOT issues_seeded').run(projectId);
    if (!changes || !/jvc/i.test(p.name) || !p.floors.length) return;
    for (const [text, step] of JVC_BASEMENT) {
      const s = await db.prepare('SELECT id FROM project_steps WHERE project_id = ? AND floor = ? AND name = ? ORDER BY id LIMIT 1').get(projectId, p.floors[0], step);
      await db.prepare(`INSERT INTO project_issues (project_id, floor, step_id, text, asked) VALUES (?, ?, ?, ?, 'Consultant (Eng. Bayat)')`)
        .run(projectId, p.floors[0], s?.id ?? null, text);
    }
  });
}

/** Open issues first, then the closed ones; and the latest wall checks. */
export async function issuesOf(user, projectId) {
  const role = await projectRole(user, projectId);
  if (!role) return null;
  await ensureIssues(Number(projectId));
  const issues = await db.prepare(`SELECT i.*, s.name AS step, o.name AS opened_name, c.name AS closed_name FROM project_issues i
    LEFT JOIN project_steps s ON s.id = i.step_id LEFT JOIN users o ON o.id = i.opened_by LEFT JOIN users c ON c.id = i.closed_by
    WHERE i.project_id = ? ORDER BY (i.status = 'open') DESC, i.id DESC`).all(Number(projectId));
  const checks = await db.prepare(`SELECT k.id, k.floor, k.area, k.day, k.results, k.note, u.name AS by_name FROM project_inspections k
    LEFT JOIN users u ON u.id = k.by_user WHERE k.project_id = ? ORDER BY k.day DESC, k.id DESC LIMIT 60`).all(Number(projectId));
  return {
    role,
    issues: issues.map((i) => ({
      id: i.id, floor: i.floor, step: i.step, step_id: i.step_id, text: i.text, asked: i.asked, status: i.status, answer: i.answer,
      opened_by: i.opened_name, opened_at: i.opened_at, closed_by: i.closed_name, closed_at: i.closed_at,
    })),
    checks: checks.map((k) => ({ ...k, failed: k.results.filter((r) => !r.pass).map((r) => r.check) })),
  };
}

// ---------- the screen: a manager adds or closes an issue ----------

async function stepOn(projectId, floor, stepSaid) {
  const want = line(stepSaid, 120);
  if (!want) return null;
  const steps = await db.prepare('SELECT id, floor, name FROM project_steps WHERE project_id = ? AND lower(floor) = lower(?)').all(projectId, floor || '');
  const hits = steps.filter((s) => s.name.toLowerCase() === want.toLowerCase()).length ? steps.filter((s) => s.name.toLowerCase() === want.toLowerCase())
    : steps.filter((s) => has(s.name, want));
  if (hits.length !== 1) {
    throw bad(`${hits.length ? `"${want}" could be more than one step` : `No step called "${want}"`}${floor ? ` on ${floor}` : ''}. ` +
      `Steps: ${(hits.length ? hits : steps).map((s) => s.name).join('; ') || 'none - say the floor'}.`);
  }
  return hits[0].id;
}

async function addIssue(user, projectId, { floor, step, text, asked }) {
  const said = line(text, 600);
  if (!said) throw bad('Say what the issue is.');
  const f = line(floor, 40) || null;
  const stepId = await stepOn(projectId, f, step);
  return db.prepare('INSERT INTO project_issues (project_id, floor, step_id, text, asked, opened_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .run(projectId, f, stepId, said, line(asked, 120) || null, user.id);
}

async function closeIssue(user, issueId, answer) {
  const said = line(answer, 600);
  if (!said) throw bad('Say the answer, or what settled it.');
  const { changes } = await db.prepare(`UPDATE project_issues SET status = 'closed', answer = ?, closed_by = ?, closed_at = extract(epoch from now())::bigint
    WHERE id = ? AND status = 'open'`).run(said, user.id, issueId);
  if (!changes) throw bad('This issue is already closed.', 409);
}

export async function saveIssue(user, projectId, body = {}) {
  const role = await projectRole(user, projectId);
  if (!role) return null;
  if (!canRecord(role)) throw bad('Only people on this project can raise an issue.', 403);
  await addIssue(user, Number(projectId), body);
  return issuesOf(user, projectId);
}

export async function closeIssueOnScreen(user, issueId, { answer } = {}) {
  const i = await db.prepare('SELECT project_id FROM project_issues WHERE id = ?').get(Number(issueId) || 0);
  if (!i) return null;
  const role = await projectRole(user, i.project_id);
  if (!role) return null;
  if (!canDecide(role)) throw bad('Only a manager closes an issue.', 403);
  await closeIssue(user, Number(issueId), answer);
  return issuesOf(user, i.project_id);
}

// ---------- cards from chat ----------

async function findIssue(projectId, said) {
  const want = line(said, 200);
  const open = await db.prepare(`SELECT id, text FROM project_issues WHERE project_id = ? AND status = 'open' ORDER BY id`).all(projectId);
  const byNumber = /^#?\d+$/.test(want) && open.find((i) => i.id === Number(want.replace('#', '')));
  const hits = byNumber ? [byNumber] : open.filter((i) => has(i.text, want));
  if (hits.length !== 1) {
    throw bad(`${hits.length ? `"${want}" matches more than one open issue` : `No open issue matches "${want}"`}. ` +
      `Open issues: ${(hits.length ? hits : open).map((i) => `#${i.id} ${i.text}`).join(' | ') || 'none'}.`);
  }
  return hits[0];
}

/** A new issue, ready on a card. */
export async function proposeIssue(user, input, { conversationId = null, agentId = null } = {}) {
  const p = await pickProject(user, input.project, agentId);
  if (!canRecord(p.role)) throw bad(`This user is not the store keeper or a manager on ${p.name}.`);
  const text = line(input.text, 600);
  if (!text) throw bad('Say what the issue is.');
  const floor = line(input.floor, 40) ? (p.floors.find((f) => f.toLowerCase() === line(input.floor, 40).toLowerCase()) || line(input.floor, 40)) : null;
  await ensureSteps(p.id); // an issue can be the first thing anyone records
  const stepId = await stepOn(p.id, floor, input.step);
  const step = stepId ? (await db.prepare('SELECT name FROM project_steps WHERE id = ?').get(stepId)).name : null;
  return saveCard(user, p, 'issue', { text, floor, step, step_id: stepId, asked: line(input.asked, 120) || null }, conversationId);
}

/** Closing an issue with its answer, ready on a card. Managers only. */
export async function proposeClose(user, input, { conversationId = null, agentId = null } = {}) {
  const p = await pickProject(user, input.project, agentId);
  if (!canDecide(p.role)) throw bad(`Only a manager on ${p.name} closes an issue. Tell the user to ask one.`);
  await ensureIssues(p.id);
  const i = await findIssue(p.id, input.issue);
  const answer = line(input.answer, 600);
  if (!answer) throw bad('Say the answer, or what settled it.');
  return saveCard(user, p, 'issue_close', { issue_id: i.id, text: i.text, answer }, conversationId);
}

// "ties" for "Tied to columns", "joints not full" for "Joints full": every word said starts
// like a word of the check (all but its last letter). More than one match is asked about.
const sameWords = (check, said) => {
  const words = check.toLowerCase().split(/[^a-z0-9]+/);
  const want = said.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3 && !['not', 'the', 'and', 'too', 'bad', 'wrong'].includes(x));
  return want.length > 0 && want.every((x) => words.some((y) => y.startsWith(x.slice(0, Math.max(3, x.length - 1)))));
};

/** The daily wall walk for a room, ready on a card: every check passes unless said otherwise. */
export async function proposeInspection(user, input, { conversationId = null, agentId = null } = {}) {
  const p = await pickProject(user, input.project, agentId);
  if (!canRecord(p.role)) throw bad(`This user is not the store keeper or a manager on ${p.name}.`);
  const failed = [];
  for (const w of (Array.isArray(input.failed) ? input.failed : []).map((x) => line(x, 200)).filter(Boolean)) {
    const hit = WALL_CHECKS.filter((c) => has(c, w) || sameWords(c, w));
    if (hit.length !== 1) throw bad(`Which check is "${w}"? The checks: ${WALL_CHECKS.join('; ')}.`);
    if (!failed.includes(hit[0])) failed.push(hit[0]);
  }
  const floor = line(input.floor, 40) ? (p.floors.find((f) => f.toLowerCase() === line(input.floor, 40).toLowerCase()) || line(input.floor, 40)) : null;
  const d = line(input.date, 10);
  return saveCard(user, p, 'inspection', {
    floor, area: line(input.area, 120) || null, day: /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= dubaiDate() ? d : dubaiDate(),
    checks: WALL_CHECKS, failed, note: line(input.note, 400) || null,
  }, conversationId);
}

/**
 * The tap on Confirm, inside confirmCard's transaction. A wall check takes what was ticked
 * on the card (body.passed); anything not ticked is a Fail.
 */
export async function applyIssueCard(user, card, body = {}) {
  const d = card.data;
  if (card.kind === 'issue') {
    await addIssue(user, card.project_id, { floor: d.floor, step: d.step, text: d.text, asked: d.asked });
  } else if (card.kind === 'issue_close') {
    if (!canDecide(await projectRole(user, card.project_id))) throw bad('Only a manager closes an issue.', 403);
    await closeIssue(user, d.issue_id, d.answer);
  } else {
    const passed = Array.isArray(body.passed) ? body.passed : d.checks.filter((c) => !d.failed.includes(c));
    const results = d.checks.map((check) => ({ check, pass: passed.includes(check) }));
    await db.prepare('INSERT INTO project_inspections (project_id, proposal_id, floor, area, day, results, note, by_user) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)')
      .run(card.project_id, card.id, d.floor, d.area, d.day, JSON.stringify(results), d.note, user.id);
    return results.filter((r) => !r.pass).map((r) => r.check);
  }
  return [];
}

/** After a wall check with a Fail is confirmed: the managers hear what failed, and where. */
export async function pushFailedCheck(card, failed, by, push = sendPush) {
  const ids = (await managersOf(card.project_id)).filter((id) => id !== by.id);
  if (!ids.length || !failed.length) return;
  const where = [card.data.floor, card.data.area].filter(Boolean).join(', ');
  await push(ids, {
    title: `${card.project}: wall check failed${where ? ` (${where})` : ''}`,
    body: `${failed.join('; ')}${card.data.note ? ` - ${card.data.note}` : ''}`,
    url: '/', tag: `project-check-${card.id}`,
  }).catch(() => {});
}

// ---------- Reem in chat ----------

async function issuesForChat(user, input, agentId) {
  const p = await pickProject(user, input.project, agentId);
  const r = await issuesOf(user, p.id);
  const open = r.issues.filter((i) => i.status === 'open');
  const closed = r.issues.filter((i) => i.status === 'closed').slice(0, 15);
  const where = (i) => [i.floor, i.step].filter(Boolean).join(' - ');
  return [
    `Project: ${p.name}. Issues are what was raised in Reem; anything not raised is not here.`,
    '', `Open issues (${open.length}):`,
    ...open.map((i) => `  #${i.id}${where(i) ? ` [${where(i)}]` : ''} ${i.text}${i.asked ? ` (asked: ${i.asked})` : ''}`),
    '', `Closed lately (${closed.length}):`,
    ...closed.map((i) => `  #${i.id}${where(i) ? ` [${where(i)}]` : ''} ${i.text} → ${i.answer}${i.closed_by ? ` (${i.closed_by})` : ''}`),
    '', `Wall checks lately (${r.checks.length}):`,
    ...r.checks.slice(0, 15).map((k) => `  ${k.day} ${[k.floor, k.area].filter(Boolean).join(', ') || 'site'}: ` +
      `${k.failed.length ? `FAILED ${k.failed.join('; ')}` : 'all passed'}${k.note ? ` - ${k.note}` : ''}${k.by_name ? ` (${k.by_name})` : ''}`),
    '', `The wall checks: ${WALL_CHECKS.join('; ')}.`,
  ].join('\n');
}

const PROJECT = { type: 'string', description: 'Leave out unless the user names a project.' };

export const ISSUE_DEFS = {
  issues: {
    name: 'project_issues',
    description: 'A building project\'s issues (questions for the consultant, problems holding work up) open and closed with their answers, ' +
      'and the latest wall checks with what failed. Use for "what are we waiting on?", "any open questions for the consultant?", "did the walls pass?". Answer only from what it returns.',
    input_schema: { type: 'object', properties: { project: PROJECT } },
  },
  raise: {
    name: 'log_issue',
    description: 'Get a new issue ready on a card: a question for the consultant or a problem holding work up, e.g. "ask the consultant the pool level", ' +
      '"the pump room door frame is the wrong size". Name the floor and step it holds up when said. This only shows a card: nothing is raised until they tap Confirm.',
    input_schema: {
      type: 'object',
      properties: {
        project: PROJECT, text: { type: 'string' }, floor: { type: 'string' },
        step: { type: 'string', description: 'The step it holds up, if said.' }, asked: { type: 'string', description: 'Who it was asked, e.g. "Consultant".' },
      },
      required: ['text'],
    },
  },
  close: {
    name: 'close_issue',
    description: 'Managers only: get the closing of an open issue ready on a card, with its answer, e.g. "consultant says pool deck is −3.00". ' +
      'issue: its number (#12) or words from it. This only shows a card: nothing is closed until they tap Confirm.',
    input_schema: { type: 'object', properties: { project: PROJECT, issue: { type: 'string' }, answer: { type: 'string' } }, required: ['issue', 'answer'] },
  },
  check: {
    name: 'log_wall_check',
    description: 'Get the daily wall check of a room ready on a card: the nine blockwork checks, each Pass unless it is in failed. ' +
      'Use when they report walking the walls, e.g. "checked the pump room, all fine" or "generator room: joints not full, no ties". ' +
      'The card lets them tick each check before Confirm; a Fail goes to the managers. Never say it was recorded.',
    input_schema: {
      type: 'object',
      properties: {
        project: PROJECT, floor: { type: 'string' }, area: { type: 'string', description: 'The room, if said.' },
        failed: { type: 'array', items: { type: 'string' }, description: 'The checks that failed, in their words.' },
        note: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD, only for a day other than today.' },
      },
    },
  },
};

export function issueHandlers(user, { agentId, records, decides, opts, shown, ready }) {
  return {
    project_issues: (input) => issuesForChat(user, input, agentId),
    ...(records && {
      log_issue: async (input) => {
        const c = shown(await proposeIssue(user, input, opts));
        return `Card #${c.id}: issue "${c.data.text}"${c.data.step ? ` holding ${c.data.floor} - ${c.data.step}` : ''}.${ready} and tap Confirm.`;
      },
      log_wall_check: async (input) => {
        const c = shown(await proposeInspection(user, input, opts));
        return `Card #${c.id}: wall check${c.data.area ? ` of ${c.data.area}` : ''}, ${c.data.failed.length ? `failing: ${c.data.failed.join('; ')}` : 'every check marked Pass'}.` +
          `${ready}, tick each check that passed, and tap Confirm.`;
      },
    }),
    ...(decides && {
      close_issue: async (input) => {
        const c = shown(await proposeClose(user, input, opts));
        return `Card #${c.id}: close issue #${c.data.issue_id} with "${c.data.answer}".${ready} and tap Confirm. ` +
          'If it held a blocked step, say the step can go on once it is updated.';
      },
    }),
  };
}
