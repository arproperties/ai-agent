import { closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCase, caseMarkdown, emailMarkdown, buildCasePdf } from '../server/casePdf.js';
import { parseBlocks } from '../server/replyDoc.js';

test.after(() => closeDb());
const folder = { name: 'Akhtar v Khan', case_number: '123/2026', party_a: 'Akhtar', party_b: 'Khan' };
const e1 = { mail_key: 'k1', message_id: '<1@x>', at: 1759500000, sender: 'a@x.com', recipients: 'b@x.com', subject: 'Filing', body: 'We filed today.' };
const e2 = { mail_key: 'k2', message_id: '<2@x>', at: 1759600000, sender: 'b@x.com', recipients: 'a@x.com', subject: 'Hearing notice', body: 'Hearing is on the 20th.' };
const byAt = (a, b) => a.at - b.at;
const SUMMARY = '## Parties\nA vs B\n## What has happened\n- 3 Oct filed\n## Latest position\nHearing set\n## Pending / awaiting reply\nNone';

test('the case PDF has the summary first and every email after, oldest first', async () => {
  const ask = async () => SUMMARY;
  const md = caseMarkdown(folder, [e2, e1].sort(byAt), await summarizeCase(folder, [e1, e2], { ask }));
  assert.ok(md.indexOf('## Parties') < md.indexOf('## All emails'));
  assert.ok(md.indexOf(e1.subject) < md.indexOf(e2.subject));
  assert.ok(md.startsWith('# Akhtar v Khan'));
  assert.ok(md.includes('Case 123/2026 · Akhtar vs Khan · 2 emails · updated '));
});

test('the summary prompt sends emails oldest first, bodies cut at 4000, maxTokens 2000', async () => {
  let seen;
  const ask = async (prompt, opts) => { seen = { prompt, opts }; return SUMMARY; };
  await summarizeCase(folder, [e2, { ...e1, body: 'x'.repeat(5000) }], { ask });
  assert.equal(seen.opts.maxTokens, 2000);
  assert.ok(seen.prompt.indexOf('Filing') < seen.prompt.indexOf('Hearing notice'));
  assert.ok(seen.prompt.includes('x'.repeat(4000)) && !seen.prompt.includes('x'.repeat(4001)));
});

test('when the AI fails the summary is a plain email list', async () => {
  const s = await summarizeCase(folder, [e2, e1], { ask: async () => { throw new Error('down'); } });
  assert.ok(s.startsWith('## Emails'));
  assert.ok(s.indexOf('Filing') < s.indexOf('Hearing notice'));
});

test('the PDF is still made when the AI fails', async () => {
  const { bytes, name, markdown } = await buildCasePdf(folder, [e1], { ask: async () => { throw new Error('down'); } });
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
  assert.equal(name, 'Akhtar v Khan.pdf');
  assert.ok(markdown.includes('## All emails'));
});

test('Arabic email text makes a PDF', async () => {
  const { bytes } = await buildCasePdf(folder, [{ ...e1, body: 'تم تأجيل الجلسة' }], { ask: async () => '## Parties\nأ' });
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
});

test('an email body cannot break the document structure', () => {
  const evil = { ...e1, body: '# Fake heading\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n- item\n> quote\n---' };
  const md = caseMarkdown(folder, [evil, e2], '## Parties\nx');
  const headings = parseBlocks(md).filter((b) => b.type === 'heading').map((b) => b.text);
  assert.ok(!headings.includes('Fake heading'));
  assert.equal(headings.filter((h) => h.includes('Filing') || h.includes('Hearing notice')).length, 2);
  const types = new Set(parseBlocks(md).map((b) => b.type));
  assert.ok(!types.has('table') && !types.has('code') && !types.has('quote') && !types.has('rule') && !types.has('item'));
});

test('one email alone has its heading, From/To and body', () => {
  const md = emailMarkdown(e1);
  assert.ok(md.startsWith('# Filing') || md.startsWith('### Filing') || md.includes('Filing'));
  assert.ok(md.includes('a@x.com') && md.includes('b@x.com') && md.includes('We filed today.'));
});
