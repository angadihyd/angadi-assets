// ═══════════════════════════════════════════════════════════════
//  POST /api/verify-payment
//  Called by the browser immediately after a successful Razorpay
//  payment, for instant confirmation. Verifies the checkout signature
//  (HMAC-SHA256 of "order_id|payment_id" with the key secret) and, if
//  valid, marks the order 'paid' in Supabase.
//
//  This complements /api/razorpay-webhook.js: verify-payment gives the
//  user instant feedback; the webhook is the reliable backstop if the
//  browser closes before this runs. Both are idempotent.
//
//  Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
//  Returns: { success: true } on a verified payment.
//
//  Required env vars: RAZORPAY_KEY_SECRET, SUPABASE_URL,
//                     SUPABASE_SERVICE_ROLE_KEY
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { RAZORPAY_KEY_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!RAZORPAY_KEY_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Payment verification not configured' });
    return;
  }

  let body;
  try { body = await readJson(req); }
  catch { res.status(400).json({ error: 'Invalid request body' }); return; }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    res.status(400).json({ error: 'Missing payment fields' });
    return;
  }

  // ── Verify the signature ──
  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const valid =
    expected.length === razorpay_signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature));

  if (!valid) {
    // Signature mismatch — never mark as paid.
    res.status(400).json({ error: 'Invalid payment signature' });
    return;
  }

  // ── Signature valid → mark the order paid (idempotent) ──
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?razorpay_order_id=eq.${encodeURIComponent(razorpay_order_id)}&status=neq.paid`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ status: 'paid', payment_id: razorpay_payment_id }),
      }
    );
    if (!r.ok) {
      const txt = await r.text();
      console.error('verify-payment: Supabase update failed', r.status, txt);
      // Payment is genuinely verified; the webhook will reconcile. Still report success.
    }
  } catch (e) {
    console.error('verify-payment: Supabase error', e);
    // Don't fail the user — webhook backstop will mark it paid.
  }

  res.status(200).json({ success: true });
};
