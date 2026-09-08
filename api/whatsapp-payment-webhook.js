// ═══════════════════════════════════════════════════════════════
//  POST /api/whatsapp-payment-webhook
//  Razorpay calls this when a WhatsApp Payment Link is paid. This
//  mirrors api/razorpay-webhook.js (same HMAC-verify-then-confirm
//  pattern) but matches on razorpay_payment_link_id instead of
//  razorpay_order_id, and additionally sends a WhatsApp confirmation
//  message to the customer once the order flips to 'paid'.
//
//  Required env vars:
//    RAZORPAY_WHATSAPP_WEBHOOK_SECRET   set when you create THIS webhook
//                                        in the Razorpay dashboard (it is
//                                        a separate secret from the one
//                                        used by /api/razorpay-webhook)
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (already set for the site)
//    META_ACCESS_TOKEN / META_PHONE_NUMBER_ID   (already set for the bot)
//
//  Webhook URL to register in Razorpay Dashboard → Settings → Webhooks:
//    https://www.angadi.farm/api/whatsapp-payment-webhook
//  Active events: payment_link.paid
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

function sbHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function patchOrderByLinkId(env, linkId, fields) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/orders?razorpay_payment_link_id=eq.${encodeURIComponent(linkId)}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(env.SUPABASE_SERVICE_ROLE_KEY), Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
}

async function sendWhatsAppText(env, to, body) {
  if (!env.META_ACCESS_TOKEN || !env.META_PHONE_NUMBER_ID) return;
  try {
    await fetch(`https://graph.facebook.com/v20.0/${env.META_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
  } catch (e) { console.error('WA confirmation send failed', e); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const env = process.env;
  const { RAZORPAY_WHATSAPP_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;

  if (!RAZORPAY_WHATSAPP_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('WhatsApp payment webhook not configured');
    res.status(500).json({ error: 'Webhook not configured' });
    return;
  }

  const raw = await readRaw(req);

  const expected = crypto.createHmac('sha256', RAZORPAY_WHATSAPP_WEBHOOK_SECRET).update(raw).digest('hex');
  const received = req.headers['x-razorpay-signature'] || '';
  const valid = received.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  if (!valid) {
    console.warn('Invalid WhatsApp payment webhook signature');
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  let event;
  try { event = JSON.parse(raw); } catch { res.status(400).json({ error: 'Bad payload' }); return; }

  if (event.event !== 'payment_link.paid') {
    res.status(200).json({ ignored: event.event }); // ack so Razorpay stops retrying
    return;
  }

  const link = event.payload?.payment_link?.entity;
  const payment = event.payload?.payment?.entity;
  const linkId = link?.id;
  const amountPaid = payment?.amount ?? link?.amount_paid;
  const paymentId = payment?.id || null;

  if (!linkId) { res.status(200).json({ error: 'No payment link id in payload' }); return; }

  try {
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?razorpay_payment_link_id=eq.${encodeURIComponent(linkId)}&select=order_id,total,status,customer`,
      { headers: sbHeaders(SUPABASE_SERVICE_ROLE_KEY) }
    );
    const rows = await lookup.json();
    const order = Array.isArray(rows) ? rows[0] : null;

    if (!order) { console.warn('No matching order for link', linkId); res.status(200).json({ error: 'Order not found' }); return; }
    if (order.status === 'paid') { res.status(200).json({ ok: true, note: 'already paid' }); return; }

    const expectedPaise = Math.round(Number(order.total) * 100);
    if (Number(amountPaid) !== expectedPaise) {
      console.error('Amount mismatch', { linkId, amountPaid, expectedPaise });
      await patchOrderByLinkId(env, linkId, { status: 'amount_mismatch', payment_id: paymentId });
      res.status(200).json({ error: 'Amount mismatch' });
      return;
    }

    const upd = await patchOrderByLinkId(env, linkId, { status: 'paid', payment_id: paymentId });
    if (!upd.ok) {
      const txt = await upd.text();
      console.error('Failed to mark paid', upd.status, txt);
      res.status(500).json({ error: 'Update failed' });
      return;
    }

    const phone = order.customer?.phone;
    if (phone) {
      await sendWhatsAppText(env, phone, `✅ Payment received for order *${order.order_id}*!\nYour order is confirmed. Thank you for ordering from Angadi! 🐐`);
    }
  } catch (e) {
    console.error('WhatsApp payment webhook processing error', e);
    res.status(500).json({ error: 'Processing error' });
    return;
  }

  res.status(200).json({ ok: true });
};
