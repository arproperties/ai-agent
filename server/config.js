import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);

export const DATA_DIR = `${ROOT}data`;
export const PORT = Number(process.env.PORT) || 3001;
// Postgres. Uploads and the embedding model still live on disk in DATA_DIR.
export const DATABASE_URL = process.env.DATABASE_URL || '';

// Web push. Generated once by `node scripts/vapid-keys.js` and pasted into .env — they
// are this server's identity to Apple's and Google's push services, not an account with
// either of them. Missing keys simply mean notifications stay off.
export const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
export const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
// Who to contact if this server ever misbehaves; a push service may require it.
export const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@ainalreempro.com';

export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5 · balanced' },
  { id: 'claude-opus-5', label: 'Opus 5 · smartest' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 · fastest' },
];
export const FAST_MODEL = 'claude-haiku-4-5-20251001';
export const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
export const COLORS = ['violet', 'blue', 'teal', 'amber', 'rose', 'slate'];
export const AGENT_ICONS = ['bot', 'sparkles', 'building', 'home', 'briefcase', 'headset', 'users', 'pen', 'megaphone', 'graduation', 'brain', 'code', 'calculator', 'wallet', 'scale', 'stethoscope', 'dumbbell', 'heart', 'chef', 'plane', 'shopping', 'camera', 'globe', 'rocket'];
export const FOLDERS = ['Contracts & Agreements', 'Tenancy & Property', 'Invoices & Receipts', 'Financial & Tax', 'Legal', 'HR & Employees',
  'IDs & Personal', 'Company & Licenses', 'Correspondence', 'Marketing', 'Photos', 'Other'];
