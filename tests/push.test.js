import './helpers/push-env.js'; // before helpers/db.js: push.js reads the keys as it loads
import test from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { saveSubscription, removeSubscription, subscriptionsFor, sendPush, pushReady } from '../server/push.js';
import { messengerHandlers as h } from '../server/messenger.js';

test.after(() => closeDb());

// Nothing here talks to Apple or Google. web-push's one outward-facing call is replaced
// with a note of what it was asked to send, which is the part worth checking: who was
// about to be woken, and what the notice said.
const posted = [];
let answer = async () => ({ statusCode: 201 });
webpush.sendNotification = async (sub, payload) => {
  posted.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
  return answer(sub);
};
const fresh = () => { posted.length = 0; answer = async () => ({ statusCode: 201 }); };

const device = (n) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } });
const tick = () => new Promise((r) => setTimeout(r, 30)); // the push is fire-and-forget

test('the keys are in place, so notifications are possible at all', () => {
  assert.equal(pushReady(), true);
});

test('a device is remembered, and forgotten again', async () => {
  await reset();
  fresh();
  const me = await makeUser('Sara');

  await saveSubscription(me, device('phone'), 'iPhone');
  assert.equal((await subscriptionsFor(me)).length, 1);

  // The same phone saying so twice is the same phone, not two.
  await saveSubscription(me, device('phone'), 'iPhone');
  assert.equal((await subscriptionsFor(me)).length, 1);

  // A second device of the same person is a second row: each is allowed separately.
  await saveSubscription(me, device('laptop'), 'MacBook');
  assert.equal((await subscriptionsFor(me)).length, 2);

  await removeSubscription(me, device('phone').endpoint);
  assert.deepEqual((await subscriptionsFor(me)).map((r) => r.device), ['MacBook']);
});

test('signing in as someone else on the same phone moves the device to them', async () => {
  await reset();
  fresh();
  const [sara, tom] = [await makeUser('Sara'), await makeUser('Tom')];

  await saveSubscription(sara, device('shared'), 'the office iPad');
  await saveSubscription(tom, device('shared'), 'the office iPad');

  // Otherwise that iPad would keep buzzing with Sara's messages for Tom to read.
  assert.equal((await subscriptionsFor(sara)).length, 0);
  assert.equal((await subscriptionsFor(tom)).length, 1);
});

test('one person cannot switch off another person\'s device', async () => {
  await reset();
  fresh();
  const [sara, tom] = [await makeUser('Sara'), await makeUser('Tom')];
  await saveSubscription(sara, device('phone'), 'iPhone');

  await removeSubscription(tom, device('phone').endpoint);
  assert.equal((await subscriptionsFor(sara)).length, 1);
});

test('rubbish is refused rather than stored', async () => {
  await reset();
  const me = await makeUser('Sara');
  for (const bad of [null, {}, { endpoint: 'https://push.example.com/x' }, { endpoint: 'javascript:alert(1)', keys: { p256dh: 'a', auth: 'b' } }]) {
    await assert.rejects(() => saveSubscription(me, bad), /usable push subscription/);
  }
  assert.equal((await subscriptionsFor(me)).length, 0);
});

test('a notice goes to every device a person has switched on, and to nobody else', async () => {
  await reset();
  fresh();
  const [sara, tom] = [await makeUser('Sara'), await makeUser('Tom')];
  await saveSubscription(sara, device('phone'), 'iPhone');
  await saveSubscription(sara, device('laptop'), 'MacBook');

  const sent = await sendPush([sara, tom], { title: 'Tom', body: 'Are you in today?', url: '/?chat=4', tag: 'chat-4' });

  assert.equal(sent, 2); // both of Sara's; Tom has switched nothing on
  assert.deepEqual(posted.map((p) => p.endpoint).sort(), ['https://push.example.com/laptop', 'https://push.example.com/phone']);
  assert.equal(posted[0].title, 'Tom');
  assert.equal(posted[0].body, 'Are you in today?');
  assert.equal(posted[0].url, '/?chat=4');
});

test('a device that says it is gone for good is dropped', async () => {
  await reset();
  fresh();
  const me = await makeUser('Sara');
  await saveSubscription(me, device('deleted-app'), 'old iPhone');
  await saveSubscription(me, device('phone'), 'iPhone');

  // 410 Gone: the app was deleted or the permission revoked. Retrying it forever would
  // mean every future message paying for a request that can never succeed.
  answer = async (sub) => {
    if (sub.endpoint.endsWith('deleted-app')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    return { statusCode: 201 };
  };
  const sent = await sendPush([me], { title: 'Jarvis', body: 'Hello' });

  assert.equal(sent, 1);
  assert.deepEqual((await subscriptionsFor(me)).map((r) => r.device), ['iPhone']);
});

test('a push service having a bad morning does not lose the device', async () => {
  await reset();
  fresh();
  const me = await makeUser('Sara');
  await saveSubscription(me, device('phone'), 'iPhone');

  answer = async () => { throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 }); };
  assert.equal(await sendPush([me], { title: 'Jarvis', body: 'Hello' }), 0);
  assert.equal((await subscriptionsFor(me)).length, 1); // still there for next time
});

// ---------- the part that matters: a message arriving ----------

async function call(handler, { user, params = {}, query = {}, body = {}, file } = {}) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let failed = null;
  await Promise.resolve(handler({ user, params, query, body, file }, res, (e) => { failed = e; })).catch((e) => { failed = e; });
  if (failed) throw failed;
  return res.body;
}

/** Open the app for someone, so they count as online and get the live stream instead. */
function connect(user) {
  let onClose;
  h.events({ user, on: (e, fn) => { if (e === 'close') onClose = fn; } }, { set() {}, flushHeaders() {}, write() {} });
  return () => onClose();
}

test('a message wakes the people who are away, and nobody who is here', async () => {
  await reset();
  fresh();
  const sara = { id: await makeUser('Sara'), name: 'Sara' };
  const tom = { id: await makeUser('Tom'), name: 'Tom' };
  const ann = { id: await makeUser('Ann'), name: 'Ann' };
  for (const u of [sara, tom, ann]) await saveSubscription(u.id, device(u.name), u.name);

  const chat = await call(h.create, { user: sara, body: { name: 'Site works', members: [tom.id, ann.id] } });
  const watching = connect(ann); // Ann has the app open; Tom does not

  await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'Concrete arrives at seven' } });
  await tick();

  // Not Sara: she sent it. Not Ann: she is watching it arrive live.
  assert.deepEqual(posted.map((p) => p.endpoint), [`https://push.example.com/${tom.name}`]);
  assert.equal(posted[0].title, 'Sara · Site works');
  assert.equal(posted[0].body, 'Concrete arrives at seven');
  assert.equal(posted[0].url, `/?chat=${chat.id}`);
  watching();
});

test('a one-to-one notice is just the sender\'s name, and a file says what it is', async () => {
  await reset();
  fresh();
  const sara = { id: await makeUser('Sara'), name: 'Sara' };
  const tom = { id: await makeUser('Tom'), name: 'Tom' };
  await saveSubscription(tom.id, device('tom'), 'iPhone');

  const chat = await call(h.create, { user: sara, body: { userId: tom.id } });
  await call(h.send, {
    user: sara, params: { id: chat.id }, body: {},
    file: { originalname: 'tenancy.pdf', mimetype: 'application/pdf', size: 12, buffer: Buffer.from('a pdf, sort of') },
  });
  await tick();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].title, 'Sara'); // no chat name: there is only the one person
  assert.equal(posted[0].body, '📎 tenancy.pdf');
});

test('a message still sends when the push service is broken', async () => {
  await reset();
  fresh();
  const sara = { id: await makeUser('Sara'), name: 'Sara' };
  const tom = { id: await makeUser('Tom'), name: 'Tom' };
  await saveSubscription(tom.id, device('tom'), 'iPhone');
  answer = async () => { throw new Error('the whole push service is down'); };

  const chat = await call(h.create, { user: sara, body: { userId: tom.id } });
  const msg = await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'Still got through' } });
  await tick();

  // The message is what matters. The buzz is a nice-to-have on top of it.
  assert.equal(msg.body, 'Still got through');
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM dm_messages WHERE chat_id = ?').get(chat.id)).n, 1);
});
