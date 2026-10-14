import './helpers/push-env.js'; // before helpers/db.js: push.js reads the keys as it loads
import test from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { saveSubscription } from '../server/push.js';
import { proposeReminder, decideReminder, findPeople, getReminder, teamReminderKit, photoFor, assignTodo, bringOldRemindersIntoTodos } from '../server/teamReminders.js';
import { listTodos, dueTodos, updateTodo, deleteTodo } from '../server/todos.js';
import { runRemindersOnce } from '../server/reminders.js';

test.after(() => closeDb());

const posted = [];
webpush.sendNotification = async (sub, payload) => { posted.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); return { statusCode: 201 }; };
const now = () => Math.floor(Date.now() / 1000);
const giveTodos = (id) => db.prepare("INSERT INTO module_access (user_id, module) VALUES (?, 'todos')").run(id);

async function office() {
  await reset();
  posted.length = 0;
  const boss = await makeUser('Boss Man');
  const rona = await makeUser('Rona Khan');
  const tauqeer = await makeUser('Tauqeer Ali');
  for (const [id, n] of [[boss, 'b'], [rona, 'r'], [tauqeer, 't']]) {
    await saveSubscription(id, { endpoint: `https://push.example.com/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } }, n);
    await giveTodos(id);
  }
  return { boss, rona, tauqeer };
}

/** What someone else has given this person and they have not ticked: their own to-do list, filtered. */
const given = async (userId, done = false) => (await listTodos(userId, { done })).filter((t) => t.team_reminder_id);

test('names are found by first name, and an unknown or doubtful one is asked about', async () => {
  const { boss, rona } = await office();
  assert.deepEqual((await findPeople(boss, ['rona'])).map((u) => u.id), [rona]);
  await assert.rejects(findPeople(boss, ['Sara']), /Nobody called "Sara"/);
  const das = await makeUser('Rona Das');
  await giveTodos(das);
  await assert.rejects(findPeople(boss, ['Rona']), /could be Rona Das or Rona Khan/);
});

test('nothing reaches anyone until the sender taps Send', async () => {
  const { boss, rona, tauqeer } = await office();
  const r = await proposeReminder(boss, { text: 'Send the report', people: ['Rona', 'Tauqeer'] });
  assert.equal(r.status, 'pending');
  await runRemindersOnce();
  assert.equal(posted.length, 0);
  assert.equal((await given(rona)).length, 0);

  const sent = await decideReminder(boss, r.id, true);
  assert.equal(sent.status, 'delivered');
  assert.deepEqual(posted.map((p) => p.endpoint).sort(), ['https://push.example.com/r', 'https://push.example.com/t']);
  assert.equal(posted[0].title, 'To-do from Boss Man');
  assert.equal(posted[0].url, '/?todos=1');
  assert.equal((await given(tauqeer))[0].text, 'Send the report');
  await assert.rejects(decideReminder(boss, r.id, true), /already been sent/);
});

test('once sent, it is a to-do on each person\'s own list, due now, saying who it is from', async () => {
  const { boss, rona } = await office();
  const r = await proposeReminder(boss, { text: 'Send progress videos', people: ['Rona'] });
  await decideReminder(boss, r.id, true);
  const [t] = await listTodos(rona);
  assert.equal(t.text, 'Send progress videos');
  assert.equal(t.from_name, 'Boss Man');
  assert.equal(t.team_reminder_id, r.id);
  assert.equal((await dueTodos(rona)).length, 1, 'counted on the badge and the first screen straight away');
  assert.equal((await listTodos(boss)).length, 0, 'not on the sender\'s own list');

  // The to-do timer must not buzz a second time for what has just been delivered.
  posted.length = 0;
  await runRemindersOnce();
  assert.equal(posted.length, 0);
});

test('a timed one waits for its time, and goes once', async () => {
  const { boss, rona } = await office();
  const r = await proposeReminder(boss, { text: 'Later', people: ['Rona'], remind_at: now() + 3600 });
  await decideReminder(boss, r.id, true);
  await runRemindersOnce();
  assert.equal(posted.length, 0);
  assert.equal((await given(rona)).length, 0, 'not on her list before its time');

  await db.prepare('UPDATE team_reminders SET remind_at = ? WHERE id = ?').run(now() - 30, r.id);
  await runRemindersOnce();
  await runRemindersOnce();
  assert.equal(posted.length, 1);
  assert.equal((await given(rona)).length, 1);
});

test('everyone means everyone else, and ticking the to-do shows on the sender\'s card', async () => {
  const { boss, rona, tauqeer } = await office();
  const r = await proposeReminder(boss, { text: 'Office closes at 2', everyone: true });
  assert.equal(r.people.length, 2);
  assert.ok(!r.people.some((p) => p.id === boss));
  await decideReminder(boss, r.id, true);

  const [hers] = await given(rona);
  await updateTodo(rona, hers.id, { done: true });
  const after = await getReminder(boss, r.id);
  assert.deepEqual(after.people.map((p) => [p.name, p.done]), [['Rona Khan', true], ['Tauqeer Ali', false]]);
  assert.equal((await given(rona)).length, 0);
  assert.equal((await given(rona, true)).length, 1);
  assert.equal((await given(tauqeer)).length, 1);
  assert.equal(await updateTodo(boss, hers.id, { done: false }), null, 'not one of the sender\'s to tick');
});

test('a to-do someone gave you is ticked, not deleted', async () => {
  const { boss, rona } = await office();
  const r = await proposeReminder(boss, { text: 'Fix the sill', people: ['Rona'] });
  await decideReminder(boss, r.id, true);
  const [t] = await given(rona);
  await assert.rejects(deleteTodo(rona, t.id), /Boss Man is waiting/);
  assert.equal((await given(rona)).length, 1);
});

test('the whole of a long instruction arrives, not the first 300 letters', async () => {
  const { boss, rona } = await office();
  const long = 'Window sill silicone assessment: old sealant has failed, causing moisture ingress and mold staining on the frame and wall. '.repeat(5).trim();
  assert.ok(long.length > 500);
  const r = await proposeReminder(boss, { text: long, people: ['Rona'] });
  assert.equal(r.text, long);
  await decideReminder(boss, r.id, true);
  assert.equal((await given(rona))[0].text, long);
});

test('someone without the To-do list is named, not silently skipped; everyone leaves them out', async () => {
  const { boss } = await office();
  await makeUser('Hayley Stone');
  await assert.rejects(proposeReminder(boss, { text: 'x', people: ['Hayley'] }), /Hayley Stone does not have the To-do list/);
  const r = await proposeReminder(boss, { text: 'All hands', everyone: true });
  assert.deepEqual(r.people.map((p) => p.name), ['Rona Khan', 'Tauqeer Ali']);
});

test('cancelled goes nowhere, and nobody else can send your card', async () => {
  const { boss, rona } = await office();
  const r = await proposeReminder(boss, { text: 'Never mind', people: ['Rona'] });
  assert.equal(await decideReminder(rona, r.id, true), null);
  await decideReminder(boss, r.id, false);
  await runRemindersOnce();
  assert.equal(posted.length, 0);
  assert.equal((await given(rona)).length, 0);
});

test('a to-do typed by hand can be given to one person, and goes at once', async () => {
  const { boss, rona } = await office();
  const r = await assignTodo(boss, { text: 'Call the plumber', userId: rona });
  assert.equal(r.status, 'delivered');
  assert.equal((await given(rona))[0].from_name, 'Boss Man');
  assert.equal(posted.length, 1);
  await assert.rejects(assignTodo(boss, { text: 'x', userId: boss }), /someone else/);
  await assert.rejects(assignTodo(boss, { text: '', userId: rona }), /something to do/);
});

test('reminders sent before this change are brought onto each person\'s list, ticks and all, once', async () => {
  const { boss, rona, tauqeer } = await office();
  // The old way: delivered, with the tick on the person row and no to-do.
  const { id } = await db.prepare(`INSERT INTO team_reminders (sender_id, text, status, delivered_at)
      VALUES (?, 'Old one', 'delivered', ?) RETURNING id`).run(boss, now() - 86400);
  await db.prepare('INSERT INTO team_reminder_people (reminder_id, user_id, done, done_at) VALUES (?, ?, true, ?), (?, ?, false, NULL)')
    .run(id, rona, now() - 3600, id, tauqeer);
  await bringOldRemindersIntoTodos();
  await bringOldRemindersIntoTodos();

  assert.equal((await given(rona, true))[0].text, 'Old one');
  assert.equal((await given(tauqeer)).length, 1);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM todos').get()).n, 2);
  assert.deepEqual((await getReminder(boss, id)).people.map((p) => p.done), [true, false]);
  await runRemindersOnce();
  assert.equal(posted.length, 0, 'nobody is buzzed about yesterday');
});

test('someone who had old reminders but no To-do list is given the list, so nothing is lost - once', async () => {
  const { boss } = await office();
  const hayley = await makeUser('Hayley Stone'); // no To-do list
  const { id } = await db.prepare(`INSERT INTO team_reminders (sender_id, text, status, delivered_at)
      VALUES (?, 'Window sill silicone', 'delivered', ?) RETURNING id`).run(boss, now() - 86400);
  await db.prepare('INSERT INTO team_reminder_people (reminder_id, user_id) VALUES (?, ?)').run(id, hayley);
  await bringOldRemindersIntoTodos();

  const has = async () => !!(await db.prepare("SELECT 1 FROM module_access WHERE user_id = ? AND module = 'todos'").get(hayley));
  assert.ok(await has());
  assert.equal((await given(hayley))[0].text, 'Window sill silicone');

  // The master takes it away later; a restart does not put it back.
  await db.prepare('DELETE FROM module_access WHERE user_id = ?').run(hayley);
  await bringOldRemindersIntoTodos();
  assert.ok(!await has());
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

  await assert.rejects(proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['nothing.jpg'] }), /no picture or video called "nothing.jpg"/);
  await assert.rejects(proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['hers.jpg'] }), /no picture or video called/, 'the file is someone else\'s');
  await assert.rejects(proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['plan.pdf'] }), /not a photo or a video/);
  await assert.rejects(proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['leak.jpg', 'leak.jpg', 'leak.jpg', 'leak.jpg'] }), /at most 3/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM team_reminders').get()).n, 0, 'a reminder whose photo cannot be found is not written down');

  const r = await proposeReminder(boss, { text: 'Fix this', people: ['Rona'], photos: ['LEAK.jpg'] });
  assert.deepEqual(r.photos.map((p) => p.name), ['leak.jpg']);
  assert.equal(r.photos[0].url, `/api/team-reminders/photos/${r.photos[0].id}`);
  assert.equal(r.photos[0].mime, 'image/jpeg');
  assert.deepEqual((await proposeReminder(boss, { text: 'No picture', people: ['Rona'] })).photos, []);
});

test('a video attached in the chat goes along too, and shows on the to-do', async () => {
  const { boss, rona } = await office();
  await shelve(boss, 'sill.mp4', 'video/mp4');
  const r = await proposeReminder(boss, { text: 'See the video', people: ['Rona'], photos: ['sill.mp4'] });
  assert.equal(r.photos[0].mime, 'video/mp4');
  await decideReminder(boss, r.id, true);
  const [t] = await given(rona);
  assert.deepEqual(t.photos, r.photos);
  assert.ok(await photoFor(rona, r.photos[0].id));
  assert.equal(posted[0].body, '🎬 See the video');
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
  assert.deepEqual((await given(rona))[0].photos, r.photos);
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
  assert.match(out.content, /with 1 attachment/);
});
