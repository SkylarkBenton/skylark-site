import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';
import { sendEmail, wrapHtml } from '../_shared/email.ts';
import { handleCors, json, serviceClient, siteUrl } from '../_shared/http.ts';

type Inquiry = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  event_type: string | null;
  guest_count: number | null;
  requested_date: string | null;
  heard_about: string | null;
  message: string | null;
  status: string | null;
  approve_token: string | null;
  notified_at: string | null;
  created_at: string;
};

function formatDate(iso: string | null) {
  if (!iso) return 'Not specified';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const { url, key } = serviceClient();
  const sb = createClient(url, key);

  await sb.rpc('expire_pending_holds');

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // Database webhook payload: { type, record: {...} }
  const record = (body.record && typeof body.record === 'object' ? body.record : body) as Record<string, unknown>;
  const inquiryId = (body.inquiryId || record.id) as string | undefined;

  let inquiry: Inquiry | null = null;
  if (inquiryId) {
    const { data, error } = await sb.from('inquiries').select('*').eq('id', inquiryId).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    inquiry = data as Inquiry | null;
  } else if (record.email && record.requested_date) {
    const { data, error } = await sb
      .from('inquiries')
      .select('*')
      .eq('email', record.email)
      .eq('requested_date', record.requested_date)
      .eq('status', 'new')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    inquiry = data as Inquiry | null;
  }

  if (!inquiry) return json({ error: 'Inquiry not found' }, 404);
  if (inquiry.notified_at) return json({ ok: true, alreadyNotified: true });

  const created = new Date(inquiry.created_at).getTime();
  if (Number.isFinite(created) && Date.now() - created > 24 * 60 * 60 * 1000) {
    return json({ error: 'Inquiry is too old to notify' }, 400);
  }

  const { data: hold } = await sb
    .from('bookings')
    .select('id, status, hold_expires_at')
    .eq('inquiry_id', inquiry.id)
    .eq('status', 'pending')
    .maybeSingle();

  const { data: notifyRow } = await sb.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const hostEmail = (notifyRow?.value as { email?: string } | null)?.email || '';

  const approveUrl = `${siteUrl()}/approve.html?token=${encodeURIComponent(inquiry.approve_token || '')}`;
  const dateLabel = formatDate(inquiry.requested_date);
  const holdNote = hold
    ? `This date is held as pending on the public calendar until ${new Date(hold.hold_expires_at).toLocaleString('en-US')}.`
    : 'This date was already booked, so the request was accepted as a waitlist (no hold).';

  const detailsHtml = `
    <p style="margin:0 0 12px;"><strong>${inquiry.name || 'Guest'}</strong> requested <strong>${dateLabel}</strong>.</p>
    <p style="color:#c9c9cc;font-size:14px;line-height:1.6;">
      Event: ${inquiry.event_type || '—'}<br>
      Guests: ${inquiry.guest_count ?? '—'}<br>
      Email: ${inquiry.email || '—'}<br>
      Phone: ${inquiry.phone || '—'}<br>
      Heard about us: ${inquiry.heard_about || '—'}
    </p>
    <p style="color:#c9c9cc;font-size:14px;line-height:1.6;">${(inquiry.message || '').replace(/</g, '&lt;')}</p>
    <p style="color:#8C8C93;font-size:13px;">${holdNote}</p>
  `;

  const warnings: string[] = [];

  if (hostEmail) {
    try {
      await sendEmail({
        to: hostEmail,
        subject: `New Skylark inquiry — ${inquiry.name || 'Guest'} for ${dateLabel}`,
        html: wrapHtml(`${detailsHtml}
          <p><a href="${approveUrl}" style="display:inline-block;margin-top:12px;background:#A31E24;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600;">Review &amp; approve</a></p>
          <p style="color:#8C8C93;font-size:13px;">Or open: ${approveUrl}</p>`),
      });
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  } else {
    warnings.push('settings.notification_email is not set');
  }

  if (inquiry.email) {
    try {
      await sendEmail({
        to: inquiry.email,
        subject: 'We received your request — The Skylark',
        html: wrapHtml(`
          <p>Hi ${inquiry.name || 'there'},</p>
          <p>Thanks for requesting <strong>${dateLabel}</strong> at The Skylark. This is not a confirmed booking — we'll review the details and follow up shortly.</p>
          <p style="color:#8C8C93;font-size:14px;">If you need us sooner, call (318) 344-5001.</p>
        `),
      });
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  const sendFailed = warnings.some((w) => !w.includes('notification_email is not set'));
  if (!sendFailed) {
    await sb.from('inquiries').update({ notified_at: new Date().toISOString() }).eq('id', inquiry.id);
  }

  return json({
    ok: warnings.length === 0,
    inquiryId: inquiry.id,
    held: Boolean(hold),
    warnings,
  });
});
