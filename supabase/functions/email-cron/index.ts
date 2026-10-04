// supabase/functions/email-cron/index.ts
//
// Runs once a day (via pg_cron). Finds bookings that need a day-before
// check-in email (logged as email_type reminder) or a review-request
// email (day after the event), skips any that already got that email
// (checked against email_log), and calls send-booking-email for each
// one that's due. Reminder still uses emailType 'reminder'.
//
// The day-before reminder carries the DOOR CODE, so it only goes to bookings
// whose deposit is paid (deposit_charged_at set, payment_status deposit_paid /
// paid_in_full, or amount_paid > 0). Unpaid bookings are reported, not emailed.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PAID_FILTER = 'deposit_charged_at.not.is.null,payment_status.in.(deposit_paid,paid_in_full),amount_paid.gt.0';

function daysFromToday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function sendFor(sb: any, bookingId: string, emailType: string) {
  const res = await sb.functions.invoke('send-booking-email', {
    body: { bookingId, emailType },
  });
  return res;
}

Deno.serve(async () => {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const reminderDate = daysFromToday(1);
  const reviewDate = daysFromToday(-1);

  let remindersSent = 0;
  let reviewsSent = 0;
  const errors: string[] = [];

  // ---- Day-before check-in (includes door code): bookings 1 day out, private/website, deposit PAID only ----
  const { data: reminderCandidates } = await sb
    .from('bookings')
    .select('id, customer_email')
    .eq('event_date', reminderDate)
    .in('source', ['private', 'website'])
    .eq('status', 'confirmed')
    .not('customer_email', 'is', null)
    .or(PAID_FILTER);

  // Report (don't email) confirmed bookings tomorrow that are still unpaid.
  const { data: unpaidTomorrow } = await sb
    .from('bookings')
    .select('id')
    .eq('event_date', reminderDate)
    .in('source', ['private', 'website'])
    .in('status', ['pending', 'confirmed'])
    .is('deposit_charged_at', null)
    .eq('payment_status', 'unpaid')
    .or('amount_paid.is.null,amount_paid.lte.0');
  const remindersWithheldUnpaid = (unpaidTomorrow || []).map((b: any) => b.id);

  for (const b of reminderCandidates || []) {
    const { data: already } = await sb
      .from('email_log')
      .select('id')
      .eq('booking_id', b.id)
      .eq('email_type', 'reminder')
      .maybeSingle();
    if (already) continue;

    const result = await sendFor(sb, b.id, 'reminder');
    if (result.error) errors.push(`reminder ${b.id}: ${result.error.message}`);
    else remindersSent++;
  }

  // ---- Review requests: event was yesterday ----
  const { data: reviewCandidates } = await sb
    .from('bookings')
    .select('id, customer_email')
    .eq('event_date', reviewDate)
    .in('source', ['private', 'website'])
    .in('status', ['confirmed', 'completed'])
    .not('customer_email', 'is', null);

  for (const b of reviewCandidates || []) {
    const { data: already } = await sb
      .from('email_log')
      .select('id')
      .eq('booking_id', b.id)
      .eq('email_type', 'review_request')
      .maybeSingle();
    if (already) continue;

    const result = await sendFor(sb, b.id, 'review_request');
    if (result.error) errors.push(`review ${b.id}: ${result.error.message}`);
    else reviewsSent++;

    // Mark the booking completed now that the event has passed
    await sb.from('bookings').update({ status: 'completed' }).eq('id', b.id);
  }

  return new Response(
    JSON.stringify({ remindersSent, reviewsSent, remindersWithheldUnpaid, errors }),
    { headers: { 'Content-Type': 'application/json' } }
  );
});
