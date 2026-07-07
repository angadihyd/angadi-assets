// GET /p/:slug (rewritten to /api/share?slug=...)
// Serves a lightweight HTML shell with per-product Open Graph tags so
// links shared on WhatsApp/social show the product name, price and photo
// (crawlers don't run the JS on product-detail.html), then redirects
// real visitors to the product page.

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = async (req, res) => {
  const slug = String((req.query && req.query.slug) || '').replace(/[^a-z0-9-]/g, '');
  const fallback = '/shop.html';
  if (!slug) { res.writeHead(302, { Location: fallback }); res.end(); return; }

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  let p = null;
  if (env.SUPABASE_URL && env.KEY) {
    try {
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/products?slug=eq.${slug}&select=slug,name,name_te,price,unit,image,short_desc&limit=1`,
        { headers: { apikey: env.KEY, Authorization: `Bearer ${env.KEY}` } });
      if (r.ok) p = (await r.json())[0] || null;
    } catch { /* fall through to redirect */ }
  }
  if (!p) { res.writeHead(302, { Location: fallback }); res.end(); return; }

  const target = `/product-detail.html?id=${encodeURIComponent(p.slug)}`;
  const title = `${p.name}${p.name_te ? ` (${p.name_te})` : ''} — ₹${p.price}/${p.unit} | Angadi`;
  const desc = p.short_desc || 'Farm-fresh village meat delivered same-day in Hyderabad.';
  // WhatsApp's scraper rejects WebP and large files — use the lightweight
  // JPEG twin in product/og/ (falls back to the raw path for non-product images).
  const m = String(p.image || '').match(/^product\/(.+)\.webp$/);
  const imgPath = m ? `product/og/${m[1]}.jpg` : String(p.image || '');
  const img = `https://www.angadi.farm/${encodeURI(imgPath)}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://www.angadi.farm${target}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Angadi">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:url" content="https://www.angadi.farm/p/${esc(p.slug)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
</head>
<body>
<p>Taking you to <a href="${esc(target)}">${esc(p.name)}</a>…</p>
<script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>`);
};
