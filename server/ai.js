import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import { DATA_DIR, EMBED_MODEL, FAST_MODEL, IMAGE_MODEL } from './config.js';
import { watch, recordOpenAI, billedUserId } from './billing.js';
import { keysFor, isKeyError, keyFailed } from './aiKeys.js';

// Which API key each call uses is decided per call, for the person it is for: their own,
// else the company's, else .env (server/aiKeys.js). One client per key, made on first use.
const clients = new Map();
const clientFor = (k) => {
  if (!clients.has(k.key)) {
    clients.set(k.key, k.provider === 'anthropic' ? watch(new Anthropic({ apiKey: k.key }), k.source) : new OpenAI({ apiKey: k.key }));
  }
  return clients.get(k.key);
};

const NO_CLAUDE = 'No Claude API key is set (Settings → AI keys)';

// Plain calls: a key the provider turns down is passed over, and the call made again with the next.
async function withKey(provider, missing, fn) {
  const chain = keysFor(provider, billedUserId());
  if (!chain.length) throw new Error(missing);
  for (let i = 0; ; i++) {
    try {
      return await fn(clientFor(chain[i]), chain[i]);
    } catch (e) {
      if (!isKeyError(e) || i === chain.length - 1) throw e;
      keyFailed(chain[i], e);
    }
  }
}

// A stream is handed back at once, so it cannot quietly start again on another key: a key
// turned down is noted (the next call skips it), and chat asks once more itself (chat.js).
function streamWithKey(pick, args) {
  const [k] = keysFor('anthropic', billedUserId());
  if (!k) throw new Error(NO_CLAUDE);
  const s = pick(clientFor(k)).stream(...args);
  s.on('error', (e) => { if (isKeyError(e)) keyFailed(k, e); });
  return s;
}

// Claude: chat, reading attachments, learning memories. Every call is priced (server/billing.js).
// The same shape as the SDK client for what the app uses of it.
export const claude = {
  messages: {
    create: (...args) => withKey('anthropic', NO_CLAUDE, (c) => c.messages.create(...args)),
    stream: (...args) => streamWithKey((c) => c.messages, args),
  },
  beta: {
    messages: {
      create: (...args) => withKey('anthropic', NO_CLAUDE, (c) => c.beta.messages.create(...args)),
      stream: (...args) => streamWithKey((c) => c.beta.messages, args),
    },
  },
};

// OpenAI: voice (speech-to-text and text-to-speech) and drawing pictures
const withOpenAI = (missing, fn) => withKey('openai', missing, fn);
const NO_VOICE = 'Voice is not configured (no OpenAI key in Settings → AI keys)';

// language: an ISO 639-1 code ('ar', 'ur'…) when the caller knows what is being spoken.
// It makes short phrases far more reliable; without it the model works the language out.
// prompt: a line of context in words, for a language the API has no code for.
export async function transcribe(buffer, mimetype, { language, prompt } = {}) {
  return withOpenAI(NO_VOICE, async (openai, key) => {
    const res = await openai.audio.transcriptions.create({
      file: await toFile(buffer, `audio.${audioExt(mimetype)}`, { type: mimetype }),
      model: 'gpt-4o-mini-transcribe',
      ...(language ? { language } : {}),
      ...(prompt ? { prompt } : {}),
    });
    recordOpenAI('gpt-4o-mini-transcribe', { minutes: audioMinutes(res) }, key.source);
    return res.text;
  });
}

// How long the audio was, from what the answer says: seconds, or audio tokens (about 600 a minute).
const audioMinutes = (res) => (res.usage?.seconds ?? res.duration ?? (res.usage?.input_token_details?.audio_tokens || 0) / 10) / 60;

/** When each word is said in a spoken reply: [{ w, s, e }] in seconds, for the read-aloud highlighter. */
export async function wordTimings(buffer) {
  return withOpenAI(NO_VOICE, async (openai, key) => {
    const res = await openai.audio.transcriptions.create({
      file: await toFile(buffer, 'speech.mp3', { type: 'audio/mpeg' }),
      model: 'whisper-1', // the one model that gives word times
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });
    recordOpenAI('whisper-1', { minutes: audioMinutes(res) }, key.source);
    return (res.words || []).map((x) => ({ w: x.word, s: x.start, e: x.end }));
  });
}

const EXT = { mp4: 'mp4', m4a: 'm4a', mpeg: 'mp3', mp3: 'mp3', wav: 'wav', ogg: 'ogg' };
export const audioExt = (mimetype = '') => EXT[Object.keys(EXT).find((k) => mimetype.includes(k))] || 'webm';

/**
 * A stretch of a meeting, as who said what. speakers: [{ name, sample }] with sample a data
 * URL of 2–10 seconds of that person talking; the API names at most four. Anyone else comes
 * back as 'A', 'B'… — letters that restart with every request, so they are returned as null.
 */
export async function transcribeSpeakers(buffer, mimetype, speakers = []) {
  const known = speakers.slice(0, 4);
  const res = await withOpenAI(NO_VOICE, async (openai, key) => {
    const r = await openai.audio.transcriptions.create({
      file: await toFile(buffer, `meeting.${audioExt(mimetype)}`, { type: mimetype }),
      model: 'gpt-4o-transcribe-diarize',
      response_format: 'diarized_json',
      chunking_strategy: 'auto',
      ...(known.length ? {
        known_speaker_names: known.map((s) => s.name),
        known_speaker_references: known.map((s) => s.sample),
      } : {}),
    });
    recordOpenAI('gpt-4o-transcribe-diarize', { minutes: audioMinutes(r) }, key.source);
    return r;
  });
  const names = new Set(known.map((s) => s.name));
  return {
    duration: res.duration || 0,
    segments: (res.segments || [])
      .filter((s) => s.text?.trim())
      .map((s) => ({ start: s.start, end: s.end, speaker: names.has(s.speaker) ? s.speaker : null, text: s.text.trim() })),
  };
}

// Text to speech. Returns the raw response so the caller can pipe the audio out
// as it is generated — playback starts on the first chunk instead of the last.
export async function speakStream(text, voice, tone, signal) {
  return withOpenAI(NO_VOICE, async (openai, key) => {
    const res = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice,
      input: text.slice(0, 4000),
      instructions: tone ? `Speak naturally, in a tone that fits this character: ${tone.slice(0, 300)}` : undefined,
      response_format: 'mp3',
      stream_format: 'audio',
    }, { signal }); // stops generating (and billing) the moment the listener gives up
    recordOpenAI('gpt-4o-mini-tts', { chars: Math.min(text.length, 4000) }, key.source);
    return res;
  });
}

// A picture from a description, as JPEG bytes. Landscape, to fit an infographic; JPEG
// because a PNG of one is several times the size on disk and over a phone's connection.
export async function drawPicture(prompt) {
  return withOpenAI('Pictures are not configured (no OpenAI key in Settings → AI keys)', async (openai, key) => {
    const res = await openai.images.generate({
      model: IMAGE_MODEL, prompt, size: '1536x1024', quality: 'medium', output_format: 'jpeg', output_compression: 85, n: 1,
    });
    recordOpenAI('gpt-image', { pictures: 1 }, key.source);
    return Buffer.from(res.data[0].b64_json, 'base64');
  });
}

// Quick one-shot Claude call returning plain text
export async function ask(prompt, { system, content, maxTokens = 1024 } = {}) {
  const res = await claude.messages.create({
    model: FAST_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: content ?? prompt }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// Local embeddings: runs on this machine, free, no API key. Falls back to keyword-only search if it fails.
let embedderPromise;
function embedder() {
  embedderPromise ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = `${DATA_DIR}/models`;
    return pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
  })().catch((e) => {
    console.warn('[embeddings] disabled, using keyword search only:', e.message);
    return null;
  });
  return embedderPromise;
}
embedder(); // warm up on boot

// Texts per model run. The runtime keeps whatever memory its largest run needed, and PM2
// restarts the app when it grows too large. The multilingual model takes about 560 MB just
// to load; 2 long chunks at once peak near 590 MB, 8 near 810 MB, for the same total time.
const EMBED_BATCH = 2;

/**
 * kind: 'passage' for text that is stored, 'query' for the question it is searched with.
 * The model was trained with the two marked, and ranks worse when they are not.
 */
export async function embed(texts, kind = 'passage') {
  const fn = await embedder();
  if (!fn) return texts.map(() => null);
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const out = await fn(texts.slice(i, i + EMBED_BATCH).map((t) => `${kind}: ${t}`), { pooling: 'mean', normalize: true });
    const dims = out.dims[1];
    for (let j = 0; j < out.dims[0]; j++) vectors.push(new Float32Array(out.data.slice(j * dims, (j + 1) * dims)));
  }
  return vectors;
}
