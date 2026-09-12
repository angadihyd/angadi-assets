// ═══════════════════════════════════════════════════════════════
//  GET /api/cron-health-check
//  Daily automated site-health check, run by Vercel Cron (see the
//  "crons" entry in vercel.json — Vercel Hobby allows one run/day).
//
//  This exists because the original plan — a scheduled Claude cloud
//  agent — cannot reach www.angadi.farm at all: Anthropic's cloud
//  sandbox blocks outbound access to arbitrary domains by default,
//  confirmed by an actual run (curl and WebFetch both returned an
//  explicit egress-policy-denied error). A Vercel Cron job runs
//  inside this project's own infrastructure instead, so there is no
//  network restriction, and it needs no external account or token
//  beyond what Vercel itself provides.
//
//  Checks are the deterministic ones a scheduled LLM agent would have
//  applied anyway (fixed thresholds, not judgment calls), so plain
//  code is actually a better fit here than an agent — and it runs
//  every single day with no chance of an LLM skipping a step.
//
//  Security: Vercel automatically sends `Authorization: Bearer
//  $CRON_SECRET` on its own scheduled invocations once CRON_SECRET is
//  set as an env var (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
//  A manual test run is also accepted via the existing HEALTH_AGENT_TOKEN
//  (x-health-token header) — the same restricted credential used by
//  the health-report/health-check-data actions in api/admin.js.
//
//  Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
//  Optional: META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, ADMIN_WHATSAPP_NUMBER
// ═══════════════════════════════════════════════════════════════

const SITE = 'https://www.angadi.farm';
const CHECK_URLS = [
  SITE + '/',
  SITE + '/shop.html',
  SITE + '/checkout.html',
  SITE + '/my-orders.html',
  SITE + '/admin/orders.html', // a login gate here is the healthy response
  SITE + '/api/geocode?q=Hyderabad',
];

function sbHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}
function rest(env, path, opts = {}) {
  return fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { ...sbHeaders(env.SUPABASE_SERVICE_ROLE_KEY), ...(opts.headers || {}) },
  });
}
function timingEq(a, b) {
  const crypto = require('crypto');
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

async function checkUptime() {
  const findings = [];
  for (const url of CHECK_URLS) {
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

async function checkOrderData(env) {
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

async function saveAlert(env, f) {
  const r = await rest(env, 'health_alerts', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ severity: f.severity, title: f.title, description: f.description, source: 'daily-health-check' }]),
  });
  if (!r.ok) { console.error('cron-health-check: could not save alert', await r.text()); return; }

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

module.exports = async (req, res) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, HEALTH_AGENT_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Not configured: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const isVercelCron = CRON_SECRET && timingEq(authHeader, `Bearer ${CRON_SECRET}`);
  const isManualTest = HEALTH_AGENT_TOKEN && timingEq(req.headers['x-health-token'] || '', HEALTH_AGENT_TOKEN);
  if (!isVercelCron && !isManualTest) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
  try {
    const [uptimeFindings, orderFindings] = await Promise.all([checkUptime(), checkOrderData(env)]);
    const findings = [...uptimeFindings, ...orderFindings];

    if (!findings.length) {
      await saveAlert(env, {
        severity: 'info',
        title: 'Daily health check: all clear',
        description: `${CHECK_URLS.length} pages checked, all responding normally. No stuck orders, no unusual cancellation rate, Places quota within range.`,
      });
    } else {
      for (const f of findings.slice(0, 8)) await saveAlert(env, f);
    }

    res.status(200).json({ ok: true, findingsCount: findings.length, checkedAt: new Date().toISOString() });
  } catch (e) {
    console.error('cron-health-check failed', e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
