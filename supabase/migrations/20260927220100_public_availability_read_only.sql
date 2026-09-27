-- Security hardening (separate from the is_pending change so it can be reviewed/applied on its own).
--
-- public.public_availability is a simple single-table view, so Postgres treats it as
-- auto-updatable. It runs with its owner's rights (postgres, BYPASSRLS), and anon /
-- authenticated currently hold INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on it.
-- That means the public publishable key can likely change or delete rows in public.bookings
-- through /rest/v1/public_availability, bypassing RLS. The website only needs SELECT.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.public_availability FROM anon, authenticated;

GRANT SELECT ON public.public_availability TO anon, authenticated;
