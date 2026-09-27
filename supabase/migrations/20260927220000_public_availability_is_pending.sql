-- Expose a pending flag on the public calendar view.
--
-- Live definition before this migration (pg_get_viewdef, 2026-09-27):
--   SELECT event_date, end_date FROM bookings
--   WHERE status = ANY (ARRAY['pending'::booking_status, 'confirmed'::booking_status]);
--
-- index.html selects `event_date, end_date, is_pending`; without this column
-- PostgREST returns 400 and the page silently falls back, so "Pending" never shows.
--
-- CREATE OR REPLACE (not DROP/CREATE): existing columns keep their names, order and
-- types, the new column is appended, and the view's owner and grants are preserved.
-- Only dates and a boolean are exposed; no guest PII.
--
-- Apply manually (SQL editor / single-statement migration). Do NOT `supabase db push`
-- from this repo: the live migration history does not include
-- 20260825163000_airbnb_sync_and_inquiry_holds.sql, which would be applied too.

CREATE OR REPLACE VIEW public.public_availability AS
SELECT
  b.event_date,
  b.end_date,
  (b.status = 'pending'::public.booking_status) AS is_pending
FROM public.bookings b
WHERE b.status = ANY (ARRAY['pending'::public.booking_status, 'confirmed'::public.booking_status]);

COMMENT ON VIEW public.public_availability IS
  'Public calendar feed: booked/pending date ranges only (no guest data). is_pending = bookings.status = pending.';
