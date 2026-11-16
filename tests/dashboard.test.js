import test from 'node:test';
import { closeDb } from './helpers/db.js'; // first: tts.js loads the database
import assert from 'node:assert/strict';
import { splitDashboards, withoutDashboards, readDashboard, barShare, barValue, slices, arcPath, linePoints, askAbout } from '../server/dashboardCore.js';
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
  assert.deepEqual(d.charts[0].items.map((b) => b.value), [5, 8, 3]);
  assert.equal(d.tiles[1].value, '71');
  assert.equal(barShare(d.charts[0], d.charts[0].items[1]), 1);
  assert.equal(barValue(d.charts[0], d.charts[0].items[0]), '5 rooms');
  assert.equal(barValue({ unit: '' }, { value: 201600 }), '201,600');
});

test('the colour key only names colours that are used', () => {
  const d = readDashboard(JSON.stringify(rdc));
  // red's only bar had no number, and nothing is grey: neither is in the key.
  assert.deepEqual(d.legend.map((l) => l.color), ['yellow', 'orange', 'green']);
});

test('an unknown colour becomes blue, a known alias is kept', () => {
  const d = readDashboard(JSON.stringify({ charts: [{ bars: [{ label: 'a', value: 1, color: 'teal' }, { label: 'b', value: 2, color: 'Gray' }] }] }));
  assert.deepEqual(d.charts[0].items.map((b) => b.color), ['blue', 'grey']);
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

const mixed = {
  title: 'Rent',
  charts: [
    { type: 'donut', title: 'Paid', items: [{ label: 'Paid', value: 3, color: 'green' }, { label: 'Late', value: 1, color: 'red' }] },
    { type: 'line', title: 'Collected', unit: 'AED', color: 'purple', items: [{ label: 'Sep', value: 100 }, { label: 'Oct', value: 300 }, { label: 'Nov', value: 200 }] },
    { type: 'gauge', title: 'Target', items: [{ label: 'Collected', value: 72 }, { label: 'Units let', value: 45, max: 50, color: 'green' }] },
    { type: 'timeline', title: 'Dates', items: [{ date: '23/11/2026', label: 'Eviction', color: 'green' }, { date: '2026-11-16', label: 'Hearing', color: 'yellow' }, { label: 'No date' }] },
    { type: 'line', items: [{ label: 'only one', value: 1 }] },
    { type: 'sparkle', items: [{ label: 'x', value: 2 }] },
  ],
};

test('each chart type is read, and a line needs two points', () => {
  const d = readDashboard(JSON.stringify(mixed));
  assert.deepEqual(d.charts.map((c) => c.type), ['donut', 'line', 'gauge', 'timeline', 'bar']);
  assert.equal(d.charts[1].color, 'purple');
  // A gauge with no max is out of 100.
  assert.deepEqual(d.charts[2].items.map((g) => g.max), [100, 50]);
  // The timeline is put in date order, an undated entry last.
  assert.deepEqual(d.charts[3].items.map((t) => t.label), ['Hearing', 'Eviction', 'No date']);
});

test('donut slices add up to the whole, and the ring path is drawn', () => {
  const s = slices(readDashboard(JSON.stringify(mixed)).charts[0]);
  assert.deepEqual(s.map((x) => x.share), [0.75, 0.25]);
  assert.equal(s.at(-1).to, 1);
  assert.match(arcPath(60, 60, 46, 0, 0.75), /^M 60\.00 14\.00 A 46 46 0 1 1 /);
});

test('line points run left to right with the highest value at the top', () => {
  const pts = linePoints(readDashboard(JSON.stringify(mixed)).charts[1], 300, 100);
  assert.deepEqual(pts.map((p) => [p.x, Math.round(p.y)]), [[0, 67], [150, 0], [300, 33]]);
});

test('a tap asks about the thing tapped', () => {
  const d = readDashboard(JSON.stringify(mixed));
  assert.match(askAbout(d, d.charts[0], d.charts[0].items[1]), /"Rent — Paid".*"Late \(1\)"/);
  assert.match(askAbout(d, d.charts[2], d.charts[2].items[1]), /"Units let \(45 of 50\)"/);
  assert.match(askAbout(d, d.charts[3], d.charts[3].items[0]), /"2026-11-16: Hearing"/);
});

test('the PDF draws every chart type', async () => {
  const md = `# Rent\n\n\`\`\`dashboard\n${JSON.stringify(mixed)}\n\`\`\``;
  const bytes = await renderPdf({ title: 'Rent', markdown: md, date: new Date('2026-11-16T06:00:00Z') });
  assert.ok(bytes.length > 1000);
});
