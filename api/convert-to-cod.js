// ═══════════════════════════════════════════════════════════════
//  POST /api/convert-to-cod
//  Rescues an online order whose payment never completed.
//
//  A Razorpay order row is created as 'pending' the moment checkout
//  starts. If the payment then fails or the customer closes the
//  payment window, that row just sat there forever — the customer had
//  to start over, and most simply didn't. This lets them keep the
//  order they already filled in and pay cash on delivery instead.
//
//  Body: { orderId, phone }
//  Only ever touches an order that is still 'pending' with no
//  payment_id, so an order that was actually paid can't be flipped to
//  COD (which would mean collecting the money twice).
//
//  Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ═══════════════════════════════════════════════════════════════

const COD_LIMIT = 5000; // ₹ — matches api/create-order.js and the checkout note

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function last10(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
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

  const orderId = String(payload.orderId || '').trim();
  const phone = last10(payload.phone);
  if (!orderId || phone.length !== 10) {
    res.status(400).json({ error: 'Order ID and phone required' });
    return;
  }

  try {
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=customer,payment,payment_id,status,total&limit=1`,
      { headers: H }
    );
    const rows = lookup.ok ? await lookup.json() : [];
    const order = Array.isArray(rows) ? rows[0] : null;

    // Same ownership rule as cancelling: the order id alone isn't enough.
    if (!order || last10(order.customer && order.customer.phone) !== phone) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    if (order.payment === 'cod' || order.status === 'confirmed_cod') {
      res.status(200).json({ ok: true, alreadyCod: true });
      return;
    }
    if (order.payment_id || order.status === 'paid') {
      res.status(400).json({ error: 'This order is already paid.' });
      return;
    }
    if (order.status !== 'pending') {
      res.status(400).json({ error: 'This order can no longer be switched to Cash on Delivery. Please message us on WhatsApp.' });
      return;
    }
    if (Number(order.total || 0) > COD_LIMIT) {
      res.status(400).json({ error: `Cash on Delivery is available up to ₹${COD_LIMIT.toLocaleString('en-IN')}. Please try the payment again or message us on WhatsApp.` });
      return;
    }

    const upd = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&status=eq.pending&payment_id=is.null`,
      {
        method: 'PATCH',
        headers: { ...H, 'Prefer': 'return=representation' },
        body: JSON.stringify({ payment: 'cod', status: 'confirmed_cod' }),
      }
    );
    const updated = upd.ok ? await upd.json() : [];
    if (!Array.isArray(updated) || !updated.length) {
      // The payment landed in the moment between the checks above and here.
      res.status(409).json({ error: 'That order was just paid online — no cash needed.' });
      return;
    }
    res.status(200).json({ ok: true, orderId });
  } catch (e) {
    console.error('convert-to-cod error', e);
    res.status(500).json({ error: 'Server error' });
  }
};
