// How Leasing and Properties write a phone number, a date, an EIN and a ZIP code. The work is
// done in one file the server shares, so a receipt and the screen it came from always agree.
export { usDate, usDateOf, isoDate, typeDate, usPhone, typePhone, usEin, typeEin, typeZip, einProblem, emailProblem, zipProblem, usAddress } from '../../../server/usFormat.js';
