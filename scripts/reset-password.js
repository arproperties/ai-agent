// Admin fallback: set a user's password from the terminal.
// Usage: npm run reset-password -- someone@example.com NewPassword123
import { db } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('Usage: npm run reset-password -- <email> <new password (8+ characters)>');
  process.exit(1);
}
const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
if (!user) { console.error(`No account found for ${email}`); process.exit(1); }
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`Password updated for ${email}. They have been signed out everywhere.`);
process.exit(0);
