import { readFileSync } from 'node:fs';
import { readableDocument } from './files.js';
import { isDrawing, roughModel } from './dwg.js';
import { claude } from './ai.js';
import { FAST_MODEL } from './config.js';
import { billAs } from './billing.js';
import { isPlanFile, planModel } from './plan3d.js';

// The last few rough models made, so opening the same drawing again is instant instead of
// converting it again. Keyed by the file's bytes as well, in case it is ever replaced.
const made = new Map();

const LAYERS = {
  name: 'wall_layers',
  description: 'The layers that hold the walls of the building, as drawn in plan.',
  input_schema: { type: 'object', properties: { layers: { type: 'array', items: { type: 'string' } } }, required: ['layers'] },
};

/**
 * A drawing whose layers are not named for walls (A-MURO, BLK-200, 0…): Reem picks the wall
 * layers from their names and what is on them. Only the choice is Reem's; the walls stand
 * where the drawing has them, at its own size.
 */
async function pickWallLayers(list) {
  if (!list.length) return [];
  const res = await claude.messages.create({
    model: FAST_MODEL,
    max_tokens: 400,
    system: 'You are given the layers of an architectural CAD drawing: each name, how many lines it has and their total length. ' +
      'Pick the layers that hold the walls of the building in plan (outer walls, inner walls, partitions, blockwork). ' +
      'Not doors, windows, furniture, hatching, dimensions, text, grids, columns alone, site, landscape or the sheet frame. ' +
      'An empty list when no layer clearly holds walls. Call wall_layers once.',
    tools: [LAYERS],
    tool_choice: { type: 'tool', name: 'wall_layers' },
    messages: [{ role: 'user', content: list.join('\n') }],
  });
  const names = new Set(list.map((l) => l.slice(0, l.lastIndexOf(': ', l.indexOf(' lines')))));
  return (res.content.find((b) => b.type === 'tool_use')?.input?.layers || []).filter((l) => names.has(l)).slice(0, 8);
}

/**
 * The 3D view of a file the person may open (the same reach as opening the file itself,
 * readableDocument): the walls of a DWG/DXF, or of a PDF or picture of a plan as Reem traced
 * them; { pending, step } while a plan is still being read; null when it is not a drawing.
 */
export async function roughModelFor(user, docId) {
  const doc = await readableDocument(user, docId);
  if (!doc?.path) return null;
  if (isPlanFile(doc)) return planModel(user, doc);
  if (!isDrawing(doc.name)) return null;
  const key = `${doc.id}:${doc.hash || doc.size}`;
  if (made.has(key)) return made.get(key);
  const model = await billAs({ userId: user.id, job: '3d-plan' },
    () => roughModel(readFileSync(doc.path), doc.name, { pickLayers: pickWallLayers }));
  made.set(key, model);
  if (made.size > 5) made.delete(made.keys().next().value);
  return model;
}
