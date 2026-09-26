import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import { DATA_DIR, FAST_MODEL } from './config.js';

// Claude: chat, reading attachments, learning memories
export const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });

// OpenAI: voice only (speech-to-text and text-to-speech)
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

export async function transcribe(buffer, mimetype) {
  if (!openai) throw new Error('Voice is not configured (OPENAI_API_KEY missing)');
  const res = await openai.audio.transcriptions.create({
    file: await toFile(buffer, `audio.${audioExt(mimetype)}`, { type: mimetype }),
    model: 'gpt-4o-mini-transcribe',
  });
  return res.text;
}

const EXT = { mp4: 'mp4', m4a: 'm4a', mpeg: 'mp3', mp3: 'mp3', wav: 'wav', ogg: 'ogg' };
export const audioExt = (mimetype = '') => EXT[Object.keys(EXT).find((k) => mimetype.includes(k))] || 'webm';

/**
 * A stretch of a meeting, as who said what. speakers: [{ name, sample }] with sample a data
 * URL of 2–10 seconds of that person talking; the API names at most four. Anyone else comes
 * back as 'A', 'B'… — letters that restart with every request, so they are returned as null.
 */
export async function transcribeSpeakers(buffer, mimetype, speakers = []) {
  if (!openai) throw new Error('Voice is not configured (OPENAI_API_KEY missing)');
  const known = speakers.slice(0, 4);
  const res = await openai.audio.transcriptions.create({
    file: await toFile(buffer, `meeting.${audioExt(mimetype)}`, { type: mimetype }),
    model: 'gpt-4o-transcribe-diarize',
    response_format: 'diarized_json',
    chunking_strategy: 'auto',
    ...(known.length ? {
      known_speaker_names: known.map((s) => s.name),
      known_speaker_references: known.map((s) => s.sample),
    } : {}),
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
  if (!openai) throw new Error('Voice is not configured (OPENAI_API_KEY missing)');
  return openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice,
    input: text.slice(0, 4000),
    instructions: tone ? `Speak naturally, in a tone that fits this character: ${tone.slice(0, 300)}` : undefined,
    response_format: 'mp3',
    stream_format: 'audio',
  }, { signal }); // stops generating (and billing) the moment the listener gives up
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
    return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
  })().catch((e) => {
    console.warn('[embeddings] disabled, using keyword search only:', e.message);
    return null;
  });
  return embedderPromise;
}
embedder(); // warm up on boot

// Texts per model run. The runtime keeps whatever memory its largest run needed: 32 long
// chunks at once took it past 1 GB for good, and PM2 restarts the app at 900 MB. 8 peaks
// near 350 MB, for much the same total time.
const EMBED_BATCH = 8;

export async function embed(texts) {
  const fn = await embedder();
  if (!fn) return texts.map(() => null);
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const out = await fn(texts.slice(i, i + EMBED_BATCH), { pooling: 'mean', normalize: true });
    const dims = out.dims[1];
    for (let j = 0; j < out.dims[0]; j++) vectors.push(new Float32Array(out.data.slice(j * dims, (j + 1) * dims)));
  }
  return vectors;
}
