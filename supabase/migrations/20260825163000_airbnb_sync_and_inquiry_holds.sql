-- Airbnb calendar sync, 24h inquiry holds, and public_availability pending flag.
-- Apply on the Skylark project (rywomhsgcaighcwnftoa) before deploying the new Edge Functions.

-- ---------------------------------------------------------------------------
-- Bookings: pending holds + Airbnb uid matching
-- ---------------------------------------------------------------------------
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS inquiry_id uuid REFERENCES public.inquiries(id),
  ADD COLUMN IF NOT EXISTS airbnb_uid text;

ALTER TABLE public.inquiries
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

CREATE INDEX IF NOT EXISTS bookings_inquiry_id_idx
  ON public.bookings (inquiry_id);

CREATE INDEX IF NOT EXISTS bookings_pending_expiry_idx
  ON public.bookings (hold_expires_at)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS bookings_airbnb_uid_unique
  ON public.bookings (airbnb_uid)
  WHERE source = 'airbnb' AND airbnb_uid IS NOT NULL AND status IS DISTINCT FROM 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_pending_hold_per_start
  ON public.bookings (event_date)
  WHERE status = 'pending' AND source = 'website';

-- Allow status = pending if a check constraint currently forbids it.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'bookings'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ~* 'status'
  LOOP
    EXECUTE format('ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS %I', rec.conname);
  END LOOP;
END $$;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('confirmed', 'cancelled', 'pending'));

-- ---------------------------------------------------------------------------
-- Expire holds (used by cron, notify-inquiry, and triggers)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_pending_holds()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.bookings
  SET status = 'cancelled',
      hold_expires_at = NULL
  WHERE status = 'pending'
    AND hold_expires_at IS NOT NULL
    AND hold_expires_at <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_pending_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_pending_holds() TO service_role;

-- ---------------------------------------------------------------------------
-- Public calendar view: confirmed bookings + unexpired pending holds
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.public_availability;

CREATE VIEW public.public_availability
WITH (security_invoker = false) AS
SELECT
  b.event_date,
  COALESCE(b.end_date, b.event_date) AS end_date,
  (b.status = 'pending') AS is_pending
FROM public.bookings b
WHERE b.status = 'confirmed'
   OR (
     b.status = 'pending'
     AND (b.hold_expires_at IS NULL OR b.hold_expires_at > now())
   );

GRANT SELECT ON public.public_availability TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Inquiry insert: 24h hold on open dates (waitlist on booked dates = no hold)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_inquiry_hold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  occupied boolean;
BEGIN
  PERFORM public.expire_pending_holds();

  IF NEW.requested_date IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.status IN ('confirmed', 'pending')
      AND (b.status <> 'pending' OR b.hold_expires_at IS NULL OR b.hold_expires_at > now())
      AND NEW.requested_date >= b.event_date
      AND NEW.requested_date <= COALESCE(b.end_date, b.event_date)
  ) INTO occupied;

  IF occupied THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO public.bookings (
      event_date,
      end_date,
      source,
      status,
      customer_name,
      customer_email,
      customer_phone,
      event_type,
      guest_count,
      heard_about,
      notes,
      inquiry_id,
      hold_expires_at,
      payment_status
    ) VALUES (
      NEW.requested_date,
      NEW.requested_date,
      'website',
      'pending',
      NEW.name,
      NEW.email,
      NEW.phone,
      NEW.event_type,
      NEW.guest_count,
      NEW.heard_about,
      NEW.message,
      NEW.id,
      now() + interval '24 hours',
      'unpaid'
    );
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inquiry_hold ON public.inquiries;
CREATE TRIGGER trg_inquiry_hold
  AFTER INSERT ON public.inquiries
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_inquiry_hold();

-- Optional: invoke notify-inquiry after commit via pg_net (same public anon key
-- already in index.html). Client also invokes the function as a fallback.
CREATE OR REPLACE FUNCTION public.request_inquiry_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regproc('net.http_post') IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://rywomhsgcaighcwnftoa.supabase.co/functions/v1/notify-inquiry',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_2B_fjldZNj5TWYia1WMLnQ_GM4scyXg',
      'Authorization', 'Bearer sb_publishable_2B_fjldZNj5TWYia1WMLnQ_GM4scyXg'
    ),
    body := jsonb_build_object('inquiryId', NEW.id::text)
  );
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inquiry_notify ON public.inquiries;
CREATE TRIGGER trg_inquiry_notify
  AFTER INSERT ON public.inquiries
  FOR EACH ROW
  EXECUTE FUNCTION public.request_inquiry_notification();

-- ---------------------------------------------------------------------------
-- Convert / dismiss: confirm or release the hold without editing the desk app
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_inquiry_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    UPDATE public.bookings
    SET status = 'cancelled',
        hold_expires_at = NULL
    WHERE inquiry_id = NEW.id
      AND status = 'pending';
  ELSIF NEW.status = 'converted' THEN
    UPDATE public.bookings
    SET status = 'cancelled',
        hold_expires_at = NULL
    WHERE inquiry_id = NEW.id
      AND status = 'pending'
      AND (NEW.converted_booking_id IS NULL OR id IS DISTINCT FROM NEW.converted_booking_id);

    IF NEW.converted_booking_id IS NOT NULL THEN
      UPDATE public.bookings
      SET status = 'confirmed',
          hold_expires_at = NULL
      WHERE id = NEW.converted_booking_id
        AND status = 'pending';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inquiry_status ON public.inquiries;
CREATE TRIGGER trg_inquiry_status
  AFTER UPDATE OF status, converted_booking_id ON public.inquiries
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_inquiry_status_change();

-- A confirmed booking (approve-inquiry or desk convert) takes the date.
CREATE OR REPLACE FUNCTION public.release_overlapping_pending_holds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM 'cancelled' THEN
    RETURN NEW;
  END IF;

  UPDATE public.bookings
  SET status = 'cancelled',
      hold_expires_at = NULL
  WHERE status = 'pending'
    AND id IS DISTINCT FROM NEW.id
    AND daterange(event_date, COALESCE(end_date, event_date), '[]') &&
        daterange(NEW.event_date, COALESCE(NEW.end_date, NEW.event_date), '[]');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_booking_release_holds ON public.bookings;
CREATE TRIGGER trg_booking_release_holds
  AFTER INSERT OR UPDATE OF status, event_date, end_date ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.release_overlapping_pending_holds();

CREATE OR REPLACE FUNCTION public.clear_hold_on_confirm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'confirmed' THEN
    NEW.hold_expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_booking_clear_hold ON public.bookings;
CREATE TRIGGER trg_booking_clear_hold
  BEFORE UPDATE OF status ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_hold_on_confirm();

REVOKE ALL ON FUNCTION public.handle_new_inquiry_hold() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_inquiry_notification() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_inquiry_status_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_overlapping_pending_holds() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_hold_on_confirm() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Hourly expiry via pg_cron when the extension is available
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'expire-pending-holds',
      '15 * * * *',
      $job$SELECT public.expire_pending_holds()$job$
    );
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;
