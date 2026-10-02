import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeGroup, closeDb } from './helpers/db.js';
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

  const g = (await call(h.create, { user: sara, body: { groupId: await makeGroup(sara), name: 'Office', members: [tom.id, ali.id] } })).body;

  assert.equal(g.kind, 'group');
  assert.equal(g.name, 'Office');
  assert.equal(g.members.length, 3);
  assert.equal(g.members.find((m) => m.id === sara.id).role, 'admin');
  assert.ok(t.of('chat').some((c) => c.id === g.id));
  assert.match(g.last.body, /Sara created the topic/);
  t.close();
});

test('a group needs a name and at least one other person', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  assert.equal((await call(h.create, { user: sara, body: { groupId: await makeGroup(sara), name: '', members: [tom.id] } })).status, 400);
  assert.equal((await call(h.create, { user: sara, body: { groupId: await makeGroup(sara), name: 'Solo', members: [] } })).status, 400);
});

test('a group message reaches every member', async () => {
  await reset();
  const [sara, tom, ali] = await people('Sara', 'Tom', 'Ali');
  const g = (await call(h.create, { user: sara, body: { groupId: await makeGroup(sara), name: 'Office', members: [tom.id, ali.id] } })).body;
  const t = connect(tom); const a = connect(ali);

  await call(h.send, { user: sara, params: { id: g.id }, body: { body: 'meeting at 3' } });

  assert.ok(t.of('message').some((m) => m.body === 'meeting at 3'));
  assert.ok(a.of('message').some((m) => m.body === 'meeting at 3'));
  t.close(); a.close();
});

test('only admins add or remove people, but anyone can leave', async () => {
  await reset();
  const [sara, tom, ali, zed] = await people('Sara', 'Tom', 'Ali', 'Zed');
  const g = (await call(h.create, { user: sara, body: { groupId: await makeGroup(sara), name: 'Office', members: [tom.id, ali.id] } })).body;

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
  const g = (await call(h.create, { user: sara, body: { groupId: await makeGroup(sara), name: 'Office', members: [tom.id] } })).body;
  for (let i = 0; i < 5; i++) await call(h.send, { user: sara, params: { id: g.id }, body: { body: `old ${i}` } });

  await call(h.addMembers, { user: sara, params: { id: g.id }, body: { userIds: [zed.id] } });

  assert.equal((await call(h.get, { user: zed, params: { id: g.id } })).body.unread, 0);
});

test('when the last admin leaves, someone else becomes admin', async () => {
  await reset();
  const [sara, tom, ali] = await people('Sara', 'Tom', 'Ali');
  const g = (await call(h.create, { user: sara, body: { groupId: await makeGroup(sara), name: 'Office', members: [tom.id, ali.id] } })).body;

  await call(h.removeMember, { user: sara, params: { id: g.id, userId: sara.id } });

  const after = (await call(h.get, { user: tom, params: { id: g.id } })).body;
  assert.equal(after.members.filter((m) => m.role === 'admin').length, 1);
});

test('when the last person leaves, the group is gone', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const g = (await call(h.create, { user: sara, body: { groupId: await makeGroup(sara), name: 'Pair', members: [tom.id] } })).body;

  await call(h.removeMember, { user: sara, params: { id: g.id, userId: sara.id } });
  await call(h.removeMember, { user: tom, params: { id: g.id, userId: tom.id } });

  assert.equal(await db.prepare('SELECT 1 FROM dm_chats WHERE id = ?').get(g.id), undefined);
});

test('any member can rename a group, and everyone sees it', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const g = (await call(h.create, { user: sara, body: { groupId: await makeGroup(sara), name: 'Office', members: [tom.id] } })).body;
  const s = connect(sara);

  const r = await call(h.rename, { user: tom, params: { id: g.id }, body: { name: 'Head office' } });

  assert.equal(r.body.name, 'Head office');
  assert.ok(s.of('chat').some((c) => c.id === g.id));
  assert.match(s.of('message').at(-1).body, /Tom renamed the topic to "Head office"/);
  s.close();
});

// ---------- groups of topics ----------
test('only the master creates a group, and it starts with nobody in it', async () => {
  await reset();
  const [boss, tom] = await people('Boss', 'Tom');
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  boss.role = 'master';

  assert.equal((await call(h.createGroup, { user: tom, body: { name: 'Sales' } })).status, 403);
  const g = (await call(h.createGroup, { user: boss, body: { name: 'Sales' } })).body;
  assert.equal(g.name, 'Sales');
  assert.deepEqual((await call(h.groups, { user: boss })).body.map((x) => x.name), ['Sales']);
  assert.deepEqual((await call(h.groups, { user: tom })).body, [], 'nobody else sees an empty group');
});

test('anyone in a group can add a topic, the master is always in it, and nobody else sees it', async () => {
  await reset();
  const [boss, tom, ali, zed] = await people('Boss', 'Tom', 'Ali', 'Zed');
  const groupId = await makeGroup(boss, 'Sales');
  const leads = (await call(h.create, { user: boss, body: { groupId, name: 'Leads', members: [tom.id] } })).body;
  assert.equal(leads.groupId, groupId);
  assert.equal(leads.groupName, 'Sales');

  // Zed has no topic in Sales, so it is not his to add to.
  assert.equal((await call(h.create, { user: zed, body: { groupId, name: 'Mine', members: [ali.id] } })).status, 404);

  // Tom is in Sales through Leads, so he may start another topic, with anyone.
  const deals = (await call(h.create, { user: tom, body: { groupId, name: 'Deals', members: [ali.id] } })).body;
  assert.deepEqual(deals.members.map((m) => m.id).sort(), [boss.id, tom.id, ali.id].sort(), 'the master was put in too');

  const aliSees = (await call(h.list, { user: ali })).body.map((c) => c.name);
  assert.deepEqual(aliSees, ['Deals'], 'Ali sees only the topic he is in');
  assert.equal((await call(h.messages, { user: ali, params: { id: leads.id } })).status, 404);
  assert.deepEqual((await call(h.groups, { user: ali })).body.map((x) => x.name), ['Sales']);
  assert.deepEqual((await call(h.list, { user: boss })).body.map((c) => c.name).sort(), ['Deals', 'Leads']);
});

test('only the master deletes a group, and its topics and messages go for everyone', async () => {
  await reset();
  const [boss, tom] = await people('Boss', 'Tom');
  const groupId = await makeGroup(boss, 'Sales');
  const other = await makeGroup(boss, 'Office');
  const leads = (await call(h.create, { user: boss, body: { groupId, name: 'Leads', members: [tom.id] } })).body;
  const kept = (await call(h.create, { user: boss, body: { groupId: other, name: 'Desk', members: [tom.id] } })).body;
  await call(h.send, { user: tom, params: { id: leads.id }, body: { body: 'hi' } });
  await call(h.send, { user: tom, params: { id: kept.id }, body: { body: 'stay' } });

  assert.equal((await call(h.deleteGroup, { user: tom, params: { id: groupId } })).status, 403);
  const s = connect(tom);
  assert.equal((await call(h.deleteGroup, { user: boss, params: { id: groupId } })).status, 200);
  await tick();
  assert.deepEqual(s.of('removed'), [{ chatId: leads.id }], 'Tom is told the topic is gone');
  s.close();

  assert.deepEqual((await call(h.groups, { user: boss })).body.map((g) => g.name), ['Office']);
  assert.deepEqual((await call(h.list, { user: tom })).body.map((c) => c.name), ['Desk'], 'the other group is untouched');
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM dm_messages WHERE chat_id = ?').get(leads.id)).n, 0);
  assert.equal((await call(h.deleteGroup, { user: boss, params: { id: groupId } })).status, 404);
});

test('either person deletes a one-to-one chat, for both, and nobody outside it can', async () => {
  await reset();
  const [sara, tom, eve] = await people('Sara', 'Tom', 'Eve');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'hi' } });

  assert.equal((await call(h.deleteChat, { user: eve, params: { id: chat.id } })).status, 404);
  const s = connect(sara);
  assert.equal((await call(h.deleteChat, { user: tom, params: { id: chat.id } })).status, 200);
  await tick();
  assert.deepEqual(s.of('removed'), [{ chatId: chat.id }], 'Sara is told it is gone');
  s.close();

  assert.deepEqual((await call(h.list, { user: sara })).body, []);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM dm_messages WHERE chat_id = ?').get(chat.id)).n, 0);

  // a topic is not deleted this way: that is leaving it, or the master deleting its group
  const topic = (await call(h.create, { user: sara, body: { groupId: await makeGroup(sara), name: 'Office', members: [tom.id] } })).body;
  assert.equal((await call(h.deleteChat, { user: sara, params: { id: topic.id } })).status, 400);
});

test('a topic must go in a group', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  assert.equal((await call(h.create, { user: sara, body: { name: 'Loose', members: [tom.id] } })).status, 400);
});

test('nobody can take the master out of a topic but the master', async () => {
  await reset();
  const [boss, tom, ali] = await people('Boss', 'Tom', 'Ali');
  const groupId = await makeGroup(boss);
  const lead = (await call(h.create, { user: boss, body: { groupId, name: 'Leads', members: [tom.id] } })).body;
  const t = (await call(h.create, { user: tom, body: { groupId, name: 'Deals', members: [ali.id] } })).body;

  assert.equal((await call(h.removeMember, { user: tom, params: { id: t.id, userId: boss.id } })).status, 403);
  assert.equal((await call(h.removeMember, { user: boss, params: { id: lead.id, userId: boss.id } })).status, 200);
});

test('the master reads every topic of a group as one timeline', async () => {
  await reset();
  const [boss, tom, ali] = await people('Boss', 'Tom', 'Ali');
  const groupId = await makeGroup(boss);
  const a = (await call(h.create, { user: boss, body: { groupId, name: 'Leads', members: [tom.id] } })).body;
  const b = (await call(h.create, { user: boss, body: { groupId, name: 'Deals', members: [ali.id] } })).body;
  await call(h.send, { user: tom, params: { id: a.id }, body: { body: 'new lead' } });
  await call(h.send, { user: ali, params: { id: b.id }, body: { body: 'deal closed' } });

  const feed = (await call(h.groupMessages, { user: boss, params: { id: groupId } })).body.messages.filter((m) => m.kind !== 'system');
  assert.deepEqual(feed.map((m) => [m.body, m.chatId]), [['new lead', a.id], ['deal closed', b.id]]);
  assert.equal((await call(h.groupMessages, { user: tom, params: { id: groupId } })).status, 404, 'the one box is the master\'s');
});

test('one topic needs no guessing; with several, the answer is only ever one of the master\'s topics', async () => {
  await reset();
  const { pickTopic } = await import('../server/dmRoute.js');
  const [boss, tom, ali] = await people('Boss', 'Tom', 'Ali');
  const groupId = await makeGroup(boss);
  const a = (await call(h.create, { user: boss, body: { groupId, name: 'Leads', members: [tom.id] } })).body;
  const never = async () => { throw new Error('no call should be made'); };
  assert.deepEqual(await pickTopic(groupId, boss.id, 'hello', { model: never }), { chatId: a.id });

  const b = (await call(h.create, { user: boss, body: { groupId, name: 'Deals', members: [ali.id] } })).body;
  let shown = '';
  const model = async (prompt) => { shown = prompt; return '2'; };
  assert.deepEqual(await pickTopic(groupId, boss.id, 'Ali, close it', { model }), { chatId: b.id });
  assert.match(shown, /TOPIC 2: Deals\nMembers: .*Ali/);
  assert.deepEqual(await pickTopic(groupId, boss.id, 'hmm', { model: async () => '0' }), { chatId: null });
  assert.deepEqual(await pickTopic(groupId, boss.id, 'hmm', { model: async () => '7' }), { chatId: null });
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
