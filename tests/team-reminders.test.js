import './helpers/push-env.js'; // before helpers/db.js: push.js reads the keys as it loads
import test from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { saveSubscription } from '../server/push.js';
import { proposeReminder, decideReminder, findPeople, inbox, markDone, getReminder, teamReminderKit, photoFor } from '../server/teamReminders.js';
import { runRemindersOnce } from '../server/reminders.js';

test.after(() => closeDb());

const posted = [];
webpush.sendNotification = async (sub, payload) => { posted.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); return { statusCode: 201 }; };
const now = () => Math.floor(Date.now() / 1000);

async function office() {
  await reset();
  posted.length = 0;
  const boss = await makeUser('Boss Man');
  const rona = await makeUser('Rona Khan');
  const tauqeer = await makeUser('Tauqeer Ali');
  for (const [id, n] of [[boss, 'b'], [rona, 'r'], [tauqeer, 't']]) {
    await saveSubscription(id, { endpoint: `https://push.example.com/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } }, n);
  }
  return { boss, rona, tauqeer };
}

test('names are found by first name, and an unknown or doubtful one is asked about', async () => {
  const { boss, rona } = await office();
  assert.deepEqual((await findPeople(boss, ['rona'])).map((u) => u.id), [rona]);
  await assert.rejects(findPeople(boss, ['Sara']), /Nobody called "Sara"/);
  await makeUser('Rona Das');
  await assert.rejects(findPeople(boss, ['Rona']), /could be Rona Das or Rona Khan/);
});

test('nothing reaches anyone until the sender taps Send', async () => {
  const { boss, rona, tauqeer } = await office();
  const r = await proposeReminder(boss, { text: 'Send the report', people: ['Rona', 'Tauqeer'] });
  assert.equal(r.status, 'pending');
  await runRemindersOnce();
  assert.equal(posted.length, 0);
  assert.equal((await inbox(rona)).length, 0);

  const sent = await decideReminder(boss, r.id, true);
  assert.equal(sent.status, 'delivered');
  assert.deepEqual(posted.map((p) => p.endpoint).sort(), ['https://push.example.com/r', 'https://push.example.com/t']);
  assert.equal(posted[0].title, 'Reminder from Boss Man');
  assert.equal((await inbox(tauqeer))[0].text, 'Send the report');
  await assert.rejects(decideReminder(boss, r.id, true), /already been sent/);
});

test('a timed one waits for its time, and goes once', async () => {
  const { boss, rona } = await office();
  const r = await proposeReminder(boss, { text: 'Later', people: ['Rona'], remind_at: now() + 3600 });
  await decideReminder(boss, r.id, true);
  await runRemindersOnce();
  assert.equal(posted.length, 0);

  await db.prepare('UPDATE team_reminders SET remind_at = ? WHERE id = ?').run(now() - 30, r.id);
  await runRemindersOnce();
  await runRemindersOnce();
  assert.equal(posted.length, 1);
  assert.equal((await inbox(rona)).length, 1);
});

test('everyone means everyone else, and the sender sees who has done it', async () => {
  const { boss, rona, tauqeer } = await office();
  const r = await proposeReminder(boss, { text: 'Office closes at 2', everyone: true });
  assert.equal(r.people.length, 2);
  assert.ok(!r.people.some((p) => p.id === boss));
  await decideReminder(boss, r.id, true);

  assert.equal(await markDone(rona, r.id), true);
  assert.equal(await markDone(boss, r.id), false); // not one of theirs to tick
  const after = await getReminder(boss, r.id);
  assert.deepEqual(after.people.map((p) => [p.name, p.done]), [['Rona Khan', true], ['Tauqeer Ali', false]]);
  assert.equal((await inbox(rona)).length, 0);
  assert.equal((await inbox(tauqeer)).length, 1);
});

test('cancelled goes nowhere, and nobody else can send your card', async () => {
  const { boss, rona } = await office();
  const r = await proposeReminder(boss, { text: 'Never mind', people: ['Rona'] });
  assert.equal(await decideReminder(rona, r.id, true), null);
  await decideReminder(boss, r.id, false);
  await runRemindersOnce();
  assert.equal(posted.length, 0);
  assert.equal(await markDone(rona, r.id), false);
});

test('the chat tool only proposes, and shows the card', async () => {
  const { boss } = await office();
  const cards = [];
  const kit = await teamReminderKit(boss, { onCard: (c) => cards.push(c) });
  assert.match(kit.definitions[0].description, /Rona Khan, Tauqeer Ali/);
  const out = await kit.run({ id: 't1', name: 'remind_people', input: { text: 'Send the report', people: ['rona', 'tauqeer'] } });
  assert.ok(!out.is_error, out.content);
  assert.match(out.content, /NOT sent yet/);
  assert.equal(cards.length, 1);
  assert.equal(posted.length, 0);
  const miss = await kit.run({ id: 't2', name: 'remind_people', input: { text: 'x', people: ['Zed'] } });
  assert.equal(miss.is_error, true);
});

// A photo the way one dropped into the chat lands: a row on the sender's Shelf, bytes on disk.
const dir = `${tmpdir()}/reem-team-reminder-test`;
async function shelve(userId, name, mime = 'image/jpeg') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await db.prepare('INSERT INTO documents (user_id, name, title, kind, mime, path) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, name, name, mime.startsWith('image/') ? 'image' : 'doc', mime, `${dir}/${name}`);
}

test('a photo attached in the chat goes on the reminder by its file name', async () => {
  const { boss, rona } = await office();
  await shelve(boss, 'leak.jpg');
  await shelve(boss, 'plan.pdf', 'application/pdf');
  await shelve(rona, 'hers.jpg');

  await assert.rejects(proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['nothing.jpg'] }), /no picture called "nothing.jpg"/);
  await assert.rejects(proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['hers.jpg'] }), /no picture called/, 'the file is someone else\'s');
  await assert.rejects(proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['plan.pdf'] }), /not a photo/);
  await assert.rejects(proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['leak.jpg', 'leak.jpg', 'leak.jpg', 'leak.jpg'] }), /at most 3/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM team_reminders').get()).n, 0, 'a reminder whose photo cannot be found is not written down');

  const r = await proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['LEAK.jpg'] });
  assert.deepEqual(r.photos.map((p) => p.name), ['leak.jpg']);
  assert.equal(r.photos[0].url, `/api/team-reminders/photos/${r.photos[0].id}`);
  assert.deepEqual((await proposeReminder(boss, { text: 'No picture', people: ['Rona'] })).photos, []);
});

test('the photo opens for the sender, and for the people it was sent to once it is sent - nobody else', async () => {
  const { boss, rona, tauqeer } = await office();
  await shelve(boss, 'leak.jpg');
  const r = await proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['leak.jpg'] });
  const id = r.photos[0].id;

  const mine = await photoFor(boss, id);
  assert.equal(mine.mime, 'image/jpeg');
  assert.notEqual(mine.path, `${dir}/leak.jpg`, 'its own copy, so clearing the Shelf does not empty the reminder');
  assert.ok(existsSync(mine.path));
  assert.ok(!await photoFor(rona, id), 'not before Send');

  await decideReminder(boss, r.id, true);
  assert.ok(await photoFor(rona, id));
  assert.ok(!await photoFor(tauqeer, id), 'not sent to him');
  assert.deepEqual((await inbox(rona))[0].photos, r.photos);
  assert.equal(posted[0].body, '📷 Fix this');
});

test('a cancelled reminder takes its photo with it', async () => {
  const { boss } = await office();
  await shelve(boss, 'leak.jpg');
  const r = await proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['leak.jpg'] });
  const { path } = await photoFor(boss, r.photos[0].id);
  const after = await decideReminder(boss, r.id, false);
  assert.deepEqual(after.photos, []);
  assert.ok(!existsSync(path));
  assert.ok(!await photoFor(boss, r.photos[0].id));
});

test('the chat tool takes photos and says how many are on the card', async () => {
  const { boss } = await office();
  await shelve(boss, 'leak.jpg');
  const kit = await teamReminderKit(boss, {});
  assert.ok(kit.definitions[0].input_schema.properties.photos);
  const out = await kit.run({ id: 't1', name: 'remind_people', input: { text: 'Fix this', people: ['rona'], photos: ['leak.jpg'] } });
  assert.ok(!out.is_error, out.content);
  assert.match(out.content, /with 1 photo/);
});
