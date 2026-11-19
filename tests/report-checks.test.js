import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, db, closeDb } from './helpers/db.js';
import {
  ensureSeeds, listTypes, createType, updateType, draftItems, matchReports, checkReport, watchFiles, watchAlerts,
  reportDays, setNote, isLate, addDays, backfill,
} from '../server/reportChecks.js';

test.after(() => closeDb());

// Dubai wall-clock in milliseconds.
const at = (iso) => Date.parse(`${iso}+04:00`);
const secs = (iso) => Math.round(at(iso) / 1000);

async function master() {
  const id = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(id);
  return id;
}

async function file(userId, { title, text, created, date = null, kind = null }) {
  const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, summary, status, doc_date, kind, created_at)
    VALUES (?, ?, ?, ?, 'ready', ?, ?, ?) RETURNING id`).run(userId, `${title}.pdf`, title, title, date, kind, secs(created));
  if (text) await db.prepare('INSERT INTO document_texts (document_id, text) VALUES (?, ?)').run(id, text);
  return id;
}

const school = () => createType({
  name: 'School daily', writer: 'Engr. Tajdar Khan', about: 'Daily site progress report',
  items: ['Running total to date', 'Waste %', 'Materials used, each with its quantity'],
}, at('2026-11-16T09:00:00'));

// A fake model: the sorting call gets `matches`, the check call gets `check`.
function fakeAsker({ matches = [], check = {} } = {}) {
  const calls = [];
  const asker = async (prompt, opts) => {
    calls.push({ prompt, opts });
    if (/Report types:/.test(prompt)) return JSON.stringify({ matches });
    return JSON.stringify(typeof check === 'function' ? check(prompt) : check);
  };
  return { asker, calls };
}

const pushes = () => {
  const sent = [];
  const pusher = async (to, msg) => { sent.push({ to, ...msg }); return 1; };
  return { sent, pusher };
};

test('days: a report is late after its due hour the next day, in Dubai', () => {
  const t = { due_hour: 12 };
  assert.equal(isLate(t, '2026-11-17', at('2026-11-18T11:59:00')), false);
  assert.equal(isLate(t, '2026-11-17', at('2026-11-18T12:00:00')), true);
  assert.equal(isLate(t, '2026-11-17', at('2026-11-17T23:00:00')), false);
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
});

test('the school report type is made once, and not again after it is deleted', async () => {
  await reset();
  await ensureSeeds(at('2026-11-19T10:00:00'));
  await ensureSeeds(at('2026-11-19T10:05:00'));
  let types = await listTypes();
  assert.equal(types.length, 1);
  assert.equal(types[0].seed, 'school');
  assert.equal(types[0].starts_on, '2026-11-19', 'late reports count from the day it was made');
  assert.ok(types[0].items.some((i) => /Waste %/.test(i)));
  await db.prepare('DELETE FROM report_types').run();
  await ensureSeeds();
  types = await listTypes();
  assert.equal(types.length, 0);
});

test('a type needs a name, what it is, and at least one item', async () => {
  await reset();
  await assert.rejects(createType({ name: '', about: 'x', items: ['a'] }), /name/);
  await assert.rejects(createType({ name: 'x', about: '', items: ['a'] }), /what the report is/);
  await assert.rejects(createType({ name: 'x', about: 'y', items: ['  '] }), /at least one/);
  const t = await createType({ name: 'AC', about: 'AC cleaning', items: ['Units', 'Units', 'Photos'], work_days: '9135x1' });
  assert.deepEqual(t.items, ['Units', 'Photos'], 'repeats are dropped');
  assert.equal(t.work_days, '135');
  const u = await updateType(t.id, { due_hour: 18 });
  assert.equal(u.due_hour, 18);
  assert.deepEqual(u.items, ['Units', 'Photos'], 'what was not sent is kept');
  await assert.rejects(updateType(t.id, { due_hour: 25 }), /0 to 23/);
});

test('Reem writes a first list from the name', async () => {
  const items = await draftItems({ name: 'Cleaning', about: 'daily' }, async () => '{"items": ["Location", " ", "Chemicals used"]}');
  assert.deepEqual(items, ['Location', 'Chemicals used']);
  await assert.rejects(draftItems({ name: 'x' }, async () => 'no'), /could not write the list/);
});

test('sorting keeps only real files and types, each file once', async () => {
  const docs = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
  const types = [{ id: 7, name: 'School', about: '' }];
  const { asker } = fakeAsker({ matches: [{ file: 1, type: 7 }, { file: 1, type: 7 }, { file: 9, type: 7 }, { file: 2, type: 3 }] });
  const m = await matchReports(docs, types, asker);
  assert.deepEqual(m.map((x) => [x.doc.id, x.type.id]), [[1, 7]]);
});

test('a report with gaps waits for the master with a note, and the master is buzzed', async () => {
  await reset();
  const boss = await master();
  const francisca = await makeUser('Francisca');
  const type = await school();
  const doc = await file(francisca, { title: 'Daily progress 17 Nov', text: 'Primer 183 m2. Materials: primer.', created: '2026-11-18T09:00:00', date: '2026-11-17' });
  const { asker, calls } = fakeAsker({
    check: {
      is_report: true, report_date: '2026-11-17', summary: 'Primer on the ceiling',
      gaps: [{ item: 'running total to date', missing: 'no total to date' }, { item: 'Waste %', missing: 'no waste %' }],
      facts: { work: [{ what: 'Primer', qty: 183, unit: 'm²' }] }, note: 'Salam Tajdar, please add…',
    },
  });
  const { sent, pusher } = pushes();
  const docRow = await db.prepare('SELECT * FROM documents WHERE id = ?').get(doc);
  const c = await checkReport(type, docRow, { asker, pusher });

  assert.equal(c.report_date, '2026-11-17');
  assert.equal(c.note_state, 'waiting');
  assert.equal(c.gaps[0].item, 'Running total to date', 'the item is written as on the list');
  assert.equal(c.facts.work[0].qty, 183);
  assert.match(calls[0].prompt, /1\. Running total to date/);
  assert.match(calls[0].prompt, /Primer 183 m2/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, [boss], 'only the master');
  assert.match(sent[0].body, /2 missing: no total to date; no waste %/);
  assert.equal(sent[0].url, `/?reportchecks=${c.id}`);

  const after = await setNote(c.id, { state: 'sent', note: 'Salam Tajdar, edited' });
  assert.equal(after.note_state, 'sent');
  assert.equal(after.note, 'Salam Tajdar, edited');
  await assert.rejects(setNote(c.id, { state: 'eaten' }), /sent, dismissed or waiting/);
});

test('the same gap three reports in a row says so, and a complete new copy clears the note', async () => {
  await reset();
  await master();
  const u = await makeUser('Francisca');
  const type = await school();
  const gap = { item: 'Waste %', missing: 'no waste %' };
  const { sent, pusher } = pushes();
  for (const d of ['2026-11-16', '2026-11-17', '2026-11-18']) {
    const id = await file(u, { title: `Report ${d}`, text: 'x', created: `${d}T18:00:00`, date: d });
    const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    await checkReport(type, row, { asker: fakeAsker({ check: { report_date: d, gaps: [gap], note: 'n' } }).asker, pusher });
  }
  assert.match(sent[2].body, /^3 reports in a row without: Waste %/);
  assert.doesNotMatch(sent[1].body, /in a row/, 'twice is not yet a pattern');

  // Khan sends the 18th again, complete.
  const id = await file(u, { title: 'Report 18 again', text: 'x', created: '2026-11-18T20:00:00', date: '2026-11-18' });
  const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  await checkReport(type, row, { asker: fakeAsker({ check: { report_date: '2026-11-18', gaps: [], note: 'ignored' } }).asker, pusher });
  assert.match(sent[3].body, /complete/);
  const states = await db.prepare("SELECT note_state, note FROM report_checks WHERE report_date = '2026-11-18' ORDER BY id").all();
  assert.deepEqual(states.map((s) => s.note_state), ['replaced', 'none']);
  assert.equal(states[1].note, '', 'no note when nothing is missing');

  const { days } = await reportDays(type.id, { now: at('2026-11-19T10:00:00') });
  const d18 = days.find((d) => d.date === '2026-11-18');
  assert.equal(d18.check.gaps.length, 0, 'the newest copy is the day’s report');
  assert.equal(d18.earlier.length, 1);
});

test('a file that is not such a report is left alone', async () => {
  await reset();
  const u = await makeUser('U');
  const type = await school();
  const id = await file(u, { title: 'MRF 017', text: 'requisition', created: '2026-11-18T09:00:00' });
  const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  const c = await checkReport(type, row, { asker: fakeAsker({ check: { is_report: false } }).asker, pusher: async () => 0 });
  assert.equal(c, null);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM report_checks').get()).n, 0);
});

test('the watch reads each new file once, skips facts, old files and external people', async () => {
  await reset();
  await master();
  const u = await makeUser('Francisca');
  const outsider = await makeUser('Outsider');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(outsider);
  const type = await school();
  const now = at('2026-11-18T12:00:00');
  const report = await file(u, { title: 'Daily progress', text: 'work', created: '2026-11-18T09:00:00', date: '2026-11-17' });
  await file(u, { title: 'A fact', text: 'x', created: '2026-11-18T09:00:00', kind: 'fact' });
  await file(u, { title: 'Before the type existed', text: 'x', created: '2026-11-15T09:00:00' });
  await file(u, { title: 'No text yet', created: '2026-11-18T09:00:00' });
  await file(outsider, { title: 'Theirs', text: 'x', created: '2026-11-18T09:00:00' });

  const { asker, calls } = fakeAsker({ matches: [{ file: report, type: type.id }], check: { report_date: '2026-11-17', gaps: [] } });
  const done = await watchFiles({ now, asker, pusher: async () => 0 });
  assert.equal(done.length, 1);
  const sorted = calls[0].prompt;
  assert.match(sorted, /Daily progress/);
  assert.doesNotMatch(sorted, /A fact|Before the type|No text yet|Theirs/);

  calls.length = 0;
  assert.deepEqual(await watchFiles({ now, asker, pusher: async () => 0 }), []);
  assert.equal(calls.length, 0, 'nothing new, so no AI call at all');
});

test('a late report buzzes once, from the day the type began, on work days only', async () => {
  await reset();
  const boss = await master();
  const type = await school(); // starts 2026-11-16 (a Monday); work days Mon–Sat
  const { sent, pusher } = pushes();

  // Wed 18th, 10:00: Mon 16th is late, Tue 17th is not due until noon.
  await watchAlerts({ now: at('2026-11-18T10:00:00'), pusher });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, [boss]);
  assert.match(sent[0].body, /No report yet for Mon 16 Nov\./);
  assert.match(sent[0].body, /Tajdar Khan/);

  await watchAlerts({ now: at('2026-11-18T10:05:00'), pusher });
  assert.equal(sent.length, 1, 'not again');
  await watchAlerts({ now: at('2026-11-18T12:00:00'), pusher });
  assert.match(sent[1].body, /Tue 17 Nov/);
  assert.doesNotMatch(sent[1].body, /Mon 16/);

  // Sunday the 22nd is not a work day: Mon 23rd 12:00 has nothing new for it.
  await watchAlerts({ now: at('2026-11-23T12:00:00'), pusher });
  const last = sent.at(-1).body;
  assert.doesNotMatch(last, /Sun 22/);

  const { days } = await reportDays(type.id, { now: at('2026-11-18T13:00:00') });
  assert.deepEqual(days.map((d) => [d.date, !!d.missing, !!d.late]), [['2026-11-17', true, true], ['2026-11-16', true, true]]);
});

test('the 19:00 summary goes once, and only when there is something to say', async () => {
  await reset();
  await master();
  const u = await makeUser('Francisca');
  const type = await createType({ name: 'School daily', about: 'Daily site progress report', items: ['Waste %'] }, at('2026-11-16T09:00:00'));
  await db.prepare("UPDATE report_types SET starts_on = '2026-11-17'").run(); // so the 16th is not missing
  const { sent, pusher } = pushes();
  // Monday evening and nothing checked, nothing due yet.
  await watchAlerts({ now: at('2026-11-16T19:30:00'), pusher });
  assert.equal(sent.length, 0);

  const id = await file(u, { title: 'r', text: 'x', created: '2026-11-17T18:00:00', date: '2026-11-17' });
  const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  await checkReport(type, row, { asker: fakeAsker({ check: { report_date: '2026-11-17', gaps: [{ item: 'Waste %', missing: 'none' }], note: 'n' } }).asker, pusher: async () => 0 });
  await db.prepare('UPDATE report_checks SET checked_at = ?').run(secs('2026-11-17T18:00:00'));

  await watchAlerts({ now: at('2026-11-17T18:59:00'), pusher });
  assert.equal(sent.length, 0, 'not before 19:00');
  await watchAlerts({ now: at('2026-11-17T19:10:00'), pusher });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Reports today');
  assert.match(sent[0].body, /School daily: 1 checked, 1 note to send/);
  await watchAlerts({ now: at('2026-11-17T20:00:00'), pusher });
  assert.equal(sent.length, 1, 'once a day');
});

test('going through the past checks quietly and only this type', async () => {
  await reset();
  await master();
  const u = await makeUser('Francisca');
  const type = await school();
  const now = at('2026-11-19T10:00:00');
  const old = await file(u, { title: 'Report 10 Nov', text: 'x', created: '2026-11-10T18:00:00', date: '2026-11-10' });
  await file(u, { title: 'Invoice', text: 'x', created: '2026-11-11T18:00:00' });
  await file(u, { title: 'Too old', text: 'x', created: '2026-09-01T18:00:00' });
  const { asker, calls } = fakeAsker({ matches: [{ file: old, type: type.id }], check: { report_date: '2026-11-10', gaps: [{ item: 'Waste %', missing: 'x' }], note: 'n' } });
  const state = await backfill(type.id, { days: 30, asker, now });
  assert.deepEqual([state.state, state.files, state.found, state.checked], ['done', 2, 1, 1]);
  assert.doesNotMatch(calls[0].prompt, /Too old/);
  const saved = (await listTypes())[0].backfill;
  assert.equal(saved.state, 'done');
});
