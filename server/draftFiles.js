import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { extname } from 'node:path';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { emailFile } from './imap.js';

// Files an agent puts on an email it drafts: one from the user's Shelf (which is also where
// a file dropped into the chat lands), or one that arrived attached to another email.
// The bytes are copied here as the draft is written, so what goes out on Approve is the
// file as it was when the user saw the card — deleting it from the Shelf, or moving the
// email it came from, changes nothing. The copy goes when the draft is sent, rejected or
// deleted. Only the path is kept on the draft row: a 20 MB file has no business in a
// column that is read every time the drafts are listed.

const DIR = `${DATA_DIR}/draft-files`;
export const MAX_FILES = 10;
export const MAX_TOTAL = 20 * 1024 * 1024; // of files; base64 on the wire adds a third, and Titan stops at 30 MB

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** One of the user's own saved files, by the name or title the agent was shown. */
async function shelfFile(userId, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) throw new Error('An attachment needs a file name.');
  const like = `%${want.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await db.prepare(`SELECT id, name, title, mime, path FROM documents
    WHERE user_id = ? AND path IS NOT NULL AND (lower(name) LIKE ? OR lower(title) LIKE ?) ORDER BY id DESC LIMIT 20`)
    .all(userId, like, like);
  const exact = rows.filter((d) => d.name.toLowerCase() === want || String(d.title || '').toLowerCase() === want);
  // The same file name twice means the newer upload: that is the one just dropped into the chat.
  const doc = exact[0] ?? (rows.length === 1 ? rows[0] : null);
  if (!doc) {
    throw new Error(rows.length
      ? `More than one saved file matches “${name}”: ${rows.map((d) => d.name).join(', ')}. Use the exact file name.`
      : `There is no saved file called “${name}”. Only files on the user's Shelf, or dropped into this chat, can be attached.`);
  }
  let buffer;
  try { buffer = readFileSync(doc.path); } catch { throw new Error(`${doc.name} is listed on the Shelf but its file is missing.`); }
  return { name: doc.name, mimetype: doc.mime, buffer };
}

/**
 * Resolve what the agent asked for — [{ name, email_id? }] — into the rows a draft keeps.
 * All or nothing: one file that cannot be found fails the draft, rather than an email
 * going out that says "attached" with nothing on it.
 */
export async function gather(userId, items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length > MAX_FILES) throw new Error(`Too many attachments (at most ${MAX_FILES} on one email).`);
  const files = [];
  for (const it of list) {
    files.push(it?.email_id ? await emailFile(userId, { id: it.email_id, name: it.name }) : await shelfFile(userId, it?.name));
  }
  const total = files.reduce((n, f) => n + f.buffer.length, 0);
  if (total > MAX_TOTAL) throw new Error(`These attachments are ${mb(total)} together; an email can carry ${mb(MAX_TOTAL)}.`);

  if (files.length) mkdirSync(`${DIR}/${userId}`, { recursive: true });
  return files.map((f) => {
    const path = `${DIR}/${userId}/${randomUUID()}${extname(f.name).toLowerCase().replace(/[^.\w]/g, '')}`;
    writeFileSync(path, f.buffer);
    return { filename: f.name, contentType: f.mimetype || 'application/octet-stream', path, size: f.buffer.length };
  });
}

/** A draft's attachments as the mail composer takes them: bytes in, paths out. */
export function withContent(attachments) {
  return attachments.map(({ path, size, ...a }) => {
    if (!path) return a; // already carries its bytes (the meeting PDF)
    try { return { ...a, content: readFileSync(path).toString('base64') }; } catch { throw new Error(`The attachment ${a.filename} is no longer available. Write the email again.`); }
  });
}

/** Remove a draft's copies. Only ever inside our own folder, whatever the row says. */
export function discard(draft) {
  for (const a of draft?.attachments ? JSON.parse(draft.attachments) : []) {
    if (a.path?.startsWith(`${DIR}/`)) rmSync(a.path, { force: true });
  }
}
