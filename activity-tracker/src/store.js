import Database from 'better-sqlite3';
import { dubaiDate } from './summary.js';

// The PC's own little database: the day's spans, when the tracker was running, which days
// were sent, and a few settings. One file under %APPDATA%\activity-tracker. Nothing here
// leaves the PC except the day summary; spans older than 30 days are deleted.
//
// Dates are stored beside each row as the Dubai date, so "today's spans" is one indexed
// read rather than arithmetic over every row.

const DDL = `
  CREATE TABLE IF NOT EXISTS spans (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    app TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spans_date ON spans(date, started_at);
  CREATE TABLE IF NOT EXISTS running (
    started_at INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    ended_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS days (
    date TEXT PRIMARY KEY,
    sent_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export function openStore(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(DDL);

  const insertSpan = db.prepare('INSERT INTO spans (date, started_at, ended_at, app, title, kind) VALUES (?, ?, ?, ?, ?, ?)');
  const addSpans = db.transaction((spans) => {
    for (const s of spans) insertSpan.run(dubaiDate(s.startedAt), s.startedAt, s.endedAt, s.app, s.title, s.kind);
  });
  const upsertRunning = db.prepare('INSERT INTO running (started_at, date, ended_at) VALUES (?, ?, ?) ON CONFLICT (started_at) DO UPDATE SET ended_at = excluded.ended_at');
  const spansOn = db.prepare('SELECT started_at AS startedAt, ended_at AS endedAt, app, title, kind FROM spans WHERE date = ? ORDER BY started_at');
  const runningOn = db.prepare('SELECT started_at, ended_at FROM running WHERE date = ? ORDER BY started_at');
  const sentAt = db.prepare('SELECT sent_at FROM days WHERE date = ?');
  const markSent = db.prepare('INSERT INTO days (date, sent_at) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET sent_at = excluded.sent_at');
  const unsent = db.prepare('SELECT DISTINCT s.date FROM spans s LEFT JOIN days d ON d.date = s.date WHERE d.sent_at IS NULL ORDER BY s.date');
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const pruneSpans = db.prepare('DELETE FROM spans WHERE ended_at < ?');
  const pruneRunning = db.prepare('DELETE FROM running WHERE ended_at IS NOT NULL AND ended_at < ?');
  const pruneDays = db.prepare('DELETE FROM days WHERE date < ?');

  return {
    /** Closed spans from the SpanBook, kept in one transaction (the once-a-minute flush). */
    addSpans: (spans) => { if (spans.length) addSpans(spans); },
    /** Spans of one Dubai date, oldest first, in the SpanBook's shape. */
    spansOn: (date) => spansOn.all(date),
    /** A running segment [from, to|null]; the same `from` again replaces it (closing it). */
    addRunning: ([from, to]) => { upsertRunning.run(from, dubaiDate(from), to ?? null); },
    runningOn: (date) => runningOn.all(date).map((r) => [r.started_at, r.ended_at ?? null]),
    /** When a date's summary reached Reem, or null. */
    sentAt: (date) => sentAt.get(date)?.sent_at ?? null,
    markSent: (date, epoch) => { markSent.run(date, epoch); },
    /** Dates that have spans but never reached Reem: what to send when the app starts. */
    unsentDates: () => unsent.all().map((r) => r.date),
    /** Settings as JSON, so numbers and booleans come back as they went in. */
    get: (key) => { const row = getSetting.get(key); return row ? JSON.parse(row.value) : null; },
    set: (key, value) => { setSetting.run(key, JSON.stringify(value)); },
    /** Forget everything older than `days`; a day's summary already went to Reem by then. */
    prune: (days = 30, now = Math.floor(Date.now() / 1000)) => {
      const cutoff = now - days * 86400;
      pruneSpans.run(cutoff); pruneRunning.run(cutoff); pruneDays.run(dubaiDate(cutoff));
    },
    close: () => db.close(),
  };
}
