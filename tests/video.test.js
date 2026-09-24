import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from './helpers/db.js';
import { videoSeconds, videoAudio, videoFrames, FRAME_AT, VIDEO_TYPES } from '../server/knowledge.js';
import { isVideo } from '../server/files.js';

test.after(() => closeDb());

const run = promisify(execFile);

// ---------- what counts as a video ----------

test('a video is recognised by its type', () => {
  for (const mimetype of VIDEO_TYPES) assert.equal(isVideo({ mimetype, originalname: 'clip' }), true);
});

// Phones and browsers disagree about .mov in particular: Safari sends video/quicktime,
// some Android builds send nothing at all. The extension is the fallback.
test('a video with no usable type is recognised by its extension', () => {
  assert.equal(isVideo({ mimetype: 'application/octet-stream', originalname: 'site visit.MOV' }), true);
  assert.equal(isVideo({ mimetype: '', originalname: 'leak.3gp' }), true);
});

test('documents and photos are not videos', () => {
  assert.equal(isVideo({ mimetype: 'application/pdf', originalname: 'lease.pdf' }), false);
  assert.equal(isVideo({ mimetype: 'image/jpeg', originalname: 'damage.jpg' }), false);
  assert.equal(isVideo({ mimetype: 'text/plain', originalname: 'notes.txt' }), false);
});

// ---------- reading one with ffmpeg ----------
// These drive the real ffmpeg, because what can break here is the arguments, not the
// JavaScript. They skip rather than fail where it is not installed: a Mac without it
// should still be able to run the suite.

// Synchronously: node:test collects the cases as this module evaluates, and anything
// declared after a top-level await is never registered.
const haveFfmpeg = ['ffmpeg', 'ffprobe'].every((bin) => spawnSync(bin, ['-version']).status === 0);
const withFfmpeg = { skip: haveFfmpeg ? false : 'ffmpeg is not installed here' };

let dir;
let clip;
let silent;
test('make the test clips', withFfmpeg, async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-video-test-'));
  clip = join(dir, 'clip.mp4');
  silent = join(dir, 'silent.mp4');
  // 6 seconds of moving colour bars with a tone over them, and the same with no sound
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=15:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', clip]);
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=15:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', silent]);
});

test('the length of a clip is read off it', withFfmpeg, async () => {
  assert.ok(Math.abs(await videoSeconds(clip) - 6) < 0.5, 'a 6 second clip should measure about 6 seconds');
});

test('a file that is not a video has no length, rather than throwing', withFfmpeg, async () => {
  const notVideo = join(dir, 'notes.txt');
  await run('sh', ['-c', `printf 'hello' > ${JSON.stringify(notVideo)}`]);
  assert.equal(await videoSeconds(notVideo).catch(() => 0), 0);
});

test('stills come back spread through the clip', withFfmpeg, async () => {
  const out = mkdtempSync(join(tmpdir(), 'jarvis-frames-'));
  try {
    const shots = await videoFrames(clip, out, 6);
    assert.equal(shots.length, FRAME_AT.length);
    // Taken where they were asked for, in order, and never at the very start or end
    assert.deepEqual(shots.map((s) => s.at), FRAME_AT.map((f) => 6 * f));
    for (const s of shots) {
      const bytes = readFileSync(s.path);
      assert.ok(bytes.length > 1000, 'a still should not be empty');
      assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8', 'a still should be a JPEG'); // JPEG magic number
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// A 1080p frame sent whole would cost about half again as much to read for no more detail.
test('a still is capped at 1280 wide, so one frame costs the same whatever the camera', withFfmpeg, async () => {
  const out = mkdtempSync(join(tmpdir(), 'jarvis-frames-'));
  try {
    const [shot] = await videoFrames(clip, out, 6);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', shot.path]);
    assert.equal(stdout.trim(), '1280,720', 'a 1920x1080 clip should give a 1280x720 still');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the sound comes out as an mp3 small enough to send', withFfmpeg, async () => {
  const out = mkdtempSync(join(tmpdir(), 'jarvis-audio-'));
  try {
    const path = await videoAudio(clip, out);
    assert.ok(path, 'a clip with sound should give an audio file');
    const size = statSync(path).size;
    assert.ok(size > 1000, 'the audio should not be empty');
    // 32 kbps mono: six seconds is a few tens of KB, and an hour still fits the transcriber's limit
    assert.ok(size < 60_000, `six seconds of speech should be tiny, got ${size} bytes`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// A video with no sound is the ordinary case for a photo-app export, not a failure.
test('a silent video gives no audio rather than an error', withFfmpeg, async () => {
  const out = mkdtempSync(join(tmpdir(), 'jarvis-audio-'));
  try {
    assert.equal(await videoAudio(silent, out), null);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('clean up the test clips', withFfmpeg, () => rmSync(dir, { recursive: true, force: true }));
