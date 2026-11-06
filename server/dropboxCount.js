import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { scrambledArabic } from './pdfText.js';

// Counting the pages of a Dropbox folder's PDFs, in a worker thread of its own (dropbox.js).
// Taking out all the text of 4,000 pages at once pushed the server past 1 GB, more than the
// live server has spare. Here each PDF is walked a page at a time and let go of before the
// next, and only the counts and its opening text go back.
//
// The rule is the queue's own (pdfText.js, pdfTextLayer): fewer than 40 letters a page is a
// scan, and a court PDF whose Arabic reads out scrambled is read as pictures too.

const KEEP = 20000; // the opening text kept, to find the case number in

async function count(path) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
  try {
    let letters = 0;
    let text = '';
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const words = content.items.map((i) => i.str || '').join(' ');
      letters += words.replace(/\s+/g, '').length;
      if (text.length < KEEP) text += `${words}\n`;
      page.cleanup();
    }
    const pages = pdf.numPages;
    const readPages = letters < 40 * pages || scrambledArabic(text);
    return { pages, scanned: readPages ? pages : 0, text: text.slice(0, KEEP) };
  } finally {
    await (pdf.destroy?.() ?? pdf.cleanup?.()); // the proxy has destroy() in some pdf.js builds, cleanup() in others
  }
}

const out = [];
for (const path of workerData.paths) {
  try { out.push(await count(path)); } catch { out.push({ pages: 0, scanned: 0, text: '' }); }
}
parentPort.postMessage(out);
