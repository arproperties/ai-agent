import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { actionsToTodos } from '../server/meetings.js';
import { listTodos, deleteTodo } from '../server/todos.js';

test.after(() => closeDb());

const ACTIONS = [
  { who: 'Francis', what: 'Send the renewal offers', when: 'Friday' },
  { who: 'Someone else', what: 'Check the parking list', when: '' },
  { who: 'Saba', what: 'Call the plumber', when: 'tomorrow' },
];

async function meeting(userId, actions = ACTIONS, title = 'Monday ops') {
  const { id } = await db.prepare(`INSERT INTO meetings (user_id, title, status, summary) VALUES (?, ?, 'ready', ?) RETURNING id`)
    .run(userId, title, JSON.stringify({ title, summary: 'About ops', decisions: [], actions }));
  return id;
}

test('every action goes on the person\'s own list, with the meeting and the rest in the notes', async () => {
  await reset();
  const me = await makeUser('Boss');
  const id = await meeting(me);
  const r = await actionsToTodos(me, id);
  assert.equal(r.added, 3);
  const todos = (await listTodos(me)).sort((a, b) => a.id - b.id);
  assert.deepEqual(todos.map((t) => t.text), ['Send the renewal offers', 'Check the parking list', 'Call the plumber']);
  assert.match(todos[0].notes, /From the meeting "Monday ops"/);
  assert.match(todos[0].notes, /Said for: Francis/);
  assert.match(todos[0].notes, /When: Friday/);
  assert.doesNotMatch(todos[1].notes, /Said for/); // a voice that was not identified is not a name
  assert.ok(r.meeting.summary.actions.every((a) => typeof a.todo_id === 'number'));
});

test('one action can be added by its place', async () => {
  await reset();
  const me = await makeUser('Boss');
  const id = await meeting(me);
  const r = await actionsToTodos(me, id, 2);
  assert.equal(r.added, 1);
  assert.deepEqual((await listTodos(me)).map((t) => t.text), ['Call the plumber']);
  assert.equal(r.meeting.summary.actions[0].todo_id, undefined);
  assert.equal(typeof r.meeting.summary.actions[2].todo_id, 'number');
});

test('pressing it twice does not make a second to-do', async () => {
  await reset();
  const me = await makeUser('Boss');
  const id = await meeting(me);
  await actionsToTodos(me, id);
  const again = await actionsToTodos(me, id);
  assert.equal(again.added, 0);
  assert.equal((await listTodos(me)).length, 3);
  assert.equal((await actionsToTodos(me, id, 1)).added, 0);
  assert.equal((await listTodos(me)).length, 3);
});

test('"add all" after one was added only adds the rest', async () => {
  await reset();
  const me = await makeUser('Boss');
  const id = await meeting(me);
  await actionsToTodos(me, id, 0);
  const r = await actionsToTodos(me, id);
  assert.equal(r.added, 2);
  assert.equal((await listTodos(me)).length, 3);
});

test('a to-do that was deleted can be added again', async () => {
  await reset();
  const me = await makeUser('Boss');
  const id = await meeting(me);
  const first = await actionsToTodos(me, id, 0);
  await deleteTodo(me, first.meeting.summary.actions[0].todo_id);
  assert.equal((await listTodos(me)).length, 0);
  const again = await actionsToTodos(me, id, 0);
  assert.equal(again.added, 1);
  assert.equal((await listTodos(me)).length, 1);
});

test('someone else\'s meeting is not theirs to put on a list', async () => {
  await reset();
  const owner = await makeUser('Owner');
  const other = await makeUser('Other');
  const id = await meeting(owner);
  assert.equal(await actionsToTodos(other, id), null);
  assert.deepEqual(await listTodos(other), []);
  assert.deepEqual(await listTodos(owner), []);
});

test('no actions, or no such action, is refused plainly', async () => {
  await reset();
  const me = await makeUser('Boss');
  const none = await meeting(me, []);
  await assert.rejects(actionsToTodos(me, none), /no action items/);
  const some = await meeting(me);
  await assert.rejects(actionsToTodos(me, some, 9), /no such action/);
  await assert.rejects(actionsToTodos(me, some, 'x'), /no such action/);
  assert.deepEqual(await listTodos(me), []);
});

test('a meeting with no summary yet is refused, not crashed on', async () => {
  await reset();
  const me = await makeUser('Boss');
  const { id } = await db.prepare(`INSERT INTO meetings (user_id, title, status) VALUES (?, 'Still recording', 'recording') RETURNING id`).run(me);
  await assert.rejects(actionsToTodos(me, id), /no action items/);
});
