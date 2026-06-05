// Saves a Web Push subscription. Called by push-register.js from the browser.
const SUPABASE_URL = 'https://ijvkvgmzjjhwvrwtladj.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlqdmt2Z216ampod3Zyd3RsYWRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MDU2MDcsImV4cCI6MjA5NjA4MTYwN30.Kv1uqldZdoWjNnMbHMD2xuZ5i5tnl6cdvapgIIN6vJQ';

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
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
        apikey: ANON, Authorization: 'Bearer ' + ANON,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) { const t = await r.text(); res.status(500).json({ error: 'db ' + r.status, detail: t }); return; }
    res.status(200).json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
};
