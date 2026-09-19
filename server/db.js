import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { DATA_DIR, DATABASE_URL } from './config.js';

mkdirSync(DATA_DIR, { recursive: true }); // uploads and the embedding model still live on disk

if (!DATABASE_URL) throw new Error('DATABASE_URL is not set (postgres://user:pass@host:5432/dbname)');

// node-postgres hands back bigint and numeric as strings to avoid precision loss.
// Every such column here is a row id or a unix timestamp, both well inside Number.
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10, idle_in_transaction_session_timeout: 10000 });
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

// Inside tx() every query must run on that transaction's own connection, not a
// fresh one from the pool, or it would not be part of the transaction at all.
const inTx = new AsyncLocalStorage();
const run = (text, params) => (inTx.getStore() || pool).query(text, params);

// The queries are written with SQLite-style `?` placeholders; Postgres wants $1, $2…
const compiled = new Map();
function compile(sql) {
  let text = compiled.get(sql);
  if (!text) {
    let i = 0;
    text = sql.replace(/\?/g, () => `$${++i}`);
    compiled.set(sql, text);
  }
  return text;
}

/**
 * Same shape as the old node:sqlite statements, but every call is async.
 * `.run()` on an INSERT ... RETURNING id also gives back that id.
 */
export const db = {
  prepare(sql) {
    const text = compile(sql);
    return {
      get: async (...params) => (await run(text, params)).rows[0],
      all: async (...params) => (await run(text, params)).rows,
      run: async (...params) => {
        const r = await run(text, params);
        return { changes: r.rowCount, id: r.rows[0]?.id };
      },
    };
  },
  exec: (sql) => run(sql),
};

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await inTx.run(client, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const closeDb = () => pool.end();

const NOW = "extract(epoch from now())::bigint"; // unix seconds, matching the original schema

await db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT DEFAULT 'bot',
    color TEXT DEFAULT 'violet',
    persona TEXT DEFAULT '',
    model TEXT DEFAULT 'claude-sonnet-5',
    voice TEXT DEFAULT 'alloy',
    starters TEXT DEFAULT '[]',
    created_at BIGINT DEFAULT ${NOW}
  );

  -- a conversation belongs to the user; each reply records which agent wrote it
  CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    updated_at BIGINT DEFAULT ${NOW}
  );
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    files TEXT DEFAULT '[]',
    sources TEXT DEFAULT '[]',
    created_at BIGINT DEFAULT ${NOW}
  );

  -- files: agent_id NULL = shared library (visible to all the user's agents)
  CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    title TEXT,
    folder TEXT DEFAULT 'Other',
    summary TEXT,
    tags TEXT DEFAULT '[]',
    doc_date TEXT,
    hash TEXT,
    path TEXT,
    mime TEXT,
    kind TEXT,
    size INTEGER,
    status TEXT DEFAULT 'ready',
    error TEXT,
    created_at BIGINT DEFAULT ${NOW}
  );

  -- chunk/memory text is searched two ways: by meaning (embedding) and by keyword (tsvector)
  CREATE TABLE IF NOT EXISTS chunks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    embedding BYTEA,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
  );
  -- memories are about the user, so every agent shares them
  CREATE TABLE IF NOT EXISTS memories (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    embedding BYTEA,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    created_at BIGINT DEFAULT ${NOW}
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
  CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_docs_user ON documents(user_id);
  CREATE INDEX IF NOT EXISTS idx_docs_hash ON documents(user_id, hash);
  CREATE INDEX IF NOT EXISTS idx_chunks_user ON chunks(user_id, agent_id);
  CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING GIN(tsv);
  CREATE INDEX IF NOT EXISTS idx_mem_tsv ON memories USING GIN(tsv);
`);
