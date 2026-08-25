import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchIcalWithRetry, parseAirbnbIcal } from '../_shared/ical.ts';
import { planAirbnbSync, type BookingRow } from '../_shared/sync.ts';
import { cronAuthorized, handleCors, json, serviceClient } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!cronAuthorized(req)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const icalUrl = Deno.env.get('AIRBNB_ICAL_URL') || '';
  if (!icalUrl) {
    return json({ error: 'AIRBNB_ICAL_URL is not set' }, 500);
  }

  const { url, key } = serviceClient();
  const sb = createClient(url, key);

  let raw: string;
  try {
    raw = await fetchIcalWithRetry(icalUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Airbnb iCal fetch failed; leaving existing rows untouched', message);
    return json({ ok: false, failedClosed: true, error: message }, 502);
  }

  let events;
  try {
    events = parseAirbnbIcal(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Airbnb iCal parse failed; leaving existing rows untouched', message);
    return json({ ok: false, failedClosed: true, error: message }, 502);
  }

  const { data: bookings, error: loadError } = await sb
    .from('bookings')
    .select('id, source, status, event_date, end_date, airbnb_uid')
    .neq('status', 'cancelled');
  if (loadError) return json({ error: loadError.message }, 500);

  const plan = planAirbnbSync(events, (bookings || []) as BookingRow[]);

  for (const row of plan.upserts) {
    const payload = {
      event_date: row.event_date,
      end_date: row.end_date,
      source: 'airbnb',
      status: 'confirmed',
      airbnb_uid: row.airbnb_uid,
      customer_name: 'Airbnb',
      notes: row.summary || 'Airbnb',
      payment_status: 'unpaid',
    };
    if (row.id) {
      const { error } = await sb.from('bookings').update(payload).eq('id', row.id).eq('source', 'airbnb');
      if (error) return json({ error: error.message }, 500);
    } else {
      const { error } = await sb.from('bookings').insert(payload);
      if (error) return json({ error: error.message }, 500);
    }
  }

  if (plan.deletes.length) {
    const ids = plan.deletes.map((d) => d.id);
    const { error } = await sb.from('bookings').delete().in('id', ids).eq('source', 'airbnb');
    if (error) return json({ error: error.message }, 500);
  }

  return json({
    ok: true,
    feedEvents: events.length,
    upserted: plan.upserts.length,
    deleted: plan.deletes.length,
    skipped: plan.skipped.length,
  });
});
