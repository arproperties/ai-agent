// Leasing and Properties write a phone as 555-123-4567 and a date as MM/DD/YYYY. The
// formatting is plain string work shared by the server and the app, so it is tested here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { usDate, isoDate, typeDate, usPhone, typePhone, usEin, typeEin, typeZip, einProblem, emailProblem, zipProblem } from '../server/usFormat.js';

test('an EIN is written 12-3456789, and one that is not nine digits is refused', () => {
  assert.equal(usEin('123456789'), '12-3456789');
  assert.equal(usEin(' 12-3456789 '), '12-3456789');
  assert.equal(usEin('CN-1234'), 'CN-1234');
  assert.equal(typeEin('1'), '1');
  assert.equal(typeEin('123'), '12-3');
  assert.equal(typeEin('12-34567890'), '12-3456789');
  assert.equal(einProblem('12-3456789'), '');
  assert.equal(einProblem('123456789'), '');
  assert.equal(einProblem(''), '');
  assert.match(einProblem('12-345'), /nine digits/);
});

test('an email and a ZIP code are checked, and nothing typed is no problem', () => {
  assert.equal(emailProblem('info@ace.com'), '');
  assert.equal(emailProblem(''), '');
  assert.match(emailProblem('info@ace'), /email/);
  assert.match(emailProblem('info ace.com'), /email/);
  assert.equal(zipProblem('78701'), '');
  assert.equal(zipProblem('78701-1234'), '');
  assert.equal(zipProblem(''), '');
  assert.match(zipProblem('7870'), /five digits/);
  assert.equal(typeZip('787011234'), '78701-1234');
  assert.equal(typeZip('78701-'), '78701');
  assert.equal(typeZip('78a70'), '7870');
});

test('a stored date is written MM/DD/YYYY', () => {
  assert.equal(usDate('2026-10-08'), '10/08/2026');
  assert.equal(usDate('2026-01-31'), '01/31/2026');
  assert.equal(usDate(''), '');
  assert.equal(usDate(null), '');
  assert.equal(usDate('not a date'), '');
});

test('a typed date is read back as YYYY-MM-DD, or nothing when it is not a real day', () => {
  assert.equal(isoDate('10/08/2026'), '2026-10-08');
  assert.equal(isoDate('02/29/2028'), '2028-02-29');
  assert.equal(isoDate('02/29/2026'), '');
  assert.equal(isoDate('13/01/2026'), '');
  assert.equal(isoDate('10/08/20'), '');
  assert.equal(isoDate(''), '');
});

test('the slashes go in as a date is typed', () => {
  assert.equal(typeDate('1'), '1');
  assert.equal(typeDate('10'), '10');
  assert.equal(typeDate('100'), '10/0');
  assert.equal(typeDate('10082026'), '10/08/2026');
  assert.equal(typeDate('10/08/20269'), '10/08/2026');
  assert.equal(typeDate('10/'), '10');
});

test('a ten-digit phone is written 555-123-4567', () => {
  assert.equal(usPhone('5551234567'), '555-123-4567');
  assert.equal(usPhone('(555) 123-4567'), '555-123-4567');
  assert.equal(usPhone('1 555 123 4567'), '555-123-4567');
  assert.equal(usPhone('555-123-4567'), '555-123-4567');
});

test('a number with its own country code, or not ten digits long, is left as written', () => {
  assert.equal(usPhone('+971 50 123 4567'), '+971 50 123 4567');
  assert.equal(usPhone('12345'), '12345');
  assert.equal(usPhone(''), '');
  assert.equal(usPhone(null), '');
});

test('the dashes go in as a phone is typed', () => {
  assert.equal(typePhone('555'), '555');
  assert.equal(typePhone('5551'), '555-1');
  assert.equal(typePhone('5551234'), '555-123-4');
  assert.equal(typePhone('55512345678'), '555-123-4567');
  assert.equal(typePhone('555-'), '555');
  assert.equal(typePhone('15551234567'), '555-123-4567');
  assert.equal(typePhone('+971 50'), '+971 50');
});
