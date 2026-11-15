import test from 'node:test';
import assert from 'node:assert/strict';

import { nextReportAt, parseReportTime } from '../lib/schedule.mjs';

test('parses and rejects report times', () => {
  assert.deepEqual(parseReportTime('12:00'), { hours: 12, minutes: 0 });
  assert.deepEqual(parseReportTime('6:05'), { hours: 6, minutes: 5 });
  assert.throws(() => parseReportTime('25:00'));
  assert.throws(() => parseReportTime('noon'));
});

test('picks the next report slot during the day', () => {
  const at = (h, m) => new Date(2026, 10, 15, h, m, 0, 0);
  assert.equal(nextReportAt(['12:00', '18:00'], at(9, 0)).getHours(), 12);
  assert.equal(nextReportAt(['12:00', '18:00'], at(13, 0)).getHours(), 18);
  assert.equal(nextReportAt(['12:00', '18:00'], at(12, 0)).getHours(), 18);
});

test('rolls over to the next day after the last slot', () => {
  const now = new Date(2026, 10, 15, 19, 0, 0, 0);
  const next = nextReportAt(['12:00', '18:00'], now);
  assert.equal(next.getDate(), 16);
  assert.equal(next.getHours(), 12);
});

test('returns null when no times are configured', () => {
  assert.equal(nextReportAt([], new Date()), null);
});
