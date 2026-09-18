import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import { DATA_DIR, FAST_MODEL } from './config.js';

// Claude: chat, reading attachments, learning memories
export const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });

// OpenAI: voice only (speech-to-text and text-to-speech)
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

export async function transcribe(buffer, mimetype) {
  if (!openai) throw new Error('Voice is not configured (OPENAI_API_KEY missing)');
  const types = { mp4: 'mp4', m4a: 'm4a', mpeg: 'mp3', mp3: 'mp3', wav: 'wav', ogg: 'ogg' };
  const ext = types[Object.keys(types).find((k) => mimetype.includes(k))] || 'webm';
  const res = await openai.audio.transcriptions.create({
    file: await toFile(buffer, `audio.${ext}`, { type: mimetype }),
    model: 'gpt-4o-mini-transcribe',
  });
  return res.text;
}

export async function speak(text, voice, tone) {
  if (!openai) throw new Error('Voice is not configured (OPENAI_API_KEY missing)');
  const res = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice,
    input: text.slice(0, 4000),
    instructions: tone ? `Speak naturally, in a tone that fits this character: ${tone.slice(0, 300)}` : undefined,
    response_format: 'mp3',
  });
  return Buffer.from(await res.arrayBuffer());
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

export async function embed(texts) {
  const fn = await embedder();
  if (!fn) return texts.map(() => null);
  const out = await fn(texts, { pooling: 'mean', normalize: true });
  const dims = out.dims[1];
  return texts.map((_, i) => new Float32Array(out.data.slice(i * dims, (i + 1) * dims)));
}
