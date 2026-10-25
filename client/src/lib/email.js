// Pasted addresses often carry invisible characters (no-break or zero-width spaces) that
// the browser's email check rejects with "a part followed by '@' should not contain the symbol".
export const cleanEmail = (s) => String(s ?? '').replace(/[\s\u200B-\u200D\u2060]/g, '');
