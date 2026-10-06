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

// A settled email card can be folded down to one line in the chat, so an old one stops
// filling the screen without being thrown away.
await db.exec(`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false`);

// The mailbox a draft was written from. The card shows this, not whatever is connected
// today, so a draft written before a mailbox change still says who it was from.
await db.exec(`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS from_addr TEXT`);

// Files that go with the email - a meeting's PDF, say - as JSON [{ filename, contentType, content (base64) }].
await db.exec(`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS attachments TEXT`);

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

// Groups hold topics. A group is only a name: nobody is a member of the group itself.
// Each topic is an ordinary group chat (dm_chats kind 'group') pointing at its group,
// with its own members, messages and ticks - so everything a chat does, a topic does.
//   Who sees a group: anyone in at least one of its topics, and the master (who is put
//   in every topic). Only the master makes groups; anyone in a group can add a topic.
//   group_id NULL on a 'group' chat only survives until the step below has run once.
await db.exec(`
  CREATE TABLE IF NOT EXISTS dm_groups (
    id SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT ${NOW}
  );
  ALTER TABLE dm_chats ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES dm_groups(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_dm_chats_group ON dm_chats(group_id);
`);

// Group chats from before topics existed: each becomes a group of the same name, with
// itself as that group's "General" topic. Members, messages and ticks stay exactly as
// they were. The master joins it, caught up, so the new history is not a pile of unread.
// Runs once per chat: afterwards group_id is set and the WHERE finds nothing.
await db.exec(`
  DO $$
  DECLARE c RECORD; gid INTEGER; top INTEGER;
  BEGIN
    FOR c IN SELECT * FROM dm_chats WHERE kind = 'group' AND group_id IS NULL LOOP
      INSERT INTO dm_groups (name, created_by, created_at) VALUES (COALESCE(c.name, 'Group'), c.created_by, c.created_at) RETURNING id INTO gid;
      UPDATE dm_chats SET group_id = gid, name = 'General' WHERE id = c.id;
      SELECT COALESCE(MAX(id), 0) INTO top FROM dm_messages WHERE chat_id = c.id;
      INSERT INTO dm_members (chat_id, user_id, role, last_read_id, last_delivered_id)
        SELECT c.id, u.id, 'admin', top, top FROM users u WHERE u.role = 'master' AND NOT u.disabled
        ON CONFLICT (chat_id, user_id) DO NOTHING;
    END LOOP;
  END $$;
`);

// A Reem reply, carried into a team chat by the person who asked for it.
//
// Its own table on purpose. What lands in the chat is an ordinary dm_message and stays
// one - it replies, deletes and reads like every other message. This row is only the
// label saying where the words came from, so nobody mistakes Reem for the sender.
//   agent_name is copied, not looked up: the agent may be renamed or removed later, and
//     the message must keep saying who actually wrote it at the time.
//   source_message_id detaches rather than cascades - the sender clearing his own chat
//     history must never empty what he already shared with the team.
await db.exec(`
  CREATE TABLE IF NOT EXISTS dm_shared_replies (
    message_id        INTEGER PRIMARY KEY REFERENCES dm_messages(id) ON DELETE CASCADE,
    source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    agent_id          INTEGER REFERENCES agents(id)   ON DELETE SET NULL,
    agent_name        TEXT NOT NULL,
    created_at        BIGINT DEFAULT ${NOW}
  );
`);

// The to-do list. A reminder is remind_at and nothing more: no job runs at that moment,
// because nothing in this app is awake when the user is not. What the time does is make
// the todo *due*, and due work is shown the way expiring paperwork already is.
//   agent_id / conversation_id: which agent raised it and where, so "who told me this?"
//     has an answer. Both detach rather than cascade — losing the agent must not lose
//     the task, exactly as documents.agent_id already works.
//   document_id: the file it is about ("renew this licence"), detaching for the same reason.
//   done_at: when it was ticked, NULL while it is open — the finished list sorts on it.
await db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id        INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    document_id     INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    text      TEXT NOT NULL,
    notes     TEXT,
    remind_at BIGINT,
    done      BOOLEAN NOT NULL DEFAULT false,
    done_at   BIGINT,
    created_at BIGINT DEFAULT ${NOW},
    updated_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id, done, id DESC);
  -- The badge asks "what is due for this user" on every load, and the answer is almost
  -- always a handful of rows out of a list that only grows, so it gets its own partial index.
  CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(user_id, remind_at) WHERE remind_at IS NOT NULL AND NOT done;
`);

// Routines: the things that come back, kept deliberately apart from todos. A todo is
// finished and leaves; a routine never finishes, so it is not a repeat flag on that table.
//
// There is no "next occurrence" column on purpose. A routine is its first occurrence
// (starts_at), an interval, and the times it was actually done — everything else is
// derived in routines.js. So there is no schedule to drift out of step with reality, and
// ticking a turn off and un-ticking it are one insert and one delete of the same row.
//   every_n: "every N units". 1 + month = monthly, 3 + month = quarterly. Named every_n
//     because EVERY is a reserved word in Postgres and would need quoting for ever after.
await db.exec(`
  CREATE TABLE IF NOT EXISTS routines (
    id SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id        INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    text      TEXT NOT NULL,
    notes     TEXT,
    starts_at BIGINT  NOT NULL,
    every_n   INTEGER NOT NULL DEFAULT 1 CHECK (every_n BETWEEN 1 AND 366),
    unit      TEXT    NOT NULL CHECK (unit IN ('day', 'week', 'month', 'year')),
    paused    BOOLEAN NOT NULL DEFAULT false,
    created_at BIGINT DEFAULT ${NOW},
    updated_at BIGINT DEFAULT ${NOW}
  );
  -- One row per turn actually done. user_id is carried as well as routine_id so a read
  -- can be scoped to its owner without joining, the way chunks.agent_id already is.
  CREATE TABLE IF NOT EXISTS routine_completions (
    id SERIAL PRIMARY KEY,
    routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    done_at    BIGINT  NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_routines_user ON routines(user_id, id);
  CREATE INDEX IF NOT EXISTS idx_routine_done ON routine_completions(user_id, done_at DESC);
`);

// One switched-on device, for the notifications that arrive while the app is shut.
//
// A row per device, not per person: a phone, an iPad and a laptop are three separate
// permissions and three separate rows. The row existing IS the permission — switching
// notifications off deletes it, so there is no on/off column to fall out of step with
// what the browser actually allows.
//   endpoint: the address the push service gave this browser, and the thing that
//     identifies the device. Unique across the table rather than per user, so that
//     someone signing in as a different person on the same phone takes the row over
//     instead of leaving it aimed at the previous account.
//   p256dh / auth: the browser's own keys. The notice is encrypted to them, so the push
//     service carrying it cannot read what it is carrying.
await db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh   TEXT NOT NULL,
    auth     TEXT NOT NULL,
    device   TEXT,
    created_at   BIGINT DEFAULT ${NOW},
    last_used_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
`);

// One reminder already dealt with — the bookkeeping behind server/reminders.js.
//
// Its own table rather than a column on todos: "has this been sent" is about delivery,
// not about the task, and routines need the same answer without a todo to hang it on.
//   due_at is the moment it was due, not the moment it was sent, and it is what makes
//     this idempotent. A todo moved to next week has a new due_at, so it buzzes again;
//     one that has already buzzed matches an existing row and stays quiet however many
//     times the timer runs.
//   Two partial unique indexes rather than one constraint, because each row is about
//     either a todo or a routine and never both.
await db.exec(`
  CREATE TABLE IF NOT EXISTS reminders_sent (
    id SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    todo_id    INTEGER REFERENCES todos(id)    ON DELETE CASCADE,
    routine_id INTEGER REFERENCES routines(id) ON DELETE CASCADE,
    due_at  BIGINT NOT NULL,
    sent_at BIGINT DEFAULT ${NOW},
    CHECK ((todo_id IS NULL) <> (routine_id IS NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reminded_todo    ON reminders_sent(todo_id, due_at)    WHERE todo_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reminded_routine ON reminders_sent(routine_id, due_at) WHERE routine_id IS NOT NULL;
`);

// An earlier chat brought into the one open now — the bookkeeping behind server/chatRecap.js.
//
// A chat normally sees only its own last 20 messages, so points that live in chat A and
// chat B cannot reach chat C. These two tables are how they get there.
//   carried_chats: which chats were brought into which message. Its own table rather than
//     a column on messages, because it is a list, and because the same conversation can be
//     brought in by one message and still count for every message after it.
//     title is copied in, not read back through source_id, so the record survives the
//     source chat being renamed or deleted — what was brought in stays true.
//   chat_recaps: the recap of one chat, cached. Summarising is a paid call and the recap
//     is re-read on every later message, so it is written down and only made again when
//     that chat has grown: through_id is the last message it was written from.
await db.exec(`
  CREATE TABLE IF NOT EXISTS carried_chats (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    source_id  INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_carried_message ON carried_chats(message_id);
  CREATE TABLE IF NOT EXISTS chat_recaps (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    through_id INTEGER NOT NULL,
    summary TEXT NOT NULL,
    created_at BIGINT DEFAULT ${NOW}
  );
`);

// saifsys jobs that run once a day (server/saifsys.js). One row per job per Dubai day,
// written the moment the job claims the day, so a restart or a second tick never makes a
// second reminder. Its own small table so the next saifsys job just uses a new job name.
//   found: how many rows saifsys returned — kept so "did it run, and what did it see" has an answer.
await db.exec(`
  CREATE TABLE IF NOT EXISTS saifsys_runs (
    job TEXT NOT NULL,
    day DATE NOT NULL,
    found INTEGER NOT NULL DEFAULT 0,
    ran_at BIGINT DEFAULT ${NOW},
    PRIMARY KEY (job, day)
  );
`);

// Which saifsys modules each person may use (server/saifsys/index.js). The master has
// them all and is never listed here. When the table first appears, everyone who is not
// a master gets ARS — before modules, every user could look up checkouts, and nobody
// should lose that just because the list got split.
{
  const fresh = !(await db.prepare(`SELECT to_regclass('saifsys_access') AS t`).get()).t;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS saifsys_access (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module TEXT NOT NULL,
      PRIMARY KEY (user_id, module)
    );
  `);
  if (fresh) await db.exec(`INSERT INTO saifsys_access (user_id, module)
    SELECT id, 'ars' FROM users WHERE role IS DISTINCT FROM 'master' ON CONFLICT DO NOTHING`);
}

// Things Reem may DO in saifsys, per person (server/saifsys/booking.js). Separate from
// saifsys_access, which is only what they may look at. The master may do all of it and
// is never listed. One row per person per action; today the only action is
// 'ars_create_booking'.
await db.exec(`
  CREATE TABLE IF NOT EXISTS saifsys_action_access (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    PRIMARY KEY (user_id, action)
  );
`);

// An ARS booking Reem has got ready in chat, waiting for the person to tap Create.
//   status: pending (the card is showing), creating (Create was tapped; the lock that
//     stops a double tap making two bookings), created, cancelled, failed.
//   input: what goes to saifsys, with unit and guest already resolved to ids.
//   quote: saifsys's price for it, which is what the card shows and what saifsys must
//     still charge when Create is tapped (expected_total), or nothing is made.
//   result: saifsys's answer once created — the booking number above all.
await db.exec(`
  CREATE TABLE IF NOT EXISTS ars_booking_requests (
    id SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'creating', 'created', 'cancelled', 'failed')),
    input  JSONB NOT NULL,
    quote  JSONB NOT NULL,
    result JSONB,
    error  TEXT,
    note   TEXT,
    created_at BIGINT DEFAULT ${NOW},
    decided_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_ars_booking_requests_conv ON ars_booking_requests(conversation_id);
`);

// Meetings (server/meetings.js): a recording, turned into who-said-what by OpenAI's speech
// model and then summarised by Claude. Four tables of their own; nothing else reads them.
//   voice_profiles: a short sample of one person's voice, kept as a data URL because that is
//     exactly the form the speech API takes it in, and it is small (8 seconds, ~70 KB).
//   meetings.speakers: the voice_profile ids picked for this meeting (JSON), at most four —
//     the speech API names up to four known voices per request.
//   meeting_parts: the recording arrives in ten-minute pieces as it is made, so a phone that
//     dies at 1h50 still leaves 1h50. offset_s is where the piece starts in the meeting.
//   meeting_lines: what was said. speaker NULL means a voice nobody taught Reem.
await db.exec(`
  CREATE TABLE IF NOT EXISTS voice_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name   TEXT NOT NULL,
    sample TEXT NOT NULL,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_profiles_name ON voice_profiles(user_id, lower(name));
  CREATE TABLE IF NOT EXISTS meetings (
    id SERIAL PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title    TEXT NOT NULL,
    status   TEXT NOT NULL DEFAULT 'recording',
    speakers TEXT NOT NULL DEFAULT '[]',
    summary  TEXT,
    error    TEXT,
    duration_s INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT DEFAULT ${NOW},
    ended_at   BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id, id DESC);
  CREATE TABLE IF NOT EXISTS meeting_parts (
    id SERIAL PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    seq      INTEGER NOT NULL,
    offset_s REAL NOT NULL DEFAULT 0,
    path     TEXT NOT NULL,
    mime     TEXT NOT NULL,
    status   TEXT NOT NULL DEFAULT 'waiting',
    attempts INTEGER NOT NULL DEFAULT 0,
    error    TEXT,
    created_at BIGINT DEFAULT ${NOW},
    UNIQUE (meeting_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_meeting_parts_waiting ON meeting_parts(id) WHERE status = 'waiting';
  CREATE TABLE IF NOT EXISTS meeting_lines (
    id SERIAL PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    seq     INTEGER NOT NULL,
    start_s REAL NOT NULL,
    end_s   REAL NOT NULL,
    speaker TEXT,
    text    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_meeting_lines ON meeting_lines(meeting_id, start_s);
`);

// Transcribe (server/transcripts.js): any audio file or quick recording, turned into plain
// text. Apart from meetings on purpose: no speakers, no summary. path is the uploaded file,
// kept only until it has been read.
await db.exec(`
  CREATE TABLE IF NOT EXISTS transcripts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title  TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'upload',
    status TEXT NOT NULL DEFAULT 'processing',
    text   TEXT NOT NULL DEFAULT '',
    error  TEXT,
    path   TEXT NOT NULL DEFAULT '',
    duration_s INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_transcripts_user ON transcripts(user_id, id DESC);
`);

// A reminder one person sends to others — the tables behind server/teamReminders.js.
//
// Apart from todos on purpose: a todo is one person's own list, this is a message with a
// sender, several people on the end of it, and each of them ticking it off on their own.
//   status: pending until the sender taps Send on the card in chat (Reem only ever
//     proposes), then scheduled, then delivered once the phones have been told. cancelled
//     for one the sender thought better of. Nothing reaches anyone while it is pending.
//   remind_at: NULL means "as soon as they tap Send".
//   everyone: remembered so the card can say "Everyone" rather than a list of twenty names.
//   team_reminder_people: one row per person it went to, and each person's own tick.
//   team_reminder_photos: pictures sent along with it. path is the reminder's own copy of
//     the bytes, under data/reminder-files, not the sender's Shelf file.
await db.exec(`
  CREATE TABLE IF NOT EXISTS team_reminders (
    id SERIAL PRIMARY KEY,
    sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    text      TEXT NOT NULL,
    remind_at BIGINT,
    everyone  BOOLEAN NOT NULL DEFAULT false,
    status    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'delivered', 'cancelled')),
    delivered_at BIGINT,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE TABLE IF NOT EXISTS team_reminder_people (
    id SERIAL PRIMARY KEY,
    reminder_id INTEGER NOT NULL REFERENCES team_reminders(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    done    BOOLEAN NOT NULL DEFAULT false,
    done_at BIGINT,
    UNIQUE (reminder_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_team_rem_sender ON team_reminders(sender_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_team_rem_waiting ON team_reminders(remind_at) WHERE status = 'scheduled';
  CREATE INDEX IF NOT EXISTS idx_team_rem_people ON team_reminder_people(user_id, done);
  CREATE TABLE IF NOT EXISTS team_reminder_photos (
    id SERIAL PRIMARY KEY,
    reminder_id INTEGER NOT NULL REFERENCES team_reminders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    path TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_team_rem_photos ON team_reminder_photos(reminder_id);
`);

// Reminders Reem thinks someone might want — the tables behind server/suggestions.js.
//
// Only ever suggested: nothing becomes a todo until the person taps "Remind me". So this
// is its own table, not todos with a flag — a suggestion that was waved away still has to
// be remembered, or the same email would be suggested again at the next look.
//   source / ref: where it came from — 'email' + "INBOX:uid", or 'chat' + a message id.
//     Unique per person, so reading the same email twice cannot suggest it twice.
//   status: pending on the first screen, accepted (todo_id says which todo it became),
//     or dismissed.
//   suggestion_scans: when this person was last looked at, and the last chat message read,
//     so each look only reads what is new and runs at most every few hours.
await db.exec(`
  CREATE TABLE IF NOT EXISTS reminder_suggestions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source  TEXT NOT NULL CHECK (source IN ('email', 'chat')),
    ref     TEXT NOT NULL,
    text    TEXT NOT NULL,
    why     TEXT,
    remind_at BIGINT,
    status  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
    todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT ${NOW},
    UNIQUE (user_id, source, ref)
  );
  CREATE INDEX IF NOT EXISTS idx_suggestions_open ON reminder_suggestions(user_id) WHERE status = 'pending';
  CREATE TABLE IF NOT EXISTS suggestion_scans (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    scanned_at BIGINT NOT NULL,
    last_message_id INTEGER NOT NULL DEFAULT 0
  );
`);

// Tenant care — one shared inbox tenants write to (server/tenantCare.js). When a new email
// does not say which building and unit it is about, Reem writes a reply asking, and the
// people looking after the inbox tap Send. Its own tables, not imap_accounts: that mailbox
// belongs to one person, this one to a team.
//   tenant_inbox: at most one row (id = 1). last_uid is the newest email already looked
//     at; a new connection starts from the top of the inbox, so old mail is never asked about.
//     uid_validity: when the mail server renumbers the inbox, last_uid starts again.
//   tenant_inbox_members: who sees the replies and may send them (the master always may).
//   tenant_asks: one row per email that needs asking. ref = "<uid_validity>:<uid>", unique,
//     so looking at the same email twice cannot ask twice. missing: building, unit or both.
await db.exec(`
  CREATE TABLE IF NOT EXISTS tenant_inbox (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    email TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 993,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    smtp_secure BOOLEAN NOT NULL DEFAULT true,
    last_uid BIGINT,
    uid_validity BIGINT,
    checked_at BIGINT,
    error TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE TABLE IF NOT EXISTS tenant_inbox_members (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS tenant_asks (
    id SERIAL PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    message_id TEXT,
    refs TEXT,
    from_addr TEXT NOT NULL,
    from_name TEXT,
    subject TEXT,
    preview TEXT,
    received_at BIGINT,
    missing TEXT NOT NULL CHECK (missing IN ('building', 'unit', 'both')),
    reply TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
    error TEXT,
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at BIGINT,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_asks_open ON tenant_asks(id DESC) WHERE status IN ('pending', 'failed');
  CREATE INDEX IF NOT EXISTS idx_tenant_asks_from ON tenant_asks(from_addr, created_at DESC);

  -- The app was renamed from Jarvis to Reem (2026-10-01). The general assistant every
  -- account started with keeps its chats; only its name and the name in its persona change.
  UPDATE agents SET name = 'Reem', persona = replace(persona, 'You are Jarvis', 'You are Reem')
   WHERE name = 'Jarvis';
`);

// What each person is responsible for, written by the master in their own words.
//
// Its own table rather than a column on users: a person can hold several, each one is
// edited and deleted on its own, and nothing about who they are changes with them.
//   title: optional, a few words ("Rent collection"). body: free text, any length.
//   created_by: the master who wrote it, kept if that account is later removed.
await db.exec(`
  CREATE TABLE IF NOT EXISTS responsibilities (
    id SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT,
    body       TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT ${NOW},
    updated_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_responsibilities_user ON responsibilities(user_id, id);
`);

// A change to someone's responsibilities that Reem got ready from the master's chat,
// waiting on a card for Save or Cancel. Nothing touches `responsibilities` until Save.
//   action: add a new one, edit one (responsibility_id), or remove one.
//   title / body: what it will say after Save (for an edit, the whole new text).
//   result_id: the responsibility that Save wrote, so the card can say what became of it.
await db.exec(`
  CREATE TABLE IF NOT EXISTS responsibility_proposals (
    id SERIAL PRIMARY KEY,
    master_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    action  TEXT NOT NULL CHECK (action IN ('add', 'edit', 'remove')),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    responsibility_id INTEGER REFERENCES responsibilities(id) ON DELETE SET NULL,
    title TEXT,
    body  TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'cancelled')),
    result_id  INTEGER,
    decided_at BIGINT,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_resp_proposals_chat ON responsibility_proposals(master_id, conversation_id, id);
`);

// Which saifsys HR employee a Reem account is - see server/hrLinks.js.
//
// By employee code, not email: some staff have no email, and emails change in HR while
// the code (E00012) is set once when the employee is created and never edited.
// One row per person and each code at most once, so two accounts can never be the same
// employee. hr_name is the name HR gave when it was linked, for showing without a lookup.
await db.exec(`
  CREATE TABLE IF NOT EXISTS hr_links (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    employee_code TEXT NOT NULL UNIQUE,
    hr_name   TEXT,
    linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    linked_at BIGINT DEFAULT ${NOW}
  );
`);

// Checklists: the points of one job, ticked off each time it is done - see server/checklists.js.
// Their own tables rather than a flag on todos or routines: those are single things, and
// a checklist is several steps that belong together and are done as one.
//   kind: 'daily' comes back empty every morning; 'ondemand' is started when the job comes up.
//   checklist_runs: one go. day is the Dubai date for a daily go (one per day, hence the
//     unique index - NULLs do not collide, so a when-needed checklist has as many as it likes).
//   checklist_run_items: the go's own copy of the points, so editing the checklist later
//     never rewrites what was ticked before. item_id is where the copy came from.
await db.exec(`
  CREATE TABLE IF NOT EXISTS checklists (
    id SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL CHECK (kind IN ('daily', 'ondemand')),
    created_at BIGINT DEFAULT ${NOW},
    updated_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_checklists_user ON checklists(user_id, id);

  CREATE TABLE IF NOT EXISTS checklist_items (
    id SERIAL PRIMARY KEY,
    checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    text     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_checklist_items ON checklist_items(checklist_id, position);

  CREATE TABLE IF NOT EXISTS checklist_runs (
    id SERIAL PRIMARY KEY,
    checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT,
    day   TEXT,
    started_at  BIGINT DEFAULT ${NOW},
    finished_at BIGINT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_checklist_run_day ON checklist_runs(checklist_id, day);

  CREATE TABLE IF NOT EXISTS checklist_run_items (
    id SERIAL PRIMARY KEY,
    run_id  INTEGER NOT NULL REFERENCES checklist_runs(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES checklist_items(id) ON DELETE SET NULL,
    position INTEGER NOT NULL DEFAULT 0,
    text     TEXT NOT NULL,
    done_at  BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_checklist_run_items ON checklist_run_items(run_id, position);
`);

// Buildings: who runs each building and which field staff were given to them - see
// server/buildings.js. Its own tables: this is the company's structure, not HR's manager
// field and not a responsibility.
//   buildings: the name the office uses ("Townhouses"), its administrator, and who
//     handles its renewals when that is not the administrator. watched_at: when the
//     job watcher first looked, so the first look records what is there without buzzing.
//   building_sites: the saifsys buildings (re_buildings.id) behind that name - usually
//     one, several where the office's name covers more than one.
//   building_staff: the cleaners and technicians, by HR employee code. They have no Reem
//     account; they work on the saifsys staff app. One person can be in several buildings.
//   building_jobs_seen: each staff job as the watcher last saw it, so a buzz goes out
//     once when something changes and never again for the same thing.
await db.exec(`
  CREATE TABLE IF NOT EXISTS buildings (
    id SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    admin_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    renewals_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    watched_at BIGINT,
    created_at BIGINT DEFAULT ${NOW},
    updated_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_buildings_admin ON buildings(admin_id);

  CREATE TABLE IF NOT EXISTS building_sites (
    building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    site_id     INTEGER NOT NULL,
    name        TEXT NOT NULL,
    PRIMARY KEY (building_id, site_id)
  );

  CREATE TABLE IF NOT EXISTS building_staff (
    building_id   INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    employee_code TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('cleaner', 'technician')),
    PRIMARY KEY (building_id, employee_code)
  );

  CREATE TABLE IF NOT EXISTS building_jobs_seen (
    building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    job_id      INTEGER NOT NULL,
    status      TEXT NOT NULL,
    late            BOOLEAN NOT NULL DEFAULT false,
    needs_materials BOOLEAN NOT NULL DEFAULT false,
    problems        BOOLEAN NOT NULL DEFAULT false,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    seen_at BIGINT DEFAULT ${NOW},
    PRIMARY KEY (building_id, job_id)
  );
`);

// Inventory: the things kept in each unit and area of a building - see server/inventory.js.
// Its own tables, hung off buildings so the same people keep it who run the building.
//   inventory_areas: the places of a building that are not a unit (lobby, store room).
//   inventory_items: one thing in one place. unit is the saifsys unit number as text;
//     an item is in a unit or in an area, never both. photo is a path on disk.
//   inventory_log: every change, with who made it. item_id is not a foreign key, so
//     what happened to an item is still there after the item is removed.
await db.exec(`
  CREATE TABLE IF NOT EXISTS inventory_areas (
    id SERIAL PRIMARY KEY,
    building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at BIGINT DEFAULT ${NOW}
  );

  CREATE TABLE IF NOT EXISTS inventory_items (
    id SERIAL PRIMARY KEY,
    building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    unit    TEXT,
    area_id INTEGER REFERENCES inventory_areas(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    counted_in TEXT,
    quantity   NUMERIC NOT NULL DEFAULT 1,
    condition  TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'damaged', 'missing')),
    notes TEXT,
    photo TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT ${NOW},
    updated_at BIGINT DEFAULT ${NOW},
    CHECK ((unit IS NULL) <> (area_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_inventory_items_building ON inventory_items(building_id);

  CREATE TABLE IF NOT EXISTS inventory_log (
    id SERIAL PRIMARY KEY,
    building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    item_id   INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    place     TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    what TEXT NOT NULL,
    at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_inventory_log_item ON inventory_log(item_id, id);
`);

// What was taken out for a saifsys job - see takeItem in server/inventory.js. Kept on the
// log line itself (job_id set = this line is a take), so an item's history and a job's
// list of materials are the same record and cannot disagree.
await db.exec(`
  ALTER TABLE inventory_log ADD COLUMN IF NOT EXISTS job_id     INTEGER;
  ALTER TABLE inventory_log ADD COLUMN IF NOT EXISTS taken      NUMERIC;
  ALTER TABLE inventory_log ADD COLUMN IF NOT EXISTS counted_in TEXT;
  ALTER TABLE inventory_log ADD COLUMN IF NOT EXISTS note       TEXT;
  CREATE INDEX IF NOT EXISTS idx_inventory_log_job ON inventory_log(job_id) WHERE job_id IS NOT NULL;
`);

// Inventory is kept per real saifsys building (site_id = re_buildings.id), not per entry
// on the Buildings screen - see the top of server/inventory.js. The old building_id stays
// on rows written before this and is no longer read or written; its foreign key and its
// NOT NULL go, so regrouping or deleting an entry there cannot take a real building's
// inventory with it.
//
// Rows from before are moved once (site_id IS NULL marks them): a unit item of an entry
// covering several buildings carried "Name · unit" and goes to that building with the
// plain unit; everything else goes to the entry's building, the first by name when it
// covered several. An entry with nothing ticked had no real building: its rows stay
// unmoved and unseen.
const FIRST_SITE = (alias) => `(SELECT s.site_id FROM building_sites s WHERE s.building_id = ${alias}.building_id ORDER BY lower(s.name), s.site_id LIMIT 1)`;
await db.exec(`
  ALTER TABLE inventory_areas     ADD COLUMN IF NOT EXISTS site_id INTEGER;
  ALTER TABLE inventory_items     ADD COLUMN IF NOT EXISTS site_id INTEGER;
  ALTER TABLE inventory_log       ADD COLUMN IF NOT EXISTS site_id INTEGER;

  ALTER TABLE inventory_areas DROP CONSTRAINT IF EXISTS inventory_areas_building_id_fkey;
  ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_building_id_fkey;
  ALTER TABLE inventory_log   DROP CONSTRAINT IF EXISTS inventory_log_building_id_fkey;
  ALTER TABLE inventory_areas ALTER COLUMN building_id DROP NOT NULL;
  ALTER TABLE inventory_items ALTER COLUMN building_id DROP NOT NULL;
  ALTER TABLE inventory_log   ALTER COLUMN building_id DROP NOT NULL;

  UPDATE inventory_areas a SET site_id = ${FIRST_SITE('a')} WHERE a.site_id IS NULL AND a.building_id IS NOT NULL;
  UPDATE inventory_items i SET site_id = s.site_id, unit = substr(i.unit, length(s.name) + 4)
    FROM building_sites s
    WHERE i.site_id IS NULL AND i.unit IS NOT NULL AND s.building_id = i.building_id
      AND left(i.unit, length(s.name) + 3) = s.name || ' · '
      AND (SELECT count(*) FROM building_sites c WHERE c.building_id = i.building_id) > 1;
  UPDATE inventory_items i SET site_id = a.site_id FROM inventory_areas a WHERE i.site_id IS NULL AND i.area_id = a.id;
  UPDATE inventory_items i SET site_id = ${FIRST_SITE('i')} WHERE i.site_id IS NULL AND i.building_id IS NOT NULL;
  UPDATE inventory_log l SET site_id = i.site_id FROM inventory_items i WHERE l.site_id IS NULL AND l.item_id = i.id;
  UPDATE inventory_log l SET site_id = ${FIRST_SITE('l')} WHERE l.site_id IS NULL AND l.building_id IS NOT NULL;

  -- Two entries that both covered one building may each have had a "Store room": the
  -- later one keeps its items and gets its number in the name, so the index below holds.
  UPDATE inventory_areas a SET name = a.name || ' (' || a.id || ')'
    WHERE a.site_id IS NOT NULL AND EXISTS (SELECT 1 FROM inventory_areas o
      WHERE o.site_id = a.site_id AND lower(o.name) = lower(a.name) AND o.id < a.id);
  DROP INDEX IF EXISTS idx_inventory_areas_name;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_areas_site_name ON inventory_areas(site_id, lower(name)) WHERE site_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_inventory_items_site ON inventory_items(site_id);
`);

// Inventory items got ready from chat, waiting for Add or Cancel on their card - see
// "adding from chat" in server/inventory.js. lines is every item in every place, as it
// will be added; added is how many went in.
await db.exec(`
  CREATE TABLE IF NOT EXISTS inventory_proposals (
    id SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    building_id     INTEGER REFERENCES buildings(id) ON DELETE SET NULL,
    lines JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'added', 'cancelled')),
    added INTEGER,
    decided_at BIGINT,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_inventory_proposals_chat ON inventory_proposals(user_id, conversation_id, id);
  ALTER TABLE inventory_proposals ADD COLUMN IF NOT EXISTS site_id INTEGER;
`);

// Recurring payments: money that should come in every month from something in a building
// (a shop's rent, the washing machine in Ayla) - see server/recurringPayments.js.
//   recurring_buildings: the module's own buildings, typed by the accountants. Nothing to
//     do with the Buildings screen, the inventory or the saifsys building list.
//   recurring_payments: the entry, made once, in one of those buildings. day is the day of
//     the month its line is created.
//   recurring_payment_dues: one month's line of one entry, pending until marked paid.
//     amount is the entry's amount on the day the line was made, so a later change to the
//     entry never rewrites a month already asked for. One line per entry per month, by
//     the unique index, so the creator can run as often as it likes.
await db.exec(`
  CREATE TABLE IF NOT EXISTS recurring_buildings (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_buildings_name ON recurring_buildings(lower(name));

  CREATE TABLE IF NOT EXISTS recurring_payments (
    id SERIAL PRIMARY KEY,
    building_id INTEGER NOT NULL REFERENCES recurring_buildings(id),
    unit  TEXT,
    title TEXT NOT NULL,
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    day    INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
    auto_create BOOLEAN NOT NULL DEFAULT true,
    first_month TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT ${NOW},
    updated_at BIGINT DEFAULT ${NOW}
  );

  -- Entries made while a building was a saifsys building (site_id, site_name): each name
  -- becomes a building of the module's own, once, and the old columns go.
  ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS building_id INTEGER REFERENCES recurring_buildings(id);
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'recurring_payments' AND column_name = 'site_name') THEN
      INSERT INTO recurring_buildings (name)
        SELECT min(site_name) FROM recurring_payments GROUP BY lower(site_name)
        ON CONFLICT DO NOTHING;
      UPDATE recurring_payments p SET building_id = b.id FROM recurring_buildings b
        WHERE p.building_id IS NULL AND lower(b.name) = lower(p.site_name);
      ALTER TABLE recurring_payments ALTER COLUMN building_id SET NOT NULL;
      DROP INDEX IF EXISTS idx_recurring_payments_site;
      ALTER TABLE recurring_payments DROP COLUMN site_id, DROP COLUMN site_name;
    END IF;
  END $$;
  CREATE INDEX IF NOT EXISTS idx_recurring_payments_building ON recurring_payments(building_id);

  CREATE TABLE IF NOT EXISTS recurring_payment_dues (
    id SERIAL PRIMARY KEY,
    payment_id INTEGER NOT NULL REFERENCES recurring_payments(id) ON DELETE CASCADE,
    month    TEXT NOT NULL,
    due_date TEXT NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
    paid_at BIGINT,
    paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_payment_dues_month ON recurring_payment_dues(payment_id, month);
  CREATE INDEX IF NOT EXISTS idx_recurring_payment_dues_by_month ON recurring_payment_dues(month);
`);
