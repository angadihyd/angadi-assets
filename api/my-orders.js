// ═══════════════════════════════════════════════════════════════
//  POST /api/my-orders
//  Customer-facing order access, now that the orders table is no
//  longer publicly readable.
//
//  Actions:
//    list   { accessToken }            → all orders for the logged-in
//                                        user's verified phone number
//    track  { orderId, phone }         → one order (guest tracking —
//                                        BOTH the random order id and
//                                        the phone must match)
//    cancel { orderId, phone } or
//           { orderId, accessToken }   → cancel own order while it is
//                                        still early in the flow
//
//  The access token is a Supabase Auth session token from the
//  phone-OTP login; we verify it with Supabase and use the phone on
//  the verified user — never a phone number the browser claims.
//
//  Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//                     SUPABASE_ANON_KEY (for auth verification)
// ═══════════════════════════════════════════════════════════════

const CANCELLABLE = ['pending', 'confirmed', 'paid', 'paid_dev', 'confirmed_cod'];

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function last10(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.slice(-10);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Not configured' });
    return;
  }
  const H = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  let payload;
  try { payload = await readJson(req); }
  catch { res.status(400).json({ error: 'Invalid JSON' }); return; }
  const action = payload.action || 'list';

  // ── Resolve the caller's verified phone (if a token was sent) ──
  async function verifiedPhone() {
    const token = payload.accessToken;
    if (!token) return null;
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          'apikey': SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!r.ok) return null;
      const user = await r.json();
      return last10(user.phone || (user.user_metadata && user.user_metadata.phone));
    } catch { return null; }
  }

  async function fetchOrders(qs) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?${qs}`, { headers: H });
    return r.ok ? r.json() : [];
  }

  try {
    if (action === 'list') {
      const phone = await verifiedPhone();
      if (!phone) { res.status(401).json({ error: 'Login required' }); return; }
      // fetch recent orders, match by phone digits (formats vary: '+91 98…', '98…')
      const rows = await fetchOrders('select=*&order=placed_at.desc&limit=400');
      const mine = rows.filter(o => last10(o.customer && o.customer.phone) === phone);
      res.status(200).json({ data: mine });
      return;
    }

    if (action === 'track') {
      const orderId = String(payload.orderId || '').trim();
      const phone = last10(payload.phone);
      if (!orderId || phone.length !== 10) { res.status(400).json({ error: 'Order ID and phone required' }); return; }
      const rows = await fetchOrders(`select=*&order_id=eq.${encodeURIComponent(orderId)}&limit=1`);
      const order = rows[0];
      if (!order || last10(order.customer && order.customer.phone) !== phone) {
        res.status(404).json({ error: 'No order found for that ID and phone' });
        return;
      }
      res.status(200).json({ data: [order] });
      return;
    }

    if (action === 'cancel') {
      const orderId = String(payload.orderId || '').trim();
      if (!orderId) { res.status(400).json({ error: 'Order ID required' }); return; }
      // ownership: verified session phone OR the matching guest phone
      const sessionPhone = await verifiedPhone();
      const claimPhone = sessionPhone || last10(payload.phone);
      if (!claimPhone || claimPhone.length !== 10) { res.status(401).json({ error: 'Not allowed' }); return; }

      const rows = await fetchOrders(`select=*&order_id=eq.${encodeURIComponent(orderId)}&limit=1`);
      const order = rows[0];
      if (!order || last10(order.customer && order.customer.phone) !== claimPhone) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }
      if (!CANCELLABLE.includes(order.status)) {
        res.status(400).json({ error: 'This order is already being prepared and can no longer be cancelled online. Message us on WhatsApp and we will help.' });
        return;
      }
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`,
        { method: 'PATCH', headers: { ...H, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'cancelled', cancelled_at: new Date().toISOString() }) }
      );
      if (!r.ok) { res.status(500).json({ error: 'Could not cancel. Please try again.' }); return; }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('my-orders error', e);
    res.status(500).json({ error: 'Server error' });
  }
};
