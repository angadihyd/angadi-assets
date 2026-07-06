// Receives a Supabase Database Webhook on the `orders` table (INSERT + UPDATE)
// and sends Web Push to the right audience.
//   - New order (INSERT)            → push to all admins
//   - Order becomes 'ready' (UPDATE)→ push to all delivery partners
// Required Vercel env vars: VAPID_PUBLIC, VAPID_PRIVATE, (optional) VAPID_SUBJECT
const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ijvkvgmzjjhwvrwtladj.supabase.co';
// Service-role key: push_subscriptions is no longer publicly readable.
const DB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Public key is safe to ship; private key MUST come from a Vercel env var (secret).
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BPiQcgEVyRxp96djwa3O-eX7XSOvp5lN4PTpP9V1QN2EKBZ9kOINNdK-bppKo4qGOgYrzO3HPaasuBdWjMTVTuQ';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
if (VAPID_PRIVATE) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:angadihyd@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);
}

async function subsFor(role) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?select=*&role=eq.' + role, {
    headers: { apikey: DB_KEY, Authorization: 'Bearer ' + DB_KEY }
  });
  return r.ok ? r.json() : [];
}
async function deleteSub(endpoint) {
  await fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?endpoint=eq.' + encodeURIComponent(endpoint), {
    method: 'DELETE', headers: { apikey: DB_KEY, Authorization: 'Bearer ' + DB_KEY }
  });
}

module.exports = async (req, res) => {
  try {
    if (!VAPID_PRIVATE) { res.status(200).json({ error: 'VAPID_PRIVATE env not set on Vercel' }); return; }
    if (!DB_KEY) { res.status(200).json({ error: 'SUPABASE_SERVICE_ROLE_KEY env not set on Vercel' }); return; }
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const type = payload.type;
    const rec  = payload.record || {};
    const old  = payload.old_record || {};

    let role, title, body, url;
    if (type === 'INSERT') {
      role = 'admin';
      title = '🛒 New Angadi Order';
      body = `${(rec.customer && rec.customer.name) || 'Customer'} · ₹${rec.total || 0} · ${rec.payment === 'cod' ? 'COD' : 'Paid'}`;
      url = '/admin/orders.html';
    } else if (type === 'UPDATE' && rec.status === 'ready' && old.status !== 'ready') {
      role = 'partner';
      title = '🛵 New delivery available';
      const area = (rec.customer && rec.customer.address && rec.customer.address.area) || '';
      body = `${(rec.customer && rec.customer.name) || ''} · ${area} · ₹${rec.total || 0}`;
      url = '/admin/delivery-partner.html';
    } else {
      res.status(200).json({ skipped: true });
      return;
    }

    const subs = await subsFor(role);
    const data = JSON.stringify({ title, body, url });
    let sent = 0;
    await Promise.all((subs || []).map(s =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data)
        .then(() => { sent++; })
        .catch(async err => {
          if (err && (err.statusCode === 404 || err.statusCode === 410)) await deleteSub(s.endpoint);
        })
    ));
    res.status(200).json({ role, sent, total: (subs || []).length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
