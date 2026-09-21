import { api } from './api.js';
import { zipEntries, zipRead, sortFile, isJunk, baseName, mimeOf } from './zip.js';

// The browser half of a folder / ZIP import: sort the files, then send the keepers ten at a
// time. Filing happens on the server afterwards, so once this finishes the tab can close.
// Kept outside React so leaving the Shelf and coming back does not lose an upload in flight.

const BATCH_FILES = 10; // the server's per-request limit
const BATCH_BYTES = 40 * 1024 * 1024; // under the 50 MB nginx accepts per request

let state = null; // { name, phase: 'reading' | 'uploading' | 'error', sent, total, error }
const listeners = new Set();
const set = (s) => { state = s; listeners.forEach((fn) => fn(state)); };
export const importState = () => state;
export function onImport(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const warnOnLeave = (e) => { e.preventDefault(); e.returnValue = ''; };

/** A picked ZIP → items to send, with what was left out. */
async function fromZip(file) {
  const items = [];
  const ignored = {};
  for (const e of await zipEntries(file)) {
    if (isJunk(e.name)) continue;
    const kind = sortFile(e.name, e.size);
    if (kind === 'keep') items.push({ name: baseName(e.name), size: e.size, read: () => zipRead(file, e) });
    else ignored[kind] = (ignored[kind] || 0) + 1;
  }
  return { items, ignored };
}

/** A picked folder (a FileList from <input webkitdirectory>) → the same. */
function fromFolder(files) {
  const items = [];
  const ignored = {};
  for (const f of files) {
    const path = f.webkitRelativePath || f.name;
    if (isJunk(path)) continue;
    const kind = sortFile(path, f.size);
    if (kind === 'keep') items.push({ name: f.name, size: f.size, read: async () => f });
    else ignored[kind] = (ignored[kind] || 0) + 1;
  }
  return { items, ignored };
}

function batches(items) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= BATCH_FILES || bytes + it.size > BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(it);
    bytes += it.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function send(importId, batch) {
  const form = new FormData();
  for (const it of batch) {
    const blob = await it.read();
    form.append('files', new File([blob], it.name, { type: mimeOf(it.name) }));
  }
  // a dropped connection should not cost the batch: try again a couple of times
  for (let attempt = 0; ; attempt++) {
    try { return await api.upload(`/imports/${importId}/files`, form); } catch (e) {
      if (attempt >= 2 || /sign in|401/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
}

/**
 * Import a ZIP (a single File) or a folder (a FileList). Resolves when every file has been
 * sent; the server's filing progress is read from /api/imports.
 */
export async function startImport(source, name) {
  if (state && state.phase !== 'error') return;
  set({ name, phase: 'reading', sent: 0, total: 0 });
  window.addEventListener('beforeunload', warnOnLeave);
  try {
    const { items, ignored } = source instanceof File ? await fromZip(source) : fromFolder(source);
    if (!items.length) throw new Error('Nothing in there that Jarvis can read');
    const { id } = await api.post('/imports', { name, ignored });
    set({ name, phase: 'uploading', sent: 0, total: items.length });
    let sent = 0;
    for (const batch of batches(items)) {
      try {
        await send(id, batch);
      } catch (e) {
        if (/sign in|401/i.test(e.message)) throw e;
        ignored.failed = (ignored.failed || 0) + batch.length; // counted in the summary, not fatal
      }
      sent += batch.length;
      set({ name, phase: 'uploading', sent, total: items.length });
    }
    await api.post(`/imports/${id}/done`, { ignored });
    set(null);
  } catch (e) {
    set({ name, phase: 'error', error: e.message });
  } finally {
    window.removeEventListener('beforeunload', warnOnLeave);
  }
}

export const clearImportError = () => { if (state?.phase === 'error') set(null); };
