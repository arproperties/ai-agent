import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { DATA_DIR, MODELS } from './config.js';
import { isMaster } from './access.js';
import { claude, drawPicture } from './ai.js';

// Pictures: a chat message that opens with a tag is drawn instead of answered. The person
// types "/explain how an AC works" and gets an infographic back, with a few lines under it.
//
// Two steps. Claude writes what the picture says (planPicture), so the facts are Claude's
// and the words under the picture match the ones in it; the image model only draws it.
//
// A module (server/modules.js, 'pictures'): every picture is paid for, so the master
// ticks who may ask for one. Without the tick the tag is just words and gets a normal reply.
//
// To add a tag: a line in TAGS. The client needs nothing.

const DIR = `${DATA_DIR}/pictures`;

// parts: what the plan's list is, told to Claude. layout: how it is drawn, told to the image model.
export const TAGS = {
  explain: {
    asks: 'how something works',
    parts: 'the steps, in the order they happen (3 to 6)',
    layout: 'Middle: one large labelled diagram showing how it works, its main components joined by coloured arrows. ' +
      'Bottom: a row of numbered step boxes, one for each step below, each with a small icon, its heading and its line.',
  },
  breakdown: {
    asks: 'what something is made of',
    parts: 'the parts it splits into (3 to 8)',
    layout: 'Below the title: one box for each part below, laid out in a tidy grid of equal boxes, each in its own soft colour ' +
      'with a small icon, its heading and its line.',
  },
  explore: {
    asks: 'what there is to know about a subject',
    parts: 'the main areas of the subject (5 to 7)',
    layout: 'A topic map: the subject in a circle at the centre, and one branch for each area below spreading out around it, ' +
      'each branch ending in a small icon, its heading and its line.',
  },
};

/** The tag a message opens with and what follows it, or null for an ordinary message. */
export function pictureTag(text) {
  const m = new RegExp(`^/(${Object.keys(TAGS).join('|')})(?![\\w/])[\\s:]*([\\s\\S]*)$`, 'i').exec(String(text || '').trim());
  return m ? { tag: m[1].toLowerCase(), topic: m[2].trim().slice(0, 500) } : null;
}

// ---------- what the picture says ----------

const SKETCH = {
  name: 'sketch',
  description: 'Write down what the picture says.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'At most 6 words.' },
      summary: { type: 'string', description: 'One plain sentence, at most 20 words.' },
      parts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string', description: 'At most 4 words.' },
            text: { type: 'string', description: 'One short line, at most 14 words.' },
          },
          required: ['heading', 'text'],
        },
      },
      explanation: { type: 'string', description: 'Two to four short sentences to read under the picture, in plain words.' },
    },
    required: ['title', 'summary', 'parts', 'explanation'],
  },
};

/** What goes in the picture and under it. */
async function planPicture({ tag, topic }) {
  const res = await claude.messages.create({
    model: MODELS[0].id, // not the fast one: what it writes is printed as fact
    max_tokens: 1200,
    system: `You plan an infographic for staff of a property company in the UAE. It answers ${TAGS[tag].asks}. Call the sketch tool.

- parts: ${TAGS[tag].parts}.
- Plain words a new member of staff would follow. Every line short: it is printed inside a picture.
- Write in the language the request is written in.
- Only what is generally true. Never invent a price, a fee, a percentage, a date, a law or a name: give a figure only when the request itself states it.`,
    tools: [SKETCH],
    tool_choice: { type: 'tool', name: 'sketch' },
    messages: [{ role: 'user', content: topic }],
  });
  return res.content.find((b) => b.type === 'tool_use')?.input;
}

const line = (s, max) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** A plan made safe to draw: a title, at least two parts with words in them, nothing overlong. */
export function tidyPlan(p) {
  const parts = (Array.isArray(p?.parts) ? p.parts : [])
    .map((x) => ({ heading: line(x?.heading, 60), text: line(x?.text, 160) }))
    .filter((x) => x.heading)
    .slice(0, 8);
  const title = line(p?.title, 80);
  if (!title || parts.length < 2) return null;
  return { title, summary: line(p.summary, 220), parts, explanation: String(p.explanation || '').trim().slice(0, 1200) };
}

/** What the image model is asked to draw. */
export function imagePrompt(tag, plan) {
  return [
    'A clean, friendly educational infographic. Landscape, white background, flat illustration style, soft colours, generous spacing.',
    `Top: the title "${plan.title}" in large bold letters${plan.summary ? `, and under it the line "${plan.summary}"` : ''}.`,
    TAGS[tag].layout,
    plan.parts.map((x, i) => `${i + 1}. ${x.heading}${x.text ? `: ${x.text}` : ''}`).join('\n'),
    'Use exactly these words, spelled exactly as written here. No other sentences, no logos, no watermark.',
  ].join('\n\n');
}

// ---------- drawing ----------

const fileTitle = (s) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Picture';

/**
 * Draw the picture asked for and keep it. Returns what the reply says and the picture to
 * hang on it: { content, files: [{ name, kind: 'picture', pictureId }] }.
 */
export async function makePicture(user, conversationId, { tag, topic }, { plan = planPicture, draw = drawPicture } = {}) {
  const sketch = tidyPlan(await plan({ tag, topic }));
  if (!sketch) throw new Error('The plan for the picture came back empty');
  const buffer = await draw(imagePrompt(tag, sketch));
  if (!buffer?.length) throw new Error('No picture came back');
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/${randomUUID()}.jpg`;
  await writeFile(path, buffer);
  const { id } = await db.prepare('INSERT INTO pictures (user_id, conversation_id, tag, topic, title, path) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .run(user.id, conversationId, tag, topic, sketch.title, path);
  return {
    content: [`**${sketch.title}**`, sketch.explanation].filter(Boolean).join('\n\n'),
    files: [{ name: `${fileTitle(sketch.title)}.jpg`, kind: 'picture', pictureId: id }],
  };
}

/** A picture, for the person it was drawn for. The master can open anyone's, as with their chats. */
export async function pictureFor(user, id) {
  const p = await db.prepare('SELECT * FROM pictures WHERE id = ?').get(Number(id) || 0);
  return p && (p.user_id === user.id || isMaster(user)) ? p : null;
}

// ---------- routes ----------

// Not behind the module: a picture already drawn stays openable after the tick is taken away.
export const pictureRoutes = Router();

pictureRoutes.get('/:id', (req, res, next) => {
  pictureFor(req.user, req.params.id).then((p) => {
    if (!p) return res.status(404).json({ error: 'Not found' });
    const name = encodeURIComponent(`${fileTitle(p.title)}.jpg`);
    res.set('Cache-Control', 'private, max-age=86400').set('X-Content-Type-Options', 'nosniff')
      .set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`)
      // The path is our own, so a dot folder somewhere above the app is no reason to refuse it.
      .type('image/jpeg').sendFile(p.path, { dotfiles: 'allow' });
  }, next);
});
