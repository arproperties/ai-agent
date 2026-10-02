import { IMAGE_TYPES, extractText, describeImage } from './knowledge.js';

// Reading a file that came attached to an email. The mailbox modules (imap.js, outlook.js)
// fetch the bytes; what a file says is worked out here, the same way the chat's 📎 does it,
// so a PDF reads the same whether it was dropped into the chat or arrived in the inbox.
// Read-only like the rest of the mail reading: nothing is stored and nothing is filed.

export const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 24000; // the same budget chat.js gives a file dropped into the chat

const IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const key = (s) => String(s || '').trim().toLowerCase();

/**
 * Which attachment was meant. The name is whatever the model copied out of read_email, so
 * it is matched loosely — but never guessed: two candidates is an error that lists them.
 */
export function pickAttachment(files, name) {
  if (!files.length) throw new Error('That email has no attachments.');
  const want = key(name);
  const listed = files.map((f) => f.name).join(', ');
  if (!want) {
    if (files.length === 1) return files[0];
    throw new Error(`That email has ${files.length} attachments — say which one: ${listed}`);
  }
  const exact = files.filter((f) => key(f.name) === want);
  const hits = exact.length ? exact : files.filter((f) => key(f.name).includes(want));
  if (hits.length === 1) return hits[0];
  throw new Error(`${hits.length ? 'More than one attachment matches' : 'No attachment is called'} “${name}”. The attachments are: ${listed}`);
}

/** The text of one attachment: { name, mimetype, buffer } → what goes back to the agent. */
export async function attachmentText({ name, mimetype, buffer }) {
  if (buffer.length > MAX_BYTES) throw new Error(`${name} is too large to read (over ${MAX_BYTES / 1024 / 1024} MB).`);
  const ext = key(name).split('.').pop();
  const type = IMAGE_TYPES.includes(mimetype) ? mimetype : IMAGE_EXT[ext];
  const text = type
    ? await describeImage({ buffer, mimetype: type })
    : await extractText({ buffer, mimetype: String(mimetype || ''), originalname: name });
  const clean = String(text || '').replace(/\u0000/g, '').trim();
  if (!clean) throw new Error(`No readable text found in ${name}`);
  return `<attachment name="${name}">\n${clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}\n…(truncated)` : clean}\n</attachment>`;
}
