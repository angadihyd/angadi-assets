// Saves a Web Push subscription. Called by push-register.js from the browser.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ijvkvgmzjjhwvrwtladj.supabase.co';
// Service-role key: push_subscriptions is no longer publicly writable.
const DB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (!DB_KEY) { res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY env not set on Vercel' }); return; }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const sub = body.subscription;
    if (!sub || !sub.endpoint || !sub.keys) { res.status(400).json({ error: 'invalid subscription' }); return; }
    const row = {
      endpoint: sub.endpoint,
      p256dh:   sub.keys.p256dh,
      auth:     sub.keys.auth,
      role:     body.role || 'admin',
      partner_code: body.code || null
    };
    const r = await fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?on_conflict=endpoint', {
      method: 'POST',
      headers: {
        apikey: DB_KEY, Authorization: 'Bearer ' + DB_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) { const t = await r.text(); res.status(500).json({ error: 'db ' + r.status, detail: t }); return; }
    res.status(200).json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
};
