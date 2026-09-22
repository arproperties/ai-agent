import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { messengerHandlers as h } from '../server/messenger.js';

test.after(() => closeDb());

// Minimal express double, the same shape as tests/email-routes.test.js.
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

/** Open the app for `user`: a fake live stream that records every event pushed to it. */
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
  return { events, of: (name) => events.filter((e) => e.event === name).map((e) => e.data), close: () => onClose() };
}

const tick = () => new Promise((r) => setTimeout(r, 30)); // let the fire-and-forget delivery run

async function people(...names) {
  return Promise.all(names.map(async (name) => ({ id: await makeUser(name), name })));
}

test('two people only ever share one one-to-one chat', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');

  const a = await call(h.create, { user: sara, body: { userId: tom.id } });
  const b = await call(h.create, { user: tom, body: { userId: sara.id } });

  assert.equal(a.status, 200);
  assert.equal(a.body.id, b.body.id);
  assert.equal(a.body.name, 'Tom', 'a direct chat is named after the other person');
  assert.equal(b.body.name, 'Sara');
});

test('an empty chat only appears for whoever opened it, until a message is sent', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;

  assert.equal((await call(h.list, { user: tom })).body.length, 0);
  await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'hi' } });
  const list = (await call(h.list, { user: tom })).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].unread, 1);
  assert.equal(list[0].last.body, 'hi');
});

test('you cannot message yourself', async () => {
  await reset();
  const [sara] = await people('Sara');
  assert.equal((await call(h.create, { user: sara, body: { userId: sara.id } })).status, 400);
});

test('someone outside a chat can neither read nor write in it', async () => {
  await reset();
  const [sara, tom, eve] = await people('Sara', 'Tom', 'Eve');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'private' } });

  assert.equal((await call(h.messages, { user: eve, params: { id: chat.id } })).status, 404);
  assert.equal((await call(h.send, { user: eve, params: { id: chat.id }, body: { body: 'x' } })).status, 404);
  assert.equal((await call(h.get, { user: eve, params: { id: chat.id } })).status, 404);
  assert.equal((await call(h.read, { user: eve, params: { id: chat.id }, body: { upTo: 999 } })).status, 404);
});

test('a message reaches the other person live, and is delivered at once when their app is open', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  const phone = connect(tom);

  const sent = (await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'are you there?', nonce: 'n1' } })).body;

  assert.deepEqual(phone.of('message').map((m) => m.body), ['are you there?']);
  assert.equal(sent.nonce, 'n1', 'the sender can match it to its "sending" bubble');
  const tomRow = (await call(h.get, { user: sara, params: { id: chat.id } })).body.members.find((m) => m.id === tom.id);
  assert.equal(tomRow.delivered, sent.id, 'two grey ticks');
  assert.equal(tomRow.read, 0, 'not blue yet');
  phone.close();
});

test('opening the app delivers what arrived while it was closed', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  const saraPhone = connect(sara);
  const sent = (await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'later' } })).body;

  const tomPhone = connect(tom);
  await tick();

  assert.ok(saraPhone.of('receipt').some((r) => r.userId === tom.id && r.delivered === sent.id));
  saraPhone.close(); tomPhone.close();
});

test('reading turns the ticks blue and clears the unread count', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'one' } });
  const two = (await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'two' } })).body;
  const saraPhone = connect(sara);

  await call(h.read, { user: tom, params: { id: chat.id }, body: { upTo: two.id } });

  assert.equal((await call(h.list, { user: tom })).body[0].unread, 0);
  assert.ok(saraPhone.of('receipt').some((r) => r.userId === tom.id && r.read === two.id));
  saraPhone.close();
});

test('read cannot be pushed past the last message in the chat', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  const m = (await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'hi' } })).body;

  await call(h.read, { user: tom, params: { id: chat.id }, body: { upTo: m.id + 1000 } });

  const tomRow = (await call(h.get, { user: sara, params: { id: chat.id } })).body.members.find((x) => x.id === tom.id);
  assert.equal(tomRow.read, m.id);
});

test('typing is shown to the others, not to the typist', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  const s = connect(sara); const t = connect(tom);

  await call(h.typing, { user: sara, params: { id: chat.id } });

  assert.equal(t.of('typing').length, 1);
  assert.equal(s.of('typing').length, 0);
  s.close(); t.close();
});

test('a reply carries a preview of the message it answers', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  const q = (await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'lunch at 1?' } })).body;

  const a = (await call(h.send, { user: tom, params: { id: chat.id }, body: { body: 'yes', replyTo: q.id } })).body;

  assert.equal(a.replyTo.id, q.id);
  assert.equal(a.replyTo.body, 'lunch at 1?');
  assert.equal(a.replyTo.userId, sara.id);
});

test('only the sender can delete a message, and it is deleted for everyone', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  const m = (await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'oops' } })).body;
  const phone = connect(tom);

  assert.equal((await call(h.remove, { user: tom, params: { id: m.id } })).status, 404);
  assert.equal((await call(h.remove, { user: sara, params: { id: m.id } })).status, 200);

  const [after] = (await call(h.messages, { user: tom, params: { id: chat.id } })).body.messages;
  assert.equal(after.deleted, true);
  assert.equal(after.body, '');
  assert.equal(phone.of('message').at(-1).deleted, true, 'the other phone hears about it live');
  phone.close();
});

test('an empty message is refused', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  assert.equal((await call(h.send, { user: sara, params: { id: chat.id }, body: { body: '   ' } })).status, 400);
});

test('older messages come back a page at a time', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  for (let i = 1; i <= 60; i++) await call(h.send, { user: sara, params: { id: chat.id }, body: { body: `m${i}` } });

  const first = (await call(h.messages, { user: tom, params: { id: chat.id } })).body;
  assert.equal(first.messages.length, 50);
  assert.equal(first.messages.at(-1).body, 'm60', 'newest last');
  assert.equal(first.more, true);

  const older = (await call(h.messages, { user: tom, params: { id: chat.id }, query: { before: first.messages[0].id } })).body;
  assert.deepEqual(older.messages.map((m) => m.body), Array.from({ length: 10 }, (_, i) => `m${i + 1}`));

  const since = (await call(h.messages, { user: tom, params: { id: chat.id }, query: { after: first.messages.at(-2).id } })).body;
  assert.deepEqual(since.messages.map((m) => m.body), ['m60'], 'catching up after a reconnect');
});

// ---------- groups ----------
test('a group starts with its creator as admin and tells the members', async () => {
  await reset();
  const [sara, tom, ali] = await people('Sara', 'Tom', 'Ali');
  const t = connect(tom);

  const g = (await call(h.create, { user: sara, body: { name: 'Office', members: [tom.id, ali.id] } })).body;

  assert.equal(g.kind, 'group');
  assert.equal(g.name, 'Office');
  assert.equal(g.members.length, 3);
  assert.equal(g.members.find((m) => m.id === sara.id).role, 'admin');
  assert.ok(t.of('chat').some((c) => c.id === g.id));
  assert.match(g.last.body, /Sara created the group/);
  t.close();
});

test('a group needs a name and at least one other person', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  assert.equal((await call(h.create, { user: sara, body: { name: '', members: [tom.id] } })).status, 400);
  assert.equal((await call(h.create, { user: sara, body: { name: 'Solo', members: [] } })).status, 400);
});

test('a group message reaches every member', async () => {
  await reset();
  const [sara, tom, ali] = await people('Sara', 'Tom', 'Ali');
  const g = (await call(h.create, { user: sara, body: { name: 'Office', members: [tom.id, ali.id] } })).body;
  const t = connect(tom); const a = connect(ali);

  await call(h.send, { user: sara, params: { id: g.id }, body: { body: 'meeting at 3' } });

  assert.ok(t.of('message').some((m) => m.body === 'meeting at 3'));
  assert.ok(a.of('message').some((m) => m.body === 'meeting at 3'));
  t.close(); a.close();
});

test('only admins add or remove people, but anyone can leave', async () => {
  await reset();
  const [sara, tom, ali, zed] = await people('Sara', 'Tom', 'Ali', 'Zed');
  const g = (await call(h.create, { user: sara, body: { name: 'Office', members: [tom.id, ali.id] } })).body;

  assert.equal((await call(h.addMembers, { user: tom, params: { id: g.id }, body: { userIds: [zed.id] } })).status, 403);
  assert.equal((await call(h.removeMember, { user: tom, params: { id: g.id, userId: ali.id } })).status, 403);

  const added = (await call(h.addMembers, { user: sara, params: { id: g.id }, body: { userIds: [zed.id] } })).body;
  assert.equal(added.members.length, 4);

  const z = connect(zed);
  assert.equal((await call(h.removeMember, { user: sara, params: { id: g.id, userId: zed.id } })).status, 200);
  assert.ok(z.of('removed').some((r) => r.chatId === g.id), 'the removed person\'s app drops the chat');
  assert.equal((await call(h.messages, { user: zed, params: { id: g.id } })).status, 404);
  z.close();

  assert.equal((await call(h.removeMember, { user: tom, params: { id: g.id, userId: tom.id } })).status, 200);
  assert.equal((await call(h.get, { user: tom, params: { id: g.id } })).status, 404);
});

test('someone added later does not inherit a pile of unread messages', async () => {
  await reset();
  const [sara, tom, zed] = await people('Sara', 'Tom', 'Zed');
  const g = (await call(h.create, { user: sara, body: { name: 'Office', members: [tom.id] } })).body;
  for (let i = 0; i < 5; i++) await call(h.send, { user: sara, params: { id: g.id }, body: { body: `old ${i}` } });

  await call(h.addMembers, { user: sara, params: { id: g.id }, body: { userIds: [zed.id] } });

  assert.equal((await call(h.get, { user: zed, params: { id: g.id } })).body.unread, 0);
});

test('when the last admin leaves, someone else becomes admin', async () => {
  await reset();
  const [sara, tom, ali] = await people('Sara', 'Tom', 'Ali');
  const g = (await call(h.create, { user: sara, body: { name: 'Office', members: [tom.id, ali.id] } })).body;

  await call(h.removeMember, { user: sara, params: { id: g.id, userId: sara.id } });

  const after = (await call(h.get, { user: tom, params: { id: g.id } })).body;
  assert.equal(after.members.filter((m) => m.role === 'admin').length, 1);
});

test('when the last person leaves, the group is gone', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const g = (await call(h.create, { user: sara, body: { name: 'Pair', members: [tom.id] } })).body;

  await call(h.removeMember, { user: sara, params: { id: g.id, userId: sara.id } });
  await call(h.removeMember, { user: tom, params: { id: g.id, userId: tom.id } });

  assert.equal(await db.prepare('SELECT 1 FROM dm_chats WHERE id = ?').get(g.id), undefined);
});

test('any member can rename a group, and everyone sees it', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const g = (await call(h.create, { user: sara, body: { name: 'Office', members: [tom.id] } })).body;
  const s = connect(sara);

  const r = await call(h.rename, { user: tom, params: { id: g.id }, body: { name: 'Head office' } });

  assert.equal(r.body.name, 'Head office');
  assert.ok(s.of('chat').some((c) => c.id === g.id));
  assert.match(s.of('message').at(-1).body, /Tom renamed the group to "Head office"/);
  s.close();
});

// ---------- presence ----------
test('opening and closing the app shows online and last seen', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const s = connect(sara);

  const t = connect(tom);
  assert.ok(s.of('presence').some((p) => p.userId === tom.id && p.online));
  assert.equal((await call(h.people, { user: sara })).body.find((p) => p.id === tom.id).online, true);

  t.close();
  const off = s.of('presence').find((p) => p.userId === tom.id && !p.online);
  assert.ok(off?.lastSeen, 'last seen is sent as they go');
  assert.equal((await call(h.people, { user: sara })).body.find((p) => p.id === tom.id).online, false);
  s.close();
});

test('a second open tab does not flicker someone offline when the first closes', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const s = connect(sara);
  const tab1 = connect(tom); const tab2 = connect(tom);

  tab1.close();
  assert.equal(s.of('presence').filter((p) => p.userId === tom.id && !p.online).length, 0);
  tab2.close();
  assert.equal(s.of('presence').filter((p) => p.userId === tom.id && !p.online).length, 1);
  s.close();
});

test('disabled accounts are not offered as people to message', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  await db.prepare('UPDATE users SET disabled = true WHERE id = ?').run(tom.id);
  assert.deepEqual((await call(h.people, { user: sara })).body, []);
  assert.equal((await call(h.create, { user: sara, body: { userId: tom.id } })).status, 404);
});

test('people-to-people messages never touch the AI chats', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'hello' } });

  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM conversations').get()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM messages').get()).n, 0);
});
