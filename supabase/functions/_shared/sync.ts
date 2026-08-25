export type BookingRow = {
  id: string;
  source: string | null;
  status: string | null;
  event_date: string;
  end_date: string | null;
  airbnb_uid: string | null;
};

export type FeedEvent = {
  uid: string | null;
  event_date: string;
  end_date: string;
  summary: string;
};

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string) {
  return aStart <= bEnd && bStart <= aEnd;
}

export function feedKey(event: { uid?: string | null; event_date: string; end_date: string }) {
  if (event.uid) return `uid:${event.uid}`;
  return `dates:${event.event_date}:${event.end_date}`;
}

export function bookingFeedKey(booking: BookingRow) {
  if (booking.airbnb_uid) return `uid:${booking.airbnb_uid}`;
  return `dates:${booking.event_date}:${booking.end_date || booking.event_date}`;
}

export function planAirbnbSync(feedEvents: FeedEvent[], existingBookings: BookingRow[]) {
  const protectedBookings = existingBookings.filter(
    (b) => b.source !== 'airbnb' && b.status !== 'cancelled',
  );
  const airbnbRows = existingBookings.filter(
    (b) => b.source === 'airbnb' && b.status !== 'cancelled',
  );

  const seen = new Set<string>();
  const upserts: Array<{
    id: string | null;
    uid: string | null;
    event_date: string;
    end_date: string;
    airbnb_uid: string | null;
    summary: string;
  }> = [];
  const skipped: Array<{ reason: string; event: FeedEvent }> = [];

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
      || (event.uid ? airbnbRows.find((b) => b.airbnb_uid === event.uid) : undefined);

    upserts.push({
      id: existing?.id || null,
      uid: event.uid,
      event_date: event.event_date,
      end_date: event.end_date,
      airbnb_uid: event.uid,
      summary: event.summary,
    });
  }

  const keepIds = new Set(upserts.map((u) => u.id).filter(Boolean) as string[]);
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
