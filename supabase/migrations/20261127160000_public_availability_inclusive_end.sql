-- public_availability.end_date should be the last inclusive occupied night.
--
-- Live sync-airbnb-ts stores Airbnb iCal DTEND (the checkout day, exclusive
-- per RFC 5545) as bookings.end_date. The public site treats end_date as
-- inclusive (`dateStr >= event_date && dateStr <= end`), so checkout days
-- were marked booked (e.g. a Fri-night Airbnb stay 2026-12-05/DTEND 12-06
-- also greyed Saturday the 6th). The booking desk already drops the
-- checkout day for Airbnb feed rows, and booking_occupancy uses a
-- half-open range for those rows: [event_date, end_date).
--
-- This view now exposes upper(booking_occupancy(...)) - 1 so the website
-- calendar, "next open weekends", and the desk /api/calendar export all
-- see the same occupied nights. Website and private ranges stay inclusive.
-- Column names, order, and types are unchanged (no PostgREST cache bump
-- required beyond the new values).
--
-- CREATE OR REPLACE (not DROP/CREATE): owner and grants are preserved.
-- end_date is now an expression, so the view is no longer auto-updatable,
-- which is an extra safeguard on top of the SELECT-only grants.
--
-- Apply this file only (SQL editor). Do NOT `supabase db push` from this
-- repo: the live migration history does not include earlier site-only
-- files such as 20260825163000_airbnb_sync_and_inquiry_holds.sql.

CREATE OR REPLACE VIEW public.public_availability AS
SELECT
  b.event_date,
  (upper(public.booking_occupancy(b.source, b.event_date, b.end_date)) - 1) AS end_date,
  (b.status = 'pending'::public.booking_status) AS is_pending
FROM public.bookings b
WHERE b.status = ANY (ARRAY['pending'::public.booking_status, 'confirmed'::public.booking_status]);

COMMENT ON VIEW public.public_availability IS
  'Public calendar feed: booked/pending date ranges only (no guest PII). end_date is the last inclusive occupied night (Airbnb checkout days excluded). is_pending = bookings.status = pending.';

GRANT SELECT ON public.public_availability TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.public_availability FROM anon, authenticated;
