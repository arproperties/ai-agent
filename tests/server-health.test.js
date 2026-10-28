import { reset } from './helpers/db.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/db.js';
import { sample, history, readHealth } from '../server/serverHealth.js';

beforeEach(reset);

test('an hourly reading lands in the daily history', async () => {
  await sample();
  const days = await history();
  assert.equal(days.length, 1);
  assert.ok(days[0].disk_total > 0 && days[0].mem_total > 0 && days[0].db_bytes > 0);
});

test('several readings in one day show as one bar with the day’s highest numbers', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const [at, mem] of [[now - 60, 100], [now - 30, 300], [now, 200]]) {
    await db.prepare(`INSERT INTO server_health (at, disk_used, disk_total, mem_used, mem_total, app_mem, db_bytes)
      VALUES (?, 1, 10, ?, 1000, 1, 1)`).run(at, mem);
  }
  const days = await history();
  assert.equal(days.length, 1);
  assert.equal(days[0].mem_used, 300);
});

test('readings older than the chart are left out', async () => {
  const old = Math.floor(Date.now() / 1000) - 200 * 86400;
  await db.prepare(`INSERT INTO server_health (at, disk_used, disk_total, mem_used, mem_total, app_mem, db_bytes)
    VALUES (?, 1, 10, 1, 10, 1, 1)`).run(old);
  assert.equal((await history(90)).length, 0);
});

test('the live reading has every light', async () => {
  const h = await readHealth();
  for (const part of [h.disk, h.memory, h.cpu, h.backups]) assert.match(part.light, /^(green|amber|red)$/);
  assert.equal(typeof h.activity.people, 'number');
});
