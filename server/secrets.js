import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// The mailbox password, at rest. AES-256-GCM with a key from .env — the app can read the
// password back (IMAP and SMTP both need the plaintext to authenticate), so this protects
// a stolen database dump, not the running server.

function key() {
  const k = Buffer.from(process.env.EMAIL_KEY || '', 'base64');
  if (k.length !== 32) throw new Error('EMAIL_KEY is missing or invalid in .env (needs 32 random bytes, base64). See README.');
  return k;
}

export function encrypt(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(stored) {
  const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
