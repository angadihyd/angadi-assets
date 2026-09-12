// ═══════════════════════════════════════════════════════════════
//  GET /api/geocode
//  Address search + reverse geocoding, proxied server-side. The
//  browser calls THIS (same-origin), so it works on networks that
//  block the upstream provider, and the API key never reaches the
//  browser (a leaked Google key can be used to run up the bill).
//
//    /api/geocode?q=Banjara Hills        → search  (returns array)
//    /api/geocode?lat=17.41&lon=78.44    → reverse (returns object)
//
//  SEARCH uses Google Places when GOOGLE_MAPS_API_KEY is set, because
//  OpenStreetMap has almost no building data for Indian apartments
//  (searching "My Home Bhooja" there returns nothing). Google calls are
//  metered against a monthly cap and fall back to OpenStreetMap once it
//  is reached, so the bill cannot run away unattended.
//
//  REVERSE always uses OpenStreetMap: it's free, and it only has to turn
//  a pin into an area + pincode, which it does well enough.
//
//  Optional env: GOOGLE_MAPS_API_KEY
// ═══════════════════════════════════════════════════════════════

const UA = 'AngadiMeat/1.0 (https://www.angadi.farm; orders@angadi.farm)';
// Hyderabad bounding box (lon/lat) to bias + bound search results.
const VIEWBOX = '78.05,17.75,78.85,17.10';
// Centre of Hyderabad + radius, used to keep Google's results local.
const HYD = { lat: 17.385, lng: 78.4867, radiusM: 45000 };
const DEFAULT_MONTHLY_CAP = 5000;

function monthKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

async function readCap(env) {
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/site_settings?key=eq.maps&select=value`,
      { headers: { apikey: env.KEY, Authorization: `Bearer ${env.KEY}` } }
    );
    if (!r.ok) return { cap: DEFAULT_MONTHLY_CAP, enabled: true };
    const rows = await r.json();
    const v = (rows && rows[0] && rows[0].value) || {};
    return {
      cap: Number(v.monthly_cap != null ? v.monthly_cap : DEFAULT_MONTHLY_CAP),
      enabled: v.google_enabled !== false,
    };
  } catch (e) {
    return { cap: DEFAULT_MONTHLY_CAP, enabled: true };
  }
}

// Claims one call against this month's cap. Returns false if the cap is
// reached (or the check can't run) so the caller falls back to the free
// provider rather than spending money it can't account for.
async function claimQuota(env) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/use_api_quota`, {
      method: 'POST',
      headers: {
        apikey: env.KEY,
        Authorization: `Bearer ${env.KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_service: 'google_places', p_month: monthKey(), p_cap: env.cap }),
    });
    if (!r.ok) return false;
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    return !!(row && row.allowed);
  } catch (e) {
    return false;
  }
}

// Google's shape → the Nominatim shape the checkout page already expects,
// so nothing downstream has to change.
function fromGoogle(places) {
  return (places || []).map((p) => ({
    lat: String(p.location && p.location.latitude),
    lon: String(p.location && p.location.longitude),
    display_name: [
      (p.displayName && p.displayName.text) || '',
      p.formattedAddress || '',
    ].filter(Boolean).join(', '),
    source: 'google',
  }));
}

async function searchGoogle(q, key) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      // Only the fields we use — billed per field group, so keep it tight.
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({
      textQuery: q,
      regionCode: 'IN',
      maxResultCount: 6,
      locationBias: {
        circle: { center: { latitude: HYD.lat, longitude: HYD.lng }, radius: HYD.radiusM },
      },
    }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const mapped = fromGoogle(data.places);
  return mapped.length ? mapped : null;
}

async function searchOSM(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6'
    + '&countrycodes=in&viewbox=' + VIEWBOX + '&bounded=1'
    + '&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) return null;
  return r.json();
}

module.exports = async (req, res) => {
  let params;
  try { params = new URL(req.url, 'http://x').searchParams; }
  catch { res.status(400).json({ error: 'bad request' }); return; }

  const q = (params.get('q') || '').trim();
  const lat = params.get('lat');
  const lon = params.get('lon');

  // Safe diagnostic: booleans only, never the key value itself. Exists to
  // answer "why isn't Google being used" without guessing.
  if (params.get('debug') === '1') {
    const hasKey = !!process.env.GOOGLE_MAPS_API_KEY;
    const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
    let cfg = null, quotaCheck = null;
    if (hasSupabase) {
      cfg = await readCap({ SUPABASE_URL: process.env.SUPABASE_URL, KEY: process.env.SUPABASE_SERVICE_ROLE_KEY });
      if (hasKey && cfg.enabled && cfg.cap > 0) {
        try {
          const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
              'X-Goog-FieldMask': 'places.displayName',
            },
            body: JSON.stringify({ textQuery: 'Gachibowli Hyderabad', maxResultCount: 1 }),
          });
          const body = await r.text();
          quotaCheck = { httpStatus: r.status, bodyPreview: body.slice(0, 300) };
        } catch (e) {
          quotaCheck = { fetchError: String(e) };
        }
      }
    }
    res.status(200).json({ hasGoogleKey: hasKey, hasSupabaseEnv: hasSupabase, mapsSettings: cfg, googleTestCall: quotaCheck });
    return;
  }

  // ── Reverse: always the free provider ──
  if (!q) {
    if (!lat || !lon) { res.status(400).json({ error: 'Provide q (search) or lat & lon (reverse)' }); return; }
    try {
      const r = await fetch(
        'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1'
          + '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon),
        { headers: { 'User-Agent': UA, Accept: 'application/json' } }
      );
      if (!r.ok) { res.status(502).json({ error: 'geocoder error', status: r.status }); return; }
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
      res.status(200).json(await r.json());
    } catch (e) {
      console.error('geocode reverse error', e);
      res.status(502).json({ error: 'geocoder unreachable' });
    }
    return;
  }

  // ── Search: Google if configured, in budget and reachable; else OSM ──
  const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (GOOGLE_KEY && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    const env = { SUPABASE_URL, KEY: SUPABASE_SERVICE_ROLE_KEY };
    const { cap, enabled } = await readCap(env);
    if (enabled && cap > 0 && await claimQuota({ ...env, cap })) {
      try {
        const hits = await searchGoogle(q, GOOGLE_KEY);
        if (hits) {
          res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
          res.status(200).json(hits);
          return;
        }
      } catch (e) {
        console.error('google places error', e);   // fall through to OSM
      }
    }
  }

  try {
    const data = await searchOSM(q);
    if (!data) { res.status(502).json({ error: 'geocoder error' }); return; }
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.status(200).json(data);
  } catch (e) {
    console.error('geocode proxy error', e);
    res.status(502).json({ error: 'geocoder unreachable' });
  }
};
