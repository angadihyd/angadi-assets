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
//      issued by {action:'partner-login', username, password}. Credentials
//      live in the delivery_boys table itself (username + salted password
//      hash) — set/changed by the admin via {action:'set-partner-login'}.
//
//  Admin actions:
//    login {password}
//    db {table, op, values?, match?, order?, limit?, select?, conflict?}
//       tables: orders | delivery_boys | products | coupons |
//               site_settings | reviews
//       ops:    select | insert | update | upsert | delete
//    notify-customers {title?, body?, url?} → Web Push broadcast to every
//       browser that opted into customer alerts (push_subscriptions role=customer)
//    schedule-notification {title, body, url?, sendAt} → queues a push for
//       later (scheduled_notifications table). Actually sent by GET
//       /api/admin?cron=dispatch-notify, meant to be pinged every few minutes
//       by an external cron (e.g. cron-job.org) with header x-notify-token
//       matching env NOTIFY_DISPATCH_TOKEN — Vercel's own Hobby-plan cron
//       only runs once a day, too coarse for a chosen send time.
//    set-partner-login {id, username, password?} → sets a delivery
//       partner's login for the /admin/delivery-login.html app. `id` is the
//       delivery_boys row id; password is optional on an edit (blank keeps
//       the existing one). Also sets `code` = username, the identifier used
//       to route orders (assigned_to) to that partner.
//
//  Partner actions:
//    partner-login {username, password}
//    partner-orders {}                          → relevant orders
//    partner-accept {orderId}                   → race-safe claim
//    partner-advance {orderId, status}          → picked_up | out_for_delivery | delivered
//
//  Required env vars: ADMIN_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//                     VAPID_PUBLIC, VAPID_PRIVATE (for notify-customers)
//                     NOTIFY_DISPATCH_TOKEN (for the external cron, optional)
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const webpush = require('web-push');
const { syncFromSheet } = require('./_lib/sheet-orders');
const { getInstagramDigest } = require('./_lib/instagram');

// Salted scrypt hash, stored in delivery_boys.password as "salt:hash" (hex).
// Never store or return the plaintext password once this runs.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return salt + ':' + hash;
}
function verifyPasswordHash(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const check = crypto.scryptSync(password || '', salt, 32);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), check);
  } catch { return false; }
}

// Public key is safe to ship; private key is a Vercel secret. Kept in sync
// with the key baked into push-register.js and used by api/notify.js.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BPiQcgEVyRxp96djwa3O-eX7XSOvp5lN4PTpP9V1QN2EKBZ9kOINNdK-bppKo4qGOgYrzO3HPaasuBdWjMTVTuQ';

const TABLES = ['orders', 'delivery_boys', 'products', 'coupons', 'site_settings', 'reviews', 'delivery_areas', 'order_windows', 'api_usage', 'health_alerts', 'site_visits', 'login_events', 'scheduled_notifications', 'checkout_leads'];
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

// ── Daily site-health check, called by Vercel Cron (see vercel.json) ──
// Lives here rather than its own file because Vercel's Hobby plan caps a
// deployment at 12 serverless functions — this project was already at 13
// with a standalone cron-health-check.js, which failed the entire deploy
// with exceeded_serverless_functions_per_deployment. Folding it into an
// existing function is the fix, not trimming another endpoint.
//
// A scheduled Claude cloud agent was tried first and could not reach
// www.angadi.farm at all — Anthropic's cloud sandbox blocks outbound
// access to arbitrary domains by default (confirmed by an actual run).
// These checks are fixed thresholds, not judgment calls, so plain code
// here is the better fit regardless.
const HEALTH_SITE = 'https://www.angadi.farm';
const HEALTH_CHECK_URLS = [
  HEALTH_SITE + '/',
  HEALTH_SITE + '/shop.html',
  HEALTH_SITE + '/checkout.html',
  HEALTH_SITE + '/my-orders.html',
  HEALTH_SITE + '/admin/orders.html', // a login gate here is the healthy response
  HEALTH_SITE + '/api/geocode?q=Hyderabad',
];

async function runHealthUptimeChecks() {
  const findings = [];
  for (const url of HEALTH_CHECK_URLS) {
    const started = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const ms = Date.now() - started;
      const body = await r.text();
      if (!r.ok || body.length < 20) {
        findings.push({ severity: 'critical', title: `${url} is not responding correctly`, description: `Got HTTP ${r.status} with a ${body.length}-byte body. Customers hitting this page right now may see a broken page.` });
      } else if (ms > 5000) {
        findings.push({ severity: 'warning', title: `${url} responded slowly`, description: `Took ${ms}ms to respond (over the 5s threshold). Not broken, but worth watching if it keeps happening.` });
      }
    } catch (e) {
      findings.push({ severity: 'critical', title: `${url} is unreachable`, description: `Request failed: ${String(e.message || e)}. This page may be completely down for customers right now.` });
    }
  }
  return findings;
}

async function runHealthOrderChecks(env) {
  const findings = [];
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const [stuckRes, dayRes, mapsRes, usageRes] = await Promise.all([
    rest(env, `orders?select=order_id,customer,total,placed_at&status=eq.pending&payment=eq.razorpay&payment_id=is.null&placed_at=lt.${twoHoursAgo}&order=placed_at.asc&limit=20`),
    rest(env, `orders?select=status&placed_at=gte.${dayAgo}`),
    rest(env, `site_settings?key=eq.maps&select=value`),
    rest(env, `api_usage?service=eq.google_places&month=eq.${new Date().toISOString().slice(0, 7)}&select=count`),
  ]);
  const stuck = stuckRes.ok ? await stuckRes.json() : [];
  const dayOrders = dayRes.ok ? await dayRes.json() : [];
  const mapsCfgRows = mapsRes.ok ? await mapsRes.json() : [];
  const usageRows = usageRes.ok ? await usageRes.json() : [];

  if (stuck.length > 0) {
    const oldestHours = Math.max(...stuck.map((o) => (Date.now() - new Date(o.placed_at).getTime()) / 3600000));
    const list = stuck.map((o) => `${o.order_id} (${(o.customer && o.customer.name) || 'no name'}, ₹${o.total}, ${Math.round((Date.now() - new Date(o.placed_at).getTime()) / 3600000 * 10) / 10}h old)`).join('; ');
    findings.push({
      severity: stuck.length >= 5 || oldestHours >= 24 ? 'critical' : 'warning',
      title: `${stuck.length} checkout${stuck.length > 1 ? 's' : ''} started but never paid`,
      description: `These customers began an online payment that never completed, 2+ hours ago: ${list}. WhatsApp them from the Customers page to offer Pay on Delivery, or check the Abandoned tab in Orders.`,
    });
  }

  const total24h = dayOrders.length;
  const cancelled24h = dayOrders.filter((o) => o.status === 'cancelled').length;
  const rate = total24h ? (cancelled24h / total24h) * 100 : 0;
  if (total24h >= 5 && rate > 40) {
    findings.push({
      severity: 'warning',
      title: `High cancellation rate in the last 24 hours`,
      description: `${cancelled24h} of ${total24h} orders (${Math.round(rate)}%) were cancelled. Worth checking whether this is payment failures, a checkout problem, or something else.`,
    });
  }

  const cap = (mapsCfgRows[0] && mapsCfgRows[0].value && mapsCfgRows[0].value.monthly_cap) || 5000;
  const used = (usageRows[0] && usageRows[0].count) || 0;
  const pct = cap ? (used / cap) * 100 : 0;
  if (pct >= 90) {
    findings.push({
      severity: 'warning',
      title: `Google Places search nearing its monthly limit`,
      description: `${used} of ${cap} searches used this month (${Math.round(pct)}%). The site automatically switches back to the free map once the limit is hit, so this won't cause any charge — just a heads-up.`,
    });
  }

  return findings;
}

async function saveHealthAlert(env, f) {
  const r = await rest(env, 'health_alerts', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ severity: f.severity, title: f.title, description: f.description, source: 'daily-health-check' }]),
  });
  if (!r.ok) { console.error('health-check: could not save alert', await r.text()); return; }

  const { META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, ADMIN_WHATSAPP_NUMBER } = process.env;
  if (META_ACCESS_TOKEN && META_PHONE_NUMBER_ID && ADMIN_WHATSAPP_NUMBER && f.severity !== 'info') {
    try {
      const icon = f.severity === 'critical' ? '🔴' : '🟡';
      const text = `${icon} Angadi site health — ${f.severity.toUpperCase()}\n\n${f.title}\n\n${f.description}\n\nSee Admin → Dashboard for details.`;
      await fetch(`https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: ADMIN_WHATSAPP_NUMBER, type: 'text', text: { body: text.slice(0, 4096) } }),
      });
    } catch (e) { /* the admin panel alert still stands either way */ }
  }
}

// ── Google Sheet → Orders sync (site_settings key 'orders_sheet' = {url, last_sync, last_result}) ──
async function getSheetSetting(env) {
  const r = await rest(env, 'site_settings?key=eq.orders_sheet&select=value');
  const rows = r.ok ? await r.json() : [];
  return (rows[0] && rows[0].value) || {};
}
async function saveSheetSetting(env, value) {
  await rest(env, 'site_settings?on_conflict=key', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: 'orders_sheet', value }),
  });
}
async function runSheetSync(env, urlOverride) {
  const cfg = await getSheetSetting(env);
  const url = urlOverride || cfg.url;
  if (!url) throw new Error('No Google Sheet link saved yet.');
  let result;
  try { result = await syncFromSheet(env, rest, url); }
  catch (e) { result = { ok: false, error: String(e.message || e) }; }
  await saveSheetSetting(env, { url, last_sync: new Date().toISOString(), last_result: result });
  return { url, result };
}

module.exports = async (req, res) => {
  // ── Vercel Cron hits this with GET ?cron=health-check, never POST ──
  const cronParam = req.method === 'GET' ? new URL(req.url, 'http://x').searchParams.get('cron') : null;
  if (cronParam === 'health-check') {
    const SUPABASE_URL = process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const CRON_SECRET = process.env.CRON_SECRET, HEALTH_AGENT_TOKEN = process.env.HEALTH_AGENT_TOKEN;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { res.status(500).json({ error: 'Not configured' }); return; }
    const authHeader = req.headers.authorization || '';
    const isVercelCron = CRON_SECRET && timingEq(authHeader, `Bearer ${CRON_SECRET}`);
    const isManualTest = HEALTH_AGENT_TOKEN && timingEq(req.headers['x-health-token'] || '', HEALTH_AGENT_TOKEN);
    if (!isVercelCron && !isManualTest) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const henv = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
    try {
      const [uptimeFindings, orderFindings] = await Promise.all([runHealthUptimeChecks(), runHealthOrderChecks(henv)]);
      const findings = [...uptimeFindings, ...orderFindings];
      if (!findings.length) {
        await saveHealthAlert(henv, {
          severity: 'info',
          title: 'Daily health check: all clear',
          description: `${HEALTH_CHECK_URLS.length} pages checked, all responding normally. No stuck orders, no unusual cancellation rate, Places quota within range.`,
        });
      } else {
        for (const f of findings.slice(0, 8)) await saveHealthAlert(henv, f);
      }
      res.status(200).json({ ok: true, findingsCount: findings.length, checkedAt: new Date().toISOString() });
    } catch (e) {
      console.error('health-check cron failed', e);
      res.status(500).json({ error: String(e.message || e) });
    }
    return;
  }

  // ── Daily growth agent (Vercel Cron, GET ?cron=growth) ──
  // Reads yesterday's funnel (visitors → checkout started → orders), finds
  // the best traffic source, lists people who left at checkout, and writes
  // one "Growth digest" into health_alerts with a ready-to-post WhatsApp
  // status text. It only READS and DRAFTS — it never messages customers.
  if (cronParam === 'growth') {
    const SUPABASE_URL = process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const CRON_SECRET = process.env.CRON_SECRET, HEALTH_AGENT_TOKEN = process.env.HEALTH_AGENT_TOKEN;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { res.status(500).json({ error: 'Not configured' }); return; }
    const authHeader = req.headers.authorization || '';
    const okCron = CRON_SECRET && timingEq(authHeader, `Bearer ${CRON_SECRET}`);
    const okManual = HEALTH_AGENT_TOKEN && timingEq(req.headers['x-health-token'] || '', HEALTH_AGENT_TOKEN);
    if (!okCron && !okManual) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const genv = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const q = async (p) => { const r = await rest(genv, p); return r.ok ? r.json() : []; };
      const [visits, leads, orders, wins] = await Promise.all([
        q(`site_visits?select=visitor_id,source,path&created_at=gte.${encodeURIComponent(since)}&limit=5000`),
        q(`checkout_leads?select=name,phone,total,source,updated_at&updated_at=gte.${encodeURIComponent(since)}&limit=500`),
        q(`orders?select=total,status,customer&placed_at=gte.${encodeURIComponent(since)}&limit=500`),
        q(`order_windows?select=delivery_date,closes_at&is_active=eq.true&closes_at=gte.${encodeURIComponent(new Date().toISOString())}&order=closes_at.asc&limit=1`),
      ]);
      const uniq = new Set(visits.map((v) => v.visitor_id).filter(Boolean));
      const bySrc = {};
      visits.forEach((v) => { const s = v.source || 'direct/unknown'; (bySrc[s] = bySrc[s] || new Set()).add(v.visitor_id); });
      const srcLine = Object.entries(bySrc).sort((a, b) => b[1].size - a[1].size).slice(0, 5).map(([s, set]) => `${s}: ${set.size}`).join(', ') || 'none';
      const good = orders.filter((o) => o.status !== 'cancelled');
      const revenue = good.reduce((a, o) => a + (Number(o.total) || 0), 0);
      const buyerPhones = new Set(good.map((o) => String((o.customer || {}).phone || '').slice(-10)));
      const dropped = leads.filter((l) => l.phone && !buyerPhones.has(String(l.phone).slice(-10)));
      const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
      const win = wins[0];
      const dayName = win ? new Date(win.delivery_date).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' }) : null;
      const closes = win ? new Date(win.closes_at).toLocaleString('en-IN', { weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : null;
      const status = win
        ? `Fresh village mutton & country chicken, delivered ${dayName} in Hyderabad. Order by ${closes}: https://www.angadi.farm/?src=wa-status`
        : 'No order window is open. Open one in Admin → Order windows so the site can take orders.';
      // Instagram: account + post stats (read-only), and how much site
      // traffic it actually sent (?src=ig… links or instagram referrers).
      const igPrevRows = await q('site_settings?key=eq.ig_stats&select=value');
      const ig = await getInstagramDigest(process.env, igPrevRows[0] && igPrevRows[0].value);
      if (typeof ig.followers === 'number') {
        await rest(genv, 'site_settings?on_conflict=key', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ key: 'ig_stats', value: { followers: ig.followers, at: new Date().toISOString() } }),
        });
      }
      const isIg = (s) => /^ig|insta/i.test(String(s || ''));
      const igVisitors = new Set(visits.filter((v) => isIg(v.source)).map((v) => v.visitor_id)).size;
      const igLeads = leads.filter((l) => isIg(l.source)).length;
      const lines = [
        `Last 24h: ${uniq.size} visitors → ${leads.length} started checkout (${pct(leads.length, uniq.size)}) → ${good.length} orders (${pct(good.length, uniq.size)}), ₹${Math.round(revenue)}.`,
        `Visitors by source: ${srcLine}.`,
        dropped.length ? `Left at checkout, worth a personal WhatsApp: ${dropped.slice(0, 10).map((l) => `${l.name || 'customer'} ${l.phone}`).join('; ')}.` : 'Nobody left at checkout.',
        win ? '' : 'WARNING: no open order window, so every order is being rejected.',
        ...ig.lines,
        `Instagram → site (24h): ${igVisitors} visitors, ${igLeads} started checkout.`,
        `Ready to post as WhatsApp status / groups:\n${status}`,
      ].filter(Boolean);
      // Broadcast agent: when the open window closes within 24h, queue ONE
      // "last call" push to opted-in customers (sent by the dispatch-notify cron).
      let queued = false;
      if (win && new Date(win.closes_at).getTime() - Date.now() < 24 * 3600 * 1000) {
        const dupe = await q(`scheduled_notifications?select=id&title=eq.${encodeURIComponent('Last call for ' + dayName)}&send_at=gte.${encodeURIComponent(since)}&limit=1`);
        if (!dupe.length) {
          const pr = await rest(genv, 'scheduled_notifications', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ title: 'Last call for ' + dayName, body: `Fresh village mutton & chicken for ${dayName}. Orders close ${closes}.`, url: '/shop.html', send_at: new Date().toISOString() }),
          });
          queued = pr.ok;
        }
      }
      const r = await rest(genv, 'health_alerts', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{ severity: win ? 'info' : 'warning', title: 'Growth digest', description: lines.join('\n'), source: 'growth-agent' }]),
      });
      res.status(200).json({ ok: r.ok, visitors: uniq.size, leads: leads.length, orders: good.length, windowOpen: !!win, lastCallQueued: queued, instagram: !ig.error && typeof ig.followers === 'number' });
    } catch (e) {
      console.error('growth cron failed', e);
      res.status(500).json({ error: String(e.message || e) });
    }
    return;
  }

  // ── Daily Google Sheet sync (Vercel Cron, GET ?cron=sheet-sync) ──
  if (cronParam === 'sheet-sync') {
    const SUPABASE_URL = process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const CRON_SECRET = process.env.CRON_SECRET;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { res.status(500).json({ error: 'Not configured' }); return; }
    if (!(CRON_SECRET && timingEq(req.headers.authorization || '', `Bearer ${CRON_SECRET}`))) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      const out = await runSheetSync({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY });
      res.status(200).json(out.result);
    } catch (e) { res.status(200).json({ ok: false, error: String(e.message || e) }); }
    return;
  }

  // ── Notification dispatcher — called by an external cron (e.g. cron-job.org)
  // every few minutes, since Vercel's own Hobby-plan cron only runs once a day
  // and can't hit a scheduled send-time closely. Sends anything in
  // scheduled_notifications whose send_at has passed and hasn't gone out yet.
  if (cronParam === 'dispatch-notify') {
    const SUPABASE_URL = process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const CRON_SECRET = process.env.CRON_SECRET, NOTIFY_DISPATCH_TOKEN = process.env.NOTIFY_DISPATCH_TOKEN;
    const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { res.status(500).json({ error: 'Not configured' }); return; }
    const authHeader = req.headers.authorization || '';
    const isVercelCron = CRON_SECRET && timingEq(authHeader, `Bearer ${CRON_SECRET}`);
    const isExternalCron = NOTIFY_DISPATCH_TOKEN && timingEq(req.headers['x-notify-token'] || '', NOTIFY_DISPATCH_TOKEN);
    if (!isVercelCron && !isExternalCron) { res.status(401).json({ error: 'Unauthorized' }); return; }
    if (!VAPID_PRIVATE_KEY) { res.status(500).json({ error: 'VAPID_PRIVATE env not set on Vercel' }); return; }

    const nenv = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
    try {
      const now = new Date().toISOString();
      const dueR = await rest(nenv, `scheduled_notifications?sent_at=is.null&send_at=lte.${encodeURIComponent(now)}&order=send_at.asc&limit=20`);
      const due = dueR.ok ? await dueR.json() : [];
      if (!due.length) { res.status(200).json({ ok: true, dispatched: 0 }); return; }

      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:angadihyd@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE_KEY);
      const subR = await rest(nenv, 'push_subscriptions?select=*&role=eq.customer');
      const subs = subR.ok ? await subR.json() : [];

      let dispatched = 0;
      for (const n of due) {
        const data = JSON.stringify({ title: n.title, body: n.body, url: n.url || '/shop.html' });
        let sent = 0;
        await Promise.all((subs || []).map(s =>
          webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data)
            .then(() => { sent++; })
            .catch(async err => {
              if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                await rest(nenv, `push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE' }).catch(() => {});
              }
            })
        ));
        await rest(nenv, `scheduled_notifications?id=eq.${encodeURIComponent(n.id)}`,
          { method: 'PATCH', body: JSON.stringify({ sent_at: new Date().toISOString(), sent_count: sent }) }).catch(() => {});
        dispatched++;
      }
      res.status(200).json({ ok: true, dispatched });
    } catch (e) {
      console.error('dispatch-notify failed', e);
      res.status(500).json({ error: String(e.message || e) });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const env = {
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    HEALTH_AGENT_TOKEN: process.env.HEALTH_AGENT_TOKEN,
    VAPID_PRIVATE: process.env.VAPID_PRIVATE,
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
      const u = String(payload.username || '').trim().toLowerCase();
      const pr = await rest(env, `delivery_boys?username=eq.${encodeURIComponent(u)}&select=code,name,password`);
      const prows = pr.ok ? await pr.json() : [];
      const p = prows[0];
      if (p && verifyPasswordHash(payload.password || '', p.password)) {
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
      const mr = await rest(env, `delivery_boys?username=eq.${encodeURIComponent(partnerUser)}&select=code,name`);
      const mrows = mr.ok ? await mr.json() : [];
      const me = mrows[0] || { code: partnerUser, name: partnerUser };

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

    // ── HEALTH-AGENT-GATED ──
    // A separate credential from ADMIN_TOKEN, on purpose: the daily health
    // check only ever needs to read a diagnostic snapshot and file a report.
    // Scoping it to these two actions means that even if this token were ever
    // exposed, it could not touch orders, refunds, coupons, or anything else
    // — unlike ADMIN_TOKEN. It never receives the service-role key itself;
    // the queries run here, server-side, and only the computed numbers go out.
    if (action === 'health-check-data') {
      if (!env.HEALTH_AGENT_TOKEN || !timingEq(req.headers['x-health-token'] || '', env.HEALTH_AGENT_TOKEN)) {
        res.status(401).json({ error: 'Health agent token required' });
        return;
      }
      const nowIso = new Date().toISOString();
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

      const [stuckRes, dayRes, mapsRes, usageRes] = await Promise.all([
        // Razorpay checkout started, never actually paid, sitting 2h+ — a real
        // customer who tried to pay and got nothing, per the Abandoned tab logic.
        rest(env, `orders?select=order_id,customer,total,placed_at&status=eq.pending&payment=eq.razorpay&payment_id=is.null&placed_at=lt.${twoHoursAgo}&order=placed_at.asc&limit=20`),
        rest(env, `orders?select=status,payment,payment_id,total&placed_at=gte.${dayAgo}`),
        rest(env, `site_settings?key=eq.maps&select=value`),
        rest(env, `api_usage?service=eq.google_places&month=eq.${nowIso.slice(0, 7)}&select=count`),
      ]);
      const stuck = stuckRes.ok ? await stuckRes.json() : [];
      const dayOrders = dayRes.ok ? await dayRes.json() : [];
      const mapsCfgRows = mapsRes.ok ? await mapsRes.json() : [];
      const usageRows = usageRes.ok ? await usageRes.json() : [];

      const total24h = dayOrders.length;
      const cancelled24h = dayOrders.filter((o) => o.status === 'cancelled').length;
      const cap = (mapsCfgRows[0] && mapsCfgRows[0].value && mapsCfgRows[0].value.monthly_cap) || 5000;
      const used = (usageRows[0] && usageRows[0].count) || 0;

      res.status(200).json({
        checkedAt: nowIso,
        pendingStuckOrders: {
          count: stuck.length,
          orders: stuck.map((o) => ({
            orderId: o.order_id,
            name: (o.customer && o.customer.name) || null,
            total: o.total,
            hoursOld: Math.round((Date.now() - new Date(o.placed_at).getTime()) / 3600000 * 10) / 10,
          })),
        },
        last24h: {
          totalOrders: total24h,
          cancelled: cancelled24h,
          cancellationRatePct: total24h ? Math.round((cancelled24h / total24h) * 1000) / 10 : 0,
        },
        googlePlacesQuota: { used, cap, pct: cap ? Math.round((used / cap) * 1000) / 10 : 0 },
      });
      return;
    }

    if (action === 'health-report') {
      if (!env.HEALTH_AGENT_TOKEN || !timingEq(req.headers['x-health-token'] || '', env.HEALTH_AGENT_TOKEN)) {
        res.status(401).json({ error: 'Health agent token required' });
        return;
      }
      const severity = String(payload.severity || '');
      const title = String(payload.title || '').trim();
      const description = String(payload.description || '').trim();
      if (!['critical', 'warning', 'info'].includes(severity) || !title || !description) {
        res.status(400).json({ error: 'severity (critical|warning|info), title and description are required' });
        return;
      }
      const row = {
        severity, title, description,
        proposed_fix: payload.proposedFix ? String(payload.proposedFix) : null,
        source: payload.source ? String(payload.source).slice(0, 100) : 'daily-health-check',
      };
      const ins = await rest(env, 'health_alerts', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([row]),
      });
      if (!ins.ok) {
        const t = await ins.text();
        res.status(500).json({ error: 'Could not save alert: ' + t.slice(0, 200) });
        return;
      }
      const [saved] = await ins.json();

      // Best-effort WhatsApp — the site's WhatsApp bot isn't deployed yet, so
      // this quietly no-ops until META_ACCESS_TOKEN/META_PHONE_NUMBER_ID/
      // ADMIN_WHATSAPP_NUMBER are all set. Never fails the report over this.
      let whatsappSent = false;
      const { META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, ADMIN_WHATSAPP_NUMBER } = process.env;
      if (META_ACCESS_TOKEN && META_PHONE_NUMBER_ID && ADMIN_WHATSAPP_NUMBER && severity !== 'info') {
        try {
          const icon = severity === 'critical' ? '🔴' : '🟡';
          const text = `${icon} Angadi site health — ${severity.toUpperCase()}\n\n${title}\n\n${description}`
            + (row.proposed_fix ? `\n\nProposed fix: ${row.proposed_fix}` : '')
            + `\n\nSee Admin → Dashboard for details.`;
          const wr = await fetch(`https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: ADMIN_WHATSAPP_NUMBER,
              type: 'text',
              text: { body: text.slice(0, 4096) },
            }),
          });
          whatsappSent = wr.ok;
        } catch (e) { /* non-fatal — the admin panel alert still stands */ }
      }

      res.status(200).json({ ok: true, alertId: saved && saved.id, whatsappSent });
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

    if (action === 'notify-customers') {
      if (!env.VAPID_PRIVATE) { res.status(500).json({ error: 'VAPID_PRIVATE env not set on Vercel' }); return; }
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:angadihyd@gmail.com', VAPID_PUBLIC, env.VAPID_PRIVATE);
      const title = String(payload.title || '🛒 Orders are open at Angadi!').slice(0, 120);
      const body = String(payload.body || 'Order fresh village meat now before the cutoff.').slice(0, 200);
      const url = String(payload.url || '/shop.html');
      const r = await fetch(env.SUPABASE_URL + '/rest/v1/push_subscriptions?select=*&role=eq.customer', {
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY }
      });
      const subs = r.ok ? await r.json() : [];
      const data = JSON.stringify({ title, body, url });
      let sent = 0;
      await Promise.all((subs || []).map(s =>
        webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data)
          .then(() => { sent++; })
          .catch(async err => {
            if (err && (err.statusCode === 404 || err.statusCode === 410)) {
              await fetch(env.SUPABASE_URL + '/rest/v1/push_subscriptions?endpoint=eq.' + encodeURIComponent(s.endpoint), {
                method: 'DELETE', headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY }
              });
            }
          })
      ));
      res.status(200).json({ ok: true, sent, total: (subs || []).length });
      return;
    }

    if (action === 'schedule-notification') {
      const title = String(payload.title || '').trim().slice(0, 120);
      const body = String(payload.body || '').trim().slice(0, 200);
      const url = String(payload.url || '/shop.html');
      const sendAt = new Date(payload.sendAt || '');
      if (!title || !body) { res.status(400).json({ error: 'Title and message are required' }); return; }
      if (isNaN(sendAt.getTime())) { res.status(400).json({ error: 'Invalid send time' }); return; }
      if (sendAt.getTime() < Date.now() - 60000) { res.status(400).json({ error: 'Send time must be in the future' }); return; }
      const r = await rest(env, 'scheduled_notifications', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ title, body, url, send_at: sendAt.toISOString() }),
      });
      const rows = r.ok ? await r.json().catch(() => null) : null;
      if (!r.ok) { res.status(500).json({ error: 'db ' + r.status }); return; }
      res.status(200).json({ ok: true, data: rows });
      return;
    }

    if (action === 'set-partner-login') {
      const id = String(payload.id || '');
      const username = String(payload.username || '').trim().toLowerCase();
      const password = String(payload.password || '');
      if (!id) { res.status(400).json({ error: 'Missing delivery boy id' }); return; }
      if (!/^[a-z0-9_.-]{3,20}$/.test(username)) { res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, . _ -' }); return; }
      if (password && password.length < 6) { res.status(400).json({ error: 'Password must be at least 6 characters' }); return; }
      const dupR = await rest(env, `delivery_boys?username=eq.${encodeURIComponent(username)}&select=id`);
      const dupRows = dupR.ok ? await dupR.json() : [];
      if (dupRows[0] && dupRows[0].id !== id) { res.status(400).json({ error: 'That username is already taken' }); return; }
      const values = { username, code: username };
      if (password) values.password = hashPassword(password);
      const r = await rest(env, `delivery_boys?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(values) });
      const rows = r.ok ? await r.json().catch(() => null) : null;
      if (!r.ok) { res.status(500).json({ error: 'db ' + r.status }); return; }
      res.status(200).json({ ok: true, data: rows });
      return;
    }

    if (action === 'storage-upload') {
      const name = String(payload.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
      const type = String(payload.type || 'image/jpeg');
      if (!name || !type.startsWith('image/')) { res.status(400).json({ error: 'Bad file' }); return; }
      let buf;
      try { buf = Buffer.from(String(payload.base64 || ''), 'base64'); }
      catch { res.status(400).json({ error: 'Bad file data' }); return; }
      // Vercel's Node function body cap is ~4.5MB, and base64 inflates the
      // raw file by ~33% in transit — so the *decoded* limit must stay well
      // under that, not just under the request-body cap itself.
      if (!buf.length || buf.length > 3.2 * 1024 * 1024) { res.status(400).json({ error: 'Image must be under 3MB' }); return; }
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

    if (action === 'refund-order') {
      const orderId = String(payload.orderId || '');
      const amount = Number(payload.amount);
      if (!orderId || !(amount > 0)) {
        res.status(400).json({ error: 'orderId and a positive amount are required' });
        return;
      }
      const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
      const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
      if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        res.status(500).json({ error: 'Razorpay not configured on the server' });
        return;
      }

      const lookup = await rest(env, `orders?order_id=eq.${encodeURIComponent(orderId)}&select=payment,payment_id,total,refunded_amount,status`);
      const rows = await lookup.json();
      const order = Array.isArray(rows) ? rows[0] : null;
      if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
      if (order.payment !== 'razorpay' || !order.payment_id) {
        res.status(400).json({ error: 'This order was not paid online — nothing to refund via Razorpay. Cancel it directly instead.' });
        return;
      }
      const alreadyRefunded = Number(order.refunded_amount || 0);
      const orderTotal = Number(order.total || 0);
      if (alreadyRefunded + amount > orderTotal + 0.01) {
        res.status(400).json({ error: `That would exceed the order total. Already refunded ₹${alreadyRefunded}, order total ₹${orderTotal}.` });
        return;
      }

      // ── Claim the amount before spending it ──
      // refunded_amount was read above and only written after the Razorpay
      // call, so two quick clicks both read the old value and both refunded.
      // This conditional update only succeeds for the first caller.
      const newRefundedTotal = alreadyRefunded + amount;
      const claim = await rest(env,
        `orders?order_id=eq.${encodeURIComponent(orderId)}&refunded_amount=eq.${alreadyRefunded}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ refunded_amount: newRefundedTotal }),
        });
      const claimedRows = claim.ok ? await claim.json().catch(() => []) : [];
      if (!Array.isArray(claimedRows) || !claimedRows.length) {
        res.status(409).json({ error: 'Another refund for this order is already being processed. Reload the page to see the current refund total.' });
        return;
      }
      const releaseClaim = () => rest(env, `orders?order_id=eq.${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ refunded_amount: alreadyRefunded }),
      }).catch(() => {});

      // ── Call Razorpay's refund API — this actually moves money ──
      let rzpData;
      try {
        const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
        const rzpRes = await fetch(`https://api.razorpay.com/v1/payments/${order.payment_id}/refund`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: Math.round(amount * 100) }),
        });
        rzpData = await rzpRes.json();
        if (!rzpRes.ok) {
          await releaseClaim();
          res.status(500).json({ error: (rzpData && rzpData.error && rzpData.error.description) || 'Refund failed at Razorpay' });
          return;
        }
      } catch (e) {
        await releaseClaim();
        res.status(502).json({ error: 'Could not reach Razorpay: ' + String(e.message || e) });
        return;
      }

      // ── Record it — this order is now refunded/cancelled ──
      const patchFields = {
        refund_id: rzpData.id,
        refunded_amount: newRefundedTotal,
        refunded_at: new Date().toISOString(),
      };
      if (newRefundedTotal >= orderTotal - 0.01) patchFields.status = 'cancelled';
      const upd = await rest(env, `orders?order_id=eq.${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patchFields),
      });
      if (!upd.ok) {
        const t = await upd.text();
        // Refund already succeeded at Razorpay — surface this clearly rather than silently losing it.
        res.status(500).json({ error: 'Refund succeeded at Razorpay (id ' + rzpData.id + ') but saving it failed: ' + t.slice(0, 200) });
        return;
      }
      res.status(200).json({ ok: true, refundId: rzpData.id, amount, totalRefunded: newRefundedTotal, fullyCancelled: !!patchFields.status });
      return;
    }

    if (action === 'check-razorpay-payment') {
      // Read-only reconciliation check: our DB may show no payment_id (e.g. the
      // customer's browser closed before verify-payment.js ran, and the
      // razorpay-webhook.js backstop is missing/misconfigured) even though
      // Razorpay actually captured the money. Ask Razorpay directly instead
      // of trusting our own row, so a paying customer is never told "not paid".
      const orderId = String(payload.orderId || '');
      if (!orderId) { res.status(400).json({ error: 'orderId required' }); return; }
      const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
      const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
      if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        res.status(500).json({ error: 'Razorpay not configured on the server' });
        return;
      }
      const lookup = await rest(env, `orders?order_id=eq.${encodeURIComponent(orderId)}&select=razorpay_order_id,payment,payment_id,status`);
      const rows = await lookup.json();
      const order = Array.isArray(rows) ? rows[0] : null;
      if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
      if (!order.razorpay_order_id) { res.status(400).json({ error: 'This order has no Razorpay order id — it was never a Razorpay checkout.' }); return; }

      const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
      let rzpData;
      try {
        const rzpRes = await fetch(`https://api.razorpay.com/v1/orders/${order.razorpay_order_id}/payments`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        rzpData = await rzpRes.json();
        if (!rzpRes.ok) {
          res.status(500).json({ error: (rzpData && rzpData.error && rzpData.error.description) || 'Razorpay lookup failed' });
          return;
        }
      } catch (e) {
        res.status(502).json({ error: 'Could not reach Razorpay: ' + String(e.message || e) });
        return;
      }

      const payments = rzpData.items || [];
      const captured = payments.find((p) => p.status === 'captured');

      // Auto-heal: Razorpay has a captured payment we never recorded.
      if (captured && !order.payment_id) {
        await rest(env, `orders?order_id=eq.${encodeURIComponent(orderId)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ payment_id: captured.id, status: order.status === 'cancelled' ? order.status : 'paid' }),
        });
      }

      res.status(200).json({
        ok: true,
        razorpayPayments: payments.map((p) => ({ id: p.id, status: p.status, amount: p.amount, method: p.method, error_description: p.error_description })),
        reconciled: !!(captured && !order.payment_id),
        capturedPaymentId: captured ? captured.id : null,
      });
      return;
    }

    if (action === 'sheet-sync') {
      // {url?, statusOnly?} → saves the link (if given) and syncs now.
      try {
        if (payload.statusOnly) { res.status(200).json({ ok: true, config: await getSheetSetting(env) }); return; }
        const url = payload.url ? String(payload.url).trim() : '';
        if (url && !/^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(url)) {
          res.status(400).json({ error: 'Paste a Google Sheets link (https://docs.google.com/spreadsheets/d/…).' });
          return;
        }
        const out = await runSheetSync(env, url);
        res.status(200).json({ ok: out.result.ok, url: out.url, result: out.result });
      } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
      return;
    }

    if (action === 'bulk-archive-orders') {
      // Archiving only ever sets a timestamp — never deletes a row. The
      // client already exported these to CSV before calling this.
      const orderIds = Array.isArray(payload.orderIds) ? payload.orderIds : [];
      if (!orderIds.length) { res.status(400).json({ error: 'orderIds required' }); return; }
      if (!orderIds.every((id) => /^[a-zA-Z0-9_-]+$/.test(id))) {
        res.status(400).json({ error: 'Bad order id in list' });
        return;
      }
      const idList = orderIds.map((id) => encodeURIComponent(id)).join(',');
      const r = await rest(env, `orders?order_id=in.(${idList})`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ archived_at: new Date().toISOString() }),
      });
      if (!r.ok) {
        const t = await r.text();
        res.status(500).json({ error: 'Archive failed: ' + t.slice(0, 200) });
        return;
      }
      res.status(200).json({ ok: true, archived: orderIds.length });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('admin api error', e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
