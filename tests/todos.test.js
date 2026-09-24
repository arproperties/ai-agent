import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, makeDoc, closeDb } from './helpers/db.js';
import { remindAt, createTodo, listTodos, dueTodos, getTodo, updateTodo, deleteTodo, todoKit } from '../server/todos.js';

test.after(() => closeDb());

const secs = (ms) => Math.round(ms / 1000);
const inHours = (h) => secs(Date.now() + h * 3600_000);

// ---------- reading a time off whatever wrote it ----------

test('remindAt takes epoch seconds as they are', () => {
  assert.equal(remindAt(1790000000), 1790000000);
});

test('remindAt reads a millisecond timestamp as the same moment, not the year 56000', () => {
  assert.equal(remindAt(1790000000000), 1790000000);
});

test('remindAt honours an offset that is written down', () => {
  assert.equal(remindAt('2026-10-05T09:00:00+04:00'), Date.parse('2026-10-05T05:00:00Z') / 1000);
  assert.equal(remindAt('2026-10-05T09:00:00Z'), Date.parse('2026-10-05T09:00:00Z') / 1000);
});

test('a time with no offset is the user\'s time, not the server\'s', () => {
  // The live server runs on UTC. Read there, "09:00" would land at 1pm in Dubai — which
  // is the whole reason this is pinned rather than left to the host's clock.
  assert.equal(remindAt('2026-10-05T09:00:00'), Date.parse('2026-10-05T05:00:00Z') / 1000);
});

test('a bare date means that morning, not midnight', () => {
  assert.equal(remindAt('2026-10-05'), Date.parse('2026-10-05T05:00:00Z') / 1000, '09:00 Dubai');
});

test('no reminder is a real answer, and nonsense is not', () => {
  for (const empty of [null, undefined, '']) assert.equal(remindAt(empty), null);
  assert.throws(() => remindAt('whenever I get round to it'), /not a date and time/);
});

// ---------- the list ----------

test('a todo needs something to do', async () => {
  await reset();
  const user = await makeUser('Sara');
  await assert.rejects(() => createTodo(user, { text: '   ' }), /needs something to do/);
});

test('open todos lead with what is due soonest and end with what has no reminder', async () => {
  await reset();
  const user = await makeUser('Sara');
  const noDate = await createTodo(user, { text: 'Tidy the shelf' });
  const later = await createTodo(user, { text: 'Renew the tenancy', remind_at: inHours(200) });
  const soon = await createTodo(user, { text: 'Call the bank', remind_at: inHours(2) });

  const rows = await listTodos(user, { done: false });
  assert.deepEqual(rows.map((t) => t.id), [soon.id, later.id, noDate.id]);
});

test('a reminder is optional — a todo without one is still a todo', async () => {
  await reset();
  const user = await makeUser('Sara');
  const t = await createTodo(user, { text: 'Think about the office move' });
  assert.equal(t.remind_at, null);
  assert.equal((await listTodos(user)).length, 1);
  assert.equal((await dueTodos(user)).length, 0, 'nothing to be due about');
});

test('due means the reminder time has passed and the todo has not been ticked', async () => {
  await reset();
  const user = await makeUser('Sara');
  const past = await createTodo(user, { text: 'Pay the DEWA bill', remind_at: inHours(-3) });
  await createTodo(user, { text: 'Book the flights', remind_at: inHours(3) });
  await createTodo(user, { text: 'Wash the car' });
  const ticked = await createTodo(user, { text: 'Collect the visa', remind_at: inHours(-30) });
  await updateTodo(user, ticked.id, { done: true });

  assert.deepEqual((await dueTodos(user)).map((t) => t.id), [past.id]);
});

test('ticking one off moves it to the done list, and re-opening brings it back', async () => {
  await reset();
  const user = await makeUser('Sara');
  const t = await createTodo(user, { text: 'Send the invoice', remind_at: inHours(-1) });

  const done = await updateTodo(user, t.id, { done: true });
  assert.equal(done.done, true);
  assert.ok(done.done_at, 'the moment it was ticked is recorded');
  assert.equal(done.remind_at, t.remind_at, 'ticking it off does not throw the reminder away');
  assert.deepEqual((await listTodos(user, { done: false })).map((x) => x.id), []);
  assert.deepEqual((await listTodos(user, { done: true })).map((x) => x.id), [t.id]);

  const reopened = await updateTodo(user, t.id, { done: false });
  assert.equal(reopened.done, false);
  assert.equal(reopened.done_at, null, 'a reopened todo carries no stale completion time');
  assert.deepEqual((await dueTodos(user)).map((x) => x.id), [t.id]);
});

test('an edit only touches the fields it was given', async () => {
  await reset();
  const user = await makeUser('Sara');
  const t = await createTodo(user, { text: 'Renew the trade licence', notes: 'DED, ref 55-3', remind_at: inHours(48) });

  const edited = await updateTodo(user, t.id, { text: 'Renew the trade licence (Ajman)' });
  assert.equal(edited.notes, 'DED, ref 55-3');
  assert.equal(edited.remind_at, t.remind_at);

  const cleared = await updateTodo(user, t.id, { remind_at: '' });
  assert.equal(cleared.remind_at, null, 'a reminder can be dropped without losing the todo');
  assert.equal(cleared.text, 'Renew the trade licence (Ajman)');
  assert.equal(cleared.done, false);
});

// ---------- one list never reaches another ----------

test('todos never cross between accounts', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const omar = await makeUser('Omar');
  const his = await createTodo(omar, { text: 'His own problem', remind_at: inHours(-1) });

  assert.equal((await listTodos(sara)).length, 0);
  assert.equal((await dueTodos(sara)).length, 0);
  assert.equal(await getTodo(sara, his.id), undefined);
  assert.equal(await updateTodo(sara, his.id, { done: true }), null, 'she cannot tick off his todo');
  assert.equal(await deleteTodo(sara, his.id), false, 'nor delete it');
  assert.equal((await getTodo(omar, his.id)).done, false, 'and it is untouched');
});

test('a file from another account is not linked, but the todo is still kept', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const omar = await makeUser('Omar');
  const hisDoc = await makeDoc(omar, null, 'his-licence.pdf');

  const t = await createTodo(sara, { text: 'Renew the licence', documentId: hisDoc });
  assert.equal(t.document_id, null, 'the link is dropped, not honoured');
  assert.equal(t.text, 'Renew the licence');
});

test('a todo links to the file it is about', async () => {
  await reset();
  const user = await makeUser('Sara');
  const doc = await makeDoc(user, null, 'trade-licence.pdf');
  const t = await createTodo(user, { text: 'Renew it', documentId: doc });
  assert.equal(t.document_id, doc);
  assert.equal((await listTodos(user))[0].doc_name, 'trade-licence.pdf', 'the list says which file');
});

test('losing the agent that raised a todo does not lose the todo', async () => {
  await reset();
  const user = await makeUser('Sara');
  const hr = await makeAgent(user, 'HR');
  const t = await createTodo(user, { text: 'Renew the labour card', agentId: hr });
  assert.equal((await getTodo(user, t.id)).agent_name, 'HR');

  await db.prepare('DELETE FROM agents WHERE id = ?').run(hr);
  const after = await getTodo(user, t.id);
  assert.ok(after, 'the task outlives the agent');
  assert.equal(after.agent_id, null);
});

test('deleting the account takes its todos with it', async () => {
  await reset();
  const user = await makeUser('Sara');
  await createTodo(user, { text: 'Something private' });
  await db.prepare('DELETE FROM users WHERE id = ?').run(user);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM todos').get()).n, 0);
});

// ---------- what the agents can do ----------

const call = (kit, name, input) => kit.run({ id: `tu_${name}`, name, input });

test('an agent writes a todo down and is told not to promise an alert', async () => {
  await reset();
  const user = await makeUser('Sara');
  const hr = await makeAgent(user, 'HR');
  const kit = todoKit(user, { agentId: hr, conversationId: null });

  const out = await call(kit, 'add_todo', { text: 'Renew the trade licence', remind_at: '2026-10-05T09:00:00+04:00' });
  assert.equal(out.is_error, undefined);
  assert.match(out.content, /Added as todo #1/);
  assert.match(out.content, /cannot notify them elsewhere/, 'the tool result refuses to let the agent promise a ping');

  const [t] = await listTodos(user);
  assert.equal(t.text, 'Renew the trade licence');
  assert.equal(t.agent_id, hr, 'who raised it is recorded');
  assert.equal(t.remind_at, Date.parse('2026-10-05T05:00:00Z') / 1000);
});

test('a todo added without a time gets no reminder', async () => {
  await reset();
  const user = await makeUser('Sara');
  const kit = todoKit(user, {});
  await call(kit, 'add_todo', { text: 'Look into new office space' });
  assert.equal((await listTodos(user))[0].remind_at, null);
});

test('list_todos reads the list back with its ids, and says so when it is empty', async () => {
  await reset();
  const user = await makeUser('Sara');
  const kit = todoKit(user, {});
  assert.match((await call(kit, 'list_todos', {})).content, /list is empty/);

  const overdue = await createTodo(user, { text: 'Pay the fine', remind_at: inHours(-5) });
  await createTodo(user, { text: 'Read the contract' });

  const all = (await call(kit, 'list_todos', {})).content;
  assert.match(all, new RegExp(`#${overdue.id} Pay the fine`));
  assert.match(all, /DUE since/);
  assert.match(all, /Read the contract/);

  const only = (await call(kit, 'list_todos', { due_only: true })).content;
  assert.match(only, /Pay the fine/);
  assert.doesNotMatch(only, /Read the contract/, 'due_only means due only');
});

test('an agent ticks a todo off and reschedules one', async () => {
  await reset();
  const user = await makeUser('Sara');
  const kit = todoKit(user, {});
  const t = await createTodo(user, { text: 'Call the landlord', remind_at: inHours(1) });

  const moved = await call(kit, 'reschedule_todo', { id: t.id, remind_at: '2026-12-01T15:30:00+04:00' });
  assert.equal(moved.is_error, undefined);
  assert.equal((await getTodo(user, t.id)).remind_at, Date.parse('2026-12-01T11:30:00Z') / 1000);

  const dropped = await call(kit, 'reschedule_todo', { id: t.id, remind_at: '' });
  assert.match(dropped.content, /no longer has a reminder/);
  assert.equal((await getTodo(user, t.id)).remind_at, null);

  const ticked = await call(kit, 'complete_todo', { id: t.id });
  assert.match(ticked.content, /Ticked off/);
  assert.equal((await getTodo(user, t.id)).done, true);
});

test('an agent cannot reach a todo on somebody else\'s list', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const omar = await makeUser('Omar');
  const his = await createTodo(omar, { text: 'His own problem' });
  const kit = todoKit(sara, {}); // Sara's agent, Omar's id

  const out = await call(kit, 'complete_todo', { id: his.id });
  assert.equal(out.is_error, true);
  assert.match(out.content, /no todo #/);
  assert.equal((await getTodo(omar, his.id)).done, false);
});

test('a tool failure comes back as a tool_result, not as a thrown turn', async () => {
  await reset();
  const user = await makeUser('Sara');
  const kit = todoKit(user, {});
  const out = await call(kit, 'add_todo', { text: 'Something', remind_at: 'next Thursdayish' });
  assert.equal(out.is_error, true);
  assert.equal(out.tool_use_id, 'tu_add_todo');
  assert.match(out.content, /not a date and time/);
  assert.equal((await listTodos(user)).length, 0, 'nothing half-written was left behind');
});

test('the todo tools are offered under the names the handlers answer to', () => {
  const kit = todoKit(1, {});
  assert.deepEqual(kit.definitions.map((d) => d.name), ['add_todo', 'list_todos', 'complete_todo', 'reschedule_todo']);
  for (const d of kit.definitions) assert.ok(kit.status(d.name), `${d.name} has a status label`);
  assert.equal(kit.status('search_email'), null, 'and says nothing about tools that are not its own');
});
