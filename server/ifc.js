// IFC building models (.ifc), and the Revit files (.rvt) people send instead of one.

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
