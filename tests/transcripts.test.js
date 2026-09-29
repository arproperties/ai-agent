import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reset, makeUser, closeDb } from './helpers/db.js';
import {
  engine, createTranscript, listTranscripts, getTranscript, renameTranscript, deleteTranscript, settled,
} from '../server/transcripts.js';

test.after(() => closeDb());

// These drive the real ffmpeg, because turning a phone's audio into something the speech
// API takes is the part that can break. They skip where ffmpeg is not installed.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = mkdtempSync(join(tmpdir(), 'jarvis-transcripts-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

/** A few seconds of tone in the given container — what WhatsApp or a phone would hand over. */
function sound(name, seconds = 3, args = []) {
  const path = join(tmp, name);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...args, '-y', path]);
  assert.equal(r.status, 0, String(r.stderr));
  return readFileSync(path);
}

let calls;
function fake(reply = (i) => `Piece ${i}`) {
  calls = [];
  engine.transcribe = async (buf) => { calls.push(buf.length); return reply(calls.length); };
}

test('a WhatsApp voice note (.opus) comes back as text', { skip: !hasFfmpeg }, async () => {
  await reset();
  fake(() => ' Call me when you land. ');
  const user = await makeUser('Sara');
  const t = await createTranscript(user, { buffer: sound('note.opus', 3, ['-c:a', 'libopus']), originalname: 'PTT-20260929-WA0003.opus' });
  assert.equal(t.status, 'processing');
  assert.equal(t.title, 'PTT-20260929-WA0003');
  await settled();

  const done = await getTranscript(user, t.id);
  assert.equal(done.status, 'ready');
  assert.equal(done.text, 'Call me when you land.');
  assert.equal(done.duration_s, 3);
  assert.equal(done.path, undefined, 'where the file lives is not sent to the browser');
  assert.equal(calls.length, 1);
});

test('the uploaded file is thrown away once it has been read', { skip: !hasFfmpeg }, async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  const t = await createTranscript(user, { buffer: sound('memo.m4a', 2), originalname: 'memo.m4a' });
  await settled();
  const { db } = await import('./helpers/db.js');
  const row = await db.prepare('SELECT path FROM transcripts WHERE id = ?').get(t.id);
  assert.equal(existsSync(row.path), false);
});

test('a long recording is sent in ten-minute pieces, in order', { skip: !hasFfmpeg }, async () => {
  await reset();
  // The pieces go out together, so they can come back in any order; each answers with its
  // own size, and the short last piece has to end up last.
  calls = [];
  engine.transcribe = async (buf) => { calls.push(buf.length); return `${buf.length}`; };
  const user = await makeUser('Sara');
  // 21 minutes of mono 8 kHz is quick to make and still three pieces: 10, 10 and 1.
  const t = await createTranscript(user, { buffer: sound('long.mp3', 21 * 60, ['-ar', '8000', '-b:a', '8k']), originalname: 'long.mp3' });
  await settled();
  const done = await getTranscript(user, t.id);
  assert.equal(calls.length, 3);
  const sizes = done.text.split('\n\n').map(Number);
  assert.equal(sizes.length, 3);
  assert.ok(sizes[2] < sizes[0] / 5, 'the one-minute piece is last');
  assert.equal(done.duration_s, 21 * 60);
});

test('something that is not audio fails with a plain message', { skip: !hasFfmpeg }, async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  const t = await createTranscript(user, { buffer: Buffer.from('not audio at all'), originalname: 'lease.pdf' });
  await settled();
  const done = await getTranscript(user, t.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /could not read this file as audio/);
  assert.equal(calls.length, 0);
});

test('silence is ready, but says nothing was heard', { skip: !hasFfmpeg }, async () => {
  await reset();
  fake(() => '');
  const user = await makeUser('Sara');
  const t = await createTranscript(user, { buffer: sound('quiet.webm', 2), originalname: 'voice.webm', source: 'recording' });
  await settled();
  const done = await getTranscript(user, t.id);
  assert.equal(done.status, 'ready');
  assert.equal(done.title, '', 'a recording is named by its date on the page, not "voice"');
  assert.match(done.error, /No speech/);
});

test('an empty upload is refused', async () => {
  await reset();
  const user = await makeUser('Sara');
  await assert.rejects(() => createTranscript(user, { buffer: Buffer.alloc(0), originalname: 'x.opus' }), /No audio/);
});

test('each person only sees, renames and deletes their own', { skip: !hasFfmpeg }, async () => {
  await reset();
  fake();
  const sara = await makeUser('Sara');
  const omar = await makeUser('Omar');
  const t = await createTranscript(sara, { buffer: sound('a.ogg', 1), originalname: 'a.ogg' });
  await settled();

  assert.equal((await listTranscripts(omar)).length, 0);
  assert.equal(await getTranscript(omar, t.id), null);
  assert.equal(await renameTranscript(omar, t.id, 'mine now'), null);
  assert.equal(await deleteTranscript(omar, t.id), false);

  assert.equal((await renameTranscript(sara, t.id, '  Boss   about Friday ')).title, 'Boss about Friday');
  const [row] = await listTranscripts(sara);
  assert.equal(row.preview, 'Piece 1');
  assert.equal(await deleteTranscript(sara, t.id), true);
  assert.equal((await listTranscripts(sara)).length, 0);
});
