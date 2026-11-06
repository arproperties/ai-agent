import { db, reset, closeDb, makeUser } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeAsk, youtubeReply } from '../server/youtubeChat.js';
import { recordWatch, searchYouTube } from '../server/youtube.js';

delete process.env.YOUTUBE_API_KEY; // never Google from a test
test.after(closeDb);

test('which messages are YouTube asks, read without AI', () => {
  assert.deepEqual(youtubeAsk('open cyber security related videos on youtube'), { kind: 'search', q: 'cyber security', live: false });
  assert.deepEqual(youtubeAsk('show me dubai news live on youtube'), { kind: 'search', q: 'dubai news live', live: true });
  assert.deepEqual(youtubeAsk('open youtube'), { kind: 'trending' });
  const h = youtubeAsk('what did I watch about phishing last week?');
  assert.equal(h.kind, 'history');
  assert.deepEqual(h.words, ['phishing']);
  assert.ok(h.since > 0);
  assert.equal(youtubeAsk('what is the rent for unit 101?'), null, 'an ordinary question goes to Reem as usual');
  assert.equal(youtubeAsk('I uploaded the youtube contract'), null, 'youtube with no ask for videos is ordinary');
  assert.equal(youtubeAsk('search youtube for this\nand that'), null, 'a long message is ordinary');
});

test('the watch history: once per half hour, found by its words and listed with the row for the app', async () => {
  await reset();
  const me = await makeUser('Boss');
  await recordWatch(me, { id: 'aaaaaaaaaaa', title: 'Phishing explained', channel: 'Cyber Daily', duration: '8:01' });
  await recordWatch(me, { id: 'aaaaaaaaaaa', title: 'Phishing explained', channel: 'Cyber Daily' }); // again at once
  await recordWatch(me, { id: 'bbbbbbbbbbb', title: 'Dubai skyline', channel: 'Travel' });
  assert.equal((await db.prepare('SELECT count(*)::int n FROM yt_history').get()).n, 2);
  const reply = await youtubeReply({ id: me }, youtubeAsk('what did I watch about phishing'));
  assert.match(reply, /You watched 1 video about \*\*phishing\*\*/);
  const row = JSON.parse(reply.match(/```youtube\n([\s\S]*?)\n```/)[1]);
  assert.equal(row.items[0].id, 'aaaaaaaaaaa');
  const other = await makeUser('Other');
  assert.match(await youtubeReply({ id: other }, youtubeAsk('what did I watch')), /no videos/, 'each person sees only their own');
  await assert.rejects(recordWatch(me, { id: 'nope' }), /Not a YouTube video/);
});

test('a search is kept a day: asking again does not go to Google', async () => {
  await reset();
  await db.prepare('INSERT INTO yt_search_cache (query, items) VALUES (?, ?)').run('cyber security', JSON.stringify([{ id: 'ccccccccccc', title: 'Kept' }]));
  const r = await searchYouTube('Cyber  Security');
  assert.equal(r.cached, true);
  assert.equal(r.items[0].title, 'Kept');
});
