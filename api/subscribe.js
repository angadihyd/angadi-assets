// Saves a Web Push subscription. Called by push-register.js from the browser.
// Also logs lightweight, anonymous site-visit/login analytics ({type:'visit'|'login'})
// — folded in here rather than a new file because Vercel's Hobby plan caps a
// deployment at 12 serverless functions and this project is already at that cap
// (see the health-check comment in api/admin.js for the same constraint).
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ijvkvgmzjjhwvrwtladj.supabase.co';
// Service-role key: push_subscriptions is no longer publicly writable.
const DB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (!DB_KEY) { res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY env not set on Vercel' }); return; }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // ── checkout lead: name + phone saved when the customer taps Continue on the
    // address step, one row per browser, so admins can follow up if they leave ──
    if (body.type === 'lead') {
      try {
        const phone = String(body.phone || '').replace(/\D/g, '').slice(-10);
        const visitor = String(body.visitorId || '').slice(0, 64);
        if (/^[6-9]\d{9}$/.test(phone) && visitor) {
          const items = (Array.isArray(body.items) ? body.items : []).slice(0, 30)
            .map(i => ({ name: String(i.name || '').slice(0, 80), qty: Number(i.qty) || 1, price: Number(i.price) || 0 }));
          await fetch(`${SUPABASE_URL}/rest/v1/checkout_leads?on_conflict=visitor_id`, {
            method: 'POST',
            headers: { apikey: DB_KEY, Authorization: 'Bearer ' + DB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({ visitor_id: visitor, name: String(body.name || '').slice(0, 120), phone, items, total: Number(body.total) || 0, source: String(body.source || '').slice(0, 40) || null, updated_at: new Date().toISOString() })
          });
        }
      } catch (e) { /* never break checkout */ }
      res.status(200).json({ ok: true });
      return;
    }

    // ── analytics: never let a logging hiccup surface as an error to the caller ──
    if (body.type === 'visit' || body.type === 'login') {
      try {
        const table = body.type === 'visit' ? 'site_visits' : 'login_events';
        const row = body.type === 'visit'
          ? { path: String(body.path || '').slice(0, 200), visitor_id: String(body.visitorId || '').slice(0, 64), referrer: String(body.referrer || '').slice(0, 300), source: String(body.source || '').slice(0, 40) || null }
          : { user_id: body.userId || null, name: String(body.name || '').slice(0, 120), email: String(body.email || '').slice(0, 160), phone: String(body.phone || '').slice(0, 20), method: String(body.method || '').slice(0, 20) };
        const insert = (r) => fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
          method: 'POST',
          headers: { apikey: DB_KEY, Authorization: 'Bearer ' + DB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(r)
        });
        const r = await insert(row);
        // site_visits.source is added by supabase-analytics.sql; until that has
        // been run, keep logging the visit without it rather than losing it.
        if (!r.ok && 'source' in row) { delete row.source; await insert(row); }
      } catch (e) { /* analytics must never break the site */ }
      res.status(200).json({ ok: true });
      return;
    }

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
