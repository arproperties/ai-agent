// Import this FIRST in every test file. server/db.js opens a pool and runs its DDL at
// import time, so DATABASE_URL has to be set before that module is loaded. The
// process.loadEnvFile() call in config.js does not override variables already present
// in the environment, so this wins over the project's .env without touching config.js.
import { randomBytes } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Create a throwaway database and point at it:\n' +
    '  createdb jarvis_test && psql -d jarvis_test -c "CREATE EXTENSION vector;"\n' +
    '  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/jarvis_test npm test'
  );
}

// reset() TRUNCATEs every table. Against the production database that is unrecoverable,
// so refuse to run unless the database is named like a test one. Checking the name
// rather than comparing against DATABASE_URL is deliberate: the project's .env has not
// been loaded at this point, so DATABASE_URL may still be unset here and a comparison
// would silently pass.
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!/_test$/.test(dbName)) {
  throw new Error(
    `Refusing to run: the test database must be named with a "_test" suffix (got "${dbName}").\n` +
    'Every test truncates every table.'
  );
}
process.env.DATABASE_URL = url;

const { db, tx, closeDb } = await import('../../server/db.js');
export { db, tx, closeDb };

const TABLES = [
  'users', 'sessions', 'password_resets', 'agents', 'agent_assignments', 'conversations', 'messages',
  'imports', 'documents', 'chunks', 'memories', 'outlook_accounts', 'imap_accounts', 'email_drafts', 'email_action_log',
  'dm_chats', 'dm_members', 'dm_messages',
];

/** Empty every table and restart the id sequences, so ids are predictable per test. */
export async function reset() {
  await db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function makeUser(name = 'Test') {
  const email = `${name.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`;
  const { id } = await db
    .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id')
    .run(email, name, 'not-a-real-hash');
  return id;
}

export async function makeAgent(userId, name) {
  const { id } = await db
    .prepare('INSERT INTO agents (user_id, name, persona) VALUES (?, ?, ?) RETURNING id')
    .run(userId, name, `You are ${name}.`);
  return id;
}

/** agentId null = the shared library. */
export async function makeDoc(userId, agentId, name) {
  const { id } = await db
    .prepare(`INSERT INTO documents (user_id, agent_id, name, title, status)
              VALUES (?, ?, ?, ?, 'ready') RETURNING id`)
    .run(userId, agentId, name, name);
  return id;
}
