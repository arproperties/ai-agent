import { db, tx } from './db.js';
import { projectRole } from './access.js';
import { sendPush } from './push.js';
import { dubaiDate } from './saifsys/client.js';
import { bad, line, has, canRecord, canDecide, pickProject, saveCard, managersOf } from './projects.js';
import { ensureAreas, areasOf, shortages, shortageLines, areaLine } from './projectAreas.js';
import { ensureIssues } from './projectIssues.js';

// Progress on a project: how far the work is, floor by floor (docs/superpowers/specs/
// 2026-11-02-project-progress-design.md).
//
// Each floor has steps in order, each under one of four stages (Concrete, Blockwork, MEP,
// Finishes). A step has a status and a %, a checklist ticked point by point, who does it,
// the weeks it is planned for, and sometimes a hold point: a check (usually the consultant's)
// that has to be signed off by a manager before the step can be Done.
//
// Like everything else on a project, a change said in chat ("basement blockwork 40%") only
// gets a card ready; the tap on Confirm makes it. Managers shape the steps themselves (add,
// rename, reorder, the checklist, the weeks) on the Projects screen. Nothing is recorded yet
// when a project starts, so every step starts at Not started and the agent says so.

export const STAGES = ['concrete', 'blockwork', 'mep', 'finishes'];
export const STAGE_NAME = { concrete: 'Concrete', blockwork: 'Blockwork', mep: 'MEP', finishes: 'Finishes' };
export const STATUS_NAME = { not_started: 'Not started', in_progress: 'In progress', done: 'Done', blocked: 'Blocked' };
const MAX_POINTS = 30;
const MAX_WEEK = 260;

// The steps every floor starts with: the basement plan made with Francis on 2026-11-02 (the
// "JVC School site tracker"). The weeks are the basement's, so only the first floor in the
// list gets them; the others get theirs from a manager when that floor's concrete is nearly done.
const TEMPLATE = [
  { stage: 'concrete', name: 'Concrete: columns, walls and slab', who: 'Structure contractor', points: [] },
  {
    stage: 'blockwork', name: 'Approvals and setting out', weeks: [1, 1], who: 'Contractor + consultant',
    hold: 'Consultant checks the setting-out before the first course.',
    points: ['Blockwork shop drawing approved', 'Block sample + test certificate approved', 'Walls marked on slab from grid lines', 'First block order placed'],
  },
  {
    stage: 'blockwork', name: 'Blockwork', weeks: [1, 6], who: 'Masonry crew',
    hold: 'First courses and lintels inspected in each room before closing.',
    points: ['Dowels / ties fixed to columns', 'Plant rooms first: pump, garbage, generator', 'Stores, equipment store, lobbies',
      'Changing rooms and bottom-right stores', 'Lintels, tie beams, packing under beams'],
  },
  {
    stage: 'mep', name: 'MEP first fix', weeks: [3, 8], who: 'MEP subcontractors',
    hold: 'Approved combined services drawing before each room starts.',
    points: ['Conduits and back boxes in walls', 'Pipe sleeves through walls', 'Ducts, sprinkler mains, cable trays overhead', 'Fire stopping at wall crossings'],
  },
  {
    stage: 'finishes', name: 'Plaster', weeks: [5, 9], who: 'Plaster crew',
    hold: 'MEP in walls inspected before plaster.',
    points: ['Mesh over block-to-concrete joints', 'Mesh over chases', 'Plaster rooms; parking walls stay fair-face'],
  },
  {
    stage: 'mep', name: 'Above-ceiling inspection', weeks: [8, 8], who: 'Consultant',
    hold: 'No ceiling closes before this sign-off.',
    points: ['All overhead MEP complete', 'Pressure test sprinkler mains', 'Consultant sign-off per room'],
  },
  {
    stage: 'finishes', name: 'Ceilings', weeks: [8, 10], who: 'Ceiling contractor',
    hold: 'Ceiling layout matches the reflected ceiling plan.',
    points: ['Grid in rooms, lobbies, changing rooms', 'Boards closed room by room', 'Access panels at valves and dampers', 'Cut-outs for lights, heads, detectors'],
  },
  {
    stage: 'mep', name: 'MEP final fix', weeks: [10, 11], who: 'All MEP crews together',
    points: ['Light fittings', 'Sprinkler heads', 'Smoke detectors and sounders', 'Diffusers and grilles', 'Jet fans and panels'],
  },
  {
    stage: 'finishes', name: 'Doors, floors and paint', weeks: [9, 12], who: 'Joinery, flooring, painters',
    hold: 'Fire door labels and certificates on site.',
    points: ['Fire-rated doors and closers', 'Floor finish / epoxy after ceilings', 'Ramp anti-skid finish', 'Paint walls and soffits', 'Bay lines, numbers, arrows, signage'],
  },
  {
    stage: 'mep', name: 'Testing and commissioning', weeks: [11, 12], who: 'MEP + consultant',
    hold: 'Signed test reports for every system.',
    points: ['Each system tested as soon as it finishes', 'Fire alarm + sprinkler flow test', 'Smoke extract / jet fan test', 'Generator and pumps commissioned'],
  },
  {
    stage: 'finishes', name: 'Inspections and handover', weeks: [12, 13], who: 'Manager + consultant',
    hold: 'Civil Defence and Trakhees approvals in hand.',
    points: ['Civil Defence inspection', 'Trakhees inspection', 'Snag list closed', 'Handover documents issued'],
  },
];

const dayOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
/** The programme week a day falls in: week 1 is the 7 days from the start day. */
export const weekOf = (start, day = dubaiDate()) => (start ? Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / (7 * 86400_000)) + 1 : null);

// ---------- the steps ----------

/**
 * The first time a project's progress is opened, every floor gets the template, and week 1
 * is today. The seeded flag is the lock, so two people opening it at once seed it once, and a
 * manager who later removes steps does not get them back.
 */
export async function ensureSteps(projectId) {
  if ((await db.prepare('SELECT steps_seeded FROM projects WHERE id = ?').get(projectId))?.steps_seeded) return;
  await tx(async () => {
    const p = await db.prepare(`UPDATE projects SET steps_seeded = true, start_day = coalesce(start_day, ?)
      WHERE id = ? AND NOT steps_seeded RETURNING floors`).get(dubaiDate(), projectId);
    if (!p) return;
    for (const [i, floor] of p.floors.entries()) {
      for (const [pos, t] of TEMPLATE.entries()) {
        const weeks = i === 0 && t.weeks ? t.weeks : [null, null];
        const { id } = await db.prepare(`INSERT INTO project_steps (project_id, floor, stage, position, name, who, hold_point, week_from, week_to)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(projectId, floor, t.stage, pos, t.name, t.who || null, t.hold || null, ...weeks);
        for (const [n, text] of t.points.entries()) {
          await db.prepare('INSERT INTO project_step_points (step_id, position, text) VALUES (?, ?, ?)').run(id, n, text);
        }
      }
    }
  });
}

async function stepsOf(projectId, week) {
  const steps = await db.prepare(`SELECT s.*, u.name AS signed_name FROM project_steps s LEFT JOIN users u ON u.id = s.signed_by
    WHERE s.project_id = ? ORDER BY s.position, s.id`).all(projectId);
  const points = await db.prepare(`SELECT pt.id, pt.step_id, pt.text, pt.done FROM project_step_points pt
    JOIN project_steps s ON s.id = pt.step_id WHERE s.project_id = ? ORDER BY pt.position, pt.id`).all(projectId);
  return steps.map((s) => ({
    id: s.id, floor: s.floor, stage: s.stage, name: s.name, who: s.who, hold_point: s.hold_point,
    week_from: s.week_from, week_to: s.week_to, status: s.status, percent: s.percent, note: s.note,
    signed: s.signed_at ? { by: s.signed_name, note: s.signed_note, at: s.signed_at } : null,
    points: points.filter((p) => p.step_id === s.id).map(({ id, text, done }) => ({ id, text, done })),
    late: !!(s.week_to && week > s.week_to && s.status !== 'done'),
  }));
}

const average = (list) => (list.length ? Math.round(list.reduce((n, s) => n + s.percent, 0) / list.length) : 0);
function stageOf(list) {
  if (!list.length) return null;
  const status = list.every((s) => s.status === 'done') ? 'done'
    : list.some((s) => s.status === 'blocked') ? 'blocked'
      : list.some((s) => s.status !== 'not_started' || s.percent > 0) ? 'in_progress' : 'not_started';
  return { status, percent: average(list) };
}

/** A project's progress for the screen and the chat: floors in order, their stages and steps. */
export async function progressOf(user, projectId) {
  const role = await projectRole(user, projectId);
  if (!role) return null;
  await ensureSteps(Number(projectId));
  await ensureAreas(Number(projectId));
  const p = await db.prepare('SELECT id, name, floors, start_day FROM projects WHERE id = ?').get(Number(projectId));
  const week = weekOf(p.start_day);
  const steps = await stepsOf(p.id, week);
  const areas = await areasOf(p.id);
  // A step on a floor since taken off the project's list still shows, after the listed ones.
  const names = [...p.floors, ...new Set([...steps, ...areas].map((s) => s.floor).filter((f) => !p.floors.includes(f)))];
  return {
    project: { id: p.id, name: p.name }, role, start_day: p.start_day, week,
    weeks: Math.max(0, ...steps.map((s) => s.week_to || 0)) || null,
    floors: names.map((name) => {
      const list = steps.filter((s) => s.floor === name);
      return {
        name, percent: average(list), stages: Object.fromEntries(STAGES.map((k) => [k, stageOf(list.filter((s) => s.stage === k))])), steps: list,
        areas: areas.filter((a) => a.floor === name).map((a) => ({ ...a, late: !!(a.week_to && week > a.week_to && a.percent < 100) })),
      };
    }),
  };
}

/** Every confirmed change to a step, newest first. */
export async function stepHistory(user, stepId) {
  const s = await db.prepare('SELECT project_id FROM project_steps WHERE id = ?').get(Number(stepId) || 0);
  if (!s || !(await projectRole(user, s.project_id))) return null;
  return db.prepare(`SELECT h.id, h.what, h.at, u.name AS by_name FROM project_step_updates h LEFT JOIN users u ON u.id = h.by_user
    WHERE h.step_id = ? ORDER BY h.id DESC LIMIT 200`).all(Number(stepId));
}

const history = (stepId, what, by, proposalId = null) => db.prepare('INSERT INTO project_step_updates (step_id, proposal_id, what, by_user) VALUES (?, ?, ?, ?)')
  .run(stepId, proposalId, line(what, 600), by);

// ---------- a manager shapes the steps (the screen) ----------

async function managerOf(user, projectId) {
  const role = await projectRole(user, projectId);
  if (!role) return null;
  if (!canDecide(role)) throw bad('Only a manager on this project can change its steps.', 403);
  return role;
}

const weekNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  if (!(n >= 1 && n <= MAX_WEEK)) throw bad(`A week is a number from 1 to ${MAX_WEEK}.`);
  return n;
};

/** Week 1 of the programme. Every step's planned weeks move with it. */
export async function setStartDay(user, projectId, { start_day: day } = {}) {
  if (!(await managerOf(user, projectId))) return null;
  const d = line(day, 10);
  if (!dayOk(d)) throw bad('Give the start day as a date.');
  await db.prepare('UPDATE projects SET start_day = ? WHERE id = ?').run(d, Number(projectId));
  return progressOf(user, projectId);
}

/** Add a step (stepId null) or change one: name, stage, who, hold point, weeks and its checklist. */
export async function saveStep(user, projectId, stepId, body = {}) {
  let pid = Number(projectId) || 0;
  let was = null;
  if (stepId) {
    was = await db.prepare('SELECT * FROM project_steps WHERE id = ?').get(Number(stepId) || 0);
    if (!was) return null;
    pid = was.project_id;
  }
  if (!(await managerOf(user, pid))) return null;
  const name = line(body.name, 120);
  if (!name) throw bad('Give the step a name.');
  const stage = STAGES.includes(body.stage) ? body.stage : was?.stage;
  if (!stage) throw bad('Pick its stage: Concrete, Blockwork, MEP or Finishes.');
  const floor = line(body.floor, 40) || was?.floor;
  if (!floor) throw bad('Say which floor.');
  const from = weekNum(body.week_from);
  const to = weekNum(body.week_to);
  if (from && to && to < from) throw bad('The last week cannot be before the first.');
  const hold = line(body.hold_point, 300) || null;
  const points = [...new Set((Array.isArray(body.points) ? body.points : []).map((t) => line(t, 200)).filter(Boolean))].slice(0, MAX_POINTS);
  await tx(async () => {
    let id = was?.id;
    if (was) {
      // A hold point taken off, or changed, needs signing again.
      const resign = hold !== was.hold_point;
      await db.prepare(`UPDATE project_steps SET name = ?, stage = ?, floor = ?, who = ?, hold_point = ?, week_from = ?, week_to = ?,
        updated_by = ?, updated_at = extract(epoch from now())::bigint${resign ? ', signed_by = NULL, signed_note = NULL, signed_at = NULL' : ''} WHERE id = ?`)
        .run(name, stage, floor, line(body.who, 120) || null, hold, from, to, user.id, id);
      await history(id, `Step changed: ${name}${resign && was.signed_at ? ' (hold point changed: its sign-off was cleared)' : ''}`, user.id);
    } else {
      const last = await db.prepare('SELECT coalesce(max(position), -1) AS n FROM project_steps WHERE project_id = ? AND floor = ?').get(pid, floor);
      id = (await db.prepare(`INSERT INTO project_steps (project_id, floor, stage, position, name, who, hold_point, week_from, week_to, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, extract(epoch from now())::bigint) RETURNING id`)
        .run(pid, floor, stage, last.n + 1, name, line(body.who, 120) || null, hold, from, to, user.id)).id;
      await history(id, `Step added: ${name}`, user.id);
    }
    // The checklist as written now; a point kept word for word keeps its tick.
    const old = await db.prepare('SELECT * FROM project_step_points WHERE step_id = ?').all(id);
    await db.prepare('DELETE FROM project_step_points WHERE step_id = ?').run(id);
    for (const [n, text] of points.entries()) {
      const kept = old.find((o) => o.text.toLowerCase() === text.toLowerCase());
      await db.prepare('INSERT INTO project_step_points (step_id, position, text, done, done_by, done_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, n, text, !!kept?.done, kept?.done_by ?? null, kept?.done_at ?? null);
    }
  });
  // Read after the transaction, never inside it: progressOf may start one of its own.
  return progressOf(user, pid);
}

export async function deleteStep(user, stepId) {
  const s = await db.prepare('SELECT project_id FROM project_steps WHERE id = ?').get(Number(stepId) || 0);
  if (!s || !(await managerOf(user, s.project_id))) return null;
  await db.prepare('DELETE FROM project_steps WHERE id = ?').run(Number(stepId));
  return progressOf(user, s.project_id);
}

/** Up (-1) or down (+1) one place among the steps of its floor. */
export async function moveStep(user, stepId, { dir } = {}) {
  const s = await db.prepare('SELECT project_id, floor FROM project_steps WHERE id = ?').get(Number(stepId) || 0);
  if (!s || !(await managerOf(user, s.project_id))) return null;
  await tx(async () => {
    const ids = (await db.prepare('SELECT id FROM project_steps WHERE project_id = ? AND floor = ? ORDER BY position, id').all(s.project_id, s.floor)).map((r) => r.id);
    const at = ids.indexOf(Number(stepId));
    const to = at + (Number(dir) < 0 ? -1 : 1);
    if (to >= 0 && to < ids.length) [ids[at], ids[to]] = [ids[to], ids[at]];
    for (const [n, id] of ids.entries()) await db.prepare('UPDATE project_steps SET position = ? WHERE id = ?').run(n, id);
  });
  return progressOf(user, s.project_id);
}

// ---------- cards from chat ----------

async function findStep(p, floorSaid, stepSaid) {
  const floorText = line(floorSaid, 40).toLowerCase();
  const want = line(stepSaid, 120);
  if (!floorText) throw bad(`Say which floor. ${p.name} has: ${p.floors.join(', ')}.`);
  if (!want) throw bad('Say which step.');
  const all = await db.prepare('SELECT id, floor, name FROM project_steps WHERE project_id = ? ORDER BY position, id').all(p.id);
  const onFloor = all.filter((s) => s.floor.toLowerCase() === floorText);
  if (!onFloor.length) throw bad(`No steps on a floor called "${floorSaid}". Floors: ${[...new Set(all.map((s) => s.floor))].join(', ')}.`);
  const exact = onFloor.filter((s) => s.name.toLowerCase() === want.toLowerCase());
  const hits = exact.length ? exact : onFloor.filter((s) => has(s.name, want));
  if (hits.length !== 1) {
    throw bad(`${hits.length ? `"${want}" could be more than one step` : `No step called "${want}"`} on ${onFloor[0].floor}. ` +
      `Its steps: ${(hits.length ? hits : onFloor).map((s) => s.name).join('; ')}. Ask which one if it is not clear.`);
  }
  const [step] = (await stepsOf(p.id, weekOf(p.start_day))).filter((s) => s.id === hits[0].id);
  return step;
}

const notSigned = (s) => `"${s.name}" on ${s.floor} has a hold point that a manager has not signed off yet (${s.hold_point}). ` +
  'It can be In progress until then; a manager signs it off first (sign_off), then it can be Done.';

/** A change to a step, ready on a card: status, %, a note, points ticked. */
export async function proposeProgress(user, input, { conversationId = null, agentId = null } = {}) {
  const p = await pickProject(user, input.project, agentId);
  if (!canRecord(p.role)) throw bad(`This user is not the store keeper or a manager on ${p.name}, so they cannot record for it.`);
  await ensureSteps(p.id);
  const s = await findStep(p, input.floor, input.step);
  const said = STATUS_NAME[input.status] ? input.status : null;
  const pct = input.percent === undefined || input.percent === null || input.percent === '' ? null : Math.round(Number(input.percent));
  if (pct !== null && !(pct >= 0 && pct <= 100)) throw bad('A % is from 0 to 100.');
  const note = line(input.note, 400) || null;
  const wanted = (Array.isArray(input.points) ? input.points : []).map((t) => line(t, 200)).filter(Boolean);
  if (!said && pct === null && !note && !wanted.length) throw bad('Say what changed: a status, a %, a note or the points done.');

  const status = said || (pct === 100 ? 'done' : pct !== null && pct > 0 ? 'in_progress' : s.status === 'not_started' ? 'in_progress' : s.status);
  const percent = status === 'done' ? 100 : status === 'not_started' ? 0 : pct ?? s.percent;
  if (status === 'blocked' && !note) throw bad('Say why it is blocked, in the note: the managers get it.');
  if (status === 'done' && s.hold_point && !s.signed) throw bad(notSigned(s));

  const points = [];
  for (const w of wanted) {
    const open = s.points.filter((x) => !x.done);
    const hit = open.find((x) => x.text.toLowerCase() === w.toLowerCase()) || (open.filter((x) => has(x.text, w)).length === 1 && open.find((x) => has(x.text, w)));
    if (!hit) {
      throw bad(`No open point "${w}" in "${s.name}". Its open points: ${open.map((x) => x.text).join('; ') || 'none, every point is ticked'}.`);
    }
    if (!points.some((x) => x.id === hit.id)) points.push({ id: hit.id, text: hit.text });
  }
  // Done means the whole step is done: its open points are ticked with it (Francis, 2026-11-03).
  if (status === 'done') for (const x of s.points) if (!x.done && !points.some((y) => y.id === x.id)) points.push({ id: x.id, text: x.text });
  return saveCard(user, p, 'progress', {
    step_id: s.id, floor: s.floor, step: s.name, stage: s.stage, status, percent, note, points,
    was: { status: s.status, percent: s.percent },
  }, conversationId);
}

/** A manager signing a hold point, ready on a card. */
export async function proposeSignoff(user, input, { conversationId = null, agentId = null } = {}) {
  const p = await pickProject(user, input.project, agentId);
  if (!canDecide(p.role)) throw bad(`Only a manager on ${p.name} signs off hold points. Tell the user to ask one.`);
  await ensureSteps(p.id);
  const s = await findStep(p, input.floor, input.step);
  if (!s.hold_point) throw bad(`"${s.name}" on ${s.floor} has no hold point to sign.`);
  if (s.signed) throw bad(`The hold point of "${s.name}" on ${s.floor} was already signed off${s.signed.by ? ` by ${s.signed.by}` : ''}.`);
  return saveCard(user, p, 'signoff', {
    step_id: s.id, floor: s.floor, step: s.name, hold_point: s.hold_point,
    signer: line(input.signed_by, 80) || null, note: line(input.note, 400) || null,
  }, conversationId);
}

/**
 * The tap on Confirm for a progress or sign-off card: called by confirmCard inside its
 * transaction, after the card's own status has moved, so a double tap does this once.
 */
export async function applyStepCard(user, card) {
  const d = card.data;
  const s = await db.prepare('SELECT * FROM project_steps WHERE id = ? AND project_id = ?').get(d.step_id, card.project_id);
  if (!s) throw bad('That step was removed from the project.', 409);
  if (card.kind === 'signoff') {
    if (!canDecide(await projectRole(user, card.project_id))) throw bad('Only a manager on this project signs off hold points.', 403);
    if (s.signed_at) throw bad('This hold point was already signed off.', 409);
    const said = [d.signer && `Signed by ${d.signer}`, d.note].filter(Boolean).join(' · ') || null;
    await db.prepare('UPDATE project_steps SET signed_by = ?, signed_note = ?, signed_at = extract(epoch from now())::bigint WHERE id = ?').run(user.id, said, s.id);
    await history(s.id, `Hold point signed off${said ? `: ${said}` : ''}`, user.id, card.id);
    return;
  }
  // Checked again at the tap: the sign-off may have been cleared since the card was made.
  if (d.status === 'done' && s.hold_point && !s.signed_at) throw bad('The hold point is not signed off yet: a manager signs it first.', 409);
  await db.prepare(`UPDATE project_steps SET status = ?, percent = ?, note = ?, updated_by = ?, updated_at = extract(epoch from now())::bigint WHERE id = ?`)
    .run(d.status, d.percent, d.note, user.id, s.id);
  for (const pt of d.points) {
    await db.prepare(`UPDATE project_step_points SET done = true, done_by = ?, done_at = extract(epoch from now())::bigint
      WHERE id = ? AND step_id = ? AND NOT done`).run(user.id, pt.id, s.id);
  }
  // A point a manager added after the card was made is done too, when the step is.
  if (d.status === 'done') {
    await db.prepare(`UPDATE project_step_points SET done = true, done_by = ?, done_at = extract(epoch from now())::bigint
      WHERE step_id = ? AND NOT done`).run(user.id, s.id);
  }
  await history(s.id, [
    `${STATUS_NAME[d.status]}${d.status === 'in_progress' ? ` ${d.percent}%` : ''}`, d.note,
    d.points.length && `ticked: ${d.points.map((x) => x.text).join(', ')}`,
  ].filter(Boolean).join(' · '), user.id, card.id);
}

/** After a blocked step is confirmed: the managers hear why. */
export async function pushBlocked(card, by, push = sendPush) {
  const ids = (await managersOf(card.project_id)).filter((id) => id !== by.id);
  if (!ids.length) return;
  await push(ids, {
    title: `${card.project}: ${card.data.floor} blocked`,
    body: `${card.data.step}: ${card.data.note}`, url: '/', tag: `project-step-${card.data.step_id}`,
  }).catch(() => {});
}

// ---------- Reem in chat ----------

const stepLine = (s, n) => [
  `  ${n}. [${STAGE_NAME[s.stage]}] ${s.name}: ${STATUS_NAME[s.status]}${s.status === 'in_progress' ? ` ${s.percent}%` : ''}${s.late ? ' - LATE' : ''}`,
  s.week_from ? `planned wk ${s.week_from}${s.week_to !== s.week_from ? `-${s.week_to}` : ''}` : null,
  s.points.length ? `points ${s.points.filter((x) => x.done).length}/${s.points.length}` +
    (s.points.some((x) => !x.done) ? ` (open: ${s.points.filter((x) => !x.done).map((x) => x.text).join('; ')})` : '') : null,
  s.hold_point ? `hold point: ${s.hold_point} - ${s.signed ? `signed off${s.signed.note ? ` (${s.signed.note})` : ''}` : 'NOT signed off'}` : null,
  s.note && `note: ${s.note}`, s.who && `who: ${s.who}`,
].filter(Boolean).join('; ');

async function progressForChat(user, input, agentId) {
  const p = await pickProject(user, input.project, agentId);
  const pr = await progressOf(user, p.id);
  const floorSaid = line(input.floor, 40).toLowerCase();
  const floors = floorSaid ? pr.floors.filter((f) => f.name.toLowerCase() === floorSaid) : pr.floors;
  if (floorSaid && !floors.length) throw bad(`No floor called "${input.floor}". Floors: ${pr.floors.map((f) => f.name).join(', ')}.`);
  // Without a floor named, the detail is for the first floor not finished: where the work is.
  const detail = floorSaid ? floors : [pr.floors.find((f) => f.percent < 100) || pr.floors[pr.floors.length - 1]].filter(Boolean);
  const updates = await db.prepare(`SELECT h.what, h.at, s.floor, s.name, u.name AS by_name FROM project_step_updates h
    JOIN project_steps s ON s.id = h.step_id LEFT JOIN users u ON u.id = h.by_user
    WHERE s.project_id = ? AND h.proposal_id IS NOT NULL ORDER BY h.id DESC LIMIT 12`).all(p.id);
  const out = [
    `Project: ${pr.project.name}. Today: ${dubaiDate()}. Programme week ${pr.week}${pr.weeks ? ` of ${pr.weeks}` : ''} (week 1 began ${pr.start_day}).`,
    updates.length ? 'Progress is what was confirmed in Reem; a step never updated may simply not have been reported - say "not recorded in Reem", do not guess.'
      : 'No progress has been confirmed in Reem yet: every step is at its start. Say so plainly; do not guess from files.',
    '',
    'Floors:',
    ...pr.floors.map((f) => `  ${f.name}: ${f.percent}% - ${STAGES.filter((k) => f.stages[k]).map((k) => `${STAGE_NAME[k]} ${STATUS_NAME[f.stages[k].status].toLowerCase()} ${f.stages[k].percent}%`).join(', ')}`),
  ];
  for (const f of detail) {
    const next = f.steps.find((s) => s.status !== 'done');
    out.push('', `${f.name}, step by step:`, ...f.steps.map((s, i) => stepLine(s, i + 1)),
      `Next on ${f.name}: ${next ? `${next.name}${next.status === 'blocked' ? ' (BLOCKED)' : ''}` : 'every step is done'}.`);
    if (f.areas.length) out.push(`${f.name} areas (rooms) and their take-off:`, ...f.areas.map(areaLine));
  }
  const short = shortageLines(await shortages(p.id, pr.week), pr.week);
  if (short.length) out.push('', ...short);
  await ensureIssues(p.id);
  const open = await db.prepare(`SELECT i.id, i.text, i.floor, s.name AS step FROM project_issues i LEFT JOIN project_steps s ON s.id = i.step_id
    WHERE i.project_id = ? AND i.status = 'open' ORDER BY i.id`).all(p.id);
  if (open.length) out.push('', `Open issues (${open.length}; project_issues has the detail):`, ...open.map((i) => `  #${i.id}${i.step ? ` [${i.floor} - ${i.step}]` : ''} ${i.text}`));
  const blocked = pr.floors.flatMap((f) => f.steps.filter((s) => s.status === 'blocked'));
  const late = pr.floors.flatMap((f) => f.steps.filter((s) => s.late));
  if (blocked.length) out.push('', 'Blocked:', ...blocked.map((s) => `  ${s.floor} - ${s.name}: ${s.note}`));
  if (late.length) out.push('', `Late (planned end week passed, not done):`, ...late.map((s) => `  ${s.floor} - ${s.name} (planned to end wk ${s.week_to})`));
  if (updates.length) {
    out.push('', 'Latest confirmed updates:', ...updates.map((u) => `  ${dubaiDate(Number(u.at) * 1000)} ${u.floor} - ${u.name}: ${u.what}${u.by_name ? ` (${u.by_name})` : ''}`));
  }
  return out.join('\n');
}

const PROJECT = { type: 'string', description: 'The project name, or part of it. Leave out unless the user names one: the chat\'s own project is used.' };

export const PROGRESS_DEFS = {
  progress: {
    name: 'project_progress',
    description: 'How far the work on a building project is, as confirmed in Reem: each floor\'s % and stages (Concrete, Blockwork, MEP, Finishes), ' +
      'the steps of the floor being worked on (or the one asked about) with their status, %, open checklist points, hold points and whether signed, ' +
      'what is next, what is blocked and why, what is late against the planned weeks, and the latest updates. ' +
      'Use for "what\'s next?", "how far is the basement?", "what is late?", "what is blocked?". Answer only from what it returns. ' +
      'Also call it to see the exact step names before log_progress or sign_off.',
    input_schema: { type: 'object', properties: { project: PROJECT, floor: { type: 'string', description: 'A floor to see step by step, e.g. "Basement".' } } },
  },
  log: {
    name: 'log_progress',
    description: 'Get a change to one step of the work ready on a card: "basement blockwork 40%, north side done", "pump room walls done", ' +
      '"MEP first fix started in basement", "plaster blocked: waiting for MEP inspection". One step per call. ' +
      'Status: in_progress (with a %), done, blocked (the reason goes in note; managers get a push), or not_started. ' +
      'points: checklist points of that step now done, in their words or the exact point text. ' +
      'Done ticks every open point of the step. A step with a hold point cannot be Done until a manager signs the hold point off. ' +
      'This only shows a card: nothing changes until they tap Confirm. Never say it was recorded.',
    input_schema: {
      type: 'object',
      properties: {
        project: PROJECT,
        floor: { type: 'string', description: 'The floor, as the project names it: "Basement", "Ground"…' },
        step: { type: 'string', description: 'The step name or a clear part of it, e.g. "Blockwork", "MEP first fix", "Plaster".' },
        status: { type: 'string', enum: ['not_started', 'in_progress', 'done', 'blocked'] },
        percent: { type: 'integer', description: '0-100, only when the user says one.' },
        note: { type: 'string', description: 'What was said about it; for blocked, why.' },
        points: { type: 'array', items: { type: 'string' }, description: 'Checklist points of this step that are now done.' },
      },
      required: ['floor', 'step'],
    },
  },
  signoff: {
    name: 'sign_off',
    description: 'Managers only: get the sign-off of a step\'s hold point ready on a card, e.g. "the consultant checked the setting-out in the basement". ' +
      'Ask who signed it (e.g. the consultant\'s name) if not said. This only shows a card: nothing is signed until they tap Confirm. Never say it was signed.',
    input_schema: {
      type: 'object',
      properties: {
        project: PROJECT,
        floor: { type: 'string' },
        step: { type: 'string' },
        signed_by: { type: 'string', description: 'Who checked it, e.g. "Eng. Bayat (consultant)".' },
        note: { type: 'string' },
      },
      required: ['floor', 'step'],
    },
  },
};

/** The progress tools for projectKit: reading for anyone on a project, cards for those who record or decide. */
export function progressHandlers(user, { agentId, records, decides, opts, shown, ready }) {
  return {
    project_progress: (input) => progressForChat(user, input, agentId),
    ...(records && {
      log_progress: async (input) => {
        const c = shown(await proposeProgress(user, input, opts));
        const d = c.data;
        return `Card #${c.id}: ${d.floor} - ${d.step} → ${STATUS_NAME[d.status]}${d.status === 'in_progress' ? ` ${d.percent}%` : ''}` +
          `${d.points.length ? `; ticks ${d.points.map((x) => x.text).join(', ')}` : ''}.${ready} and tap Confirm.`;
      },
    }),
    ...(decides && {
      sign_off: async (input) => {
        const c = shown(await proposeSignoff(user, input, opts));
        return `Card #${c.id}: sign off the hold point of ${c.data.floor} - ${c.data.step} (${c.data.hold_point}).${ready} and tap Confirm.`;
      },
    }),
  };
}
