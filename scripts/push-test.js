// Send one notification to somebody's phones, and say exactly what happened.
//   node --env-file=.env scripts/push-test.js saba@ainalreempro.com
//
// For when "it did not buzz" and the question is which half is at fault: whether the
// phone is registered at all, or whether the message path decided not to wake it. This
// skips the message path entirely and goes straight to the push service.
import { db, closeDb } from '../server/db.js';
import { sendPush, subscriptionsFor, pushReady } from '../server/push.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: node --env-file=.env scripts/push-test.js <email>');
  process.exit(1);
}

if (!pushReady()) {
  console.error('This server has no VAPID keys, so it cannot send anything. See the README.');
  await closeDb();
  process.exit(1);
}

const user = await db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No account with the email ${email}.`);
  await closeDb();
  process.exit(1);
}

const devices = await subscriptionsFor(user.id);
console.log(`${user.name} has ${devices.length} device(s) switched on:`);
for (const d of devices) console.log(`  - ${d.device || 'unnamed'} (added ${new Date(d.created_at * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })})`);
if (!devices.length) {
  console.log('\nNothing to send to. They have not tapped Allow on any device yet.');
  await closeDb();
  process.exit(0);
}

const sent = await sendPush([user.id], { title: 'Jarvis', body: 'Test notification — nothing is wrong.', url: '/', tag: 'push-test' });
console.log(`\nAccepted by the push service for ${sent} of ${devices.length} device(s).`);
console.log(sent ? 'If the phone still does not buzz, the fault is on the phone: notifications off for Jarvis in its settings, or a Focus mode.' : 'None were accepted — the reason is logged above.');
await closeDb();
