// ═══════════════════════════════════════════════════════════════
//  POST /api/razorpay-webhook
//  Razorpay calls this when money actually moves. This is the ONLY
//  place an order becomes 'paid' — so a paid status can never be
//  faked from the browser.
//
//  We verify the HMAC signature, confirm the amount matches the
//  pending order, then flip the order to 'paid' in Supabase using
//  the service-role key.
//
//  Required environment variables:
//    RAZORPAY_WEBHOOK_SECRET    (set when you create the webhook in Razorpay)
//    SUPABASE_URL               https://ijvkvgmzjjhwvrwtladj.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY
//
//  Webhook URL to register in Razorpay Dashboard → Settings → Webhooks:
//    https://www.angadi.farm/api/razorpay-webhook
//  Active events: payment.captured  (and optionally order.paid)
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function patchOrder(supaUrl, key, rzpOrderId, fields) {
  const r = await fetch(
    `${supaUrl}/rest/v1/orders?razorpay_order_id=eq.${encodeURIComponent(rzpOrderId)}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(fields),
    }
  );
  return r;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const {
    RAZORPAY_WEBHOOK_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
  } = process.env;

  if (!RAZORPAY_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Webhook not configured');
    res.status(500).json({ error: 'Webhook not configured' });
    return;
  }

  const raw = await readRaw(req);

  // ── 1. Verify signature over the RAW body ──
  const expected = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(raw)
    .digest('hex');
  const received = req.headers['x-razorpay-signature'] || '';

  const valid =
    received.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));

  if (!valid) {
    console.warn('Invalid webhook signature');
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  // ── 2. Parse the verified event ──
  let event;
  try { event = JSON.parse(raw); }
  catch { res.status(400).json({ error: 'Bad payload' }); return; }

  const type = event.event;
  const payment = event.payload?.payment?.entity;
  const orderEntity = event.payload?.order?.entity;

  // We only act on a successful capture.
  if (type !== 'payment.captured' && type !== 'order.paid') {
    res.status(200).json({ ignored: type }); // ack so Razorpay stops retrying
    return;
  }

  const rzpOrderId = payment?.order_id || orderEntity?.id;
  const paymentId  = payment?.id || null;
  const amountPaid = payment?.amount ?? orderEntity?.amount_paid;

  if (!rzpOrderId) {
    res.status(200).json({ error: 'No order id in payload' });
    return;
  }

  // ── 3. Look up the pending order and verify the amount ──
  try {
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?razorpay_order_id=eq.${encodeURIComponent(rzpOrderId)}&select=total,status`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const rows = await lookup.json();
    const order = Array.isArray(rows) ? rows[0] : null;

    if (!order) {
      console.warn('No matching order for', rzpOrderId);
      res.status(200).json({ error: 'Order not found' });
      return;
    }

    if (order.status === 'paid') {
      res.status(200).json({ ok: true, note: 'already paid' }); // idempotent
      return;
    }

    const expectedPaise = Math.round(Number(order.total) * 100);
    if (Number(amountPaid) !== expectedPaise) {
      console.error('Amount mismatch', { rzpOrderId, amountPaid, expectedPaise });
      await patchOrder(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, rzpOrderId, {
        status: 'amount_mismatch',
        payment_id: paymentId,
      });
      res.status(200).json({ error: 'Amount mismatch' });
      return;
    }

    // ── 4. Confirm the order ──
    const upd = await patchOrder(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, rzpOrderId, {
      status: 'paid',
      payment_id: paymentId,
    });
    if (!upd.ok) {
      const txt = await upd.text();
      console.error('Failed to mark paid', upd.status, txt);
      res.status(500).json({ error: 'Update failed' });
      return;
    }
  } catch (e) {
    console.error('Webhook processing error', e);
    res.status(500).json({ error: 'Processing error' });
    return;
  }

  res.status(200).json({ ok: true });
};
