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

// Dimensions of Xenova/all-MiniLM-L6-v2, the local embedding model in ai.js.
// Changing the model means changing this and re-embedding everything.
export const EMBED_DIMS = 384;

// pgvector does the similarity search inside Postgres, against an index. Creating an
// extension needs superuser, which the app's role deliberately is not, so on a fresh
// database run once:  sudo -u postgres psql -d <db> -c 'CREATE EXTENSION vector;'
// Re-running it as a normal role once it exists is only a NOTICE, so boot stays safe.
if (!(await db.prepare("SELECT 1 FROM pg_extension WHERE extname = 'vector'").get())) {
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');
  } catch (e) {
    throw new Error(
      'The "vector" extension is required but not installed in this database. ' +
      `Install the package (apt-get install postgresql-16-pgvector) and run, as a superuser:\n` +
      "  CREATE EXTENSION vector;\n" + `(${e.message})`
    );
  }
}

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

  -- Access to an agent comes from an assignment, not from ownership. agents.user_id is
  -- the owner (the master); these rows are who may use it.
  --   mode 'chat'      - appears in the user's sidebar, the router may select it
  --   mode 'knowledge' - hidden agent, its shelf is readable in the background
  CREATE TABLE IF NOT EXISTS agent_assignments (
    agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    mode       TEXT    NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'knowledge')),
    is_primary BOOLEAN NOT NULL DEFAULT false,
    created_at BIGINT DEFAULT ${NOW},
    PRIMARY KEY (agent_id, user_id)
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
  -- agent_id is which shelf a file sits on, not who owns it - user_id is the owner.
  -- So it detaches when an agent goes, the way messages.agent_id already does; it must
  -- never take other people's files down with it.
  CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
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

  -- chunk/memory text is searched two ways: by meaning (embedding) and by keyword (tsvector).
  -- 384 dims = Xenova/all-MiniLM-L6-v2, and embed() normalises, so cosine is the right metric.
  CREATE TABLE IF NOT EXISTS chunks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL, -- a shelf label; see documents.agent_id
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    embedding vector(${EMBED_DIMS}),
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
  );
  -- memories are about the user, so every agent shares them
  CREATE TABLE IF NOT EXISTS memories (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    embedding vector(${EMBED_DIMS}),
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    created_at BIGINT DEFAULT ${NOW}
  );

  -- one connected Outlook mailbox per user (read-only access through Microsoft Graph)
  CREATE TABLE IF NOT EXISTS outlook_accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email TEXT,
    access_token TEXT,
    refresh_token TEXT NOT NULL,
    expires_at BIGINT,
    created_at BIGINT DEFAULT ${NOW}
  );

  -- one connected IMAP mailbox per user (Titan, Gmail…); the password is encrypted with EMAIL_KEY
  CREATE TABLE IF NOT EXISTS imap_accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 993,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    created_at BIGINT DEFAULT ${NOW}
  );


  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
  CREATE INDEX IF NOT EXISTS idx_assign_user ON agent_assignments(user_id);
  CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_docs_user ON documents(user_id);
  CREATE INDEX IF NOT EXISTS idx_docs_hash ON documents(user_id, hash);
  CREATE INDEX IF NOT EXISTS idx_chunks_user ON chunks(user_id, agent_id);
  CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING GIN(tsv);
  CREATE INDEX IF NOT EXISTS idx_mem_tsv ON memories USING GIN(tsv);
`);

// Databases created before pgvector stored embeddings as raw float32 BYTEA and scored them
// in JavaScript, which meant reading every row on every query. The vectors cannot be cast
// across in SQL, but the text they came from is still here, so the column is simply replaced
// and scripts/backfill-embeddings.js re-embeds it. Until that runs the embedding is NULL and
// search falls back to keywords, which is degraded but correct.
await db.exec(`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'chunks' AND column_name = 'embedding' AND data_type = 'bytea') THEN
      ALTER TABLE chunks DROP COLUMN embedding;
      ALTER TABLE chunks ADD COLUMN embedding vector(${EMBED_DIMS});
      RAISE NOTICE 'chunks.embedding converted to vector(${EMBED_DIMS}) - run scripts/backfill-embeddings.js';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'memories' AND column_name = 'embedding' AND data_type = 'bytea') THEN
      ALTER TABLE memories DROP COLUMN embedding;
      ALTER TABLE memories ADD COLUMN embedding vector(${EMBED_DIMS});
      RAISE NOTICE 'memories.embedding converted to vector(${EMBED_DIMS}) - run scripts/backfill-embeddings.js';
    END IF;
  END $$;

  CREATE INDEX IF NOT EXISTS idx_chunks_vec ON chunks USING hnsw (embedding vector_cosine_ops);
  CREATE INDEX IF NOT EXISTS idx_mem_vec ON memories USING hnsw (embedding vector_cosine_ops);
`);

// Columns added for the master/assignment model. ADD COLUMN IF NOT EXISTS is safe to
// re-run, so this block is idempotent and runs on every boot like the rest of the schema.
// users.role deliberately has no CHECK constraint: more roles may follow, and a
// constraint here would need a migration to change. The values are 'master' and 'user'.
await db.exec(`
  ALTER TABLE users     ADD COLUMN IF NOT EXISTS role       TEXT    NOT NULL DEFAULT 'user';
  ALTER TABLE users     ADD COLUMN IF NOT EXISTS disabled   BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE users     ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

  -- Sharing is per-item and opt-in. Denormalised onto chunks for the same reason
  -- agent_id already is: recall() must filter without joining documents.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE chunks    ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;

  CREATE INDEX IF NOT EXISTS idx_chunks_shared ON chunks(shared) WHERE shared;

  -- Where a learned fact came from, so a wrong one can be traced to the conversation
  -- that produced it and deleted at the source. Only facts set it.
  -- (No origin_user_id: facts are captured from the master's own chats, so it would
  --  always repeat documents.user_id. Add it if that is ever widened.)
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS origin_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL;

  -- The company a file is for, read off the document by the classifier. NULL means it
  -- names no company (only people, or nobody), which the Shelf shows as "Other".
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS company TEXT;

  -- A folder or ZIP brought in at once. Its files are ordinary documents, filed one by one
  -- from the queue (status 'queued'); this row is the receipt: how many arrived, how many
  -- were already there, and what was deliberately left out (voice notes, videos, ...).
  CREATE TABLE IF NOT EXISTS imports (
    id SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    added      INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    ignored    TEXT NOT NULL DEFAULT '{}',
    uploaded   BOOLEAN NOT NULL DEFAULT false,
    dismissed  BOOLEAN NOT NULL DEFAULT false,
    created_at BIGINT DEFAULT ${NOW},
    updated_at BIGINT DEFAULT ${NOW}
  );
  -- The date a document stops being valid, read off it by the classifier: a trade licence,
  -- a visa, an Emirates ID, a tenancy, an insurance policy. Text in the same YYYY-MM-DD
  -- shape as doc_date, so the two sort and compare the same way. NULL is the normal
  -- answer - most paperwork does not expire, and a guessed expiry is worse than none.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS expires_on TEXT;
  CREATE INDEX IF NOT EXISTS idx_docs_expiry ON documents(user_id, expires_on) WHERE expires_on IS NOT NULL;

  ALTER TABLE documents ADD COLUMN IF NOT EXISTS import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_docs_queued ON documents(id) WHERE status = 'queued';
  CREATE INDEX IF NOT EXISTS idx_docs_import ON documents(import_id) WHERE import_id IS NOT NULL;

  -- Whatever broke, wherever it broke. user_id is nulled rather than cascaded when an
  -- account goes: the fault outlives the account that met it, and a crash nobody is left
  -- to name is still a crash worth seeing. Anonymous rows are ordinary - a failure on the
  -- sign-in screen has no user to attach to.
  CREATE TABLE IF NOT EXISTS error_log (
    id SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source     TEXT NOT NULL CHECK (source IN ('client', 'server')),
    message    TEXT NOT NULL,
    stack      TEXT,
    url        TEXT,
    agent      TEXT,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_errors_recent ON error_log(id DESC);

  -- Master can read anyone's workspace, so it is recorded, and both sides can see it.
  -- target_id is deliberately NOT a foreign key: deleting the file that was read must
  -- not delete the record of it having been read.
  CREATE TABLE IF NOT EXISTS access_log (
    id SERIAL PRIMARY KEY,
    actor_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    target_id  INTEGER,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_access_subject ON access_log(subject_user_id, id DESC);
`);

// Sending. The mailbox row gains its SMTP side and one switch: can_write. It defaults to
// false so every connection made before this feature existed stays read-only — write
// access is something its owner turns on, never something they inherit.
await db.exec(`
  ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS smtp_host   TEXT;
  ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS smtp_port   INTEGER NOT NULL DEFAULT 465;
  ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS smtp_secure BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS can_write   BOOLEAN NOT NULL DEFAULT false;

  -- An email an agent wrote but has not been allowed to send. The status IS the approval:
  -- nothing reaches SMTP except by a row moving to 'approved', and only the user moves it.
  -- That also makes the send queue durable — a restart loses nothing that was approved.
  --   refs: the References header. 'references' is a reserved word in Postgres.
  --   reply_to_id: the folder:uid of the email being answered, the same id search_email gives.
  CREATE TABLE IF NOT EXISTS email_drafts (
    id SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id        INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    to_addrs   TEXT NOT NULL DEFAULT '[]',
    cc_addrs   TEXT NOT NULL DEFAULT '[]',
    subject    TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    in_reply_to TEXT,
    refs        TEXT,
    reply_to_id TEXT,
    status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'sending', 'sent', 'rejected', 'failed')),
    message_id TEXT,
    error      TEXT,
    created_at BIGINT DEFAULT ${NOW},
    decided_at BIGINT,
    sent_at    BIGINT
  );

  -- Every send and every mailbox action, for the person whose mailbox it is. draft_id and
  -- agent_id are deliberately NOT foreign keys: deleting the draft, or the agent that wrote
  -- it, must not delete the record of what was done. Recipients and ids only — never a body,
  -- never a credential.
  CREATE TABLE IF NOT EXISTS email_action_log (
    id SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id   INTEGER,
    action     TEXT NOT NULL,
    draft_id   INTEGER,
    recipients TEXT,
    target     TEXT,
    message_id TEXT,
    ok         BOOLEAN NOT NULL DEFAULT true,
    error      TEXT,
    created_at BIGINT DEFAULT ${NOW}
  );

  CREATE INDEX IF NOT EXISTS idx_drafts_queue ON email_drafts(id) WHERE status = 'approved';
  CREATE INDEX IF NOT EXISTS idx_drafts_user  ON email_drafts(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_email_log_rate ON email_action_log(user_id, created_at) WHERE action = 'send' AND ok;
`);

// 'sending' is the claim a drain takes on a draft before it touches SMTP, so that two
// drains running at once cannot both deliver the same email. Databases created before
// that existed have the older five-value constraint, which would reject the claim.
await db.exec(`
  ALTER TABLE email_drafts DROP CONSTRAINT IF EXISTS email_drafts_status_check;
  ALTER TABLE email_drafts ADD CONSTRAINT email_drafts_status_check
    CHECK (status IN ('pending', 'approved', 'sending', 'sent', 'rejected', 'failed'));
`);

// Databases created before this treated agents.id as the OWNER of a document, so
// deleting a shared agent destroyed every assigned user's files. agent_id is a shelf
// label; the owner is user_id. Swap the two foreign keys over to SET NULL so a deleted
// shelf detaches its contents instead of taking them with it.
await db.exec(`
  DO $$
  DECLARE t text; c text;
  BEGIN
    FOREACH t IN ARRAY ARRAY['documents', 'chunks'] LOOP
      SELECT tc.constraint_name INTO c
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
       WHERE tc.table_name = t AND tc.constraint_type = 'FOREIGN KEY'
         AND kcu.column_name = 'agent_id' AND rc.delete_rule = 'CASCADE';
      IF c IS NOT NULL THEN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL', t, t || '_agent_id_fkey');
        RAISE NOTICE '%.agent_id now detaches instead of cascading', t;
      END IF;
    END LOOP;
  END $$;
`);

// A detached item must not become MORE visible than it was. recall() reads
// `shared AND agent_id IS NULL` as "reaches every user", so a shared shelf item whose
// agent_id has just been nulled would go from "the people assigned this shelf" to
// "everyone". Unsharing it as the agent goes closes that on the way out, at the same
// layer the SET NULL happens, so no deletion path can skip it.
await db.exec(`
  CREATE OR REPLACE FUNCTION unshare_orphaned_shelf_items() RETURNS trigger AS $$
  BEGIN
    UPDATE documents SET shared = false WHERE agent_id = OLD.id AND shared;
    UPDATE chunks    SET shared = false WHERE agent_id = OLD.id AND shared;
    RETURN OLD;
  END $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_unshare_orphaned_shelf_items ON agents;
  CREATE TRIGGER trg_unshare_orphaned_shelf_items
    BEFORE DELETE ON agents
    FOR EACH ROW EXECUTE FUNCTION unshare_orphaned_shelf_items();
`);

// Messages between people (the Messages screen). Entirely separate from the AI chats:
// none of these tables touch conversations/messages, and nothing here is sent to an agent.
//   dm_chats.direct_key: "<lower id>:<higher id>" for a one-to-one chat, so two people
//   only ever share one; NULL for groups.
//   dm_members.last_read_id / last_delivered_id: how far each member has got, which is
//   all the ticks need — a message is read by someone once their pointer passes its id.
//   dm_messages.user_id NULL is a system line ("Sara added Tom").
await db.exec(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at BIGINT;

  CREATE TABLE IF NOT EXISTS dm_chats (
    id SERIAL PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
    name       TEXT,
    direct_key TEXT UNIQUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT ${NOW},
    updated_at BIGINT DEFAULT ${NOW}
  );
  CREATE TABLE IF NOT EXISTS dm_members (
    chat_id INTEGER NOT NULL REFERENCES dm_chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    role    TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    last_read_id      INTEGER NOT NULL DEFAULT 0,
    last_delivered_id INTEGER NOT NULL DEFAULT 0,
    joined_at BIGINT DEFAULT ${NOW},
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS dm_messages (
    id SERIAL PRIMARY KEY,
    chat_id     INTEGER NOT NULL REFERENCES dm_chats(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'image', 'file', 'system')),
    body        TEXT NOT NULL DEFAULT '',
    reply_to_id INTEGER REFERENCES dm_messages(id) ON DELETE SET NULL,
    file_path TEXT,
    file_name TEXT,
    file_mime TEXT,
    file_size INTEGER,
    deleted   BOOLEAN NOT NULL DEFAULT false,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_dm_members_user ON dm_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_dm_messages_chat ON dm_messages(chat_id, id);
`);
