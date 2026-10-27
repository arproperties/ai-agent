// The legal dates of a case, read out of its own files and emails, for the panel beside the chat.
//
// Not the person's to-dos and not Legal cases: what the papers themselves say - a hearing, a
// deadline to file or answer, an appeal window, a limitation or repose date. A wrong date here
// is worse than none, so every date has to come with words copied from its source, and a date
// whose words are not found in that source is thrown away. The person can always open the
// source and check.
//
// Reading is paid for, so a case is read once, and again only when a file or an email has come
// in since (the fingerprint), or when the person asks with "Check again".
import { db } from './db.js';
import { claude } from './ai.js';
import { billAs } from './billing.js';
import { CAREFUL_MODEL } from './config.js';
import { dubaiDate } from './saifsys/client.js';
import { sameCase } from './primaryCase.js';
import { caseKey } from './caseMatch.js';

const PER_FILE = 50000; // chars read from one file
const PER_EMAIL = 5000; // and from one email
const BUDGET = 150000; // and from the whole case, newest first after the summary

const keyOf = (primary) => primary.key || caseKey(primary.number);

/** What there is to read: the case's files (as listed beside the chat) and its case folder's emails. */
export async function sourcesOf(userId, primary, files) {
  const ids = files.map((f) => f.id);
  const texts = ids.length
    ? await db.prepare('SELECT document_id id, text FROM document_texts WHERE document_id = ANY(?::int[])').all(ids) : [];
  const folders = (await db.prepare('SELECT id, case_number FROM case_folders WHERE user_id = ?').all(userId))
    .filter((f) => f.id === primary.folderId || sameCase(f.case_number, primary.number));
  const emails = folders.length
    ? await db.prepare(`SELECT id, at, sender, subject, body, doc_id FROM case_emails WHERE folder_id = ANY(?::int[]) ORDER BY at DESC, id DESC`)
      .all(folders.map((f) => f.id)) : [];
  const out = [];
  for (const f of files) { // already summary first, then newest
    const text = texts.find((t) => t.id === f.id)?.text;
    if (text?.trim()) out.push({ ref: `f${f.id}`, name: f.title || f.name, docId: f.id, text: text.slice(0, PER_FILE) });
  }
  for (const e of emails) {
    if (!e.body?.trim()) continue;
    const when = e.at ? new Date(e.at * 1000).toISOString().slice(0, 10) : '';
    out.push({ ref: `e${e.id}`, name: `Email from ${e.sender || 'unknown'}${when ? `, ${when}` : ''}: ${e.subject || '(no subject)'}`,
      docId: e.doc_id || null, text: e.body.slice(0, PER_EMAIL) });
  }
  let left = BUDGET;
  return out.filter((s) => { if (left <= 0) return false; s.text = s.text.slice(0, left); left -= s.text.length; return true; });
}

/** What the case had when it was read: a new file, a longer text or a new email changes it. */
export const fingerprint = (sources) => sources.map((s) => `${s.ref}:${s.text.length}`).join(',');

const RECORD = {
  name: 'record_dates',
  description: 'Record every legal date found in the sources.',
  input_schema: {
    type: 'object',
    properties: {
      dates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            due: { type: 'string', description: 'The date as YYYY-MM-DD.' },
            what: { type: 'string', description: 'What happens or must be done by then, in at most 12 plain words, e.g. "Answer to the amended petition due".' },
            basis: { type: 'string', description: 'Only when the date is worked out rather than written: how, in one short line, e.g. "30 days after service on 1 Oct 2026".' },
            source: { type: 'string', description: 'The id of the source it is in, e.g. f12 or e5.' },
            quote: { type: 'string', description: 'The words in that source that give the date, copied exactly, 5 to 40 words.' },
          },
          required: ['due', 'what', 'source', 'quote'],
        },
      },
    },
    required: ['dates'],
  },
};

/** The paid call: sources in, dates out. Taken as an argument below so tests can stand in for it. */
async function askForDates(sources, today) {
  const res = await claude.messages.create({
    model: CAREFUL_MODEL, // not the fast one: these dates are acted on
    max_tokens: 4000,
    system: `You read the papers of one legal case and list its legal dates. Today is ${today}. Call record_dates once.
Include only dates that matter legally: court hearings and trial dates, mediation or arbitration sessions, deadlines to file, answer, respond, appeal or pay, discovery or disclosure deadlines, limitation and statute of repose dates, notice periods, dates ordered by a court, and deadlines a lawyer or the other side set in writing.
Leave out ordinary dates that are only history (when an email was sent, when a contract was signed) unless a deadline runs from them.
Include past ones too: the app shows them as passed.
Never guess. When a date is worked out from a rule written in the papers ("within 30 days of service"), give the worked-out date and say how in basis; if the starting date is not in the papers, leave it out.
The quote must be copied word for word from that source: it is checked, and a date whose quote is not found is dropped.`,
    tools: [RECORD],
    tool_choice: { type: 'tool', name: 'record_dates' },
    messages: [{ role: 'user', content: sources.map((s) => `<source id="${s.ref}" name="${s.name.replace(/"/g, "'")}">\n${s.text}\n</source>`).join('\n\n') }],
  });
  return res.content.find((b) => b.type === 'tool_use')?.input?.dates || [];
}

// Quotes are matched loosely on spacing, case and quote marks, never on the words themselves.
const flat = (s) => String(s || '').toLowerCase().replace(/[‘’“”"'`]/g, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const realDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** Keeps only dates that are real days and whose quote is in the source they name; one of each. */
export function checked(found, sources) {
  const seen = new Set();
  return found.flatMap((d) => {
    const src = sources.find((s) => s.ref === d.source);
    const quote = String(d.quote || '').trim();
    if (!src || !realDay(d.due) || !quote || !flat(src.text).includes(flat(quote))) return [];
    const what = String(d.what || '').trim().slice(0, 120);
    const key = `${d.due}|${flat(what).slice(0, 24)}`;
    if (!what || seen.has(key)) return [];
    seen.add(key);
    return [{ due: d.due, what, basis: d.basis ? String(d.basis).trim().slice(0, 160) : null, quote: quote.slice(0, 400), source_name: src.name, doc_id: src.docId }];
  });
}

/** Reads the case and replaces its dates. Awaited by tests; started in the background otherwise. */
export async function scanCase(userId, primary, files, { ask = askForDates, today = dubaiDate() } = {}) {
  const key = keyOf(primary);
  const sources = await sourcesOf(userId, primary, files);
  const print = fingerprint(sources);
  let dates = [];
  let error = null;
  try {
    dates = sources.length ? checked(await ask(sources, today), sources) : [];
  } catch (e) {
    error = 'Could not read the case just now. Try Check again.';
    console.error('[case deadlines]', e.message);
  }
  if (!error) {
    await db.prepare('DELETE FROM case_deadlines WHERE user_id = ? AND case_key = ?').run(userId, key);
    for (const d of dates) {
      await db.prepare(`INSERT INTO case_deadlines (user_id, case_key, due, what, basis, quote, source_name, doc_id)
        VALUES (?, ?, ?::date, ?, ?, ?, ?, ?)`).run(userId, key, d.due, d.what, d.basis, d.quote, d.source_name, d.doc_id);
    }
  }
  await db.prepare(`INSERT INTO case_deadline_scans (user_id, case_key, fingerprint, scanned_at, error)
    VALUES (?, ?, ?, extract(epoch from now())::bigint, ?)
    ON CONFLICT (user_id, case_key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, scanned_at = EXCLUDED.scanned_at, error = EXCLUDED.error`)
    .run(userId, key, error ? null : print, error);
}

const running = new Set(); // `${userId}:${case_key}` being read right now

/**
 * The case's dates for the panel. Starts a read in the background when the case has never been
 * read, has something new since, or force (Check again); the page asks again while scanning.
 */
export async function deadlinesFor(userId, primary, files, { force = false, scan = scanCase } = {}) {
  const key = keyOf(primary);
  const job = `${userId}:${key}`;
  const last = await db.prepare('SELECT fingerprint, scanned_at, error FROM case_deadline_scans WHERE user_id = ? AND case_key = ?').get(userId, key);
  if (!running.has(job)) {
    const stale = force || !last || last.error || last.fingerprint !== fingerprint(await sourcesOf(userId, primary, files));
    if (stale) {
      running.add(job);
      billAs({ userId, job: 'cases', note: `Deadlines for ${primary.number}` }, () => scan(userId, primary, files))
        .catch((e) => console.error('[case deadlines]', e.message))
        .finally(() => running.delete(job));
    }
  }
  const rows = await db.prepare(`SELECT id, due::text due, what, basis, quote, source_name, doc_id FROM case_deadlines
    WHERE user_id = ? AND case_key = ? ORDER BY due, id`).all(userId, key);
  return { today: dubaiDate(), scanning: running.has(job), scannedAt: last?.scanned_at || null, error: last?.error || null, deadlines: rows };
}
