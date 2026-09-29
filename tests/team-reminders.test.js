import './helpers/push-env.js'; // before helpers/db.js: push.js reads the keys as it loads
import test from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { saveSubscription } from '../server/push.js';
import { proposeReminder, decideReminder, findPeople, inbox, markDone, getReminder, teamReminderKit } from '../server/teamReminders.js';
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
