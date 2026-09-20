// Promote an existing account to master. Role lives on the account, not in an env var,
// so changing the email address never costs the role.
//   node scripts/make-master.js someone@example.com
import { db, closeDb } from '../server/db.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: node scripts/make-master.js <email>');
  process.exit(1);
}

const user = await db.prepare('SELECT id, name, email, role FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No account with the email ${email}.`);
  await closeDb();
  process.exit(1);
}

const existing = await db.prepare("SELECT email FROM users WHERE role = 'master' AND id <> ?").all(user.id);
if (existing.length) {
  console.log(`Note: already master - ${existing.map((u) => u.email).join(', ')}`);
}

await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(user.id);
console.log(`${user.name} <${user.email}> is now master.`);
await closeDb();
