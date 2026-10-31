import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailText, htmlToText } from '../server/mailText.js';

test('keeps the plain-text part when there is one', () => {
  assert.equal(mailText({ text: 'Hello', html: '<p>Other</p>' }), 'Hello');
});

test('an HTML-only email (a phone daily report) is read from its HTML', () => {
  const html = '<html><head><style>p{}</style></head><body><div dir="ltr">Daily Progress Report<br>Fine Plaster&nbsp;= 54m&sup2;'
    + '<table><tr><td>Blocks</td><td>120</td></tr></table></div></body></html>';
  const t = mailText({ text: '', html });
  assert.match(t, /Daily Progress Report\nFine Plaster = 54m/);
  assert.match(t, /Blocks \| 120/);
  assert.doesNotMatch(t, /<|p\{\}/);
});

test('no text and no html stays empty', () => {
  assert.equal(mailText({}), '');
  assert.equal(htmlToText('&amp; &#65; &#x42;'), '& A B');
});
