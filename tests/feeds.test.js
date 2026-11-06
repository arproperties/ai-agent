import { db, reset, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { feedRoutes, parseFeed, pushLine } from '../server/feeds.js';
import { dubaiDate } from '../server/saifsys/client.js';

// The routes as index.js mounts them, behind requireMaster; here the signed-in master is set by hand.
let base, server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/feeds', (req, res, next) => { req.user = { id: 1, role: 'master', name: 'Boss' }; next(); }, feedRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/feeds`;
});
test.after(async () => { server.close(); await closeDb(); });

const put = (path, body) => fetch(`${base}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('the search reply is read into numbers only: words, bad links and missing parts come out as null or empty', () => {
  const f = parseFeed('Here you go\n```json\n' + JSON.stringify({
    gold: { k24: '312.50', k22: 289.25, k21: 'about 276', source: 'Khaleej Times' },
    fx: { USD: 3.6725, INR: 0.0418 },
    stocks: [{ name: 'Emaar Properties', symbol: 'EMAAR', market: 'DFM', price: 14.2, change_pct: -1.1 }, { price: 3 }],
    news: [{ title: 'DLD record week', url: 'javascript:alert(1)' }, { title: 'Rents', url: 'https://example.com/a' }],
  }) + '\n```');
  assert.equal(f.gold.k24, 312.5);
  assert.equal(f.gold.k21, null, 'a word where a price goes is dropped');
  assert.equal(f.gold.k18, null);
  assert.equal(f.fuel.super98, null, 'a part not found is empty, not a guess');
  assert.equal(f.stocks.length, 1, 'a share with no name is left out');
  assert.equal(f.news[0].url, '', 'only web links are kept');
  assert.equal(f.news[1].url, 'https://example.com/a');
  assert.throws(() => parseFeed('sorry, no json'), /could not read/);
});

test('the buzz line is short and skips what is missing', () => {
  assert.equal(pushLine({ gold: { k24: 312.5, k22: 289 }, fx: {}, brent: {}, weather: { high: 31.6 } }), 'Gold 24K 312.50 · 22K 289.00 · 32°');
  assert.equal(pushLine({}), 'Your morning feed is ready');
});

test('the page gets today, the days before it and the buzz time', async () => {
  await reset();
  const today = dubaiDate();
  await db.prepare('INSERT INTO feed_days (day, data) VALUES (?, ?), (?, ?)')
    .run('2020-01-01', JSON.stringify({ gold: { k24: 200 } }), today, JSON.stringify({ gold: { k24: 300 } }));
  await db.prepare(`INSERT INTO feed_days (day, error, tries) VALUES ('2020-01-02', 'timed out', 3)`).run();
  const r = await (await fetch(base)).json();
  assert.equal(r.day, today);
  assert.equal(r.today.data.gold.k24, 300);
  assert.deepEqual(r.history.map((h) => h.day), [today, '2020-01-01'], 'a failed day is not history');
  assert.equal(r.settings.push_at, '07:00', 'the buzz starts at 7');
});

test('the buzz time can be changed or turned off, and nonsense is refused', async () => {
  await reset();
  assert.equal((await put('/settings', { push_at: '06:30' })).status, 200);
  assert.equal((await (await fetch(base)).json()).settings.push_at, '06:30');
  assert.equal((await put('/settings', { push_at: '25:00' })).status, 400);
  assert.equal((await put('/settings', { push_at: '' })).status, 200);
  assert.equal((await (await fetch(base)).json()).settings.push_at, '');
});

test('a question needs a question', async () => {
  const r = await fetch(`${base}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
  assert.equal(r.status, 400);
});

test('a YouTube link is pinned once, with any link form; anything else is refused', async () => {
  await reset();
  const post = (url) => fetch(`${base}/videos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  assert.equal((await post('https://example.com/watch?v=dQw4w9WgXcQ')).status, 400);
  assert.equal((await post('not a link')).status, 400);
  const a = await (await post('https://youtu.be/dQw4w9WgXcQ?t=30')).json();
  assert.equal(a.video_id, 'dQw4w9WgXcQ');
  await post('https://www.youtube.com/watch?v=dQw4w9WgXcQ'); // the same video again
  await post('https://www.youtube.com/live/abcdefghijk');
  const { videos } = await (await fetch(base)).json();
  assert.deepEqual(videos.map((v) => v.video_id), ['abcdefghijk', 'dQw4w9WgXcQ'], 'newest first, no repeats');
  await fetch(`${base}/videos/${a.id}`, { method: 'DELETE' });
  assert.equal((await (await fetch(base)).json()).videos.length, 1);
});

test('YouTube: lengths read plainly; no search before a key, and a key that is not one is refused before asking Google', async () => {
  const { duration } = await import('../server/youtube.js');
  assert.equal(duration('PT4M5S'), '4:05');
  assert.equal(duration('PT1H2M3S'), '1:02:03');
  assert.equal(duration('P0D'), '');
  await reset();
  assert.equal((await fetch(`${base}/youtube/search?q=dubai`)).status, 400);
  assert.equal((await put('/youtube/key', { key: 'hello' })).status, 400);
  assert.equal((await put('/youtube/key', { key: '' })).status, 200);
  assert.equal((await (await fetch(base)).json()).youtube, false);
});
