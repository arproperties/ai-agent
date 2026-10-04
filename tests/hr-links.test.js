import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb } from './helpers/db.js';
import { lookupCode, linkFor, linkUser, unlinkUser } from '../server/hrLinks.js';
import { addResponsibility, responsibilityKit } from '../server/responsibilities.js';

test.after(() => closeDb());

// A stand-in for saifsys HR: an exact code finds the employee, and like the real one a
// bare number is also tried as an id, which must not count as a code match.
const STAFF = { E00012: { id: 12, code: 'E00012', name: 'Jessa Cruz', company: 'ARS', position: 'Admin', status: 'Active' } };
const hr = async (module, action, { q }) => {
  assert.equal(`${module}/${action}`, 'hr/employee');
  const e = STAFF[q] || Object.values(STAFF).find((s) => String(s.id) === q);
  return e ? { found: 1, employee: e } : { found: 0 };
};

test('a code is checked against HR, and only an exact code counts', async () => {
  assert.equal((await lookupCode(' e00012 ', hr)).name, 'Jessa Cruz');
  await assert.rejects(lookupCode('E99999', hr), /no employee with code E99999/);
  await assert.rejects(lookupCode('12', hr), /no employee with code 12/, 'an id is not a code');
  await assert.rejects(lookupCode('  ', hr), /Type an employee code/);
});

test('link, change and unlink; one employee is never two accounts', async () => {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const jessa = await makeUser('Jessa');
  const other = await makeUser('Other');

  const l = await linkUser(master, jessa, 'e00012', hr);
  assert.equal(l.code, 'E00012');
  assert.equal((await linkFor(jessa)).name, 'Jessa Cruz');
  await linkUser(master, jessa, 'E00012', hr); // linking again is fine
  await assert.rejects(linkUser(master, other, 'E00012', hr), /already linked to Jessa/);

  await addResponsibility(master, jessa, { title: 'Park Place' });
  const out = (await responsibilityKit(master).run({ id: 't', name: 'team_responsibilities', input: {} })).content;
  assert.match(out, /Jessa \[HR E00012\]:/, 'Riley sees the code next to the name');

  assert.equal(await unlinkUser(jessa), true);
  assert.equal(await linkFor(jessa), undefined);
  await linkUser(master, other, 'E00012', hr); // free again once unlinked
});
