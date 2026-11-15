import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { hello, sendDay, PairingError } from '../src/reem.js';

// A stand-in for Reem's door: records what arrived and answers as told.
function door(status, body) {
  const seen = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      seen.push({ path: req.url, key: req.headers['x-tracker-key'], body: data ? JSON.parse(data) : null });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((ok) => server.listen(0, () => ok({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() })));
}

test('hello carries the key and returns whose PC this is', async () => {
  const d = await door(200, { name: 'Francisca', device: 'Front desk', day_end: '18:30' });
  const r = await hello(d.url, 'k123');
  assert.deepEqual(r, { name: 'Francisca', device: 'Front desk', day_end: '18:30' });
  assert.equal(d.seen[0].path, '/api/from-tracker/hello');
  assert.equal(d.seen[0].key, 'k123');
  d.close();
});

test('sendDay posts the day as JSON and returns the answer', async () => {
  const d = await door(200, { ok: true, day_end: '18:30' });
  const day = { date: '2026-11-15', apps: [] };
  const r = await sendDay(d.url, 'k123', day);
  assert.deepEqual(r, { ok: true, day_end: '18:30' });
  assert.equal(d.seen[0].path, '/api/from-tracker/day');
  assert.deepEqual(d.seen[0].body, day);
  d.close();
});

test('a 401 is a pairing problem with Reem\'s own words; anything else is a plain error', async () => {
  const d = await door(401, { error: 'This PC is not paired with Reem' });
  await assert.rejects(() => sendDay(d.url, 'k', {}), (e) => e instanceof PairingError && e.message === 'This PC is not paired with Reem');
  d.close();
  const e = await door(500, { error: 'boom' });
  await assert.rejects(() => hello(e.url, 'k'), (err) => !(err instanceof PairingError) && /boom/.test(err.message));
  e.close();
});

test('a dead Reem is a plain error, not a pairing one', async () => {
  await assert.rejects(() => hello('http://127.0.0.1:9', 'k'), (err) => !(err instanceof PairingError));
});
