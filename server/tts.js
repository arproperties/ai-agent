// Spoken replies: register a snippet, then stream its audio (and keep it on disk).
//
// Two steps, because <audio> can only load a GET URL and the reply text is too
// long to put in one. The browser then streams the mp3 natively: it starts
// playing on the first chunk and can pause, resume and seek. Finished audio is
// cached by content, so reading the same reply again is instant and free.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { DATA_DIR } from './config.js';
import { speakStream } from './ai.js';

const DIR = `${DATA_DIR}/tts`;
const MAX_FILES = 400;          // ~a few hundred replies; oldest are dropped
const PENDING_TTL = 10 * 60000; // a registered snippet is playable for 10 minutes

mkdirSync(DIR, { recursive: true });

const file = (key) => `${DIR}/${key}.mp3`;
const pending = new Map(); // key -> { userId, text, voice, tone, at }

// Markdown reads badly out loud: drop code blocks, bullets, emphasis and link URLs.
export const spoken = (raw) => String(raw || '')
  .replace(/```[\s\S]*?```/g, ' (code omitted) ')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/[*_#>`|]/g, '')
  .trim();

// Same text in the same voice = same key, so a replay hits the cache.
export function prepare({ userId, text, voice, tone }) {
  const key = createHash('sha256').update(`${voice}|${tone || ''}|${text}`).digest('hex').slice(0, 32);
  pending.set(key, { userId, text, voice, tone, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL) pending.delete(k);
  return { key, cached: existsSync(file(key)) };
}

export const cachedPath = (key) => (/^[a-f0-9]{32}$/.test(key) && existsSync(file(key)) ? file(key) : null);

export const claim = (key, userId) => {
  const job = pending.get(key);
  return job && job.userId === userId ? job : null;
};

// Generate and pipe to the client and to the cache at the same time. The cache
// file is only kept if the whole thing arrived.
export async function streamTo(key, job, res) {
  // Tied to the listener: hanging up cancels the generation, whether it has
  // started sending audio yet or not.
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());

  let upstream;
  try {
    upstream = await speakStream(job.text, job.voice, job.tone, ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) return; // gave up before the first note
    throw e;
  }
  if (ctrl.signal.aborted) return;

  const source = Readable.fromWeb(upstream.body);
  const tmp = `${file(key)}.${randomUUID()}.part`;
  const disk = createWriteStream(tmp);
  let settled = false;

  // Only keep the cached file if the whole thing arrived — a half-generated
  // reply must never be replayed as if it were complete.
  const settle = (whole) => {
    if (settled) return;
    settled = true;
    disk.end(() => {
      try { whole ? renameSync(tmp, file(key)) : unlinkSync(tmp); } catch { /* already gone */ }
      if (whole) prune();
    });
  };

  source.on('end', () => settle(true));
  source.on('error', () => { settle(false); res.destroy(); }); // includes the abort above

  res.type('audio/mpeg');
  source.pipe(disk, { end: false }); // settle() closes it, so cancels clean up too
  source.pipe(res);
}

function prune() {
  const all = readdirSync(DIR);
  for (const f of all.filter((f) => f.endsWith('.part'))) { // abandoned by an earlier crash
    try { if (Date.now() - statSync(`${DIR}/${f}`).mtimeMs > 3600_000) unlinkSync(`${DIR}/${f}`); } catch { /* raced */ }
  }
  const files = all.filter((f) => f.endsWith('.mp3'))
    .map((f) => ({ f, at: statSync(`${DIR}/${f}`).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { f } of files.slice(MAX_FILES)) try { unlinkSync(`${DIR}/${f}`); } catch { /* raced */ }
}
