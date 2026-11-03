import { db, reset, makeUser, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveUpload } from '../server/files.js';

test.after(() => closeDb());

// An upload as index.js hands it over: waiting on disk, its bytes read from there when asked for.
function onDisk(dir, name, text) {
  const f = { originalname: name, mimetype: 'text/plain', path: join(dir, name) };
  writeFileSync(f.path, text);
  f.size = Buffer.byteLength(text);
  Object.defineProperty(f, 'buffer', { get: () => readFileSync(f.path), enumerable: true });
  return f;
}

test('an upload waiting on disk is moved into the uploads folder, and can still be read afterwards', async () => {
  await reset();
  const me = await makeUser('Me');
  const dir = mkdtempSync(join(tmpdir(), 'reem-upload-'));
  try {
    const f = onDisk(dir, 'lease.txt', 'The rent is 40,000 a year.');
    const waiting = f.path;
    const { doc, duplicate } = await saveUpload(me, null, f);
    assert.equal(duplicate, false);
    assert.equal(readFileSync(doc.path, 'utf8'), 'The rent is 40,000 a year.');
    assert.equal(existsSync(waiting), false, 'moved, not copied');
    assert.equal(f.buffer.toString(), 'The rent is 40,000 a year.', 'filing that runs after the reply still reads it');
    // The same bytes again: the copy already held, and the new upload is left for the request to clear.
    const again = onDisk(dir, 'copy.txt', 'The rent is 40,000 a year.');
    const second = await saveUpload(me, null, again);
    assert.deepEqual([second.duplicate, second.doc.id], [true, doc.id]);
    assert.equal(existsSync(again.path), true);
    rmSync(doc.path, { force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
