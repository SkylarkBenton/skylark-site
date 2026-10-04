// supabase/functions/send-booking-email/index.ts
//
// Sends one of these email types for a booking: confirmation, reminder
// (day-before check-in, includes the door code), review_request, damage_notice.
// Call with a POST body like:
//   { "bookingId": "uuid-here", "emailType": "confirmation" }
//
// The reminder (door code) is refused (HTTP 409) unless the booking's deposit is
// paid: deposit_charged_at set, payment_status deposit_paid/paid_in_full, or
// amount_paid > 0. The door code is never sent to an unpaid booking.
//
// Required secrets (Project Settings -> Edge Functions -> Secrets):
//   RESEND_API_KEY   = your Resend API key
//   FROM_EMAIL       = e.g. "The Skylark <bookings@skylarkbenton.com>"
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const FROM_EMAIL = Deno.env.get('FROM_EMAIL') || 'The Skylark <bookings@skylarkbenton.com>';

function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function depositPaid(b: any): boolean {
  return Boolean(b.deposit_charged_at) ||
    b.payment_status === 'deposit_paid' || b.payment_status === 'paid_in_full' ||
    Number(b.amount_paid || 0) > 0;
}

function escapeHtml(v: string): string {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// settings.house_rules.text: one rule per line. Placeholder text is ignored.
function houseRulesHtml(raw: string): string {
  const text = String(raw || '').trim();
  if (!text || /^house rules go here/i.test(text)) return '';
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => '&bull; ' + escapeHtml(l)).join('<br>');
}

function buildEmail(emailType: string, booking: any, settings: Record<string, any>, extra: Record<string, any> = {}) {
  const venueName = settings.venue_info?.name || 'The Skylark';
  const dateLabel = formatDate(booking.event_date);
  const houseRules = houseRulesHtml(settings.house_rules?.text || '');
  const reviewLink = settings.google_review_link?.url || '';

  if (emailType === 'confirmation') {
    return {
      subject: `You're booked at ${venueName} — ${dateLabel}`,
      html: `
        <p>Hi ${booking.customer_name || 'there'},</p>
        <p>Your event at <strong>${venueName}</strong> is confirmed for <strong>${dateLabel}</strong>, noon to midnight.</p>
        ${booking.event_type ? `<p>Event type: ${booking.event_type}</p>` : ''}
        ${booking.guest_count ? `<p>Guests: ${booking.guest_count}</p>` : ''}
        ${booking.rate ? `<p>Total: $${booking.rate}${booking.deposit_amount ? ` (deposit of $${booking.deposit_amount} noted)` : ''}</p>` : ''}
        <p>We're looking forward to hosting you. If anything changes, just reply to this email.</p>
      `,
    };
  }

  if (emailType === 'reminder') {
    const doorCode = settings.door_code?.code;
    return {
      subject: `Check-in for tomorrow — ${venueName}`,
      html: `
        <p>Hi ${booking.customer_name || 'there'},</p>
        <p>You're all set for tomorrow at <strong>${venueName}</strong>. Your rental window is <strong>${dateLabel}</strong>, noon to midnight.</p>
        ${doorCode ? `<p>Your door code is: <strong style="font-size:20px;">${doorCode}</strong></p>` : ''}
        <p>If you post from your night, tag us <a href="https://www.instagram.com/theskylarkbenton/">@theskylarkbenton</a> on Instagram or <a href="https://www.facebook.com/skylarkbenton">Skylark Benton</a> on Facebook. We love seeing it.</p>
        ${houseRules ? `<p><strong>House rules:</strong><br>${houseRules}</p>` : ''}
        <p>See you tomorrow!</p>
      `,
    };
  }

  if (emailType === 'review_request') {
    return {
      subject: `Thanks for celebrating with us at ${venueName}!`,
      html: `
        <p>Hi ${booking.customer_name || 'there'},</p>
        <p>Thanks so much for hosting your event with us. We hope it was everything you hoped for.</p>
        ${reviewLink ? `<p>If you have a minute, we'd love a review: <a href="${reviewLink}">${reviewLink}</a></p>` : ''}
        <p>Hope to host you again soon!</p>
      `,
    };
  }

  if (emailType === 'damage_notice') {
    const amountDollars = ((extra.damageAmountCents || 0) / 100).toFixed(2);
    return {
      subject: `Notice regarding your event at ${venueName}`,
      html: `
        <p>Hi ${booking.customer_name || 'there'},</p>
        <p>Following your event at ${venueName} on ${dateLabel}, we identified the following issue:</p>
        <p style="padding:12px;background:#f5f5f5;border-radius:6px;">${extra.damageDescription || 'Damage or excessive mess beyond normal use.'}</p>
        <p>The estimated cost to remedy this is <strong>$${amountDollars}</strong>. As outlined in your signed rental agreement, if we don't hear from you within 3 business days, this amount will be charged to the card on file.</p>
        <p>If you'd like to discuss this, please reply to this email as soon as possible.</p>
      `,
    };
  }

  return null;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { bookingId, emailType, damageAmountCents, damageDescription } = await req.json();
    if (!bookingId || !emailType) {
      return new Response(JSON.stringify({ error: 'bookingId and emailType are required' }), { status: 400, headers: corsHeaders });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: booking, error: bErr } = await sb.from('bookings').select('*').eq('id', bookingId).single();
    if (bErr || !booking) {
      return new Response(JSON.stringify({ error: 'Booking not found' }), { status: 404, headers: corsHeaders });
    }
    if (!booking.customer_email) {
      return new Response(JSON.stringify({ error: 'No email on file for this booking' }), { status: 400, headers: corsHeaders });
    }
    if (emailType === 'reminder' && !depositPaid(booking)) {
      return new Response(
        JSON.stringify({ error: 'Deposit not paid: check-in reminder (door code) withheld', bookingId }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: settingsRows } = await sb.from('settings').select('key, value');
    const settings: Record<string, any> = {};
    (settingsRows || []).forEach((r: any) => { settings[r.key] = r.value; });

    const email = buildEmail(emailType, booking, settings, { damageAmountCents, damageDescription });
    if (!email) {
      return new Response(JSON.stringify({ error: `Unknown emailType: ${emailType}` }), { status: 400, headers: corsHeaders });
    }

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: booking.customer_email,
        subject: email.subject,
        html: email.html,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      return new Response(JSON.stringify({ error: `Resend failed: ${errText}` }), { status: 502, headers: corsHeaders });
    }

    await sb.from('email_log').insert({
      booking_id: bookingId,
      email_type: emailType,
      sent_to: booking.customer_email,
    });

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
