import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);

export const DATA_DIR = `${ROOT}data`;
export const PORT = Number(process.env.PORT) || 3001;
// Postgres. Uploads and the embedding model still live on disk in DATA_DIR.
export const DATABASE_URL = process.env.DATABASE_URL || '';
// The local embedding model (ai.js). Multilingual, because the files and the questions
// are in Arabic as well as English. Vectors from two models cannot be compared, so each
// stored one is marked with the model that made it: change this and db.js clears the
// old ones at boot, and `npm run backfill-embeddings` builds them again.
export const EMBED_MODEL = 'Xenova/multilingual-e5-small';

// Web push. Generated once by `node scripts/vapid-keys.js` and pasted into .env — they
// are this server's identity to Apple's and Google's push services, not an account with
// either of them. Missing keys simply mean notifications stay off.
export const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
export const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
// Who to contact if this server ever misbehaves; a push service may require it.
export const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@ainalreempro.com';

export const MODELS = [
  // Auto: Haiku answers and calls Sonnet in as an advisor only when a question is hard
  // (server/chat.js), so nobody has to guess per agent which questions will be hard.
  { id: 'auto', label: 'Auto · cheap, asks Sonnet when hard' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 · balanced' },
  { id: 'claude-opus-5', label: 'Opus 5 · smartest' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 · fastest' },
];
export const FAST_MODEL = 'claude-haiku-4-5-20251001';
// What Auto runs on: the executor writes the answer, the advisor is consulted mid-answer.
export const AUTO_MODEL = 'claude-haiku-5-5';
export const ADVISOR_MODEL = 'claude-sonnet-5-5';
// The master on Auto: the boss noticed Haiku's answers, so his get the stronger model writing them.
export const MASTER_MODEL = 'claude-sonnet-5-5';
// For work printed or filed as fact (lease renewals, picture captions): always the careful model.
export const CAREFUL_MODEL = 'claude-sonnet-5';
// OpenAI's image model, for the pictures a chat tag asks for (server/pictures.js).
export const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-2.5-sunburst';
export const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
export const COLORS = ['violet', 'blue', 'teal', 'amber', 'rose', 'slate'];
export const AGENT_ICONS = ['bot', 'sparkles', 'building', 'home', 'briefcase', 'headset', 'users', 'pen', 'megaphone', 'graduation', 'brain', 'code', 'calculator', 'wallet', 'scale', 'stethoscope', 'dumbbell', 'heart', 'chef', 'plane', 'shopping', 'camera', 'globe', 'rocket'];
export const FOLDERS = ['Contracts & Agreements', 'Tenancy & Property', 'Invoices & Receipts', 'Financial & Tax', 'Legal', 'HR & Employees',
  'IDs & Personal', 'Company & Licenses', 'Correspondence', 'Marketing', 'Photos', 'Other'];
