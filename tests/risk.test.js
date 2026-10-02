import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeRisk } from '../lib/risk.js';

test('ok state when old enough and karma is non-negative', () => {
  const now = new Date('2026-10-11T00:00:00Z');
  const record = { dateStable: '2026-10-01 00:00:00', karma: 2 };

  const result = computeRisk(record, { minStableAgeDays: 5, now });

  assert.equal(result.state, 'ok');
  assert.equal(result.daysSinceStable, 10);
  assert.equal(result.karma, 2);
});

test('below-threshold when pushed to stable too recently', () => {
  const now = new Date('2026-10-03T00:00:00Z');
  const record = { dateStable: '2026-10-01 00:00:00', karma: 0 };

  const result = computeRisk(record, { minStableAgeDays: 5, now });

  assert.equal(result.state, 'below-threshold');
  assert.equal(result.daysSinceStable, 2);
});

test('below-threshold when karma is negative even though the update is old', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const record = { dateStable: '2026-10-01 00:00:00', karma: -1 };

  const result = computeRisk(record, { minStableAgeDays: 5, now });

  assert.equal(result.state, 'below-threshold');
  assert.equal(result.daysSinceStable, 19);
});

test('untracked when there is no Bodhi record', () => {
  const result = computeRisk(null, { minStableAgeDays: 5, now: new Date() });

  assert.equal(result.state, 'untracked');
  assert.equal(result.daysSinceStable, null);
  assert.equal(result.karma, null);
});

test('exactly at the age threshold counts as ok, not below', () => {
  const now = new Date('2026-10-06T00:00:00Z');
  const record = { dateStable: '2026-10-01 00:00:00', karma: 0 };

  const result = computeRisk(record, { minStableAgeDays: 5, now });

  assert.equal(result.daysSinceStable, 5);
  assert.equal(result.state, 'ok');
});
