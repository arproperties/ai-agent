import test from 'node:test';
import { closeDb } from './helpers/db.js'; // first: tts.js loads the database
import assert from 'node:assert/strict';
import { splitDashboards, withoutDashboards, readDashboard, barShare, barValue } from '../server/dashboardCore.js';
import { parseBlocks, renderPdf, documentPart } from '../server/replyDoc.js';
import { spoken } from '../server/tts.js';

test.after(() => closeDb());

const rdc = {
  title: 'RDC cases — rooms per case',
  subtitle: 'As at 16/11/2026',
  tiles: [{ label: 'Rooms in cases', value: 24, color: 'blue' }, { label: 'Rooms not filed', value: '71' }],
  charts: [{
    title: 'Rooms per case', unit: 'rooms',
    bars: [
      { label: '23323/2026', value: 5, color: 'yellow' },
      { label: '21791/2026 (Appeal 24757/2026)', value: '8', color: 'orange' },
      { label: '21554/2026', value: 3, color: 'green' },
      { label: 'No number', value: 'n/a', color: 'red' },
    ],
  }],
  legend: [
    { color: 'yellow', label: 'Hearing today' },
    { color: 'orange', label: 'Won, next step open' },
    { color: 'green', label: 'Won, eviction set' },
    { color: 'red', label: 'Lost' },
    { color: 'grey', label: 'Not filed' },
  ],
};
const reply = (d = rdc) => `Here it is.\n\n\`\`\`dashboard\n${JSON.stringify(d)}\n\`\`\`\n\nThe hearings are today.`;

test('a reply is cut into its words and its dashboard', () => {
  const parts = splitDashboards(reply());
  assert.equal(parts.length, 3);
  assert.equal(parts[1].dashboard.title, 'RDC cases — rooms per case');
  assert.equal(withoutDashboards(reply()), 'Here it is.\n\n\n\nThe hearings are today.');
});

test('a block still arriving is pending, a broken one is null', () => {
  assert.deepEqual(splitDashboards('Hi\n```dashboard\n{"tiles":')[1], { pending: true });
  assert.equal(splitDashboards('```dashboard\n{not json}\n```')[0].dashboard, null);
  assert.equal(readDashboard('{"title":"Empty"}'), null);
});

test('bars without a number are left out, numbers in text are read', () => {
  const d = readDashboard(JSON.stringify(rdc));
  assert.deepEqual(d.charts[0].bars.map((b) => b.value), [5, 8, 3]);
  assert.equal(d.tiles[1].value, '71');
  assert.equal(barShare(d.charts[0], d.charts[0].bars[1]), 1);
  assert.equal(barValue(d.charts[0], d.charts[0].bars[0]), '5 rooms');
  assert.equal(barValue({ unit: '' }, { value: 201600 }), '201,600');
});

test('the colour key only names colours that are used', () => {
  const d = readDashboard(JSON.stringify(rdc));
  // red's only bar had no number, and nothing is grey: neither is in the key.
  assert.deepEqual(d.legend.map((l) => l.color), ['yellow', 'orange', 'green']);
});

test('an unknown colour becomes blue, a known alias is kept', () => {
  const d = readDashboard(JSON.stringify({ charts: [{ bars: [{ label: 'a', value: 1, color: 'teal' }, { label: 'b', value: 2, color: 'Gray' }] }] }));
  assert.deepEqual(d.charts[0].bars.map((b) => b.color), ['blue', 'grey']);
});

test('the PDF draws the dashboard instead of printing its JSON', async () => {
  const md = `# RDC cases\n\n\`\`\`dashboard\n${JSON.stringify(rdc)}\n\`\`\`\n\n| Case | Rooms |\n|---|---|\n| 🟡 23323/2026 | 5 |`;
  const blocks = parseBlocks(md);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'dashboard', 'table']);
  const bytes = await renderPdf({ title: 'RDC cases', markdown: md, date: new Date('2026-11-16T06:00:00Z') });
  assert.ok(bytes.length > 1000);
  assert.ok(documentPart(`<!--doc-->\n${md}\n<!--/doc-->`).markdown.includes('```dashboard'));
});

test('a broken dashboard block in a PDF is still printed as code', () => {
  assert.equal(parseBlocks('```dashboard\n{oops\n```')[0].type, 'code');
});

test('a dashboard is not read aloud', () => {
  assert.equal(spoken(reply()), 'Here it is.\n\n \n\nThe hearings are today.');
});
