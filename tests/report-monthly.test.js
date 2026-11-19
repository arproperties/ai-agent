import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, db, closeDb } from './helpers/db.js';
import { createType } from '../server/reportChecks.js';
import { monthData, monthSummary, monthMarkdown, monthlyPdf, watchMonthly, reportMonths, prevMonth } from '../server/reportMonthly.js';

test.after(() => closeDb());

const at = (iso) => Date.parse(`${iso}+04:00`);

async function setup() {
  await reset();
  const boss = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(boss);
  const type = await createType({ name: 'School daily', writer: 'Khan', items: ['Running totals — to date', 'Waste % — blocks'], work_days: '0123456' }, at('2026-11-01T09:00:00'));
  await db.prepare("UPDATE report_types SET starts_on = '2026-11-20' WHERE id = ?").run(type.id); // watching began later
  const add = async (day, gaps, facts = {}, state = 'past') => {
    const { id } = await db.prepare("INSERT INTO documents (user_id, name, status) VALUES (?, ?, 'ready') RETURNING id").run(boss, `r-${day}-${Math.random()}`);
    await db.prepare(`INSERT INTO report_checks (type_id, document_id, report_date, gaps, facts, note_state) VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?)`)
      .run(type.id, id, day, JSON.stringify(gaps.map((item) => ({ item, missing: 'x' }))), JSON.stringify(facts), state);
  };
  return { boss, type, add };
}

test('a month in numbers: reports, days with none, what was missing, work added up', async () => {
  const { type, add } = await setup();
  await add('2026-10-30', ['Waste % — blocks']);
  await add('2026-11-02', ['Running totals — to date', 'Waste % — blocks'], { work: [{ what: 'Primer', qty: 100, unit: 'm²' }], materials: [{ what: 'Cement', qty: 2, unit: 'bags' }], people: 6 });
  await add('2026-11-02', [], { work: [{ what: 'Primer', qty: 100, unit: 'm²' }] }); // the newer copy of the 2nd is the day's
  await add('2026-11-03', ['Waste % — blocks'], { work: [{ what: 'primer', qty: 50.5, unit: 'm²' }, { what: 'Steel', qty: null, unit: '' }], people: 4 }, 'sent');
  const d = await monthData(type.id, '2026-11', at('2026-11-06T10:00:00'));
  assert.equal(d.reports, 2);
  assert.equal(d.complete, 1);
  assert.equal(d.withGaps, 1);
  assert.deepEqual(d.missing, ['2026-11-01', '2026-11-04', '2026-11-05'], 'from the 1st, as a report was on file before it; today is not counted');
  assert.deepEqual(d.often, [{ item: 'Waste %', n: 1 }]);
  assert.equal(d.notesSent, 1);
  const primer = d.work.find((w) => w.what.toLowerCase() === 'primer');
  assert.equal(primer.total, 150.5, 'the same work under another capital is one line');
  assert.equal(primer.days, 2);
  assert.equal(d.work.find((w) => w.what === 'Steel').counted, 0);
  assert.equal(d.people, 4, 'the newer copy of the 2nd gave no people');
  assert.equal(d.partial, true);
  assert.deepEqual(d.before, { month: '2026-10', reports: 1, withGaps: 1 });
  assert.deepEqual(await reportMonths(type.id), ['2026-11', '2026-10']);
  await assert.rejects(monthData(type.id, '2026-13'), /YYYY-MM/);
  assert.equal(prevMonth('2026-01'), '2025-12');

  const md = monthMarkdown(d, '- Primer 150.5 m² done.');
  assert.match(md, /^Written by Khan\. So far: up to Thu 5 Nov\./);
  assert.match(md, /```dashboard\n\{.*"Reports in".*\}\n```/);
  assert.match(md, /\| primer|Primer \| 150\.5 m² \| 2 \|/i);
  assert.match(md, /\| Steel \| not given \| 1 \|/);
  assert.match(md, /\| Wed 4 Nov \| 🔴 None \| No report came in \|/);
  assert.match(md, /## In short\n\n- Primer 150\.5 m² done\./);
});

test('Reem writes the summary once, and again only when the numbers change', async () => {
  const { type, add } = await setup();
  await add('2026-11-02', ['Waste % — blocks']);
  let calls = 0;
  const asker = async () => { calls++; return 'Here:\n- One.\n- Two.\nThanks'; };
  const d = await monthData(type.id, '2026-11', at('2026-11-06T10:00:00'));
  assert.equal(await monthSummary(d, asker), '- One.\n- Two.', 'only the bullet lines');
  await monthSummary(d, asker);
  assert.equal(calls, 1);
  await add('2026-11-03', []);
  await monthSummary(await monthData(type.id, '2026-11', at('2026-11-06T10:00:00')), asker);
  assert.equal(calls, 2);

  const pdf = await monthlyPdf(type.id, '2026-11', { asker, now: at('2026-11-06T10:00:00') });
  assert.equal(pdf.name, 'School daily - November 2026.pdf');
  assert.equal(pdf.bytes.subarray(0, 4).toString(), '%PDF');
});

test('on the 1st from 08:00 the master gets last month, once', async () => {
  const { boss, type, add } = await setup();
  await add('2026-11-02', ['Waste % — blocks']);
  const sent = [];
  const pusher = async (to, msg) => { sent.push({ to, ...msg }); };
  const asker = async () => '- ok';
  await watchMonthly({ now: at('2026-12-01T07:59:00'), asker, pusher });
  assert.equal(sent.length, 0, 'not before 08:00');
  await watchMonthly({ now: at('2026-12-02T09:00:00'), asker, pusher });
  assert.equal(sent.length, 0, 'only on the 1st');
  await watchMonthly({ now: at('2026-12-01T08:05:00'), asker, pusher });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, [boss]);
  assert.equal(sent[0].title, 'School daily · November 2026');
  assert.match(sent[0].body, /1 report, 1 with something missing/);
  assert.equal(sent[0].url, `/api/report-checks/types/${type.id}/monthly?month=2026-11`);
  await watchMonthly({ now: at('2026-12-01T09:00:00'), asker, pusher });
  assert.equal(sent.length, 1, 'once');
});
