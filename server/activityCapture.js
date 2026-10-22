import { db, withActor } from './db.js';

// The activity log: who changed what, and when, across the whole app. The database writes
// it down itself: one trigger, on every table, puts a row in activity_log for each row added,
// changed or deleted, with the old and the new values. The person comes from the request
// (or the chat turn) through set_config, see withActor in db.js; nobody signed in is 'system'.
//
// For a new feature there is nothing to do: on every start the app attaches the trigger to
// any table that does not have it yet, so a table added tomorrow is logged from its first
// row. Two deliberate choices remain:
//   - a table that is pure machine state (a cache, a "sent already" marker) goes in
//     SKIP_TABLES below, or it floods the log with rows no person made;
//   - a table should get a name a person reads in LABELS (server/activity.js); without one it
//     still shows, under a tidied table name.
//
// The log cannot be changed or deleted through the app: a guard trigger refuses it.

export const SKIP_TABLES = new Set([
  'activity_log', 'sessions', 'password_resets', 'chunks', 'error_log', 'push_subscriptions',
  'reminders_sent', 'lease_alerts_sent', 'suggestion_scans', 'saifsys_runs', 'building_jobs_seen',
  'chat_recaps', 'lease_import_reads',
]);
// Columns whose change alone is not something a person did.
const IGNORED = ['updated_at', 'last_seen_at'];
// Never kept in the log: passwords, tokens, keys, and embeddings (long and meaningless).
const HIDDEN = '(^|_)(password|token|secret|hash|embedding)(_|$)|_enc$|(^|_)(direct|api|private)_key$';
const TRIGGER = 'activity_capture';

await db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_user_id INTEGER,
    actor_name TEXT,
    via TEXT NOT NULL,
    table_name TEXT NOT NULL,
    row_id TEXT,
    action TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
    old JSONB,
    new JSONB,
    changed TEXT[]
  );
  CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_log (at DESC);
  CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_log (actor_user_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_activity_row ON activity_log (table_name, row_id);

  CREATE OR REPLACE FUNCTION activity_clean(j JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(jsonb_object_agg(k, CASE
      WHEN k ~* '${HIDDEN}' THEN '"[hidden]"'::jsonb
      WHEN jsonb_typeof(v) = 'string' AND length(v #>> '{}') > 500 THEN to_jsonb(left(v #>> '{}', 500) || '…')
      ELSE v END), '{}'::jsonb)
    FROM jsonb_each(j) AS e(k, v)
  $$;

  CREATE OR REPLACE FUNCTION activity_capture() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    o JSONB; n JSONB; ch TEXT[]; actor INTEGER; who TEXT; how TEXT;
  BEGIN
    IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
    IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
    IF TG_OP = 'UPDATE' THEN
      SELECT array_agg(k ORDER BY k) INTO ch FROM jsonb_object_keys(n) AS k
        WHERE (n -> k) IS DISTINCT FROM (o -> k) AND k <> ALL (ARRAY[${IGNORED.map((c) => `'${c}'`).join(', ')}]);
      IF ch IS NULL THEN RETURN NULL; END IF;
    END IF;
    actor := nullif(current_setting('app.actor', true), '')::INTEGER;
    how := CASE WHEN actor IS NULL THEN 'system' ELSE coalesce(nullif(current_setting('app.via', true), ''), 'screen') END;
    IF actor IS NOT NULL THEN SELECT name INTO who FROM users WHERE id = actor; END IF;
    INSERT INTO activity_log (actor_user_id, actor_name, via, table_name, row_id, action, old, new, changed)
      VALUES (actor, who, how, TG_TABLE_NAME, coalesce(n ->> 'id', o ->> 'id'), lower(TG_OP),
        CASE WHEN o IS NULL THEN NULL ELSE activity_clean(o) END,
        CASE WHEN n IS NULL THEN NULL ELSE activity_clean(n) END, ch);
    RETURN NULL;
  END $$;

  CREATE OR REPLACE FUNCTION activity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'The activity log cannot be changed';
  END $$;
  DROP TRIGGER IF EXISTS activity_guard ON activity_log;
  CREATE TRIGGER activity_guard BEFORE UPDATE OR DELETE ON activity_log FOR EACH ROW EXECUTE FUNCTION activity_guard();
`);

/** Attaches the logging trigger to every table that lacks it. Returns the tables just attached. */
export async function attachActivityTriggers() {
  const rows = await db.prepare(`SELECT t.tablename AS name FROM pg_tables t
    WHERE t.schemaname = current_schema()
      AND NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
        JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE c.relname = t.tablename AND s.nspname = t.schemaname AND g.tgname = ?)
    ORDER BY t.tablename`).all(TRIGGER);
  const added = [];
  for (const { name } of rows) {
    if (SKIP_TABLES.has(name)) continue;
    await db.exec(`CREATE TRIGGER ${TRIGGER} AFTER INSERT OR UPDATE OR DELETE ON "${name}" FOR EACH ROW EXECUTE FUNCTION activity_capture()`);
    added.push(name);
  }
  return added;
}

/** Express middleware, after requireUser: every change this request makes is this person's. */
export function actorContext(req, res, next) {
  withActor({ userId: req.user.id, via: req.path === '/chat' ? 'chat' : 'screen' }, () => next());
}
