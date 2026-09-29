// Drawings in replies. What a drawing is and how it is drawn lives in server/drawingCore.js,
// shared with the server so the picture here and the PDF and AutoCAD files it makes match.
// The PNG is made here, in the browser, from the same SVG the chat shows.
import { toSvg, drawingFileName } from '../../../server/drawingCore.js';

export { splitDrawings, lastDrawing, withoutDrawings, exportAsked, toSvg } from '../../../server/drawingCore.js';

export const FORMATS = {
  pdf: { label: 'PDF', kind: 'Document' },
  png: { label: 'Image', kind: 'PNG image' },
  dxf: { label: 'AutoCAD', kind: 'DXF drawing' },
};

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Twice the on-screen size, so it stays sharp when zoomed or printed.
async function png(drawing) {
  const svg = toSvg(drawing);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = Object.assign(document.createElement('canvas'), { width: img.naturalWidth * 2, height: img.naturalHeight * 2 });
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the image'))), 'image/png'));
}

/** Download the drawing in `format`. PDF and AutoCAD are made by the server from the saved reply `messageId`. */
export async function downloadDrawing(format, drawing, messageId) {
  if (format === 'png') return save(await png(drawing), drawingFileName(drawing.title, 'png'));
  const res = await fetch(`/api/replies/${messageId}/drawing/${format}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not make the file');
  save(await res.blob(), drawingFileName(drawing.title, format));
}
