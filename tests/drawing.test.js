import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { splitDrawings, lastDrawing, withoutDrawings, exportAsked, normalize, toSvg, extent, drawingFileName } from '../server/drawingCore.js';
import { drawingPdf, drawingDxf, fitPage, drawingRoutes } from '../server/drawing.js';
import { spoken } from '../server/tts.js';

test.after(() => closeDb());

const plan = {
  title: 'Kiosk <plan> & co',
  unit: 'm',
  shapes: [
    { type: 'line', points: [[1.1, 3], [0, 3], [0, 0], [3, 0], [3, 3], [1.9, 3]], weight: 'thick' },
    { type: 'rect', x: 0.05, y: 0.05, w: 0.65, h: 0.95, label: 'Fridge', note: 'Under-counter', color: 'green' },
    { type: 'circle', x: 0.3, y: 1.7, r: 0.07, color: 'red' },
    { type: 'arc', x: 1.1, y: 3, r: 0.8, from: 0, to: 90, dash: true },
    { type: 'text', x: 1.5, y: 1.3, text: 'Work aisle', bold: true },
    { type: 'dim', from: [0, 3], to: [3, 3], offset: 0.5, label: '3.0 m' },
  ],
  legend: [{ color: 'green', label: 'Refrigeration' }],
};
const reply = (d = plan) => `Here it is.\n\n\`\`\`drawing\n${JSON.stringify(d)}\n\`\`\`\n\nSizes are estimates.`;

test('a reply splits into its words and its drawing', () => {
  const parts = splitDrawings(reply());
  assert.deepEqual(parts.map((p) => Object.keys(p)[0]), ['text', 'drawing', 'text']);
  assert.equal(parts[1].drawing.title, 'Kiosk <plan> & co');
  assert.equal(withoutDrawings(reply()), 'Here it is.\n\n\n\nSizes are estimates.');
  assert.equal(lastDrawing('no drawing here'), null);
});

test('a drawing still arriving is pending, and a broken one reads as null', () => {
  assert.ok(splitDrawings('Here:\n```drawing\n{"title":"x","sha').at(-1).pending);
  assert.equal(splitDrawings('```drawing\n{not json\n```')[0].drawing, null);
  assert.equal(lastDrawing('```drawing\n{not json\n```'), null);
});

test('only shapes that make sense are kept', () => {
  const d = normalize({ shapes: [
    { type: 'rect', x: 0, y: 0, w: -1, h: 1 }, // no size
    { type: 'rect', x: '1', y: 0, w: 1, h: 1, color: 'pink' }, // a number as text, an unknown colour
    { type: 'script', x: 0, y: 0 },
    { type: 'line', points: [[0, 0]] },
  ] });
  assert.equal(d.shapes.length, 1);
  assert.equal(d.shapes[0].x, 1);
  assert.equal(d.shapes[0].color, 'sand');
  assert.equal(d.title, 'Drawing');
  assert.equal(normalize({ shapes: [] }), null);
  assert.equal(normalize(null), null);
});

test('the picture escapes every word', () => {
  const svg = toSvg(normalize(plan));
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('Kiosk &lt;plan&gt; &amp; co'));
  assert.ok(!svg.includes('<plan>'));
});

test('a plan in metres goes on the PDF at a standard scale', async () => {
  const d = normalize(plan);
  assert.equal(fitPage(d, 841.89 - 72, 595.28 - 72 - 22).scale, 25);
  const bytes = Buffer.from(await drawingPdf(d, { date: new Date('2026-09-29') }));
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  // Same drawing, same date: same file.
  assert.deepEqual(Buffer.from(await drawingPdf(d, { date: new Date('2026-09-29') })), bytes);
  // A diagram with no real size is fitted to the page instead.
  assert.equal(fitPage({ ...d, unit: '' }, 500, 500).scale, null);
});

test('the AutoCAD file is in metres, with y turned up', () => {
  const dxf = drawingDxf(normalize(plan));
  assert.match(dxf, /\$INSUNITS\r\n70\r\n6/);
  assert.match(dxf, /0\r\nARC\r\n8\r\nBLACK\r\n6\r\nDASHED/);
  assert.match(dxf, /0\r\nCIRCLE[\s\S]*?\r\n20\r\n-1\.7\r\n/);
  assert.ok(dxf.trimEnd().endsWith('EOF'));
  assert.ok(!drawingDxf({ ...normalize(plan), unit: '' }).includes('$INSUNITS'));
});

test('a measurement line moves the way its offset says, whichever end comes first', () => {
  const at = (from, to) => extent(normalize({ shapes: [{ type: 'dim', from, to, offset: 0.5 }] }));
  assert.equal(at([0, 3], [3, 3]).y0, 3.5);
  assert.equal(at([3, 3], [0, 3]).y0, 3.5);
  assert.equal(at([0, 0], [0, 3]).x0, 0.5);
});

test('file handover, file names and reading aloud', () => {
  assert.equal(exportAsked('<!--export:dxf-->\nHere it is for AutoCAD.'), 'dxf');
  assert.equal(exportAsked('Drawings come as PDF, image or AutoCAD.'), null);
  assert.equal(drawingFileName('Kiosk: plan / v2', 'pdf'), 'Kiosk- plan - v2.pdf');
  assert.equal(spoken(reply()), 'Here it is.\n\n \n\nSizes are estimates.');
});

test('the files are only for the person whose reply it is', async () => {
  await reset();
  const owner = await makeUser('owner');
  const other = await makeUser('other');
  const agent = await makeAgent(owner, 'Planner');
  const { id: convId } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(owner, 'Kiosk');
  const add = async (content) => (await db.prepare(`INSERT INTO messages (conversation_id, agent_id, role, content)
    VALUES (?, ?, 'assistant', ?) RETURNING id`).run(convId, agent, content)).id;
  const drawn = await add(reply());
  const plain = await add('Just words.');

  let as = owner;
  const app = express();
  app.use((req, res, next) => { req.user = { id: as }; next(); });
  app.use('/api/replies', drawingRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const url = (id, f) => `http://127.0.0.1:${server.address().port}/api/replies/${id}/drawing/${f}`;
  try {
    const pdf = await fetch(url(drawn, 'pdf'));
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /Kiosk%20-plan-%20%26%20co\.pdf/);
    const dxf = await fetch(url(drawn, 'dxf'));
    assert.equal(dxf.status, 200);
    assert.match(await dxf.text(), /ENTITIES/);
    assert.equal((await fetch(url(plain, 'pdf'))).status, 400);
    assert.equal((await fetch(url(drawn, 'mp4'))).status, 404);
    as = other;
    assert.equal((await fetch(url(drawn, 'pdf'))).status, 404);
  } finally {
    server.close();
  }
});
