import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { cronAuthorized, handleCors, json, serviceClient } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!cronAuthorized(req)) return json({ error: 'Unauthorized' }, 401);

  const { url, key } = serviceClient();
  const sb = createClient(url, key);
  const { data, error } = await sb.rpc('expire_pending_holds');
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, expired: data ?? 0 });
});
