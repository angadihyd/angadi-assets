// ═══════════════════════════════════════════════════════════════
//  POST /api/create-order
//  The ONLY way an order is created (online payment AND cash on
//  delivery). Prices are validated server-side against the Supabase
//  products table, so the browser can never set the amount.
//
//  Body: { items, slot, promoCode, customer, userId, payment }
//    payment: 'razorpay' (default) | 'cod'
//
//  Razorpay → creates a Razorpay order, stores a PENDING order,
//             returns { keyId, razorpayOrderId, amount, orderId }
//  COD      → stores a CONFIRMED_COD order (limit ₹5,000),
//             returns { cod:true, orderId, subtotal, delivery,
//                       discount, total }
//
//  Required env vars:
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//    RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET   (online payment only)
// ═══════════════════════════════════════════════════════════════

// ── Fallback prices if the products table is unreachable ──
const FALLBACK_PRICES = {
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

// ── Fallback promo codes (DB coupons are checked first) ──
const FALLBACK_PROMOS = {
  'ANGADI10': { type: 'percent', value: 10, min_order: 0 },
  'FIRST100': { type: 'flat',    value: 100, min_order: 499 },
  'VILLAGE':  { type: 'percent', value: 5,  min_order: 0 },
};

const EXPRESS_SLOT = 'Express (2 hrs, +₹99)';
const COD_LIMIT = 5000;          // ₹ — matches the note shown at checkout
const PRICE_TOLERANCE = 2;       // ₹ rounding slack on computed line prices

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

function sbHeaders(key) {
  return { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
}

// Parse a quantity factor out of the item name suffix, e.g.
//   "Village Goat Meat · 500 g"  → 0.5   (of the per-kg price)
//   "Goat Liver · 1.5kg · Curry Cut" → 1.5
//   "Country Eggs · 12 eggs"     → 12    (of the per-egg price)
//   "Full Goat"                  → 1
function parseFactor(name) {
  const parts = String(name).split(' · ').slice(1);
  for (const part of parts) {
    const kg = part.match(/^([\d.]+)\s*kg$/i);
    if (kg) return parseFloat(kg[1]);
    const g = part.match(/^([\d.]+)\s*g$/i);
    if (g) return parseFloat(g[1]) / 1000;
    const count = part.match(/^([\d.]+)\s*(eggs?|pcs?|pieces?|heads?|goats?)$/i);
    if (count) return parseFloat(count[1]);
  }
  return 1;
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

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Ordering not configured. Missing server environment variables.' });
    return;
  }

  let payload;
  try { payload = await readJson(req); }
  catch { res.status(400).json({ error: 'Invalid request body' }); return; }

  const { items, slot, promoCode, customer, userId } = payload;
  const isCOD = payload.payment === 'cod';

  if (!isCOD && (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET)) {
    res.status(500).json({ error: 'Online payment not configured.' });
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Cart is empty' });
    return;
  }

  // ── Load the live catalog (source of truth for prices) ──
  const catalog = { ...FALLBACK_PRICES };
  const stockOut = new Set();
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/products?select=name,price,in_stock&active=eq.true`,
      { headers: sbHeaders(SUPABASE_SERVICE_ROLE_KEY) }
    );
    if (r.ok) {
      const rows = await r.json();
      for (const p of rows) {
        catalog[p.name] = Number(p.price);
        if (p.in_stock === false) stockOut.add(p.name);
      }
    }
  } catch (e) { /* fall back to the hardcoded list */ }

  // ── Validate & recompute every line ──
  let subtotal = 0;
  const validatedItems = [];
  for (const it of items) {
    const baseName = String(it.name || '').split(' · ')[0].trim();
    const unitPrice = catalog[baseName];
    if (unitPrice == null) {
      res.status(400).json({ error: `"${baseName}" is not in our catalog. Please refresh the page and try again.` });
      return;
    }
    if (stockOut.has(baseName)) {
      res.status(400).json({ error: `"${baseName}" is out of stock right now. Please remove it from your cart.` });
      return;
    }
    const qty = parseInt(it.qty, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      res.status(400).json({ error: `Invalid quantity for ${baseName}` });
      return;
    }
    const factor = parseFactor(it.name);
    if (!Number.isFinite(factor) || factor <= 0 || factor > 200) {
      res.status(400).json({ error: `Invalid weight for ${baseName}` });
      return;
    }
    const expected = Math.round(unitPrice * factor);
    const clientPrice = Math.round(Number(it.price));
    // The client's line price must match what we compute from the
    // catalog (± rounding). Anything else is stale or tampered.
    const linePrice = Math.abs(clientPrice - expected) <= PRICE_TOLERANCE ? clientPrice : expected;
    subtotal += linePrice * qty;
    validatedItems.push({ name: it.name, price: linePrice, qty });
  }

  // ── Delivery (admin-configurable via site_settings 'delivery') ──
  let dcfg = { standard_fee: 49, free_above: 999, express_fee: 99 };
  try {
    const sr = await fetch(
      `${SUPABASE_URL}/rest/v1/site_settings?key=eq.delivery&select=value`,
      { headers: sbHeaders(SUPABASE_SERVICE_ROLE_KEY) }
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

  // ── Discount — check admin-managed DB coupons first ──
  let discount = 0;
  if (promoCode) {
    const code = String(promoCode).toUpperCase();
    let promo = null;
    try {
      const cr = await fetch(
        `${SUPABASE_URL}/rest/v1/coupons?code=eq.${encodeURIComponent(code)}&active=eq.true&select=type,value,min_order,expires_at`,
        { headers: sbHeaders(SUPABASE_SERVICE_ROLE_KEY) }
      );
      if (cr.ok) {
        const rows = await cr.json();
        if (rows.length) promo = rows[0];
      }
    } catch (e) { /* fall through */ }
    if (!promo) promo = FALLBACK_PROMOS[code] || null;
    if (promo) {
      const expired = promo.expires_at && new Date(promo.expires_at) < new Date();
      const belowMin = Number(promo.min_order || 0) > subtotal;
      if (!expired && !belowMin) {
        discount = promo.type === 'percent'
          ? Math.round(subtotal * Number(promo.value) / 100)
          : Math.round(Number(promo.value));
      }
    }
  }
  discount = Math.min(discount, subtotal); // never below zero

  const total = subtotal - discount + delivery;
  if (total < 1) {
    res.status(400).json({ error: 'Order total must be at least ₹1' });
    return;
  }

  const orderId = newOrderId();

  // ═══ CASH ON DELIVERY — insert directly as confirmed_cod ═══
  if (isCOD) {
    if (total > COD_LIMIT) {
      res.status(400).json({ error: `Cash on Delivery is available for orders up to ₹${COD_LIMIT.toLocaleString('en-IN')}. Please pay online for this order.` });
      return;
    }
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
        method: 'POST',
        headers: { ...sbHeaders(SUPABASE_SERVICE_ROLE_KEY), 'Prefer': 'return=minimal' },
        body: JSON.stringify([{
          order_id: orderId,
          user_id: userId || null,
          customer: customer || {},
          items: validatedItems,
          subtotal, delivery, discount, total,
          payment: 'cod',
          status: 'confirmed_cod',
        }]),
      });
      if (!r.ok) {
        const txt = await r.text();
        console.error('COD insert failed', r.status, txt);
        res.status(500).json({ error: 'Could not save order. Please try again or order on WhatsApp.' });
        return;
      }
    } catch (e) {
      console.error('COD insert error', e);
      res.status(500).json({ error: 'Could not save order. Please try again or order on WhatsApp.' });
      return;
    }
    res.status(200).json({ cod: true, orderId, subtotal, delivery, discount, total });
    return;
  }

  // ═══ ONLINE — create the Razorpay order (amount locked here) ═══
  let rzpOrder;
  try {
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: total * 100,
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
      headers: { ...sbHeaders(SUPABASE_SERVICE_ROLE_KEY), 'Prefer': 'return=minimal' },
      body: JSON.stringify([{
        order_id: orderId,
        razorpay_order_id: rzpOrder.id,
        user_id: userId || null,
        customer: customer || {},
        items: validatedItems,
        subtotal, delivery, discount, total,
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
    amount: total * 100,
    orderId,
  });
};
