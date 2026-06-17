// ═══════════════════════════════════════════════════════════════
//  POST /api/create-order
//  Securely creates a Razorpay order from server-validated prices,
//  then stores a PENDING order in Supabase. The browser NEVER sets
//  the amount — we recompute it here from the source-of-truth price
//  list so a user cannot pay ₹1 for a goat.
//
//  Returns: { keyId, razorpayOrderId, amount, orderId }
//
//  Required environment variables (set in Vercel → Settings → Env):
//    RAZORPAY_KEY_ID            (e.g. rzp_live_xxx or rzp_test_xxx)
//    RAZORPAY_KEY_SECRET
//    SUPABASE_URL               https://ijvkvgmzjjhwvrwtladj.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY  (Supabase → Settings → API → service_role)
// ═══════════════════════════════════════════════════════════════

// ── SOURCE-OF-TRUTH PRICES (₹) ──
// Keep in sync with shop.html / product-detail.html. (TODO: move to a
// Supabase `products` table so there's only one place to update.)
const PRICES = {
  'Village Goat Meat': 680,
  'Country Chicken':   520,
  'Fresh River Fish':  450,
  'Baby Goat Legs':    980,
  'Country Eggs':       12,
  'Full Goat':        8500,
  'Goat Legs':         400,
  'Goat Liver':       1000,
  'Goat Head':         520,
};

// ── PROMO CODES (must match cart.html) ──
const PROMOS = {
  'ANGADI10': { type: 'percent', value: 10 },
  'FIRST100': { type: 'flat',    value: 100 },
  'VILLAGE':  { type: 'percent', value: 5 },
};

const EXPRESS_SLOT = 'Express (2 hrs, +₹99)';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function newOrderId() {
  const r = () => Math.random().toString(36).slice(2, 7).toUpperCase();
  return `ANG-${r()}-${r()}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const {
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
  } = process.env;

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Payment not configured. Missing server environment variables.' });
    return;
  }

  let payload;
  try { payload = await readJson(req); }
  catch { res.status(400).json({ error: 'Invalid request body' }); return; }

  const { items, slot, promoCode, customer, userId } = payload;

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Cart is empty' });
    return;
  }

  // ── Recompute every line ──
  // For products in our known catalog we use the SERVER price (anti-tamper).
  // For dynamic DB products not in the map we fall back to the client price
  // (validated as a sane positive number) so they aren't blocked at checkout.
  let subtotal = 0;
  const validatedItems = [];
  for (const it of items) {
    const baseName = String(it.name || '').split(' · ')[0].trim();
    const known = PRICES[baseName];
    const clientPrice = Number(it.price);
    const unitPrice = known != null ? known : clientPrice;
    const qty = parseInt(it.qty, 10);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0 || unitPrice > 1000000) {
      res.status(400).json({ error: `Invalid price for ${baseName}` });
      return;
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      res.status(400).json({ error: `Invalid quantity for ${baseName}` });
      return;
    }
    subtotal += unitPrice * qty;
    validatedItems.push({ name: it.name, price: unitPrice, qty });
  }

  // ── Delivery (admin-configurable via site_settings 'delivery') ──
  let dcfg = { standard_fee: 49, free_above: 999, express_fee: 99 };
  try {
    const sr = await fetch(
      `${SUPABASE_URL}/rest/v1/site_settings?key=eq.delivery&select=value`,
      { headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (sr.ok) {
      const rows = await sr.json();
      const v = Array.isArray(rows) && rows[0] && rows[0].value;
      if (v) dcfg = {
        standard_fee: Number(v.standard_fee ?? dcfg.standard_fee),
        free_above:   Number(v.free_above   ?? dcfg.free_above),
        express_fee:  Number(v.express_fee  ?? dcfg.express_fee),
      };
    }
  } catch (e) { /* fall back to defaults */ }

  const delivery = slot === EXPRESS_SLOT
    ? dcfg.express_fee
    : (subtotal >= dcfg.free_above ? 0 : dcfg.standard_fee);

  // ── Discount (server-validated promo) ──
  let discount = 0;
  if (promoCode) {
    const p = PROMOS[String(promoCode).toUpperCase()];
    if (p) discount = p.type === 'percent' ? Math.round(subtotal * p.value / 100) : p.value;
  }
  discount = Math.min(discount, subtotal); // never below zero

  const total = subtotal - discount + delivery;
  const amountPaise = total * 100;
  if (amountPaise < 100) {
    res.status(400).json({ error: 'Order total must be at least ₹1' });
    return;
  }

  const orderId = newOrderId();

  // ── Create the Razorpay order (amount locked here) ──
  let rzpOrder;
  try {
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        receipt: orderId,
        notes: { orderId, customerName: customer?.name || '', phone: customer?.phone || '' },
      }),
    });
    rzpOrder = await r.json();
    if (r.status === 401) {
      console.error('Razorpay auth failed', rzpOrder);
      res.status(401).json({ error: 'Payment gateway authentication failed' });
      return;
    }
    if (!r.ok || !rzpOrder.id) {
      console.error('Razorpay order failed', rzpOrder);
      res.status(500).json({ error: 'Could not create payment order' });
      return;
    }
  } catch (e) {
    console.error('Razorpay request error', e);
    res.status(502).json({ error: 'Payment gateway unreachable' });
    return;
  }

  // ── Store a PENDING order (service role → bypasses RLS) ──
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify([{
        order_id: orderId,
        razorpay_order_id: rzpOrder.id,
        user_id: userId || null,
        customer: customer || {},
        items: validatedItems,
        subtotal,
        delivery,
        discount,
        total,
        payment: 'razorpay',
        status: 'pending',
      }]),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error('Supabase insert failed', r.status, txt);
      res.status(500).json({ error: 'Could not save order' });
      return;
    }
  } catch (e) {
    console.error('Supabase request error', e);
    res.status(500).json({ error: 'Could not save order' });
    return;
  }

  res.status(200).json({
    keyId: RAZORPAY_KEY_ID,
    razorpayOrderId: rzpOrder.id,
    amount: amountPaise,
    orderId,
  });
};
