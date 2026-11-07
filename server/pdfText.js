// A PDF's text layer and whether it has to be read as pictures. No database and no Claude, so
// it can run in a worker thread (dropboxCount.js) as well as in the server.

/**
 * Arabic stored as display shapes in visual order, the way Dubai Courts and other court
 * systems write their PDFs. The text layer is there, but read out it comes back with the
 * letters reversed and split apart, and an agent working from it misreads names, figures
 * and orders. Ordinary Arabic text uses the base letters; these use the presentation forms.
 */
export function scrambledArabic(text) {
  const forms = (text.match(/[\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return forms >= 100 && forms >= 0.3 * (forms + arabic);
}

/**
 * A PDF's own text and page count, and whether Claude has to read its pages instead: a scan
 * is page images with little or no text layer, and a court PDF carries one that reads out
 * jumbled. Local and free - nothing is sent anywhere to decide.
 */
export async function pdfTextLayer(buffer) {
  const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await pdfText(pdf, { mergePages: true });
  const scanned = text.replace(/\s+/g, '').length < 40 * pdf.numPages;
  const scrambled = !scanned && scrambledArabic(text);
  return { text, pages: pdf.numPages, readPages: scanned || scrambled, why: scanned ? 'scanned' : scrambled ? 'court Arabic' : null };
}
