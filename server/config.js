import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);

export const DATA_DIR = `${ROOT}data`;
export const PORT = Number(process.env.PORT) || 3001;
// Optional: when set, people need this invite code to create an account
export const REGISTRATION_CODE = process.env.REGISTRATION_CODE || '';

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
