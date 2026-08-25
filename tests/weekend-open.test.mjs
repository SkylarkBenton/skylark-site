import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOpenWeekendDates, formatWeekendLabel } from '../lib/weekend-open.mjs';

function occupancyFrom(booked) {
  const set = new Set(booked);
  return (iso) => (set.has(iso) ? 'booked' : 'open');
}

test('picks the first open day of each weekend, Friday first', () => {
  const from = new Date(2026, 7, 25); // Tue Aug 25
  const dates = nextOpenWeekendDates(from, occupancyFrom([]));
  assert.deepEqual(dates, ['2026-08-28', '2026-09-04', '2026-09-11']);
});

test('skips a booked Friday and uses Saturday of that weekend', () => {
  const from = new Date(2026, 7, 25);
  const dates = nextOpenWeekendDates(from, occupancyFrom(['2026-08-28']));
  assert.equal(dates[0], '2026-08-29');
});

test('skips a fully booked weekend', () => {
  const from = new Date(2026, 7, 25);
  const dates = nextOpenWeekendDates(
    from,
    occupancyFrom(['2026-08-28', '2026-08-29', '2026-08-30']),
  );
  assert.equal(dates[0], '2026-09-04');
  assert.equal(dates.length, 3);
});

test('treats pending like booked for the teaser', () => {
  const from = new Date(2026, 7, 25);
  const occupancy = (iso) => (iso === '2026-08-28' || iso === '2026-08-29' || iso === '2026-08-30' ? 'pending' : 'open');
  const dates = nextOpenWeekendDates(from, occupancy);
  assert.equal(dates[0], '2026-09-04');
});

test('returns empty when no weekend is open in the window', () => {
  const from = new Date(2026, 7, 25);
  const occupancy = () => 'booked';
  assert.deepEqual(nextOpenWeekendDates(from, occupancy, { weeks: 8 }), []);
});

test('labels match Sep 5 style', () => {
  assert.equal(formatWeekendLabel('2026-09-05'), 'Sep 5');
  assert.equal(formatWeekendLabel('2026-08-28'), 'Aug 28');
});
