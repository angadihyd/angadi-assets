// ═══════════════════════════════════════════════════════════════
//  POST /api/admin
//  Single guarded backend for the admin panel and the delivery
//  partner app. All database access happens here with the Supabase
//  SERVICE ROLE key — the browser never gets write access.
//
//  Auth model:
//    • Admin: header  x-admin-token  must equal env ADMIN_TOKEN.
//      Obtained via {action:'login', password} (password === token).
//    • Partner: header x-partner-token is a stateless signed token
//      issued by {action:'partner-login', username, password}.
//      Credentials live in env PARTNER_CREDS (JSON):
//        {"raju":{"password":"…","code":"db1","name":"Raju Kumar"}}
//
//  Admin actions:
//    login {password}
//    db {table, op, values?, match?, order?, limit?, select?, conflict?}
//       tables: orders | delivery_boys | products | coupons |
//               site_settings | reviews
//       ops:    select | insert | update | upsert | delete
//
//  Partner actions:
//    partner-login {username, password}
//    partner-orders {}                          → relevant orders
//    partner-accept {orderId}                   → race-safe claim
//    partner-advance {orderId, status}          → picked_up | out_for_delivery | delivered
//
//  Required env vars: ADMIN_TOKEN, SUPABASE_URL,
//                     SUPABASE_SERVICE_ROLE_KEY, PARTNER_CREDS (optional)
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const TABLES = ['orders', 'delivery_boys', 'products', 'coupons', 'site_settings', 'reviews'];
const OPS = ['select', 'insert', 'update', 'upsert', 'delete'];
const CONFLICT_KEYS = { products: 'slug', site_settings: 'key', coupons: 'code' };
const PARTNER_STATUSES = ['picked_up', 'out_for_delivery', 'delivered'];

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function timingEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function partnerSig(username, secret) {
  return crypto.createHmac('sha256', 'partner:' + secret).update(username).digest('hex').slice(0, 32);
}
function makePartnerToken(username, secret) {
  return 'pt.' + username + '.' + partnerSig(username, secret);
}
function verifyPartnerToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'pt') return null;
  const [, username, sig] = parts;
  if (!timingEq(sig, partnerSig(username, secret))) return null;
  return username;
}

function getPartners() {
  try { return JSON.parse(process.env.PARTNER_CREDS || '{}'); }
  catch { return {}; }
}

// ── Minimal PostgREST helper (service role) ──
function rest(env, path, opts = {}) {
  return fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

function matchToQuery(match) {
  const params = [];
  for (const [col, val] of Object.entries(match || {})) {
    if (!/^[a-zA-Z0-9_]+$/.test(col)) throw new Error('Bad column: ' + col);
    if (val === null) params.push(`${col}=is.null`);
    else params.push(`${col}=eq.${encodeURIComponent(String(val))}`);
  }
  return params;
}

async function dbAction(env, { table, op, values, match, order, limit, select, conflict }) {
  if (!TABLES.includes(table)) return { status: 400, body: { error: 'Table not allowed' } };
  if (!OPS.includes(op)) return { status: 400, body: { error: 'Op not allowed' } };

  const params = matchToQuery(match);
  if (select && /^[a-zA-Z0-9_,>:()\-\s*]+$/.test(select)) params.push('select=' + encodeURIComponent(select));
  else if (op === 'select' || op === 'update' || op === 'upsert' || op === 'insert') params.push('select=*');
  if (order && /^[a-zA-Z0-9_.]+$/.test(order)) params.push('order=' + order);
  if (limit && Number.isInteger(limit) && limit > 0 && limit <= 1000) params.push('limit=' + limit);

  let method = 'GET', headers = {}, body;
  if (op === 'insert') { method = 'POST'; body = JSON.stringify(values); headers.Prefer = 'return=representation'; }
  if (op === 'upsert') {
    method = 'POST'; body = JSON.stringify(values);
    const key = conflict || CONFLICT_KEYS[table];
    if (key) params.push('on_conflict=' + key);
    headers.Prefer = 'resolution=merge-duplicates,return=representation';
  }
  if (op === 'update') {
    if (!params.length) return { status: 400, body: { error: 'update requires match' } };
    method = 'PATCH'; body = JSON.stringify(values); headers.Prefer = 'return=representation';
  }
  if (op === 'delete') {
    if (!matchToQuery(match).length) return { status: 400, body: { error: 'delete requires match' } };
    method = 'DELETE'; headers.Prefer = 'return=representation';
  }

  const r = await rest(env, table + (params.length ? '?' + params.join('&') : ''), { method, headers, body });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) return { status: 500, body: { error: 'db ' + r.status, detail: data } };
  return { status: 200, body: { data } };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const env = {
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  if (!env.ADMIN_TOKEN || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Admin API not configured. Set ADMIN_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in Vercel.' });
    return;
  }

  let payload;
  try { payload = await readJson(req); }
  catch { res.status(400).json({ error: 'Invalid JSON' }); return; }
  const action = payload.action;

  try {
    // ── PUBLIC: logins ──
    if (action === 'login') {
      if (timingEq(payload.password || '', env.ADMIN_TOKEN)) {
        res.status(200).json({ ok: true, token: env.ADMIN_TOKEN });
      } else {
        res.status(401).json({ error: 'Wrong password' });
      }
      return;
    }

    if (action === 'partner-login') {
      const partners = getPartners();
      const u = String(payload.username || '').trim().toLowerCase();
      const p = partners[u];
      if (p && timingEq(payload.password || '', p.password)) {
        res.status(200).json({ ok: true, token: makePartnerToken(u, env.ADMIN_TOKEN), code: p.code, name: p.name });
      } else {
        res.status(401).json({ error: 'Invalid username or password' });
      }
      return;
    }

    // ── PARTNER-GATED ──
    const partnerUser = verifyPartnerToken(req.headers['x-partner-token'], env.ADMIN_TOKEN);
    if (action && action.startsWith('partner-')) {
      if (!partnerUser) { res.status(401).json({ error: 'Partner login required' }); return; }
      const partners = getPartners();
      const me = partners[partnerUser] || { code: partnerUser, name: partnerUser };

      if (action === 'partner-orders') {
        const r = await rest(env,
          `orders?or=(status.eq.ready,and(assigned_to.eq.${encodeURIComponent(me.code)},status.in.(assigned,picked_up,out_for_delivery,delivered)))` +
          `&order=placed_at.desc&limit=100`);
        const data = r.ok ? await r.json() : [];
        res.status(200).json({ data });
        return;
      }

      if (action === 'partner-accept') {
        const orderId = String(payload.orderId || '');
        const now = new Date().toISOString();
        const r = await rest(env,
          `orders?order_id=eq.${encodeURIComponent(orderId)}&status=eq.ready&assigned_to=is.null`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ assigned_to: me.code, accepted_by: me.name, status: 'assigned', accepted_at: now }),
          });
        const rows = r.ok ? await r.json() : [];
        if (!rows.length) { res.status(200).json({ taken: true }); return; }
        await rest(env, `delivery_boys?code=eq.${encodeURIComponent(me.code)}`,
          { method: 'PATCH', body: JSON.stringify({ status: 'busy' }) }).catch(() => {});
        res.status(200).json({ ok: true, order: rows[0] });
        return;
      }

      if (action === 'partner-advance') {
        const orderId = String(payload.orderId || '');
        const status = String(payload.status || '');
        if (!PARTNER_STATUSES.includes(status)) { res.status(400).json({ error: 'Status not allowed' }); return; }
        const now = new Date().toISOString();
        const patch = { status };
        if (status === 'picked_up') patch.picked_up_at = now;
        if (status === 'delivered') patch.delivered_at = now;
        // only their own order
        const r = await rest(env,
          `orders?order_id=eq.${encodeURIComponent(orderId)}&assigned_to=eq.${encodeURIComponent(me.code)}`,
          { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
        const rows = r.ok ? await r.json() : [];
        if (!rows.length) { res.status(403).json({ error: 'Not your order' }); return; }
        // keep partner availability in sync
        const boyPatch = status === 'delivered'
          ? { status: 'available', active_order_id: null }
          : (status === 'out_for_delivery' ? { status: 'busy', active_order_id: orderId } : null);
        if (boyPatch) {
          await rest(env, `delivery_boys?code=eq.${encodeURIComponent(me.code)}`,
            { method: 'PATCH', body: JSON.stringify(boyPatch) }).catch(() => {});
        }
        res.status(200).json({ ok: true, order: rows[0] });
        return;
      }

      if (action === 'partner-status') {
        const status = String(payload.status || '');
        if (!['available', 'busy', 'offline'].includes(status)) { res.status(400).json({ error: 'Bad status' }); return; }
        await rest(env, `delivery_boys?code=eq.${encodeURIComponent(me.code)}`,
          { method: 'PATCH', body: JSON.stringify({ status }) }).catch(() => {});
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: 'Unknown partner action' });
      return;
    }

    // ── ADMIN-GATED ──
    if (!timingEq(req.headers['x-admin-token'] || '', env.ADMIN_TOKEN)) {
      res.status(401).json({ error: 'Admin login required' });
      return;
    }

    if (action === 'db') {
      const out = await dbAction(env, payload);
      res.status(out.status).json(out.body);
      return;
    }

    if (action === 'storage-upload') {
      const name = String(payload.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
      const type = String(payload.type || 'image/jpeg');
      if (!name || !type.startsWith('image/')) { res.status(400).json({ error: 'Bad file' }); return; }
      let buf;
      try { buf = Buffer.from(String(payload.base64 || ''), 'base64'); }
      catch { res.status(400).json({ error: 'Bad file data' }); return; }
      if (!buf.length || buf.length > 4.2 * 1024 * 1024) { res.status(400).json({ error: 'Image must be under 4MB' }); return; }
      const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/product-images/${name}`, {
        method: 'POST',
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': type,
          'x-upsert': 'true',
        },
        body: buf,
      });
      if (!r.ok) { const t = await r.text(); res.status(500).json({ error: 'Upload failed: ' + t.slice(0, 200) }); return; }
      res.status(200).json({ ok: true, publicUrl: `${env.SUPABASE_URL}/storage/v1/object/public/product-images/${name}` });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('admin api error', e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
