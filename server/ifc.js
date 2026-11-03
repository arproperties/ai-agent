// IFC building models (.ifc), and the Revit files (.rvt) people send instead of one.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { oneAtATime } from './dwg.js';

const run = promisify(execFile);
const READER = fileURLToPath(new URL('./ifcRead.js', import.meta.url));

export const isIfc = (name) => /\.ifc$/i.test(String(name));
export const isRevit = (name) => /\.rvt$/i.test(String(name));

// Revit's own format is closed: only Autodesk's paid cloud service (APS, formerly Forge)
// reads it, charged per file, so Reem does not. Every Revit version can save an IFC instead.
export const REVIT_HELP = 'Revit files (.rvt) cannot be opened directly. Please ask the consultant or designer to send ' +
  'the model as IFC instead: in Revit, File → Export → IFC. Send that .ifc file here and it opens in 3D.';

/**
 * What an IFC model is, read from its header alone: the program that wrote it and the IFC
 * version. Enough to file it and say it opens in 3D; nothing about the building is guessed.
 */
export function ifcHeader(buffer, name) {
  const head = buffer.subarray(0, 8192).toString('latin1');
  if (!/^ISO-10303-21;/.test(head.trimStart())) throw new Error(`${name} is not a readable IFC model (it may be the zipped .ifczip kind, or damaged)`);
  const schema = head.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i)?.[1] || 'not given';
  const fileName = head.match(/FILE_NAME\s*\(([^;]*)\);/is)?.[1] || '';
  const parts = [...fileName.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const program = parts[parts.length - 2] || parts[parts.length - 1] || '';
  return [
    `IFC building model: ${name}`,
    `IFC version: ${schema}.${program ? ` Written by: ${program}.` : ''}`,
    'This is a 3D model of a building. It can be opened with "View in 3D" on the file, in the chat or on the Shelf.',
  ].join('\n');
}

const READ_TIMEOUT_MS = 180_000;

/**
 * An IFC model as text for chats and the Shelf: storeys, element counts per storey and the
 * quantity totals the model itself carries (server/ifcRead.js). Read in a process of its own,
 * one model at a time and after any drawing being converted (dwg.js oneAtATime), stopped
 * after three minutes; its memory is all given back when it ends.
 *
 * When the model cannot be read, it is still described from its header, so it is kept and
 * can be opened in 3D: the viewer reads it in the browser, not here.
 */
export function readIfc(buffer, name) {
  return oneAtATime(() => readInChild(buffer, name)).catch((e) => {
    console.error('[ifc] could not read', name, e.message);
    return `${ifcHeader(buffer, name)}\nIts contents could not be read here (${e.message}), so nothing about its storeys or quantities is known; say so if asked. It can still be opened in 3D.`;
  });
}

async function readInChild(buffer, name) {
  mkdirSync(join(DATA_DIR, 'tmp'), { recursive: true });
  const dir = mkdtempSync(join(DATA_DIR, 'tmp', 'ifc-'));
  try {
    const file = join(dir, 'model.ifc');
    writeFileSync(file, buffer);
    let out;
    try {
      ({ stdout: out } = await run(process.execPath, [READER, file, name], { timeout: READ_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }));
    } catch (e) {
      if (e.killed) throw new Error('it took too long to read');
      out = e.stdout; // the reader says what went wrong on its own last line
    }
    const r = JSON.parse(String(out || '').trim().split('\n').pop() || '{}');
    if (r.error || !r.text) throw new Error(r.error || 'the reader gave nothing back');
    console.log(`[ifc] read ${name}: ${Math.round(buffer.length / 1048576)} MB file, ${r.peakMB} MB at most`);
    return r.text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
