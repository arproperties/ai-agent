import test from 'node:test';
import assert from 'node:assert/strict';
import { waNumber, whatsappUrl, greeting, rehypeWhatsApp } from '../client/src/lib/whatsapp.js';

// ---------- one number, written many ways ----------

test('a UAE mobile comes out the same however it is written', () => {
  for (const raw of ['050 123 4567', '0501234567', '50 123 4567', '+971 50 123 4567', '+971501234567', '00971 50 123 4567', '971501234567', '050-123-4567']) {
    assert.equal(waNumber(raw), '971501234567', raw);
  }
});

test('an international number keeps its own country code', () => {
  assert.equal(waNumber('+44 7911 123456'), '447911123456');
  assert.equal(waNumber('0091 98765 43210'), '919876543210');
});

test('what is not clearly a number WhatsApp can open is refused, not guessed', () => {
  for (const raw of ['', null, 'hello', '04 123 4567', '07911 123456', '+971 4 123 4567', '12345', '+1234567890123456']) {
    assert.equal(waNumber(raw), null, String(raw));
  }
});

// ---------- the link ----------

test('the link opens the chat with a greeting typed in, named when the name is known', () => {
  const url = new URL(whatsappUrl('050 123 4567', 'Ahmed'));
  assert.equal(url.origin + url.pathname, 'https://wa.me/971501234567');
  assert.equal(url.searchParams.get('text'), greeting('Ahmed'));
  assert.match(greeting('Ahmed'), /^Hello Ahmed, this is /);
  assert.match(greeting(''), /^Hello, this is /);
  assert.equal(whatsappUrl('not a number'), null);
});

// ---------- numbers inside a reply ----------

const hast = (...children) => ({ type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children }] });
const run = (tree) => { rehypeWhatsApp()(tree); return tree.children[0].children; };
const text = (value) => ({ type: 'text', value });

test('a number inside a sentence becomes a link; the words around it stay', () => {
  const kids = run(hast(text('Call him on +971 50 123 4567 today.')));
  assert.equal(kids.length, 3);
  assert.equal(kids[0].value, 'Call him on ');
  assert.equal(kids[1].tagName, 'a');
  assert.match(kids[1].properties.href, /^https:\/\/wa\.me\/971501234567\?text=/);
  assert.equal(kids[1].children[0].value, '+971 50 123 4567');
  assert.equal(kids[2].value, ' today.');
});

test('dates, amounts and ids are not turned into links', () => {
  const sentence = 'Due 2026-11-21, rent AED 1,200,000.50, ref 20261121 and unit 5012.';
  const kids = run(hast(text(sentence)));
  assert.equal(kids.length, 1);
  assert.equal(kids[0].value, sentence);
});

test('numbers in code and in existing links are left as written', () => {
  const code = { type: 'element', tagName: 'code', properties: {}, children: [text('050 123 4567')] };
  const a = { type: 'element', tagName: 'a', properties: { href: 'tel:0501234567' }, children: [text('050 123 4567')] };
  const kids = run(hast(code, a));
  assert.equal(kids[0].children[0].value, '050 123 4567');
  assert.equal(kids[1].children[0].value, '050 123 4567');
  assert.equal(kids[1].properties.href, 'tel:0501234567');
});

test('two numbers in one line each get their own link', () => {
  const kids = run(hast(text('050 123 4567 or 055 987 6543')));
  const links = kids.filter((k) => k.tagName === 'a');
  assert.equal(links.length, 2);
  assert.match(links[1].properties.href, /971559876543/);
});
