/**
 * Plan Airbnb iCal upserts against existing bookings.
 * Never overwrites private/website rows. Fail-closed callers must skip
 * delete when the feed was not fetched/parsed successfully.
 */

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

export function feedKey(event) {
  if (event.uid) return `uid:${event.uid}`;
  return `dates:${event.event_date}:${event.end_date}`;
}

export function bookingFeedKey(booking) {
  if (booking.airbnb_uid) return `uid:${booking.airbnb_uid}`;
  return `dates:${booking.event_date}:${booking.end_date || booking.event_date}`;
}

export function planAirbnbSync(feedEvents, existingBookings) {
  const protectedBookings = existingBookings.filter(
    (b) => b.source !== 'airbnb' && b.status !== 'cancelled',
  );
  const airbnbRows = existingBookings.filter(
    (b) => b.source === 'airbnb' && b.status !== 'cancelled',
  );

  const seen = new Set();
  const upserts = [];
  const skipped = [];

  for (const event of feedEvents) {
    const key = feedKey(event);
    if (seen.has(key)) continue;
    seen.add(key);

    const overlapsProtected = protectedBookings.some((b) =>
      rangesOverlap(
        event.event_date,
        event.end_date,
        b.event_date,
        b.end_date || b.event_date,
      ),
    );
    if (overlapsProtected) {
      skipped.push({ reason: 'overlaps_non_airbnb', event });
      continue;
    }

    const existing = airbnbRows.find((b) => bookingFeedKey(b) === key)
      || (event.uid ? airbnbRows.find((b) => b.airbnb_uid === event.uid) : null);

    upserts.push({
      id: existing?.id || null,
      uid: event.uid,
      event_date: event.event_date,
      end_date: event.end_date,
      airbnb_uid: event.uid,
      summary: event.summary,
    });
  }

  const keepIds = new Set(upserts.map((u) => u.id).filter(Boolean));
  const keepKeys = new Set([
    ...upserts.map((u) => feedKey(u)),
    ...skipped.map((s) => feedKey(s.event)),
  ]);
  const deletes = airbnbRows.filter((b) => {
    if (keepIds.has(b.id)) return false;
    return !keepKeys.has(bookingFeedKey(b));
  });

  return { upserts, deletes, skipped };
}
