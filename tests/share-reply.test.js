import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { messengerHandlers as h } from '../server/messenger.js';

test.after(() => closeDb());

// The same express double the other messenger tests use.
async function call(handler, { user, params = {}, query = {}, body = {}, file } = {}) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
  let failed = null;
  await Promise.resolve(handler({ user, params, query, body, file }, res, (e) => { failed = e; }))
    .catch((e) => { failed = e; });
  if (failed) return { status: failed.status || 500, body: { error: failed.message } };
  return { status: res.statusCode, body: res.body };
}

function connect(user) {
  const events = [];
  let onClose;
  const res = {
    set() {}, flushHeaders() {},
    write(frame) {
      const event = frame.match(/^event: (.*)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1];
      if (event) events.push({ event, data: JSON.parse(data) });
    },
  };
  h.events({ user, on: (e, fn) => { if (e === 'close') onClose = fn; } }, res);
  return { of: (name) => events.filter((e) => e.event === name).map((e) => e.data), close: () => onClose() };
}

async function person(name) {
  return { id: await makeUser(name), name };
}

/** One saved reply from `agentId`, in a conversation belonging to `user`. */
async function reply(user, agentId, content) {
  const { id: convId } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id')
    .run(user.id, 'Monday meeting');
  const { id } = await db.prepare(`INSERT INTO messages (conversation_id, agent_id, role, content)
    VALUES (?, ?, 'assistant', ?) RETURNING id`).run(convId, agentId, content);
  return { id, convId };
}

test('a reply shared into a group arrives as a message, labelled with the agent who wrote it', async () => {
  await reset();
  const boss = await person('Boss');
  const tom = await person('Tom');
  const agent = await makeAgent(boss.id, 'Planner');
  const points = await reply(boss, agent, '1. Budget\n2. Hiring');

  const chat = (await call(h.create, { user: boss, body: { name: 'Team', members: [tom.id] } })).body;
  const tomApp = connect(tom);

  const shared = await call(h.share, { user: boss, params: { id: chat.id }, body: { messageId: points.id } });
  assert.equal(shared.status, 200, shared.body.error);
  assert.equal(shared.body.body, '1. Budget\n2. Hiring');
  assert.equal(shared.body.userId, boss.id, 'it is sent by the person who shared it');
  assert.equal(shared.body.sharedFrom, 'Planner', 'the bubble says the words are the agent\'s');

  const seen = tomApp.of('message').filter((m) => m.kind !== 'system');
  assert.equal(seen.length, 1, 'it reaches the group live');
  assert.equal(seen[0].sharedFrom, 'Planner');

  const list = (await call(h.messages, { user: tom, params: { id: chat.id } })).body.messages;
  assert.equal(list.at(-1).sharedFrom, 'Planner', 'and it is still labelled when the chat is opened later');
  tomApp.close();
});

test('only the reply travels: the question that produced it is not sent', async () => {
  await reset();
  const boss = await person('Boss');
  const tom = await person('Tom');
  const agent = await makeAgent(boss.id, 'Planner');
  const { id: messageId, convId } = await reply(boss, agent, 'The points');
  await db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`)
    .run(convId, 'something private I asked');

  const chat = (await call(h.create, { user: boss, body: { name: 'Team', members: [tom.id] } })).body;
  await call(h.share, { user: boss, params: { id: chat.id }, body: { messageId } });

  const list = (await call(h.messages, { user: tom, params: { id: chat.id } })).body.messages;
  const bodies = list.map((m) => m.body).join('\n');
  assert.match(bodies, /The points/);
  assert.doesNotMatch(bodies, /something private/);
});

test('you can only share your own reply, and only into a chat you are in', async () => {
  await reset();
  const boss = await person('Boss');
  const tom = await person('Tom');
  const eve = await person('Eve');
  const agent = await makeAgent(boss.id, 'Planner');
  const points = await reply(boss, agent, 'The points');
  const chat = (await call(h.create, { user: boss, body: { name: 'Team', members: [tom.id] } })).body;

  assert.equal((await call(h.share, { user: eve, params: { id: chat.id }, body: { messageId: points.id } })).status, 404,
    'an outsider cannot share into the chat');
  assert.equal((await call(h.share, { user: tom, params: { id: chat.id }, body: { messageId: points.id } })).status, 404,
    'a member cannot pass on somebody else\'s reply');
  assert.equal((await call(h.share, { user: boss, params: { id: chat.id }, body: { messageId: 99999 } })).status, 404);
});

test('what was shared stays put when the agent is deleted or the sender clears their history', async () => {
  await reset();
  const boss = await person('Boss');
  const tom = await person('Tom');
  const agent = await makeAgent(boss.id, 'Planner');
  const points = await reply(boss, agent, 'The points');
  const chat = (await call(h.create, { user: boss, body: { name: 'Team', members: [tom.id] } })).body;
  await call(h.share, { user: boss, params: { id: chat.id }, body: { messageId: points.id } });

  await db.prepare('DELETE FROM agents WHERE id = ?').run(agent);
  await db.prepare('DELETE FROM conversations WHERE id = ?').run(points.convId);

  const list = (await call(h.messages, { user: tom, params: { id: chat.id } })).body.messages;
  assert.equal(list.at(-1).body, 'The points');
  assert.equal(list.at(-1).sharedFrom, 'Planner', 'the label is a copy, so it outlives the agent');
});
