import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, makeAgent, makeDoc, closeDb } from './helpers/db.js';
import { teamDocuments } from '../server/router.js';

test.after(() => closeDb());

test("teamDocuments returns the caller's own documents", async () => {
  await reset();
  const alice = await makeUser('Alice');
  const lawyer = await makeAgent(alice, 'Lawyer');
  const hr = await makeAgent(alice, 'HR');
  await makeDoc(alice, lawyer, 'alice-tenancy.pdf');

  const docs = await teamDocuments(alice, [lawyer, hr]);
  assert.deepEqual(docs.map((d) => d.name), ['alice-tenancy.pdf']);
});

test("teamDocuments never returns another user's documents on a shared agent", async () => {
  await reset();
  const alice = await makeUser('Alice');
  const bob = await makeUser('Bob');
  const shared = await makeAgent(alice, 'Lawyer'); // Plan 2 lets Bob use this same agent
  const other = await makeAgent(alice, 'HR');

  await makeDoc(alice, shared, 'alice-tenancy.pdf');
  await makeDoc(bob, shared, 'bob-divorce-papers.pdf');

  const docs = await teamDocuments(alice, [shared, other]);
  const names = docs.map((d) => d.name);
  assert.ok(!names.includes('bob-divorce-papers.pdf'), `leaked another user's file: ${names.join(', ')}`);
  assert.deepEqual(names, ['alice-tenancy.pdf']);
});

test('teamDocuments handles an empty agent list without building invalid SQL', async () => {
  await reset();
  const alice = await makeUser('Alice');
  assert.deepEqual(await teamDocuments(alice, []), []);
});
