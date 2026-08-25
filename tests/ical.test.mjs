import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAirbnbIcal, addDays } from '../lib/ical.mjs';
import { planAirbnbSync } from '../lib/airbnb-sync.mjs';

const SAMPLE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:Airbnb
BEGIN:VEVENT
UID:abc-123@airbnb.com
DTSTART;VALUE=DATE:20261120
DTEND;VALUE=DATE:20261123
SUMMARY:Reserved
END:VEVENT
BEGIN:VEVENT
UID:def-456@airbnb.com
DTSTART;VALUE=DATE:20261201
DTEND;VALUE=DATE:20261202
SUMMARY:Airbnb (Not available)
END:VEVENT
END:VCALENDAR
`;

test('DATE DTEND is exclusive so a 20-23 block books 20 through 22', () => {
  const events = parseAirbnbIcal(SAMPLE);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    uid: 'abc-123@airbnb.com',
    event_date: '2026-11-20',
    end_date: '2026-11-22',
    summary: 'Reserved',
  });
  assert.deepEqual(events[1], {
    uid: 'def-456@airbnb.com',
    event_date: '2026-12-01',
    end_date: '2026-12-01',
    summary: 'Airbnb (Not available)',
  });
});

test('folded lines are unfolded', () => {
  const folded = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:fold
SUMMARY:A long
  summary
DTSTART;VALUE=DATE:20260110
DTEND;VALUE=DATE:20260111
END:VEVENT
END:VCALENDAR
`;
  const events = parseAirbnbIcal(folded);
  assert.equal(events[0].summary, 'A long summary');
});

test('rejects non-calendar bodies (fail closed)', () => {
  assert.throws(() => parseAirbnbIcal('<html>503</html>'), /not a VCALENDAR/);
});

test('rejects VEVENT soup that cannot be parsed', () => {
  assert.throws(
    () => parseAirbnbIcal('BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VEVENT\nEND:VCALENDAR'),
    /none could be parsed/,
  );
});

test('upserts by uid and does not overwrite private/website bookings', () => {
  const feed = parseAirbnbIcal(SAMPLE);
  const existing = [
    {
      id: 'private-1',
      source: 'private',
      status: 'confirmed',
      event_date: '2026-11-20',
      end_date: '2026-11-20',
      airbnb_uid: null,
    },
    {
      id: 'airbnb-old',
      source: 'airbnb',
      status: 'confirmed',
      event_date: '2026-10-01',
      end_date: '2026-10-03',
      airbnb_uid: 'stale-uid@airbnb.com',
    },
    {
      id: 'airbnb-keep',
      source: 'airbnb',
      status: 'confirmed',
      event_date: '2026-12-01',
      end_date: '2026-12-01',
      airbnb_uid: 'def-456@airbnb.com',
    },
  ];
  const plan = planAirbnbSync(feed, existing);
  assert.equal(plan.upserts.length, 1);
  assert.equal(plan.upserts[0].airbnb_uid, 'def-456@airbnb.com');
  assert.equal(plan.upserts[0].id, 'airbnb-keep');
  assert.deepEqual(plan.deletes.map((d) => d.id), ['airbnb-old']);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].event.uid, 'abc-123@airbnb.com');
});

test('does not delete an airbnb row skipped because it now overlaps a private booking', () => {
  const feed = parseAirbnbIcal(SAMPLE);
  const existing = [
    {
      id: 'private-1',
      source: 'website',
      status: 'confirmed',
      event_date: '2026-11-21',
      end_date: '2026-11-21',
      airbnb_uid: null,
    },
    {
      id: 'airbnb-overlap',
      source: 'airbnb',
      status: 'confirmed',
      event_date: '2026-11-20',
      end_date: '2026-11-22',
      airbnb_uid: 'abc-123@airbnb.com',
    },
  ];
  const plan = planAirbnbSync(feed, existing);
  assert.ok(!plan.deletes.some((d) => d.id === 'airbnb-overlap'));
});

test('empty valid calendar removes stale airbnb rows', () => {
  const feed = parseAirbnbIcal('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR');
  const plan = planAirbnbSync(feed, [
    {
      id: 'airbnb-old',
      source: 'airbnb',
      status: 'confirmed',
      event_date: '2026-10-01',
      end_date: '2026-10-01',
      airbnb_uid: 'gone',
    },
    {
      id: 'website-1',
      source: 'website',
      status: 'confirmed',
      event_date: '2026-10-02',
      end_date: '2026-10-02',
      airbnb_uid: null,
    },
  ]);
  assert.equal(plan.upserts.length, 0);
  assert.deepEqual(plan.deletes.map((d) => d.id), ['airbnb-old']);
});

test('addDays rolls across months', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-11-23', -1), '2026-11-22');
});
