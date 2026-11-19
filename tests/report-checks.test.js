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
  const plain = await createType({ name: 'Cleaning', writer: 'Faisal', about: '', items: ['Photos — before and after', 'Chemicals'] });
  assert.match(plain.about, /^Cleaning, written by Faisal\. A report like this covers: Photos, Chemicals\./, 'left empty, Reem says what it is');
  await assert.rejects(createType({ name: 'x', about: 'y', items: ['  '] }), /at least one/);
  const t = await createType({ name: 'AC', about: 'AC cleaning', items: ['Units', 'Units', 'Photos'], work_days: '9135x1' });
  assert.deepEqual(t.items, ['Units', 'Photos'], 'repeats are dropped');
  assert.equal(t.work_days, '135');
  const u = await updateType(t.id, { due_hour: 18 });
  assert.equal(u.due_hour, 18);
  assert.deepEqual(u.items, ['Units', 'Photos'], 'what was not sent is kept');
  await assert.rejects(updateType(t.id, { due_hour: 25 }), /0 to 23/);
});

test('a misread date is mended from the upload day', async () => {
  const { plausibleDay, cleanGaps } = await import('../server/reportChecks.js');
  assert.equal(plausibleDay('2026-11-13', '2026-11-14'), '2026-11-13');
  assert.equal(plausibleDay('2010-11-04', '2026-11-06'), '2026-11-04', '"4/11/10" is this year');
  assert.equal(plausibleDay('2026-12-11', '2026-11-14'), '2026-11-12', '12/11 read as 11 December');
  assert.equal(plausibleDay('2026-02-11', '2026-11-14'), '2026-11-02', 'day and month the wrong way round');
  assert.equal(plausibleDay('2026-12-30', '2027-01-02'), '2026-12-30', 'December report uploaded in January');
  assert.equal(plausibleDay('2028-12-20', '2026-10-25'), null, 'nothing near: the caller takes the day before the upload');
  assert.equal(plausibleDay('nonsense', '2026-10-25'), null);
  assert.deepEqual(cleanGaps([{ item: 'Waste %', missing: 'a' }, { item: 'waste %', missing: 'b' }], ['Waste %']), [{ item: 'Waste %', missing: 'a; b' }]);
  assert.deepEqual(cleanGaps([{ item: 'Waste %', missing: 'a' }], ['Waste % — blocks issued vs needed']), [{ item: 'Waste % — blocks issued vs needed', missing: 'a' }], 'the short label is the item');
});

test('what a report is gets written in the background, and again when its list changes', async () => {
  await reset();
  const { describeType } = await import('../server/reportChecks.js');
  const asked = [];
  const describe = async (prompt) => { asked.push(prompt); return 'Photos of the cleaning report. Not invoices.'; };
  const t = await createType({ name: 'Cleaning', writer: 'Faisal', items: ['Photos — before and after'] }, Date.now(), { describe });
  await new Promise((r) => setTimeout(r, 50));
  assert.match(asked[0], /Report: Cleaning\nWritten by: Faisal/);
  assert.equal((await listTypes())[0].about, 'Photos of the cleaning report. Not invoices.');

  await updateType(t.id, { due_hour: 9 }, { describe });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(asked.length, 1, 'a new due time does not need a new description');
  await updateType(t.id, { items: ['Photos — before and after', 'Chemicals'] }, { describe: async () => 'New one.' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await listTypes())[0].about, 'New one.');
  assert.equal(await describeType(999, describe), null);
});

test('an agent from one sentence: Reem fills in the rest, and says what it cannot do', async () => {
  const { planAgent } = await import('../server/reportChecks.js');
  let asked = '';
  const plan = await planAgent('  Watch Umer AC reports, 4 units a day  ', async (prompt) => {
    asked = prompt;
    return JSON.stringify({ name: 'AC cleaning report', writer: 'Umer', items: ['Units — how many', ' ', 'Photos — before and after'],
      work_days: '1234569', due_hour: 30, daily_target: '4', summary: 'It will check each AC report.', limits: '' });
  });
  assert.equal(asked, 'Watch Umer AC reports, 4 units a day');
  assert.deepEqual(plan.items, ['Units — how many', 'Photos — before and after']);
  assert.equal(plan.work_days, '123456');
  assert.equal(plan.due_hour, 12, 'an hour that is not one is the default');
  assert.equal(plan.daily_target, 4);
  assert.equal(plan.brief, 'Watch Umer AC reports, 4 units a day');
  const invoices = await planAgent('Check every invoice uploaded', async () => JSON.stringify({ name: 'Invoice check', items: ['VAT — 5%'], work_days: '' }));
  assert.equal(invoices.work_days, '', 'invoices come whenever there is one');
  await assert.rejects(planAgent('hi', async () => '{}'), /in a sentence/);
  await assert.rejects(planAgent('watch my email for complaints', async () => 'no'), /could not set this agent up/);

  await reset();
  const t = await createType({ ...plan, daily_target: 4 });
  assert.equal(t.brief, 'Watch Umer AC reports, 4 units a day', 'the sentence is kept with the agent');
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

  // A long answer cut off in the middle still gives the matches it got to.
  const cut = await matchReports(docs, types, async () => '{"matches": [{"file": 2, "type": 7}, {"file": 1, "ty');
  assert.deepEqual(cut.map((x) => x.doc.id), [2]);
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

test('a daily target: fewer units buzzes the master with the reason, enough does not', async () => {
  await reset();
  const boss = await master();
  const u = await makeUser('Boss2');
  const ac = await createType({ name: 'AC cleaning', writer: 'Umer', items: ['Units — unit numbers done'], daily_target: 4 }, at('2026-11-16T09:00:00'));
  assert.equal(ac.daily_target, 4);
  assert.equal((await updateType(ac.id, { daily_target: 0 })).daily_target, null, '0 or empty is no target');
  await updateType(ac.id, { daily_target: '4' });
  const typeRow = (await listTypes()).find((t) => t.id === ac.id);
  const { sent, pusher } = pushes();
  const run = async (day, facts) => {
    const id = await file(u, { title: `AC ${day}`, text: 'units', created: `${day}T18:00:00`, date: day });
    const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    const { asker, calls } = fakeAsker({ check: { report_date: day, gaps: [], facts } });
    await checkReport(typeRow, row, { asker, pusher });
    return calls[0].prompt;
  };
  const prompt = await run('2026-11-17', { units_done: 2, short_reason: 'tenant away in 305' });
  assert.match(prompt, /Daily target: 4 units a day/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, [boss]);
  assert.equal(sent[0].body, '2 of 4 units done (tenant away in 305).');
  await run('2026-11-18', { units_done: 4 });
  assert.equal(sent.length, 1, 'the target was met');
  await run('2026-11-19', { units_done: 3, short_reason: 'not given' });
  assert.equal(sent[1].body, '3 of 4 units done.');
  const { shortOf } = await import('../server/reportChecks.js');
  assert.equal(shortOf({ daily_target: 4 }, { facts: { units_done: null } }), null, 'no count, no shortfall');
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
  const nov = await reportDays(type.id, { month: '2026-11', now: at('2026-11-18T13:00:00') });
  assert.deepEqual([nov.from, nov.to], ['2026-11-01', '2026-11-30']);
  assert.deepEqual(nov.days.map((d) => d.date), ['2026-11-17', '2026-11-16'], 'a month: from the day watching began, up to yesterday');
  assert.equal((await reportDays(type.id, { month: '2026-10', now: at('2026-11-18T13:00:00') })).days.length, 0, 'nothing before it began');
});

test('a report that comes whenever there is one is never late', async () => {
  await reset();
  await master();
  const t = await createType({ name: 'Invoices', about: 'x', items: ['VAT — 5%'], work_days: '' }, at('2026-11-16T09:00:00'));
  assert.equal(t.work_days, '');
  const { sent, pusher } = pushes();
  await watchAlerts({ now: at('2026-11-20T12:00:00'), pusher });
  assert.equal(sent.length, 0);
  const { days } = await reportDays(t.id, { now: at('2026-11-20T12:00:00') });
  assert.equal(days.length, 0);
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
  const c = await db.prepare('SELECT note_state FROM report_checks').get();
  assert.equal(c.note_state, 'past', 'an old report\'s note is kept, not waited on');
});
