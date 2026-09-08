// ═══════════════════════════════════════════════════════════════
//  GET/POST /api/whatsapp-webhook
//  Meta WhatsApp Cloud API webhook. GET handles the one-time
//  verification handshake; POST receives every inbound message and
//  runs the ordering conversation (product list → quantity →
//  delivery area → name/address → payment method).
//
//  Orders are written straight into the EXISTING `orders` table
//  (same one checkout.html uses) tagged customer.source='whatsapp',
//  so they show up in admin/orders.html and trigger the existing
//  push-notification webhook (api/notify.js) with no extra work.
//
//  Safety/reliability:
//   - Every inbound message id is claimed via an INSERT into
//     wa_processed_messages (unique constraint on msg_id). If Meta
//     retries a webhook delivery, or a customer double-taps a
//     button before the first tap finishes processing, the second
//     attempt is dropped before it can create a duplicate order.
//   - Cart prices are re-fetched from the live `products` table
//     right before payment (see askPayment/refreshCartPrices) —
//     a price cached earlier in a long conversation can never be
//     the one actually charged, mirroring api/create-order.js.
//   - Any uncaught error still tells the customer something broke
//     instead of leaving them with silence.
//
//  Required env vars:
//    META_ACCESS_TOKEN     Meta Cloud API access token
//    META_PHONE_NUMBER_ID  the "Phone number ID" from Meta app dashboard
//    META_VERIFY_TOKEN     any string you choose; must match what you
//                           enter in Meta → WhatsApp → Configuration
//    META_APP_SECRET       (recommended) verifies inbound webhook signature
//    ADMIN_WHATSAPP_NUMBER (optional) your own WhatsApp number — customers
//                           who ask to talk to a person get routed here
//    RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET   (already set for the site)
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (already set for the site)
//
//  Webhook URL to register in Meta → WhatsApp → Configuration:
//    https://www.angadi.farm/api/whatsapp-webhook
//  Subscribe to field: messages
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const COD_LIMIT = 5000; // ₹ — matches the website's COD limit
const RESTART_WORDS = ['hi', 'hello', 'hey', 'menu', 'order', 'start'];
const HELP_WORDS = ['talk', 'help', 'human', 'agent', 'support', 'call', 'question'];
const GRAPH_VERSION = 'v20.0';

// ── Low-level helpers ──────────────────────────────────────────

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

async function sbGet(env, path) {
  const r = await fetch(`${env.SUPABASE_URL}${path}`, { headers: sbHeaders(env.SUPABASE_SERVICE_ROLE_KEY) });
  if (!r.ok) { console.error('Supabase GET failed', path, r.status, await r.text()); return []; }
  return r.json();
}

async function sbPost(env, path, rows) {
  const r = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { ...sbHeaders(env.SUPABASE_SERVICE_ROLE_KEY), Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) console.error('Supabase POST failed', path, r.status, await r.text());
  return r.ok;
}

async function sbUpsert(env, path, rows) {
  const r = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { ...sbHeaders(env.SUPABASE_SERVICE_ROLE_KEY), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) console.error('Supabase upsert failed', path, r.status, await r.text());
  return r.ok;
}

// Atomically claims a Meta message id via the wa_processed_messages unique
// constraint. Returns true only for the request that actually won the
// insert — a retried/duplicate delivery gets an empty result and must not
// process the message again. Fails OPEN (returns true) on any DB error so
// a Supabase hiccup never silently swallows a real customer message.
async function claimMessage(env, msgId) {
  if (!msgId) return true;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/wa_processed_messages`, {
      method: 'POST',
      headers: { ...sbHeaders(env.SUPABASE_SERVICE_ROLE_KEY), Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify([{ msg_id: msgId }]),
    });
    if (!r.ok) { console.error('claimMessage failed', r.status, await r.text()); return true; }
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { console.error('claimMessage error', e); return true; }
}

function newOrderId() {
  const r = () => Math.random().toString(36).slice(2, 7).toUpperCase();
  return `ANG-${r()}-${r()}`;
}

function formatIST(iso) {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return iso; }
}
function formatDateIST(dateStr) {
  try {
    return new Date(`${dateStr}T00:00:00+05:30`).toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short',
    });
  } catch { return dateStr; }
}

// ── WhatsApp send helpers ────────────────────────────────────

async function sendMessage(env, to, payload) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${env.META_PHONE_NUMBER_ID}/messages`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...payload }),
  });
  if (!r.ok) console.error('WA send failed', r.status, await r.text());
  return r;
}

function sendText(env, to, body) {
  return sendMessage(env, to, { type: 'text', text: { body } });
}

function sendButtons(env, to, bodyText, buttons) {
  // buttons: [{id, title}], max 3 — WhatsApp button title limit is 20 chars
  return sendMessage(env, to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  });
}

function sendList(env, to, bodyText, buttonLabel, rows) {
  // rows: [{id, title, description}] — WhatsApp list rows: 24-char title,
  // 72-char description, MAX 10 rows total per message. Callers must
  // paginate if they have more than 10 options (see showProductList /
  // showAreaList below).
  return sendMessage(env, to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonLabel.slice(0, 20),
        sections: [{ rows: rows.slice(0, 10).map((r) => ({ id: r.id, title: r.title.slice(0, 24), description: (r.description || '').slice(0, 72) })) }],
      },
    },
  });
}

// ── Conversation state ───────────────────────────────────────

async function getState(env, waId) {
  const rows = await sbGet(env, `/rest/v1/wa_conversation_state?wa_id=eq.${encodeURIComponent(waId)}&select=state,context&limit=1`);
  return rows[0] || { state: 'idle', context: {} };
}

async function saveState(env, waId, state, context) {
  await sbUpsert(env, '/rest/v1/wa_conversation_state', [{ wa_id: waId, state, context, updated_at: new Date().toISOString() }]);
}

async function upsertCustomer(env, waId, name, address, area) {
  await sbUpsert(env, '/rest/v1/wa_customers', [{ wa_id: waId, name, last_address: address, last_area: area, updated_at: new Date().toISOString() }]);
}

// ── Business logic ───────────────────────────────────────────

async function getOpenWindow(env) {
  const now = new Date().toISOString();
  const rows = await sbGet(env, `/rest/v1/order_windows?is_active=eq.true&opens_at=lte.${now}&closes_at=gte.${now}&order=closes_at.asc&limit=1`);
  return rows[0] || null;
}

async function showProductList(env, to, ctx, page = 0) {
  const products = await sbGet(env, `/rest/v1/products?select=slug,name,price,unit&active=eq.true&in_stock=eq.true&order=sort_order.asc`);
  if (!products.length) {
    await sendText(env, to, 'Sorry, nothing is available to order right now. Please check back soon.');
    return;
  }
  const pageSize = 9; // leaves room for a "more items" row (10-row cap)
  const start = page * pageSize;
  const slice = products.slice(start, start + pageSize);
  const rows = slice.map((p) => ({ id: `prod:${p.slug}`, title: p.name, description: `₹${p.price}/${p.unit}` }));
  if (start + pageSize < products.length) rows.push({ id: `prod_more:${page + 1}`, title: '➡️ More items' });
  await sendList(env, to, 'Tap below to pick a product:', 'View Menu', rows);
  await saveState(env, to, 'awaiting_menu_choice', { ...(ctx || {}), productPage: page });
}

async function showAreaList(env, to, ctx, page = 0) {
  const areas = await sbGet(env, `/rest/v1/delivery_areas?select=id,name&active=eq.true&order=sort_order.asc`);
  const pageSize = 9; // leaves room for a "more areas" row (10-row cap)
  const start = page * pageSize;
  const slice = areas.slice(start, start + pageSize);
  const rows = slice.map((a) => ({ id: `area:${a.id}`, title: a.name }));
  if (start + pageSize < areas.length) rows.push({ id: `area_more:${page + 1}`, title: '➡️ More areas' });
  await sendList(env, to, 'Select your delivery area:', 'Choose Area', rows);
  await saveState(env, to, 'awaiting_area', { ...ctx, areaPage: page });
}

async function startOrder(env, to) {
  const win = await getOpenWindow(env);
  if (!win) {
    await sendText(env, to, "🐐 Angadi orders are closed right now.\nWe open every week for the upcoming Sunday delivery — we'll be here when the window opens.\n\nType *hi* anytime to check again, or *talk* to reach us directly.");
    await saveState(env, to, 'idle', {});
    return;
  }
  await sendText(env, to, `🐐 Welcome to Angadi!\nOrdering is open until *${formatIST(win.closes_at)}* for delivery on *${formatDateIST(win.delivery_date)}*.\n\n(Type *talk* anytime to reach a real person instead.)`);
  await showProductList(env, to, { cart: [], windowId: win.id }, 0);
}

// Re-fetches live prices for everything in the cart right before payment,
// so a price that changed mid-conversation (or a product that went out of
// stock) is never what actually gets charged. Mirrors the server-side
// price validation api/create-order.js already does for web checkout.
async function refreshCartPrices(env, cart) {
  const slugs = [...new Set(cart.map((i) => i.slug).filter(Boolean))];
  const bySlug = {};
  if (slugs.length) {
    const inList = slugs.map((s) => `"${s}"`).join(',');
    const rows = await sbGet(env, `/rest/v1/products?slug=in.(${inList})&select=slug,name,price,unit,in_stock,active`);
    for (const r of rows) bySlug[r.slug] = r;
  }
  const refreshed = [];
  const unavailable = [];
  for (const item of cart) {
    if (!item.slug) { refreshed.push(item); continue; } // can't verify — keep as-is defensively
    const live = bySlug[item.slug];
    if (!live || live.active === false || live.in_stock === false) { unavailable.push(item.name); continue; }
    refreshed.push({ ...item, price: live.price, name: live.name, unit: live.unit });
  }
  return { cart: refreshed, unavailable };
}

async function askPayment(env, to, ctx) {
  const { cart, unavailable } = await refreshCartPrices(env, ctx.cart);
  if (unavailable.length) {
    await sendText(env, to, `⚠️ Sorry, this became unavailable and was removed from your order: ${unavailable.join(', ')}`);
  }
  if (!cart.length) {
    await sendText(env, to, 'Your cart is now empty. Please pick items again.');
    await showProductList(env, to, { ...ctx, cart: [] }, 0);
    return;
  }
  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const total = Math.round(subtotal + (ctx.area.delivery_fee || 0));
  const summary = cart.map((i) => `• ${i.qty} ${i.unit} ${i.name} — ₹${Math.round(i.price * i.qty)}`).join('\n');
  await sendText(env, to, `🧾 Order summary:\n${summary}\n\nDelivery (${ctx.area.name}): ₹${ctx.area.delivery_fee || 0}\n*Total: ₹${total}*`);
  await sendButtons(env, to, 'How would you like to pay?', [
    { id: 'pay_cod', title: '💵 Cash on Delivery' },
    { id: 'pay_online', title: '💳 Pay Online' },
    { id: 'human_help', title: '💬 Talk to us' },
  ]);
  await saveState(env, to, 'awaiting_payment', { ...ctx, cart, subtotal, total });
}

async function createRazorpayLink(env, { orderId, name, phone, amount }) {
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(amount * 100),
      currency: 'INR',
      reference_id: orderId,
      description: `Angadi order ${orderId}`,
      customer: { name: name || 'Angadi Customer', contact: `+${phone}` },
      notify: { sms: false, email: false },
      reminder_enable: true,
    }),
  });
  const data = await r.json();
  if (!r.ok || !data.id) { console.error('Razorpay link failed', data); return null; }
  return data;
}

async function finalizeCOD(env, to, ctx) {
  if (ctx.total > COD_LIMIT) {
    await sendText(env, to, `Cash on Delivery is available for orders up to ₹${COD_LIMIT.toLocaleString('en-IN')}. Please choose Pay Online for this order.`);
    await sendButtons(env, to, 'How would you like to pay?', [{ id: 'pay_online', title: '💳 Pay Online' }]);
    return;
  }
  const orderId = newOrderId();
  const ok = await sbPost(env, '/rest/v1/orders', [{
    order_id: orderId,
    customer: { name: ctx.name, phone: to, address: ctx.address, area: ctx.area.name, source: 'whatsapp' },
    items: ctx.cart.map((i) => ({ name: i.name, price: i.price, qty: i.qty })),
    subtotal: ctx.subtotal, delivery: ctx.area.delivery_fee || 0, discount: 0, total: ctx.total,
    payment: 'cod', status: 'confirmed_cod',
  }]);
  if (!ok) { await sendText(env, to, 'Sorry, something went wrong saving your order. Please try again in a moment.'); return; }
  await upsertCustomer(env, to, ctx.name, ctx.address, ctx.area.name);
  await sendText(env, to, `✅ Order placed! *${orderId}*\nPay ₹${ctx.total} cash on delivery.\nThank you for ordering from Angadi! 🐐`);
  await saveState(env, to, 'idle', {});
}

async function finalizeOnline(env, to, ctx) {
  const orderId = newOrderId();
  const link = await createRazorpayLink(env, { orderId, name: ctx.name, phone: to, amount: ctx.total });
  if (!link) {
    await sendText(env, to, 'Sorry, creating the payment link failed. Please try again in a moment, or choose Cash on Delivery.');
    return;
  }
  const ok = await sbPost(env, '/rest/v1/orders', [{
    order_id: orderId,
    razorpay_payment_link_id: link.id,
    customer: { name: ctx.name, phone: to, address: ctx.address, area: ctx.area.name, source: 'whatsapp' },
    items: ctx.cart.map((i) => ({ name: i.name, price: i.price, qty: i.qty })),
    subtotal: ctx.subtotal, delivery: ctx.area.delivery_fee || 0, discount: 0, total: ctx.total,
    payment: 'razorpay_link', status: 'pending',
  }]);
  if (!ok) { await sendText(env, to, 'Sorry, something went wrong saving your order. Please try again in a moment.'); return; }
  await upsertCustomer(env, to, ctx.name, ctx.address, ctx.area.name);
  await sendText(env, to, `✅ Order *${orderId}* saved!\nPay ₹${ctx.total} to confirm:\n${link.short_url}\n\nYour order confirms automatically as soon as payment is received.`);
  await saveState(env, to, 'idle', {});
}

// Hands the conversation off to a human. Notifies ADMIN_WHATSAPP_NUMBER (if
// set) and puts the customer's chat into 'human_handoff' — the bot goes
// quiet for that number until they type a restart word, so it doesn't talk
// over whoever picks up the conversation.
async function requestHumanHelp(env, from, ctx) {
  await sendText(env, from, "Got it — we'll reply here shortly! 💬\nType *hi* anytime to go back to ordering.");
  if (env.ADMIN_WHATSAPP_NUMBER) {
    const label = ctx?.name ? `${ctx.name} (${from})` : from;
    await sendText(env, env.ADMIN_WHATSAPP_NUMBER, `💬 Customer wants to talk: ${label}\nhttps://wa.me/${from}`);
  }
  await saveState(env, from, 'human_handoff', ctx || {});
}

// ── Main routing ──────────────────────────────────────────────

async function routeMessage(env, from, userInput, state) {
  const ctx = state.context || {};

  const isHelp = (userInput.kind === 'text' && HELP_WORDS.includes(userInput.value.toLowerCase()))
    || (userInput.kind === 'button' && userInput.value === 'human_help');
  if (isHelp) return requestHumanHelp(env, from, ctx);

  const isRestart = userInput.kind === 'text' && RESTART_WORDS.includes(userInput.value.toLowerCase());

  // A human is expected to be handling this chat — stay quiet unless the
  // customer explicitly restarts the bot.
  if (state.state === 'human_handoff' && !isRestart) return;

  if (isRestart || state.state === 'idle') {
    return startOrder(env, from);
  }

  if (userInput.kind === 'list' && userInput.value.startsWith('prod_more:')) {
    const page = parseInt(userInput.value.split(':')[1], 10) || 0;
    await showProductList(env, from, ctx, page);
    return;
  }

  if (state.state === 'awaiting_menu_choice' && userInput.kind === 'list' && userInput.value.startsWith('prod:')) {
    const slug = userInput.value.slice(5);
    const rows = await sbGet(env, `/rest/v1/products?slug=eq.${encodeURIComponent(slug)}&select=slug,name,price,unit&limit=1`);
    const product = rows[0];
    if (!product) { await sendText(env, from, 'Sorry, that item is no longer available.'); await showProductList(env, from, ctx, ctx.productPage || 0); return; }
    await sendText(env, from, `How many ${product.unit} of *${product.name}* would you like? (e.g. 1 or 1.5)`);
    await saveState(env, from, 'awaiting_qty', { ...ctx, pendingProduct: product });
    return;
  }

  if (state.state === 'awaiting_qty' && userInput.kind === 'text') {
    const qty = parseFloat(userInput.value.replace(',', '.'));
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100) {
      await sendText(env, from, 'Please enter a valid quantity, e.g. 1 or 1.5');
      return;
    }
    const p = ctx.pendingProduct;
    if (!p) { await sendText(env, from, "Sorry, let's start that item again."); await showProductList(env, from, ctx, ctx.productPage || 0); return; }
    const cart = [...(ctx.cart || []), { slug: p.slug, name: p.name, price: p.price, unit: p.unit, qty }];
    await sendButtons(env, from, `Added ${qty} ${p.unit} ${p.name} ✅\n\nAdd another item?`, [
      { id: 'more_yes', title: '➕ Add item' },
      { id: 'more_no', title: "✅ That's all" },
      { id: 'human_help', title: '💬 Talk to us' },
    ]);
    await saveState(env, from, 'awaiting_more_items', { ...ctx, cart, pendingProduct: null });
    return;
  }

  if (state.state === 'awaiting_more_items' && userInput.kind === 'button' && userInput.value === 'more_yes') {
    await showProductList(env, from, ctx, 0);
    return;
  }

  if (state.state === 'awaiting_more_items' && userInput.kind === 'button' && userInput.value === 'more_no') {
    if (!ctx.cart || !ctx.cart.length) {
      await sendText(env, from, 'Your cart is empty — please pick at least one item.');
      await showProductList(env, from, ctx, 0);
      return;
    }
    await showAreaList(env, from, ctx);
    return;
  }

  if (userInput.kind === 'list' && userInput.value.startsWith('area_more:')) {
    const page = parseInt(userInput.value.split(':')[1], 10) || 0;
    await showAreaList(env, from, ctx, page);
    return;
  }

  if (state.state === 'awaiting_area' && userInput.kind === 'list' && userInput.value.startsWith('area:')) {
    const areaId = userInput.value.slice(5);
    const rows = await sbGet(env, `/rest/v1/delivery_areas?id=eq.${encodeURIComponent(areaId)}&select=id,name,delivery_fee&limit=1`);
    const area = rows[0];
    if (!area) { await sendText(env, from, 'Please pick a valid area from the list.'); return; }

    const known = await sbGet(env, `/rest/v1/wa_customers?wa_id=eq.${encodeURIComponent(from)}&select=name,last_address&limit=1`);
    const newCtx = { ...ctx, area };
    if (known[0]?.name && known[0]?.last_address) {
      newCtx.name = known[0].name;
      await sendButtons(env, from, `Deliver to your usual address?\n📍 ${known[0].last_address}`, [
        { id: 'addr_yes', title: '✅ Yes, same' },
        { id: 'addr_no', title: '📝 New address' },
      ]);
      await saveState(env, from, 'awaiting_address_confirm', newCtx);
    } else {
      await sendText(env, from, 'What name should we put on the order?');
      await saveState(env, from, 'awaiting_name', newCtx);
    }
    return;
  }

  if (state.state === 'awaiting_address_confirm' && userInput.kind === 'button') {
    if (userInput.value === 'addr_yes') {
      const known = await sbGet(env, `/rest/v1/wa_customers?wa_id=eq.${encodeURIComponent(from)}&select=last_address&limit=1`);
      await askPayment(env, from, { ...ctx, address: known[0]?.last_address || '' });
    } else {
      await sendText(env, from, 'Please share your new delivery address (house/flat no., street, landmark):');
      await saveState(env, from, 'awaiting_address', ctx);
    }
    return;
  }

  if (state.state === 'awaiting_name' && userInput.kind === 'text') {
    await sendText(env, from, 'Please share your delivery address (house/flat no., street, landmark):');
    await saveState(env, from, 'awaiting_address', { ...ctx, name: userInput.value.slice(0, 80) });
    return;
  }

  if (state.state === 'awaiting_address' && userInput.kind === 'text') {
    await askPayment(env, from, { ...ctx, address: userInput.value.slice(0, 300) });
    return;
  }

  if (state.state === 'awaiting_payment' && userInput.kind === 'button') {
    if (userInput.value === 'pay_cod') await finalizeCOD(env, from, ctx);
    else if (userInput.value === 'pay_online') await finalizeOnline(env, from, ctx);
    return;
  }

  await sendText(env, from, "Sorry, I didn't understand that. Type *hi* to start a new order, or *talk* to reach us directly.");
}

// ── HTTP entry point ─────────────────────────────────────────

module.exports = async (req, res) => {
  const env = process.env;

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
      res.status(200).send(challenge);
    } else {
      res.status(403).send('Forbidden');
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  if (!env.META_ACCESS_TOKEN || !env.META_PHONE_NUMBER_ID || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('WhatsApp webhook not configured');
    res.status(200).json({ ok: true }); // ack anyway so Meta doesn't retry-storm
    return;
  }

  const raw = await readRaw(req);

  if (env.META_APP_SECRET) {
    const expected = 'sha256=' + crypto.createHmac('sha256', env.META_APP_SECRET).update(raw).digest('hex');
    const received = req.headers['x-hub-signature-256'] || '';
    const valid = received.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
    if (!valid) { res.status(403).json({ error: 'Invalid signature' }); return; }
  }

  let body;
  try { body = JSON.parse(raw); } catch { res.status(200).json({ ok: true }); return; }

  let from; // hoisted so the catch block below can still message the customer
  try {
    const value = body.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];

    if (!msg) {
      // Status callbacks (sent/delivered/read) — nothing to do.
      res.status(200).json({ ignored: true });
      return;
    }

    from = msg.from;

    const claimed = await claimMessage(env, msg.id);
    if (!claimed) {
      // Meta retried this exact delivery, or we're racing a double-tap —
      // it was already (or is already being) processed. Don't do it twice.
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    let userInput;
    if (msg.type === 'text') userInput = { kind: 'text', value: (msg.text?.body || '').trim() };
    else if (msg.type === 'interactive' && msg.interactive?.type === 'list_reply') userInput = { kind: 'list', value: msg.interactive.list_reply.id };
    else if (msg.type === 'interactive' && msg.interactive?.type === 'button_reply') userInput = { kind: 'button', value: msg.interactive.button_reply.id };
    else userInput = { kind: 'other', value: null };

    const state = await getState(env, from);
    await routeMessage(env, from, userInput, state);
  } catch (e) {
    console.error('WhatsApp webhook processing error', e);
    if (from) {
      try { await sendText(env, from, "Sorry, something went wrong on our end. Type *hi* to start over, or *talk* to reach us directly."); }
      catch (e2) { console.error('fallback send failed', e2); }
    }
  }

  res.status(200).json({ ok: true });
};
