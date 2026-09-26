import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import {
  engine, saveVoice, listVoices, deleteVoice, createMeeting, addPart, finishMeeting, getMeeting, listMeetings,
  deleteMeeting, resummarize, settled, turns, transcriptText, clock, meetingKit,
} from '../server/meetings.js';

test.after(() => closeDb());

const SAMPLE = `data:audio/webm;base64,${'A'.repeat(6000)}`;
const audio = Buffer.from('fake audio bytes');
const SUMMARY = JSON.stringify({
  title: 'Q4 rent review', summary: 'They agreed the rent review.',
  decisions: ['Raise rent 5%'], actions: [{ who: 'Francis', what: 'Send the report', when: 'Wednesday' }],
});

// Every test starts with engines that answer instantly and record what they were given.
let calls;
function fakes({ transcribe, summarize } = {}) {
  calls = { transcribe: [], summarize: [] };
  engine.transcribe = async (buf, mime, voices) => {
    calls.transcribe.push({ mime, voices: voices.map((v) => v.name) });
    return transcribe ? transcribe(buf, mime, voices) : {
      duration: 20,
      segments: [
        { start: 0, end: 4, speaker: 'Boss', text: 'We need the report by Thursday.' },
        { start: 5, end: 8, speaker: 'Francis', text: "I'll send it Wednesday." },
        { start: 9, end: 12, speaker: null, text: 'Sounds good.' },
      ],
    };
  };
  engine.summarize = async (prompt) => { calls.summarize.push(prompt); return summarize ? summarize(prompt) : SUMMARY; };
}

async function setup() {
  await reset();
  fakes();
  const user = await makeUser('Boss');
  const boss = await saveVoice(user, { name: 'Boss', sample: SAMPLE });
  const francis = await saveVoice(user, { name: 'Francis', sample: SAMPLE });
  return { user, boss, francis };
}

// ---------- voices ----------

test('a voice needs a name and a real recording', async () => {
  await reset();
  const user = await makeUser('Sara');
  await assert.rejects(() => saveVoice(user, { name: ' ', sample: SAMPLE }), /name/);
  await assert.rejects(() => saveVoice(user, { name: 'Sara', sample: 'hello' }), /did not come through/);
  await assert.rejects(() => saveVoice(user, { name: 'Sara', sample: 'data:audio/webm;base64,AAAA' }), /too short/);
});

test('recording a name again replaces the sample instead of making a second Francis', async () => {
  const { user } = await setup();
  await saveVoice(user, { name: 'francis', sample: `data:audio/mp4;base64,${'B'.repeat(6000)}` });
  const voices = await listVoices(user);
  assert.deepEqual(voices.map((v) => v.name), ['Boss', 'francis']);
  const row = await db.prepare(`SELECT sample FROM voice_profiles WHERE lower(name) = 'francis'`).get();
  assert.match(row.sample, /^data:audio\/mp4/);
  assert.equal(voices[0].sample, undefined, 'the sample itself never goes back to the browser');
});

test('nobody can use or delete another person\'s voices', async () => {
  const { boss } = await setup();
  const other = await makeUser('Other');
  assert.equal(await deleteVoice(other, boss.id), false);
  const m = await createMeeting(other, { speakers: [boss.id] });
  assert.deepEqual(m.speakers, [], 'someone else\'s voice id is dropped');
});

test('at most four people can be named in one meeting', async () => {
  const { user } = await setup();
  await assert.rejects(() => createMeeting(user, { speakers: [1, 2, 3, 4, 5] }), /up to 4/);
});

// ---------- the recording, start to finish ----------

test('pieces are written up as they arrive, and the summary waits for Stop', async () => {
  const { user, boss, francis } = await setup();
  const m = await createMeeting(user, { title: '', speakers: [boss.id, francis.id] });
  assert.equal(m.status, 'recording');

  await addPart(user, m.id, { seq: 0, offset: 0, buffer: audio, mimetype: 'audio/webm' });
  await settled();
  let got = await getMeeting(user, m.id);
  assert.equal(got.lines.length, 3, 'the first piece is transcribed during the meeting');
  assert.equal(calls.summarize.length, 0, 'no summary while still recording');
  assert.deepEqual(calls.transcribe[0].voices, ['Boss', 'Francis']);

  await addPart(user, m.id, { seq: 1, offset: 600, buffer: audio, mimetype: 'audio/webm' });
  await finishMeeting(user, m.id, { duration: 620 });
  await settled();
  got = await getMeeting(user, m.id);
  assert.equal(got.status, 'ready');
  assert.equal(got.error, null);
  assert.equal(got.lines.length, 6);
  assert.equal(got.lines[3].start_s, 600, 'the second piece is placed ten minutes in');
  assert.equal(got.title, 'Q4 rent review', 'an untitled meeting takes the summary\'s title');
  assert.deepEqual(got.summary.actions, [{ who: 'Francis', what: 'Send the report', when: 'Wednesday' }]);
  assert.deepEqual(got.speaker_names.sort(), ['Boss', 'Francis']);
  assert.match(calls.summarize[0], /\[10:05\] Francis: I'll send it Wednesday\./);
});

test('a title the user typed is kept', async () => {
  const { user } = await setup();
  const m = await createMeeting(user, { title: 'Board meeting' });
  await addPart(user, m.id, { seq: 0, offset: 0, buffer: audio, mimetype: 'audio/webm' });
  await finishMeeting(user, m.id);
  await settled();
  assert.equal((await getMeeting(user, m.id)).title, 'Board meeting');
});

test('the same piece sent twice is only written up once', async () => {
  const { user } = await setup();
  const m = await createMeeting(user, {});
  await addPart(user, m.id, { seq: 0, offset: 0, buffer: audio, mimetype: 'audio/webm' });
  await addPart(user, m.id, { seq: 0, offset: 0, buffer: audio, mimetype: 'audio/webm' });
  await settled();
  assert.equal((await getMeeting(user, m.id)).lines.length, 3);
  assert.equal(calls.transcribe.length, 1);
});

test('a finished meeting takes no more pieces', async () => {
  const { user } = await setup();
  const m = await createMeeting(user, {});
  await finishMeeting(user, m.id);
  await assert.rejects(() => addPart(user, m.id, { seq: 0, buffer: audio, mimetype: 'audio/webm' }), /already finished/);
});

test('a voice sample the service refuses costs the names, not the meeting', async () => {
  const { user, boss } = await setup();
  fakes({
    transcribe: (buf, mime, voices) => {
      if (voices.length) throw Object.assign(new Error('bad reference audio'), { status: 400 });
      return { duration: 5, segments: [{ start: 0, end: 5, speaker: null, text: 'Hello.' }] };
    },
  });
  const m = await createMeeting(user, { speakers: [boss.id] });
  await addPart(user, m.id, { seq: 0, offset: 0, buffer: audio, mimetype: 'audio/webm' });
  await finishMeeting(user, m.id);
  await settled();
  const got = await getMeeting(user, m.id);
  assert.equal(got.status, 'ready');
  assert.deepEqual(got.lines.map((l) => l.text), ['Hello.']);
});

test('a piece that keeps failing is parked, and the summary waits for it', async () => {
  const { user } = await setup();
  fakes({ transcribe: () => { throw Object.assign(new Error('timeout'), { status: 500 }); } });
  const m = await createMeeting(user, {});
  await addPart(user, m.id, { seq: 0, offset: 0, buffer: audio, mimetype: 'audio/webm' });
  await finishMeeting(user, m.id);
  await settled();
  const part = await db.prepare('SELECT status, attempts FROM meeting_parts WHERE meeting_id = ?').get(m.id);
  assert.deepEqual(part, { status: 'retry', attempts: 1 });
  assert.equal((await getMeeting(user, m.id)).status, 'processing', 'not summarised with a piece still to come');
});

test('when every piece fails the meeting says so rather than showing an empty summary', async () => {
  const { user } = await setup();
  // The file is gone: no point trying again, so it fails on the first go.
  fakes({ transcribe: () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); } });
  const m = await createMeeting(user, {});
  await addPart(user, m.id, { seq: 0, offset: 0, buffer: audio, mimetype: 'audio/webm' });
  await finishMeeting(user, m.id);
  await settled();
  const got = await getMeeting(user, m.id);
  assert.equal(got.status, 'failed');
  assert.match(got.error, /could not be turned into text/);
});

test('a summary that fails keeps the transcript and can be tried again', async () => {
  const { user } = await setup();
  fakes({ summarize: () => 'not json at all' });
  const m = await createMeeting(user, {});
  await addPart(user, m.id, { seq: 0, offset: 0, buffer: audio, mimetype: 'audio/webm' });
  await finishMeeting(user, m.id);
  await settled();
  let got = await getMeeting(user, m.id);
  assert.equal(got.status, 'ready');
  assert.equal(got.summary, null);
  assert.equal(got.lines.length, 3);
  assert.match(got.error, /summary could not be written/);

  fakes();
  await resummarize(user, m.id);
  await settled();
  got = await getMeeting(user, m.id);
  assert.equal(got.error, null);
  assert.equal(got.summary.title, 'Q4 rent review');
});

test('deleting a meeting removes its lines and its audio', async () => {
  const { user } = await setup();
  const m = await createMeeting(user, {});
  await addPart(user, m.id, { seq: 0, offset: 0, buffer: audio, mimetype: 'audio/webm' });
  await settled();
  const { path } = await db.prepare('SELECT path FROM meeting_parts WHERE meeting_id = ?').get(m.id);
  assert.ok(existsSync(path));
  const other = await makeUser('Other');
  assert.equal(await deleteMeeting(other, m.id), false, 'not someone else\'s to delete');
  assert.equal(await deleteMeeting(user, m.id), true);
  assert.equal(existsSync(path), false);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM meeting_lines').get()).n, 0);
  assert.deepEqual(await listMeetings(user), []);
});

// ---------- reading it back ----------

test('one voice talking in a row reads as one turn', () => {
  const lines = [
    { start_s: 0, end_s: 2, speaker: 'Boss', text: 'Right.' },
    { start_s: 2.5, end_s: 4, speaker: 'Boss', text: 'Next item.' },
    { start_s: 5, end_s: 6, speaker: null, text: 'Yes.' },
  ];
  assert.equal(turns(lines).length, 2);
  assert.equal(transcriptText(lines), '[00:00] Boss: Right. Next item.\n[00:05] Someone else: Yes.');
  assert.equal(clock(3725), '01:02:05');
});

test('an agent can find the meeting and what Francis promised', async () => {
  const { user, boss, francis } = await setup();
  const m = await createMeeting(user, { speakers: [boss.id, francis.id] });
  await addPart(user, m.id, { seq: 0, offset: 0, buffer: audio, mimetype: 'audio/webm' });
  await finishMeeting(user, m.id);
  await settled();

  const kit = meetingKit(user);
  const list = await kit.run({ id: 't1', name: 'list_meetings', input: {} });
  assert.match(list.content, new RegExp(`#${m.id} Q4 rent review`));
  const read = await kit.run({ id: 't2', name: 'read_meeting', input: { id: m.id, search: 'Wednesday' } });
  assert.match(read.content, /Francis: Send the report \(by Wednesday\)/);
  assert.match(read.content, /Francis: I'll send it Wednesday\./);

  const other = await makeUser('Other');
  const theirs = await meetingKit(other).run({ id: 't3', name: 'read_meeting', input: { id: m.id } });
  assert.equal(theirs.is_error, true, 'another user\'s meeting is not there');
});
